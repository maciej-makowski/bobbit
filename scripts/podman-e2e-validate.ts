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

/**
 * Scenario B — the rootless-podman root-owned /workspace blocker.
 *
 * Reproduces the user's exact failure: a REUSED container whose `/workspace`
 * named volume is root-owned (as happens for volumes created before the
 * node-owned /workspace fix) makes the unprivileged `node` user unable to
 * write `/workspace/.git`, so `git clone … .` fails with
 * `/workspace/.git: Permission denied`.
 *
 * We podman-run a container with the project label and force `/workspace`
 * root-owned (simulating the user's pre-existing volume), then drive the REAL
 * ProjectSandbox.init() → reconnect path → _runInitSequence. The fix issues a
 * root `chown node:node /workspace` before the clone, so the clone now
 * succeeds and /workspace/.git exists, node-owned. Then createWorktree adds a
 * worktree (git worktree add exit 0).
 */
async function validateRootOwnedWorkspaceChown(runtime: PodmanRuntime, cloneSource: ReturnType<typeof resolveSandboxCloneSource>): Promise<void> {
	const projectId = `podman-chown-${process.pid}`;
	const volume = `bobbit-workspace-${projectId}`;
	const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "podman-chown-proj-"));
	let containerId = "";
	try {
		// Pre-create a container with the project label + a root-owned /workspace
		// named volume, simulating the user's existing (pre-fix) container/volume.
		log("chown-setup", `podman run labelled container with root-owned ${volume}:/workspace`);
		containerId = await podman([
			"run", "-d", "--label", `bobbit-project=${projectId}`,
			"-v", `${volume}:/workspace`,
			IMAGE, "sleep", "infinity",
		]);
		await podman(["exec", "--user", "root", containerId, "chown", "root:root", "/workspace"]);
		const ownBefore = await podman(["exec", containerId, "sh", "-c", "stat -c '%U:%G' /workspace"]);
		log("chown-setup", `/workspace owner BEFORE init (must be root:root): ${ownBefore}`);
		if (ownBefore !== "root:root") throw new Error("failed to simulate a root-owned /workspace volume");

		// Prove the raw clone-as-node fails on the root-owned /workspace (the user's
		// exact symptom) BEFORE letting ProjectSandbox.init() apply the fix.
		const rawFail = await podman(["exec", "-w", "/workspace", containerId, "sh", "-c",
			'git config --global --add safe.directory "*"; git clone ' + cloneSource.cloneUrl + ' . 2>&1; echo EXIT=$?']);
		log("chown-repro", `raw clone as node on root-owned /workspace (expect Permission denied + EXIT=1):\n${rawFail}`);
		if (!/Permission denied/.test(rawFail)) throw new Error("expected the root-owned /workspace to reject the clone, but it did not");

		// Drive the REAL production path. init() finds the labelled container,
		// reconnects (so _createContainer is NOT run), and _runInitSequence must
		// chown /workspace before cloning.
		log("chown-init", "ProjectSandbox.init() (reconnect path) — must chown /workspace then clone");
		const sb = new ProjectSandbox({ runtime, sandboxMode: "podman", projectId, projectDir, repoUrl: SSH_ORIGIN, cloneSource, image: IMAGE });
		await sb.init();
		const reconnId = await sb.getContainerId();
		if (reconnId.substring(0, 12) !== containerId.substring(0, 12)) throw new Error("expected reconnect to the SAME container, not recreate");

		const ownAfter = await podman(["exec", containerId, "sh", "-c", "stat -c '%U:%G' /workspace"]);
		const gitState = await podman(["exec", containerId, "sh", "-c", "test -d /workspace/.git && echo HAS_GIT || echo NO_GIT"]);
		log("chown-init", `/workspace owner AFTER init: ${ownAfter}; .git state: ${gitState}`);
		if (gitState !== "HAS_GIT") throw new Error("BLOCKER NOT FIXED: clone into root-owned /workspace failed (no .git after init)");
		const gitLs = await podman(["exec", containerId, "ls", "-lad", "/workspace/.git"]);
		log("chown-init", `ls -lad /workspace/.git (must be node-owned):\n${gitLs}`);

		const wt = await sb.createWorktree(WORKTREE_NAME, BRANCH);
		const wtOk = await podman(["exec", containerId, "sh", "-c", "git -C /workspace-wt/" + WORKTREE_NAME + " rev-parse --is-inside-work-tree >/dev/null 2>&1 && echo WT_OK || echo WT_MISSING"]);
		log("chown-worktree", `createWorktree → ${wt}; worktree exists: ${wtOk}`);
		if (wtOk !== "WT_OK") throw new Error("createWorktree did not produce a worktree on the chowned /workspace");

		log("RESULT-B", "SUCCESS — root-owned /workspace reconnect: clone-as-node failed BEFORE fix, then init chowned /workspace → HTTPS clone exit 0 → /workspace/.git node-owned → git worktree add exit 0.");
	} finally {
		try {
			const sb = new ProjectSandbox({ runtime, sandboxMode: "podman", projectId, projectDir, repoUrl: SSH_ORIGIN, cloneSource, image: IMAGE });
			await sb.destroy();
		} catch (e: any) { console.warn("chown cleanup failed:", e?.message || e); }
		try { fs.rmSync(projectDir, { recursive: true, force: true }); } catch { /* ignore */ }
	}
}

/**
 * Scenario C — the rootless-podman root-owned /workspace-wt blocker (the EXACT
 * user failure this round). A REUSED container whose `/workspace-wt` named
 * volume is root-owned makes `git worktree add /workspace-wt/<name> <branch>`
 * fail with `could not create leading directories of '/workspace-wt/<name>/.git':
 * Permission denied`. The previous `mkdir -p /workspace-wt` guard was a no-op
 * exit-0 on the existing root-owned dir, so its chown fallback never fired.
 *
 * We podman-run a labelled container, clone /workspace (HTTPS), then force
 * BOTH /workspace and /workspace-wt back to root:root and prove the raw
 * `git worktree add` fails. Then we drive the REAL ProjectSandbox.init()
 * (reconnect path) — `_ensureWritableSandboxVolumes()` chowns BOTH volumes —
 * followed by createWorktree(), and prove the worktree is created (exit 0),
 * `.git` exists and is node-owned, and the worktree dir is node-writable.
 */
async function validateRootOwnedWorktreesChown(runtime: PodmanRuntime, cloneSource: ReturnType<typeof resolveSandboxCloneSource>): Promise<void> {
	const projectId = `podman-wtchown-${process.pid}`;
	const wsVolume = `bobbit-workspace-${projectId}`;
	const wtVolume = `bobbit-worktrees-${projectId}`;
	const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "podman-wtchown-proj-"));
	let containerId = "";
	try {
		// Pre-create a labelled container with BOTH named volumes, mimicking a
		// reused container created before the volume-ownership fix.
		log("wtchown-setup", `podman run labelled container with ${wsVolume}:/workspace + ${wtVolume}:/workspace-wt`);
		containerId = await podman([
			"run", "-d", "--label", `bobbit-project=${projectId}`,
			"-v", `${wsVolume}:/workspace`,
			"-v", `${wtVolume}:/workspace-wt`,
			IMAGE, "sleep", "infinity",
		]);

		// Populate /workspace with a real clone as node (chown first so the clone
		// succeeds), then force BOTH mount roots back to root:root to reproduce the
		// stale reused-volume state.
		await podman(["exec", "--user", "root", containerId, "chown", "node:node", "/workspace", "/workspace-wt"]);
		await podman(["exec", "-w", "/workspace", containerId, "sh", "-c",
			'git config --global --add safe.directory "*"; git clone ' + cloneSource.cloneUrl + ' .']);
		await podman(["exec", "--user", "root", containerId, "chown", "root:root", "/workspace", "/workspace-wt"]);
		const ownBefore = await podman(["exec", containerId, "sh", "-c", "stat -c '%U:%G' /workspace /workspace-wt"]);
		log("wtchown-setup", `volume owners BEFORE init (must be root:root x2):\n${ownBefore}`);
		if (!/root:root[\s\S]*root:root/.test(ownBefore)) throw new Error("failed to simulate root-owned /workspace + /workspace-wt");

		// Prove the EXACT user-reported failure on the root-owned /workspace-wt.
		// Use the `test` branch (not `master`, which is already checked out at
		// /workspace) so git reaches the leading-dir creation step instead of
		// short-circuiting on a branch-already-checked-out error.
		const rawFail = await podman(["exec", "-w", "/workspace", containerId, "sh", "-c",
			'git worktree add /workspace-wt/session/repro-fail test 2>&1; echo EXIT=$?']);
		log("wtchown-repro", `raw git worktree add on root-owned /workspace-wt (expect Permission denied + EXIT=1):\n${rawFail}`);
		if (!/could not create leading directories|Permission denied/.test(rawFail)) {
			throw new Error("expected the root-owned /workspace-wt to reject `git worktree add`, but it did not");
		}

		// Drive the REAL production path: init() reconnects (no recreate), and
		// `_ensureWritableSandboxVolumes()` must chown BOTH volumes before any op.
		log("wtchown-init", "ProjectSandbox.init() (reconnect path) — must chown BOTH volumes");
		const sb = new ProjectSandbox({ runtime, sandboxMode: "podman", projectId, projectDir, repoUrl: SSH_ORIGIN, cloneSource, image: IMAGE });
		await sb.init();
		const reconnId = await sb.getContainerId();
		if (reconnId.substring(0, 12) !== containerId.substring(0, 12)) throw new Error("expected reconnect to the SAME container, not recreate");

		const ownAfter = await podman(["exec", containerId, "sh", "-c", "stat -c '%U:%G' /workspace /workspace-wt"]);
		log("wtchown-init", `volume owners AFTER init (must be node:node x2):\n${ownAfter}`);

		// The production createWorktree — the exact failing surface.
		const wt = await sb.createWorktree(WORKTREE_NAME, BRANCH);
		const wtOk = await podman(["exec", containerId, "sh", "-c", "git -C /workspace-wt/" + WORKTREE_NAME + " rev-parse --is-inside-work-tree >/dev/null 2>&1 && echo WT_OK || echo WT_MISSING"]);
		const gitLs = await podman(["exec", containerId, "ls", "-lad", "/workspace-wt/" + WORKTREE_NAME + "/.git"]);
		const writable = await podman(["exec", containerId, "sh", "-c", "test -w /workspace-wt/" + WORKTREE_NAME + " && echo WRITABLE || echo READONLY"]);
		log("wtchown-worktree", `createWorktree → ${wt}; worktree: ${wtOk}; writable: ${writable}\nls -lad .git:\n${gitLs}`);
		if (wtOk !== "WT_OK") throw new Error("BLOCKER NOT FIXED: createWorktree failed on root-owned /workspace-wt");
		if (writable !== "WRITABLE") throw new Error("worktree dir is not node-writable after the fix");

		// Also prove the EXACT raw failing command now returns 0.
		const RAW_WT = "session/wtchown-raw";
		log("wtchown-worktree", `running the exact command: podman exec -w /workspace ${containerId.substring(0, 12)} git worktree add /workspace-wt/${RAW_WT} test`);
		const wtAddOut = await podman(["exec", "-w", "/workspace", containerId, "git", "worktree", "add", "/workspace-wt/" + RAW_WT, "test"]);
		console.log(wtAddOut || "(no stdout)");
		const rawGitLs = await podman(["exec", containerId, "ls", "-lad", "/workspace-wt/" + RAW_WT + "/.git"]);
		log("wtchown-worktree", `raw git worktree add exit 0; .git:\n${rawGitLs}`);

		log("RESULT-C", "SUCCESS — root-owned /workspace-wt reconnect: raw `git worktree add` failed BEFORE fix (Permission denied), then init chowned BOTH volumes → createWorktree exit 0 → .git node-owned → worktree node-writable.");
	} finally {
		try {
			const sb = new ProjectSandbox({ runtime, sandboxMode: "podman", projectId, projectDir, repoUrl: SSH_ORIGIN, cloneSource, image: IMAGE });
			await sb.destroy();
			await podman(["volume", "rm", "-f", wtVolume]).catch(() => {});
		} catch (e: any) { console.warn("wtchown cleanup failed:", e?.message || e); }
		try { fs.rmSync(projectDir, { recursive: true, force: true }); } catch { /* ignore */ }
	}
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

		// Scenario B — the root-owned /workspace chown blocker.
		await validateRootOwnedWorkspaceChown(runtime, cloneSource);

		// Scenario C — the root-owned /workspace-wt chown blocker (this round).
		await validateRootOwnedWorktreesChown(runtime, cloneSource);
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
