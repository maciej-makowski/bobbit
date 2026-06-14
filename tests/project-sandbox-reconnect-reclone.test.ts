/**
 * Regression test for the "stale reused container skips the clone" bug.
 *
 * `ProjectSandbox._initContainer()` used to `return` early in both reconnect
 * branches (running container, restarted-stopped container) after setting
 * `this.containerId`, SKIPPING `_runInitSequence()`. So a container that was
 * reused but whose `/workspace` was never populated (e.g. a prior clone
 * failed) was trusted as initialized, and the subsequent `createWorktree` →
 * `git worktree add` in `/workspace` failed with "fatal: not a git repository".
 *
 * The fix makes every reconnect path fall through to the idempotent
 * `_runInitSequence()`:
 *  - when `/workspace/.git` is MISSING → the clone IS issued (re-clone), and
 *  - when `/workspace/.git` is PRESENT → the clone is SKIPPED (no-op).
 *
 * We inject a fake ContainerRuntime that returns an existing RUNNING container
 * (so `_createContainer` — which has fs side effects — is never reached) and
 * records every `exec` argv. The `test -d /workspace/.git` probe outcome is
 * toggled per scenario.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const { ProjectSandbox } = await import("../src/server/agent/project-sandbox.ts");

/** A minimal fake ContainerRuntime that records exec calls and lets the test
 * decide whether `/workspace/.git` exists. */
function makeFakeRuntime(opts: { workspaceHasGit: boolean }) {
	const execCalls: string[][] = [];
	const runtime: any = {
		bin: "podman",
		async findContainerByLabel() { return "existing-container-id"; },
		async isRunning() { return true; },
		// Not stale: same image id for container and tag.
		async getContainerImageId() { return "img-sha"; },
		async getImageId() { return "img-sha"; },
		async startContainer() { /* unused — container is running */ },
		async removeContainer() { throw new Error("removeContainer must not be called in reconnect"); },
		async createContainer() { throw new Error("createContainer must not be called when reconnecting to a running container"); },
		async getResourceLimits() { return null; },
		async exec(_id: string, argv: string[]) {
			execCalls.push(argv);
			// Simulate the `/workspace/.git` presence probe.
			if (argv[0] === "test" && argv.includes("/workspace/.git")) {
				if (!opts.workspaceHasGit) throw new Error("test -d /workspace/.git → not found");
				return { stdout: "", stderr: "" };
			}
			// Everything else (echo ok, ls worktrees, git config, git clone, npm probes) succeeds.
			// Make the package.json / package-lock probes fail so the post-clone
			// npm steps are skipped (keep the call list focused on the clone).
			if (argv[0] === "test" && argv.some(a => a.includes("package") || a.includes("node_modules"))) {
				throw new Error("no such file");
			}
			if (argv[0] === "node") throw new Error("no build script");
			return { stdout: "", stderr: "" };
		},
	};
	return { runtime, execCalls };
}

function clonedInto(execCalls: string[][], dest: string): boolean {
	return execCalls.some(a => a[0] === "git" && a[1] === "clone" && a[a.length - 1] === dest);
}

/**
 * Index of the central `_ensureWritableSandboxVolumes()` exec: a single root
 * `chown node:node /workspace /workspace-wt` covering BOTH writable named
 * volumes. Runs on every init path so reused root-owned podman volumes become
 * node-writable before clone/worktree ops.
 */
function chownBothVolumesIndex(execCalls: string[][]): number {
	return execCalls.findIndex(
		a => a[0] === "sh" && a[1] === "-c" && /chown node:node \/workspace \/workspace-wt/.test(a[2] ?? ""),
	);
}

/** Index of the `git clone … .` into /workspace. */
function cloneIntoWorkspaceIndex(execCalls: string[][]): number {
	return execCalls.findIndex(a => a[0] === "git" && a[1] === "clone" && a[a.length - 1] === ".");
}

describe("ProjectSandbox._initContainer reconnect always ensures the workspace is initialized", () => {
	it("RE-CLONES when reconnecting to a running container whose /workspace has no .git", async () => {
		const { runtime, execCalls } = makeFakeRuntime({ workspaceHasGit: false });
		const sandbox = new ProjectSandbox({
			runtime,
			sandboxMode: "podman",
			projectId: "proj-reclone",
			projectDir: "/tmp/does-not-matter",
			repoUrl: "https://example.com/repo.git",
			image: "bobbit-agent",
		});

		await sandbox.init();

		assert.equal(await sandbox.getContainerId(), "existing-container-id", "must reconnect, not recreate");
		assert.ok(
			clonedInto(execCalls, "."),
			`expected a 'git clone … .' into /workspace for an uninitialized reused container; calls: ${JSON.stringify(execCalls)}`,
		);

		// Rootless-podman fix: the central `_ensureWritableSandboxVolumes()` issues a
		// single root `chown node:node /workspace /workspace-wt` on the reconnect
		// path, BEFORE the clone, so the unprivileged `node` user can write
		// /workspace/.git AND create worktrees under the (otherwise root-owned)
		// /workspace-wt named volume.
		const chownIdx = chownBothVolumesIndex(execCalls);
		const cloneIdx = cloneIntoWorkspaceIndex(execCalls);
		assert.ok(
			chownIdx >= 0,
			`expected a root 'chown node:node /workspace /workspace-wt' during init; calls: ${JSON.stringify(execCalls)}`,
		);
		assert.ok(
			chownIdx < cloneIdx,
			`expected chown of both volumes (idx ${chownIdx}) BEFORE git clone (idx ${cloneIdx}); calls: ${JSON.stringify(execCalls)}`,
		);
	});

	it("SKIPS the clone when reconnecting to a running container whose /workspace already has .git", async () => {
		const { runtime, execCalls } = makeFakeRuntime({ workspaceHasGit: true });
		const sandbox = new ProjectSandbox({
			runtime,
			sandboxMode: "podman",
			projectId: "proj-noclone",
			projectDir: "/tmp/does-not-matter",
			repoUrl: "https://example.com/repo.git",
			image: "bobbit-agent",
		});

		await sandbox.init();

		assert.equal(await sandbox.getContainerId(), "existing-container-id", "must reconnect, not recreate");
		assert.ok(
			!clonedInto(execCalls, "."),
			`expected NO clone for a healthy reused container (/workspace/.git present); calls: ${JSON.stringify(execCalls)}`,
		);
		// Even for a healthy reconnect (clone skipped), the central
		// `_ensureWritableSandboxVolumes()` still chowns BOTH writable named volumes
		// to node — reused podman volumes can be stale root-owned mounts, and the
		// subsequent worktree ops need /workspace-wt writable.
		assert.ok(
			chownBothVolumesIndex(execCalls) >= 0,
			`expected a root 'chown node:node /workspace /workspace-wt' even for a healthy reconnect; calls: ${JSON.stringify(execCalls)}`,
		);
	});
});
