/**
 * Real-podman end-to-end validation for the stale-container reclone fix.
 *
 * Exercises ProjectSandbox directly against the PodmanRuntime (routed at the
 * host podman socket via CONTAINER_HOST). Reproduces the user's exact failing
 * scenario:
 *   1. Resolve an SSH origin → HTTPS clone URL (prior fix).
 *   2. Create the container via podman → clone /workspace over HTTPS → create a
 *      worktree (the now-passing `git worktree add`).
 *   3. Simulate a STALE container from a prior failed clone: wipe /workspace so
 *      it has no .git but the container is reused.
 *   4. Re-init (reconnect path) and prove the fix re-clones and the worktree is
 *      created again — the exact command that used to fail now returns 0.
 *
 * Run: CONTAINER_HOST=unix:///run/user/$(id -u)/podman/podman.sock npx tsx scripts/podman-e2e-validate.ts
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PodmanRuntime } from "../src/server/agent/container-runtime/podman-runtime.js";
import { ProjectSandbox } from "../src/server/agent/project-sandbox.js";
import { resolveSandboxCloneSource } from "../src/server/agent/sandbox-clone-source.js";

const execFileAsync = promisify(execFile);
const PROJECT_ID = `podman-e2e-${process.pid}`;
const IMAGE = "localhost/bobbit-agent:latest";
const SSH_ORIGIN = "git@github.com:octocat/Hello-World.git";
const WORKTREE_NAME = "session/validate-wt";
const BRANCH = "octo-validate";

function log(step: string, msg: string): void {
	console.log(`\n=== [${step}] ${msg}`);
}

async function podman(args: string[]): Promise<string> {
	const { stdout } = await execFileAsync("podman", args, { env: process.env, timeout: 120_000, maxBuffer: 10 * 1024 * 1024 });
	return stdout.trim();
}

async function main(): Promise<void> {
	if (!process.env.CONTAINER_HOST) {
		throw new Error("CONTAINER_HOST not set — point it at the rootless podman socket");
	}
	log("env", `podman version: ${await podman(["info", "--format", "{{.Version.Version}}"])}; CONTAINER_HOST=${process.env.CONTAINER_HOST}`);

	const runtime = new PodmanRuntime();

	// Step 1 — SSH→HTTPS normalization.
	const cloneSource = resolveSandboxCloneSource({ originUrl: SSH_ORIGIN, mountSourcePath: "/unused" });
	log("ssh->https", `origin "${SSH_ORIGIN}" → clone url "${cloneSource.cloneUrl}" (kind=${cloneSource.kind})`);
	if (!cloneSource.cloneUrl.startsWith("https://")) throw new Error("SSH origin was not normalized to HTTPS");

	// A host project dir for the bind mounts (.bobbit/state).
	const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "podman-e2e-proj-"));

	const makeSandbox = (): ProjectSandbox => new ProjectSandbox({
		runtime,
		sandboxMode: "podman",
		projectId: PROJECT_ID,
		projectDir,
		repoUrl: SSH_ORIGIN,
		cloneSource,
		image: IMAGE,
	});

	let containerId = "";
	try {
		// Step 2 — first init: create container + clone + worktree.
		log("init-1", "first ProjectSandbox.init() — should create container and clone /workspace over HTTPS");
		const sb1 = makeSandbox();
		await sb1.init();
		containerId = await sb1.getContainerId();
		log("init-1", `container created: ${containerId.substring(0, 12)}`);
		console.log(await podman(["ps", "--filter", `id=${containerId}`, "--format", "{{.ID}} {{.Image}} {{.Status}}"]));
		const gitDirCheck1 = await podman(["exec", "-w", "/workspace", containerId, "sh", "-c", "test -d /workspace/.git && echo HAS_GIT || echo NO_GIT"]);
		log("init-1", `/workspace state after clone: ${gitDirCheck1}`);
		if (gitDirCheck1 !== "HAS_GIT") throw new Error("first clone did not populate /workspace/.git");

		const wt1 = await sb1.createWorktree(WORKTREE_NAME, BRANCH);
		log("init-1", `worktree created at ${wt1}`);

		// Step 3 — simulate a STALE half-initialized container (prior failed clone):
		// reuse the SAME container but wipe /workspace so it has no .git.
		log("stale", "wiping /workspace to simulate a prior-failed-clone reused container");
		// Remove the worktree first so git metadata is clean, then nuke /workspace.
		await podman(["exec", containerId, "sh", "-c", "git worktree remove --force /workspace-wt/" + WORKTREE_NAME + " 2>/dev/null; rm -rf /workspace/.git /workspace/* /workspace/.[!.]* 2>/dev/null; ls -la /workspace; rm -rf /workspace-wt/" + WORKTREE_NAME]);
		const gitDirCheckStale = await podman(["exec", containerId, "sh", "-c", "test -d /workspace/.git && echo HAS_GIT || echo NO_GIT"]);
		log("stale", `/workspace state (empty, reused container ${containerId.substring(0, 12)}): ${gitDirCheckStale}`);
		if (gitDirCheckStale !== "NO_GIT") throw new Error("failed to simulate empty /workspace");

		// Step 4 — re-init via the RECONNECT path. With the fix, this re-clones.
		log("init-2", "second ProjectSandbox.init() — reconnect path must re-clone the empty /workspace");
		const sb2 = makeSandbox();
		await sb2.init();
		const reconnId = await sb2.getContainerId();
		const sameContainer = reconnId.substring(0, 12) === containerId.substring(0, 12);
		log("init-2", `reconnected to container: ${reconnId.substring(0, 12)} (same=${sameContainer})`);
		if (!sameContainer) throw new Error("expected to reuse the SAME stale container, not recreate");
		const gitDirCheck2 = await podman(["exec", containerId, "sh", "-c", "test -d /workspace/.git && echo HAS_GIT || echo NO_GIT"]);
		log("init-2", `/workspace state after reconnect+reinit: ${gitDirCheck2}`);
		if (gitDirCheck2 !== "HAS_GIT") throw new Error("BUG NOT FIXED: reconnect skipped the re-clone; /workspace still has no .git");

		// Prove via the REAL production path: ProjectSandbox.createWorktree (which is
		// what the session/staff bring-up calls). This is the chain that used to fail
		// with "fatal: not a git repository" on the reused stale container.
		const wt2 = await sb2.createWorktree(WORKTREE_NAME, BRANCH);
		const wtExists = await podman(["exec", containerId, "sh", "-c", "git -C /workspace-wt/" + WORKTREE_NAME + " rev-parse --is-inside-work-tree >/dev/null 2>&1 && echo WT_OK || echo WT_MISSING"]);
		log("worktree-add", `ProjectSandbox.createWorktree → ${wt2}; worktree exists: ${wtExists}`);
		if (wtExists !== "WT_OK") throw new Error("createWorktree did not produce a worktree");

		// Also prove the EXACT raw failing command now returns 0 against an existing
		// remote branch (the user's scenario used a pre-existing branch ref). master
		// is octocat/Hello-World's default branch — fetched by the clone.
		const RAW_WT = "session/raw-add";
		log("worktree-add", `running the exact command: podman exec -w /workspace ${containerId.substring(0, 12)} git worktree add /workspace-wt/${RAW_WT} test`);
		const wtAddOut = await podman(["exec", "-w", "/workspace", containerId, "git", "worktree", "add", "/workspace-wt/" + RAW_WT, "test"]);
		console.log(wtAddOut || "(no stdout)");
		const rawExists = await podman(["exec", containerId, "sh", "-c", "git -C /workspace-wt/" + RAW_WT + " rev-parse --is-inside-work-tree >/dev/null 2>&1 && echo WT_OK || echo WT_MISSING"]);
		log("worktree-add", `raw git worktree add exit 0; worktree exists: ${rawExists}`);
		if (rawExists !== "WT_OK") throw new Error("raw git worktree add did not produce a worktree");

		log("RESULT", "SUCCESS — full chain: podman container → HTTPS clone (from SSH origin) → stale reuse → re-clone → git worktree add returned 0 and the worktree exists.");
	} finally {
		// Cleanup: remove the test container + volume.
		try {
			const sb = makeSandbox();
			await sb.destroy();
			log("cleanup", "container + volume destroyed");
		} catch (e: any) {
			console.warn("cleanup failed:", e?.message || e);
		}
		try { fs.rmSync(projectDir, { recursive: true, force: true }); } catch { /* ignore */ }
	}
}

main().then(() => process.exit(0)).catch((err) => {
	console.error("\n=== [FAILURE] ===\n", err?.stack || err?.message || err);
	process.exit(1);
});
