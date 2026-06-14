/**
 * Regression test for the cross-userns volume-reset fix.
 *
 * When `_initContainer()`'s bind-mount write-probe fails, the container predates
 * `--userns=keep-id` AND its persisted named volumes hold a clone owned by the
 * OLD (non-keep-id) userns mapping. Those subuids may fall outside the new
 * namespace's mapped range, so a `chown -R` cannot reliably re-own
 * `/workspace/.git` for the keep-id `node` user — `git worktree add` then fails
 * with a misleading "invalid reference". The fix: on the bind-mount-probe-failure
 * path ONLY, also reset BOTH named volumes (`bobbit-workspace-<id>` and
 * `bobbit-worktrees-<id>`) so the recreated container clones fresh, node-owned.
 *
 * The stale-IMAGE recreate path must NOT reset volumes (worktrees survive).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const { ProjectSandbox } = await import("../src/server/agent/project-sandbox.ts");

const PROJECT_ID = "vol-reset-proj";

/**
 * Fake runtime. `probeWritable` decides whether the bind-mount write-probe
 * succeeds; `imageStale` forces the stale-image branch (different image ids).
 * Records every `removeVolume` call.
 */
function makeFakeRuntime(opts: {
	probeWritable: boolean;
	imageStale?: boolean;
	/**
	 * Workspace-git write-probe outcome (the keep-id + stale-volume case). When
	 * `false`, `/workspace/.git` exists but the `node` write-probe EACCESes —
	 * exactly the user's healthy-keep-id-container-on-a-stale-volume state.
	 */
	workspaceGitWritable?: boolean;
	/** When `false`, `test -d /workspace/.git` fails (no clone yet → probe skipped). */
	hasWorkspaceGit?: boolean;
}) {
	const removedVolumes: string[] = [];
	const removed = new Set<string>();
	const hasGit = opts.hasWorkspaceGit ?? true;
	const gitWritable = opts.workspaceGitWritable ?? true;
	const runtime: any = {
		bin: "podman",
		async findContainerByLabel() { return "existing-container-id"; },
		async isRunning(id: string) { return !removed.has(id); },
		async getContainerImageId() { return "img-old"; },
		async getImageId() { return opts.imageStale ? "img-new" : "img-old"; },
		async startContainer(id: string) { if (removed.has(id)) throw new Error("no such container"); },
		async removeContainer(id: string) { removed.add(id); },
		async createContainer() { return "fresh-container-id"; },
		async getResourceLimits() { return null; },
		async removeVolume(name: string) { removedVolumes.push(name); },
		async exec(_id: string, argv: string[]) {
			// Bind-mount write-probe (host sessions dir).
			if (argv[0] === "sh" && (argv[2] ?? "").includes(".bobbit-perm-probe")) {
				if (!opts.probeWritable) throw new Error("EACCES: permission denied");
				return { stdout: "", stderr: "" };
			}
			// `test -d /workspace/.git` — clone-present check.
			if (argv[0] === "test" && argv[1] === "-d" && argv[2] === "/workspace/.git") {
				if (!hasGit) throw new Error("no /workspace/.git");
				return { stdout: "", stderr: "" };
			}
			// Workspace-git write-probe (the keep-id + stale-volume case).
			if (argv[0] === "sh" && (argv[2] ?? "").includes(".bobbit-write-probe")) {
				if (!gitWritable) throw new Error("EACCES: permission denied");
				return { stdout: "", stderr: "" };
			}
			return { stdout: "", stderr: "" };
		},
	};
	return { runtime, removedVolumes };
}

/** Spy private lifecycle so we observe recreate vs reuse and avoid fs side-effects. */
function spyLifecycle(sandbox: any) {
	const calls = { create: 0, init: 0 };
	sandbox._createContainer = async () => { calls.create++; sandbox.containerId = "fresh-container-id"; };
	sandbox._ensureWritableSandboxVolumes = async () => {};
	sandbox._ensureGitSafeDirectory = async () => {};
	sandbox._runInitSequence = async () => { calls.init++; };
	return calls;
}

function makeSandbox(runtime: any) {
	return new ProjectSandbox({
		runtime,
		sandboxMode: "podman",
		projectId: PROJECT_ID,
		projectDir: "/tmp/does-not-matter",
		repoUrl: "https://example.com/repo.git",
		image: "bobbit-agent",
	});
}

describe("ProjectSandbox._initContainer volume reset on bind-mount-probe failure (cross-userns fix)", () => {
	it("RESETS both named volumes when the bind-mount write-probe fails, then recreates + reinits", async () => {
		const { runtime, removedVolumes } = makeFakeRuntime({ probeWritable: false });
		const sandbox = makeSandbox(runtime);
		const calls = spyLifecycle(sandbox as any);

		await (sandbox as any)._initContainer();

		assert.deepEqual(
			removedVolumes.sort(),
			[`bobbit-workspace-${PROJECT_ID}`, `bobbit-worktrees-${PROJECT_ID}`].sort(),
			"BOTH named volumes must be reset on the probe-failure path",
		);
		assert.equal(calls.create, 1, "a fresh container (with keep-id) must be created");
		assert.equal(calls.init, 1, "init sequence runs on the fresh container (fresh clone)");
		assert.equal(await sandbox.getContainerId(), "fresh-container-id");
	});

	it("does NOT reset volumes when the bind-mount write-probe succeeds (reuse)", async () => {
		const { runtime, removedVolumes } = makeFakeRuntime({ probeWritable: true });
		const sandbox = makeSandbox(runtime);
		spyLifecycle(sandbox as any);

		await (sandbox as any)._initContainer();

		assert.deepEqual(removedVolumes, [], "no volume reset when the container is writable");
		assert.equal(await sandbox.getContainerId(), "existing-container-id");
	});

	it("does NOT reset volumes on the stale-IMAGE recreate path (worktrees must survive)", async () => {
		// Image is stale → recreate, but the (fresh) container's probe succeeds, so
		// the bind-mount path never fires. Volumes must be preserved.
		const { runtime, removedVolumes } = makeFakeRuntime({ probeWritable: true, imageStale: true });
		const sandbox = makeSandbox(runtime);
		const calls = spyLifecycle(sandbox as any);

		await (sandbox as any)._initContainer();

		assert.deepEqual(removedVolumes, [], "stale-image recreate must NOT reset volumes");
		assert.equal(calls.create, 1, "stale-image path recreates the container");
		assert.equal(calls.init, 1);
	});

	// ── keep-id + stale-volume case (the user's 0d7470ce state) ──────────────
	// A HEALTHY keep-id container PASSES the bind-mount write-probe (host mounts
	// work) but REUSES a /workspace clone made under an incompatible pre-keep-id
	// userns: `/workspace/.git` is foreign-owned, so `node` can't write refs and
	// `git worktree add` fails with `cannot lock ref … Permission denied`. The
	// new workspace-git write-probe must catch this and trigger the SAME reset.
	it("RESETS both named volumes when bind-mount probe PASSES but the /workspace/.git write-probe FAILS, then recreates + reinits", async () => {
		const { runtime, removedVolumes } = makeFakeRuntime({ probeWritable: true, workspaceGitWritable: false });
		const sandbox = makeSandbox(runtime);
		const calls = spyLifecycle(sandbox as any);

		await (sandbox as any)._initContainer();

		assert.deepEqual(
			removedVolumes.sort(),
			[`bobbit-workspace-${PROJECT_ID}`, `bobbit-worktrees-${PROJECT_ID}`].sort(),
			"BOTH named volumes must be reset when the /workspace/.git write-probe fails",
		);
		assert.equal(calls.create, 1, "a fresh container must be created");
		assert.equal(calls.init, 1, "init sequence runs on the fresh container (fresh, node-owned clone)");
		assert.equal(await sandbox.getContainerId(), "fresh-container-id");
	});

	it("does NOT reset volumes when BOTH probes pass (healthy keep-id container, node-owned clone)", async () => {
		const { runtime, removedVolumes } = makeFakeRuntime({ probeWritable: true, workspaceGitWritable: true });
		const sandbox = makeSandbox(runtime);
		const calls = spyLifecycle(sandbox as any);

		await (sandbox as any)._initContainer();

		assert.deepEqual(removedVolumes, [], "no reset when both probes pass");
		assert.equal(calls.create, 0, "the healthy container is reused, not recreated");
		assert.equal(await sandbox.getContainerId(), "existing-container-id");
	});

	it("does NOT probe or reset when /workspace/.git does not exist yet (never cloned)", async () => {
		// No clone yet → the write-probe is skipped entirely; reuse and let
		// _runInitSequence clone (the fresh clone is node-owned).
		const { runtime, removedVolumes } = makeFakeRuntime({
			probeWritable: true,
			hasWorkspaceGit: false,
			// Even if the write-probe WOULD fail, it must never run when there's no .git.
			workspaceGitWritable: false,
		});
		const sandbox = makeSandbox(runtime);
		const calls = spyLifecycle(sandbox as any);

		await (sandbox as any)._initContainer();

		assert.deepEqual(removedVolumes, [], "no reset when there is no /workspace/.git to probe");
		assert.equal(calls.create, 0, "container is reused");
		assert.equal(calls.init, 1, "init sequence runs to clone the empty workspace");
		assert.equal(await sandbox.getContainerId(), "existing-container-id");
	});
});
