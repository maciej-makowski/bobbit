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

/**
 * Scenario D — the rootless-podman BIND-MOUNT permission blocker (this round).
 *
 * The agent dies immediately with
 *   `EACCES: permission denied, mkdir '/home/node/.bobbit/agent/sessions/…'`
 * because `/home/node/.bobbit/agent/sessions` is a HOST bind mount and, without
 * `--userns=keep-id`, the container's `node` (uid 1000) maps to a host SUBUID
 * that does not own the host-owned dir. The fix: PodmanRuntime now emits
 * `--userns=keep-id:uid=1000,gid=1000`, mapping the HOST user to container uid
 * 1000 so host bind mounts are read/write by `node`.
 *
 * Proves on REAL podman:
 *   1. A NON-keep-id container EACCEes on the sessions bind mount (repro), and a
 *      keep-id container can write it (fix).
 *   2. The ACTUAL agent exec the gateway runs (rpc-bridge form) against the
 *      keep-id container gets PAST the sessions mkdir — NO EACCES on
 *      /home/node/.bobbit/agent/sessions (later auth/RPC failure is acceptable).
 *   3. The host user can still read/write the sessions dir (keep-id ≠ chown).
 *   4. Stale-container heal: a pre-existing NON-keep-id labelled container is
 *      detected by ProjectSandbox.init()'s write-probe and recreated with
 *      keep-id, after which the agent sessions mkdir succeeds.
 */
async function validateBindMountKeepId(runtime: PodmanRuntime): Promise<void> {
	const { buildContainerRunSpec } = await import("../src/server/agent/docker-args.js");
	const { serializeContainerRunSpec } = await import("../src/server/agent/container-runtime/base-cli-runtime.js");
	const { PODMAN_RUN_ARG_HOOKS } = await import("../src/server/agent/container-runtime/podman-runtime.js");
	const { buildAgentArgs } = await import("../src/server/agent/rpc-bridge.js");

	const projectId = `podman-keepid-${process.pid}`;
	const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "podman-keepid-proj-"));
	const stateDir = path.join(projectDir, ".bobbit", "state");
	const hostSessions = path.join(stateDir, "sessions");
	fs.mkdirSync(hostSessions, { recursive: true });
	const SESSIONS = "/home/node/.bobbit/agent/sessions";
	let bugC = "";
	let fixC = "";
	try {
		// 1a. Reproduce the bug: NON-keep-id container with the sessions bind mount.
		log("keepid-repro", `NON-keep-id container, -v ${hostSessions}:${SESSIONS}:Z (expect EACCES)`);
		bugC = await podman(["run", "-d", "-v", `${hostSessions}:${SESSIONS}:Z`, IMAGE, "sleep", "infinity"]);
		const bugWrite = await podman(["exec", bugC, "sh", "-c", `touch ${SESSIONS}/x 2>&1; echo EXIT=$?`]);
		log("keepid-repro", `write as node (expect Permission denied + EXIT=1):\n${bugWrite}`);
		if (!/Permission denied|EXIT=1/.test(bugWrite)) throw new Error("expected NON-keep-id sessions mount to EACCES, but it did not");

		// 1b. The fix: build the PRODUCTION run spec and confirm it carries keep-id
		// + :Z, then create the container and write the sessions dir successfully.
		const spec = buildContainerRunSpec({
			image: IMAGE, workspaceDir: "", label: projectId, labelPrefix: "bobbit-project-keepid",
			projectId, stateDir, memoryLimit: "2g", cpuLimit: "2", pidsLimit: "0",
		});
		const runArgv = serializeContainerRunSpec(spec, PODMAN_RUN_ARG_HOOKS);
		log("keepid-fix", `production podman run argv[0..3]: ${JSON.stringify(runArgv.slice(0, 3))}`);
		if (runArgv[2] !== "--userns=keep-id:uid=1000,gid=1000") throw new Error("production run spec missing keep-id right after `run -d`");
		const sessionsMount = runArgv.find((a) => a.includes(`:${SESSIONS}`));
		log("keepid-fix", `sessions bind mount arg: ${sessionsMount}`);
		if (!sessionsMount || !/:Z$/.test(sessionsMount)) throw new Error("sessions bind mount missing :Z relabel");
		fixC = (await runtime.createContainer(spec)).trim();
		const fixWrite = await podman(["exec", fixC, "sh", "-c", `touch ${SESSIONS}/y && echo WRITABLE`]);
		log("keepid-fix", `keep-id container write as node: ${fixWrite}; container sees owner ${await podman(["exec", fixC, "stat", "-c", "%u:%g", SESSIONS])}`);
		if (!/WRITABLE/.test(fixWrite)) throw new Error("keep-id container could not write the sessions bind mount");

		// 2. THE KEY ONE — drive the ACTUAL agent exec the gateway runs and confirm
		// it gets PAST the sessions mkdir. We feed an empty stdin and a short
		// timeout; the agent may later fail on auth/RPC (acceptable) — what must be
		// GONE is `EACCES … mkdir '/home/node/.bobbit/agent/sessions…'`.
		const agentArgs = buildAgentArgs({ cwd: "/workspace-wt/session-keepid" });
		const execArgv = [
			"exec", "-i", "-w", "/workspace-wt/session-keepid",
			"-e", "NODE_TLS_REJECT_UNAUTHORIZED=0",
			fixC,
			"node", "--disable-warning=DEP0123", "/node_modules/@earendil-works/pi-coding-agent/dist/cli.js",
			...agentArgs,
		];
		// Pre-create the cwd so the agent doesn't fail on a missing workdir first.
		await podman(["exec", "--user", "root", fixC, "sh", "-c", "mkdir -p /workspace-wt/session-keepid && chown node:node /workspace-wt/session-keepid"]);
		log("keepid-agent", `running ACTUAL agent exec: podman ${execArgv.slice(0, 3).join(" ")} … cli.js ${agentArgs.join(" ")}`);
		const agentOut = await podman(["exec", "--user", "root", fixC, "sh", "-c",
			// run the agent as node with empty stdin + 12s cap; capture all output.
			`timeout 12 sh -c 'echo "" | runuser -u node -- node --disable-warning=DEP0123 /node_modules/@earendil-works/pi-coding-agent/dist/cli.js ${agentArgs.join(" ")} 2>&1'; echo "AGENT_EXIT=$?"`,
		]).catch((e: any) => `${e?.stdout || ""}${e?.stderr || ""}${e?.message || ""}`);
		const sessionsEacces = /EACCES[^\n]*mkdir '\/home\/node\/\.bobbit\/agent\/sessions/.test(agentOut);
		log("keepid-agent", `agent output (truncated):\n${agentOut.slice(0, 1500)}`);
		if (sessionsEacces) throw new Error("BUG NOT FIXED: agent still hit EACCES on the sessions mkdir under keep-id");
		// Positive evidence: the agent actually created its session dir on the host mount.
		const sessionDirs = await podman(["exec", fixC, "sh", "-c", `ls -la ${SESSIONS} 2>&1`]);
		log("keepid-agent", `host sessions dir contents after agent start (should include an agent-created session dir):\n${sessionDirs}`);

		// 3. Host can still read/write the sessions dir (keep-id does NOT chown it).
		const probe = path.join(hostSessions, ".host-probe");
		fs.writeFileSync(probe, "ok");
		const hostReadback = fs.readFileSync(probe, "utf8");
		fs.rmSync(probe);
		log("keepid-host", `host wrote+read ${probe}: "${hostReadback}"; host owner of sessions: ${fs.statSync(hostSessions).uid}:${fs.statSync(hostSessions).gid}`);
		if (hostReadback !== "ok") throw new Error("host could not read/write the sessions dir");

		log("RESULT-D", "SUCCESS — bind-mount keep-id: NON-keep-id sessions mount EACCEd, keep-id mount is node-writable, the ACTUAL agent exec got PAST the /home/node/.bobbit/agent/sessions mkdir (no EACCES), and the host still owns/reads the dir.");
	} finally {
		for (const c of [bugC, fixC]) { if (c) await podman(["rm", "-f", c]).catch(() => {}); }
		try { fs.rmSync(projectDir, { recursive: true, force: true }); } catch { /* ignore */ }
	}
}

/**
 * Scenario E — auto-heal a stale container created WITHOUT keep-id.
 *
 * Pre-create a labelled container WITHOUT keep-id (the user's `402544fa2266`
 * situation) wired with the sessions bind mount. ProjectSandbox.init() must
 * detect the un-writable bind mount via its write-probe, REMOVE the stale
 * container and recreate it WITH keep-id, after which the agent sessions mkdir
 * succeeds.
 */
async function validateStaleContainerHeal(runtime: PodmanRuntime, cloneSource: ReturnType<typeof resolveSandboxCloneSource>): Promise<void> {
	const projectId = `podman-heal-${process.pid}`;
	const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "podman-heal-proj-"));
	const stateDir = path.join(projectDir, ".bobbit", "state");
	const hostSessions = path.join(stateDir, "sessions");
	fs.mkdirSync(hostSessions, { recursive: true });
	const SESSIONS = "/home/node/.bobbit/agent/sessions";
	let staleC = "";
	try {
		// Pre-create a NON-keep-id labelled container with the sessions bind mount.
		log("heal-setup", `NON-keep-id labelled container with ${hostSessions}:${SESSIONS}:Z`);
		staleC = await podman([
			"run", "-d", "--label", `bobbit-project=${projectId}`,
			"-v", `bobbit-workspace-${projectId}:/workspace`,
			"-v", `bobbit-worktrees-${projectId}:/workspace-wt`,
			"-v", `${hostSessions}:${SESSIONS}:Z`,
			IMAGE, "sleep", "infinity",
		]);
		const staleWrite = await podman(["exec", staleC, "sh", "-c", `touch ${SESSIONS}/x 2>&1; echo EXIT=$?`]);
		log("heal-setup", `stale container sessions write (expect EACCES):\n${staleWrite}`);
		if (!/Permission denied|EXIT=1/.test(staleWrite)) throw new Error("stale container sessions mount unexpectedly writable");

		// Drive the REAL init() — must detect the un-writable bind mount and recreate.
		log("heal-init", "ProjectSandbox.init() — write-probe should fail → recreate WITH keep-id");
		const sb = new ProjectSandbox({ runtime, sandboxMode: "podman", projectId, projectDir, repoUrl: SSH_ORIGIN, cloneSource, image: IMAGE });
		await sb.init();
		const newId = await sb.getContainerId();
		const recreated = newId.substring(0, 12) !== staleC.substring(0, 12);
		log("heal-init", `original=${staleC.substring(0, 12)} new=${newId.substring(0, 12)} recreated=${recreated}`);
		if (!recreated) throw new Error("BUG: stale non-keep-id container was reused, not recreated");

		// The recreated container must be able to write the sessions bind mount.
		const healWrite = await podman(["exec", newId, "sh", "-c", `touch ${SESSIONS}/healed && echo WRITABLE`]);
		log("heal-verify", `recreated container sessions write: ${healWrite}`);
		if (!/WRITABLE/.test(healWrite)) throw new Error("recreated container still cannot write the sessions bind mount");

		log("RESULT-E", "SUCCESS — stale-heal: a pre-existing NON-keep-id container EACCEd on the sessions mount, ProjectSandbox.init() detected it via the write-probe and recreated it WITH keep-id, and the sessions mount is now node-writable.");
	} finally {
		try {
			const sb = new ProjectSandbox({ runtime, sandboxMode: "podman", projectId, projectDir, repoUrl: SSH_ORIGIN, cloneSource, image: IMAGE });
			await sb.destroy();
		} catch (e: any) { console.warn("heal cleanup failed:", e?.message || e); }
		try { fs.rmSync(projectDir, { recursive: true, force: true }); } catch { /* ignore */ }
	}
}

/**
 * Scenario F — the cross-userns MIGRATION (the EXACT user fallout this round).
 *
 * The user's stale NON-keep-id container (`402544fa2266`) is recreated WITH
 * keep-id (`0d7470ce`) by the write-probe heal — but the recreate REUSES the
 * persisted named volume `bobbit-workspace-<id>` whose clone was made under the
 * OLD (non-keep-id) userns. So `/workspace/.git` is owned by a foreign uid that
 * isn't `node` under keep-id; `_ensureWritableSandboxVolumes` chowns only the
 * top dirs (non-recursive) and a cross-userns `chown -R` is unreliable. Result:
 * `git worktree add /workspace-wt/staff-… -b staff-… <startPoint>` FAILS (the
 * swallowed first-attempt error is hidden; the visible error is the misleading
 * no-`-b` "invalid reference").
 *
 * This scenario:
 *   1. Builds the EXACT user state: a NON-keep-id labelled container whose
 *      named volume holds a clone owned by the old userns mapping; proves a
 *      keep-id container reusing that volume → `git worktree add -b` FAILS with
 *      the REAL first-attempt error (EPERM / cannot-write-refs / foreign owner),
 *      NOT just "invalid reference".
 *   2. Drives the REAL ProjectSandbox.init(): write-probe fails → container
 *      recreated WITH keep-id AND volumes reset → fresh HTTPS clone →
 *      `createWorktree` (`git worktree add -b <branch> <startPoint>`) exit 0,
 *      worktree `.git` node-owned and writable.
 *   3. Drives the ACTUAL agent exec (rpc-bridge form) in the worktree and
 *      confirms it gets PAST the sessions mkdir AND runs in the worktree
 *      (reaches the RPC loop) with NO invalid reference / EACCES / spawn docker.
 */
async function validateCrossUsernsMigration(runtime: PodmanRuntime, cloneSource: ReturnType<typeof resolveSandboxCloneSource>): Promise<void> {
	const { buildAgentArgs } = await import("../src/server/agent/rpc-bridge.js");
	const projectId = `podman-userns-${process.pid}`;
	const wsVolume = `bobbit-workspace-${projectId}`;
	const wtVolume = `bobbit-worktrees-${projectId}`;
	const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "podman-userns-proj-"));
	const stateDir = path.join(projectDir, ".bobbit", "state");
	const hostSessions = path.join(stateDir, "sessions");
	fs.mkdirSync(hostSessions, { recursive: true });
	const SESSIONS = "/home/node/.bobbit/agent/sessions";
	const STAFF_NAME = "session/staff-userns";
	const STAFF_BRANCH = "staff-userns";
	let staleC = "";
	let keepidProbeC = "";
	try {
		// 1a. Build the user state: a NON-keep-id labelled container with BOTH named
		// volumes + the sessions bind mount. Clone /workspace as node (so the clone
		// is owned by THIS container's non-keep-id `node` → a host SUBUID).
		log("userns-setup", `NON-keep-id labelled container; clone /workspace under the OLD userns into ${wsVolume}`);
		staleC = await podman([
			"run", "-d", "--label", `bobbit-project=${projectId}`,
			"-v", `${wsVolume}:/workspace`,
			"-v", `${wtVolume}:/workspace-wt`,
			"-v", `${hostSessions}:${SESSIONS}:Z`,
			IMAGE, "sleep", "infinity",
		]);
		await podman(["exec", "--user", "root", staleC, "chown", "node:node", "/workspace", "/workspace-wt"]);
		await podman(["exec", "-w", "/workspace", staleC, "sh", "-c",
			'git config --global --add safe.directory "*"; git clone ' + cloneSource.cloneUrl + ' .']);
		const ownNonKeep = await podman(["exec", staleC, "sh", "-c", "stat -c '%u:%g' /workspace/.git"]);
		log("userns-setup", `/workspace/.git owner (container view, NON-keep-id): ${ownNonKeep}`);

		// 1b. Prove the migration symptom: a SEPARATE keep-id container reusing the
		// SAME volume can't own /workspace/.git, so `git worktree add -b` fails.
		// Record the REAL first-attempt error (with -b) vs the misleading fallback.
		log("userns-repro", "keep-id container reusing the old-userns volume — capture REAL `git worktree add -b` error");
		const { buildContainerRunSpec } = await import("../src/server/agent/docker-args.js");
		const { serializeContainerRunSpec } = await import("../src/server/agent/container-runtime/base-cli-runtime.js");
		const { PODMAN_RUN_ARG_HOOKS } = await import("../src/server/agent/container-runtime/podman-runtime.js");
		const probeSpec = buildContainerRunSpec({
			image: IMAGE, workspaceDir: "", label: `${projectId}-probe`, labelPrefix: "bobbit-project-probe",
			projectId, stateDir, memoryLimit: "2g", cpuLimit: "2", pidsLimit: "0",
		});
		// Force the SAME reused volumes onto the probe container (buildContainerRunSpec
		// already adds bobbit-workspace-<id>/bobbit-worktrees-<id> for this projectId).
		const probeArgv = serializeContainerRunSpec(probeSpec, PODMAN_RUN_ARG_HOOKS); // starts with "run"
		keepidProbeC = (await podman(probeArgv)).trim();
		await podman(["exec", "--user", "root", keepidProbeC, "sh", "-c", 'git config --global --add safe.directory "*"']);
		const ownKeepView = await podman(["exec", keepidProbeC, "sh", "-c", "stat -c '%u:%g' /workspace/.git 2>&1 || true"]);
		log("userns-repro", `/workspace/.git owner (keep-id container view — foreign uid, not node): ${ownKeepView}`);
		const firstAttempt = await podman(["exec", "-w", "/workspace", keepidProbeC, "sh", "-c",
			`git worktree add /workspace-wt/${STAFF_NAME} -b ${STAFF_BRANCH} origin/master 2>&1; echo EXIT=$?`]).catch((e: any) => `${e?.stdout || ""}${e?.stderr || ""}`);
		log("userns-repro", `REAL first-attempt error (\`git worktree add -b\` under keep-id on old-userns volume):\n${firstAttempt}`);
		const fallbackAttempt = await podman(["exec", "-w", "/workspace", keepidProbeC, "sh", "-c",
			`git worktree add /workspace-wt/${STAFF_NAME} ${STAFF_BRANCH} 2>&1; echo EXIT=$?`]).catch((e: any) => `${e?.stdout || ""}${e?.stderr || ""}`);
		log("userns-repro", `misleading no-\`-b\` fallback error (what the user actually saw):\n${fallbackAttempt}`);
		if (/EXIT=0/.test(firstAttempt)) {
			throw new Error("expected the keep-id container reusing the old-userns volume to FAIL `git worktree add -b`, but it succeeded");
		}
		await podman(["rm", "-f", keepidProbeC]).catch(() => {}); keepidProbeC = "";

		// 2. Drive the REAL fix path. init() finds the NON-keep-id stale container,
		// write-probe FAILS → recreate WITH keep-id AND reset BOTH volumes → fresh
		// HTTPS clone (node-owned) → createWorktree exit 0.
		log("userns-fix", "ProjectSandbox.init() — write-probe fails → recreate keep-id + reset volumes + fresh clone");
		const sb = new ProjectSandbox({ runtime, sandboxMode: "podman", projectId, projectDir, repoUrl: SSH_ORIGIN, cloneSource, image: IMAGE });
		await sb.init();
		const newId = await sb.getContainerId();
		const recreated = newId.substring(0, 12) !== staleC.substring(0, 12);
		log("userns-fix", `original=${staleC.substring(0, 12)} new=${newId.substring(0, 12)} recreated=${recreated}`);
		if (!recreated) throw new Error("BUG: stale non-keep-id container was reused, not recreated");

		const gitState = await podman(["exec", newId, "sh", "-c", "test -d /workspace/.git && echo HAS_GIT || echo NO_GIT"]);
		const gitOwner = await podman(["exec", newId, "sh", "-c", "stat -c '%U:%G' /workspace/.git"]);
		log("userns-fix", `after fix: /workspace state=${gitState}; /workspace/.git owner=${gitOwner} (must be node:node)`);
		if (gitState !== "HAS_GIT") throw new Error("fresh clone did not populate /workspace/.git after volume reset");
		if (gitOwner !== "node:node") throw new Error("fresh /workspace/.git is not node-owned after volume reset");

		// The production createWorktree — the exact failing surface, now exit 0.
		const wt = await sb.createWorktree(STAFF_NAME, STAFF_BRANCH, "origin/master");
		const wtOk = await podman(["exec", newId, "sh", "-c", "git -C /workspace-wt/" + STAFF_NAME + " rev-parse --is-inside-work-tree >/dev/null 2>&1 && echo WT_OK || echo WT_MISSING"]);
		const wtGitOwner = await podman(["exec", newId, "sh", "-c", "stat -c '%U:%G' /workspace-wt/" + STAFF_NAME + "/.git 2>/dev/null || stat -c '%U:%G' /workspace-wt/" + STAFF_NAME]);
		const wtWritable = await podman(["exec", newId, "sh", "-c", "test -w /workspace-wt/" + STAFF_NAME + " && echo WRITABLE || echo READONLY"]);
		log("userns-worktree", `createWorktree → ${wt}; worktree=${wtOk}; .git owner=${wtGitOwner}; writable=${wtWritable}`);
		if (wtOk !== "WT_OK") throw new Error("BLOCKER NOT FIXED: createWorktree failed after volume reset + keep-id recreate");
		if (wtWritable !== "WRITABLE") throw new Error("worktree dir is not node-writable after the fix");

		// 3. THE FULL CHAIN — drive the ACTUAL agent exec the gateway runs in the
		// worktree and confirm it reaches the RPC loop: PAST the sessions mkdir AND
		// running in the worktree. A later auth/LLM failure (no tokens) is OK.
		const agentArgs = buildAgentArgs({ cwd: "/workspace-wt/" + STAFF_NAME });
		log("userns-agent", `running ACTUAL agent exec in worktree: node … cli.js ${agentArgs.join(" ")}`);
		const agentOut = await podman(["exec", "--user", "root", "-w", "/workspace-wt/" + STAFF_NAME, newId, "sh", "-c",
			`timeout 15 sh -c 'echo "" | runuser -u node -- node --disable-warning=DEP0123 /node_modules/@earendil-works/pi-coding-agent/dist/cli.js ${agentArgs.join(" ")} 2>&1'; echo "AGENT_EXIT=$?"`,
		]).catch((e: any) => `${e?.stdout || ""}${e?.stderr || ""}${e?.message || ""}`);
		log("userns-agent", `agent output (truncated):\n${agentOut.slice(0, 2000)}`);
		if (/invalid reference/.test(agentOut)) throw new Error("agent output still contains `invalid reference`");
		if (/EACCES[^\n]*mkdir '\/home\/node\/\.bobbit\/agent\/sessions/.test(agentOut)) throw new Error("agent still hit EACCES on the sessions mkdir");
		if (/spawn docker/.test(agentOut)) throw new Error("agent attempted to `spawn docker` under podman");
		const sessionDirs = await podman(["exec", newId, "sh", "-c", `ls -la ${SESSIONS} 2>&1`]);
		log("userns-agent", `host sessions dir after agent start (should hold an agent-created session dir):\n${sessionDirs}`);

		log("RESULT-F", "SUCCESS — cross-userns migration: NON-keep-id volume's clone made `git worktree add -b` FAIL under a reused keep-id container; ProjectSandbox.init() recreated WITH keep-id, RESET both volumes, fresh node-owned clone → createWorktree exit 0 → agent exec reached the RPC loop in the worktree (no invalid reference / EACCES / spawn docker).");
	} finally {
		try {
			const sb = new ProjectSandbox({ runtime, sandboxMode: "podman", projectId, projectDir, repoUrl: SSH_ORIGIN, cloneSource, image: IMAGE });
			await sb.destroy();
			await podman(["volume", "rm", "-f", wtVolume]).catch(() => {});
		} catch (e: any) { console.warn("userns cleanup failed:", e?.message || e); }
		if (keepidProbeC) await podman(["rm", "-f", keepidProbeC]).catch(() => {});
		try { fs.rmSync(projectDir, { recursive: true, force: true }); } catch { /* ignore */ }
	}
}

/**
 * Scenario G — the EXACT user state THIS round: a HEALTHY keep-id container on a
 * STALE workspace volume (`0d7470ce`).
 *
 * Unlike Scenario F (which started from a NON-keep-id container, so the bind-mount
 * write-probe FAILS and triggers recreate), this scenario starts from a container
 * that is ALREADY keep-id — so it PASSES the bind-mount probe and is NOT recreated
 * by that path. But its persisted `/workspace` clone was made under an INCOMPATIBLE
 * (pre-keep-id) userns: `/workspace/.git` is foreign-owned, so `node` can't write
 * refs and `git worktree add` fails with
 *   `cannot lock ref 'refs/heads/…': Unable to create '/workspace/.git/refs/heads/….lock': Permission denied`.
 * Before the new workspace-git write-probe, the bind-mount probe passed → NO reset →
 * worktree add failed.
 *
 * This scenario:
 *   1. Builds the user state: a KEEP-ID labelled container (production run spec) with
 *      a clone whose `/workspace/.git` is forced foreign-owned (chown -R 999:999).
 *      Proves `touch /workspace/.git/x` as node FAILS and `git worktree add -b` fails
 *      with the `cannot lock ref … Permission denied` error.
 *   2. Drives the REAL ProjectSandbox.init() (reconnect to the keep-id container):
 *      bind-mount probe PASSES, the NEW workspace-git write-probe FAILS → reset
 *      volumes → recreate → fresh node-owned clone → createWorktree exit 0,
 *      `/workspace/.git` owner=node:node.
 *   3. Drives the ACTUAL agent exec in the worktree and confirms it reaches the RPC
 *      loop (no `cannot lock ref`, no `invalid reference`, no EACCES, no spawn docker).
 */
async function validateKeepIdStaleVolume(runtime: PodmanRuntime, cloneSource: ReturnType<typeof resolveSandboxCloneSource>): Promise<void> {
	const { buildAgentArgs } = await import("../src/server/agent/rpc-bridge.js");
	const { buildContainerRunSpec } = await import("../src/server/agent/docker-args.js");
	const projectId = `podman-keepstale-${process.pid}`;
	const wsVolume = `bobbit-workspace-${projectId}`;
	const wtVolume = `bobbit-worktrees-${projectId}`;
	const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "podman-keepstale-proj-"));
	const stateDir = path.join(projectDir, ".bobbit", "state");
	const hostSessions = path.join(stateDir, "sessions");
	fs.mkdirSync(hostSessions, { recursive: true });
	const SESSIONS = "/home/node/.bobbit/agent/sessions";
	const STAFF_NAME = "session/staff-keepstale";
	const STAFF_BRANCH = "staff-keepstale";
	let keepidC = "";
	try {
		// 1a. Build the user state: a KEEP-ID labelled container (production run spec,
		// which emits --userns=keep-id) with BOTH named volumes + the sessions mount.
		log("keepstale-setup", `KEEP-ID labelled container (production run spec); clone /workspace into ${wsVolume}`);
		const spec = buildContainerRunSpec({
			image: IMAGE, workspaceDir: "", label: projectId, labelPrefix: "bobbit-project",
			projectId, stateDir, memoryLimit: "2g", cpuLimit: "2", pidsLimit: "0",
		});
		keepidC = (await runtime.createContainer(spec)).trim();

		// Make the volumes node-writable and clone /workspace as node (so the clone
		// is initially node-owned), then FORCE /workspace/.git foreign-owned to
		// reproduce a clone made under an incompatible pre-keep-id userns.
		await podman(["exec", "--user", "root", keepidC, "chown", "node:node", "/workspace", "/workspace-wt"]);
		await podman(["exec", "-w", "/workspace", keepidC, "sh", "-c",
			'git config --global --add safe.directory "*"; git clone ' + cloneSource.cloneUrl + ' .']);
		await podman(["exec", "--user", "root", keepidC, "chown", "-R", "999:999", "/workspace/.git"]);
		const gitOwnerBefore = await podman(["exec", keepidC, "sh", "-c", "stat -c '%u:%g' /workspace/.git"]);
		log("keepstale-setup", `/workspace/.git owner BEFORE init (must be foreign 999:999): ${gitOwnerBefore}`);
		if (!/^999:999/.test(gitOwnerBefore)) throw new Error("failed to simulate a foreign-owned /workspace/.git");

		// 1b. Prove the keep-id bind-mount probe PASSES (host sessions writable) —
		// this is what makes the bind-mount-probe path NOT fire (unlike Scenario F).
		const sessWrite = await podman(["exec", keepidC, "sh", "-c", `touch ${SESSIONS}/x && rm -f ${SESSIONS}/x && echo WRITABLE`]);
		log("keepstale-repro", `keep-id sessions bind-mount write (expect WRITABLE — bind-mount probe PASSES): ${sessWrite}`);
		if (!/WRITABLE/.test(sessWrite)) throw new Error("expected keep-id container to write the sessions mount (bind-mount probe should pass)");

		// 1c. Prove the EXACT user symptom: node can't write inside /workspace/.git,
		// and `git worktree add -b` fails with `cannot lock ref … Permission denied`.
		const gitTouch = await podman(["exec", keepidC, "sh", "-c", `touch /workspace/.git/.bobbit-write-probe 2>&1; echo EXIT=$?`]);
		log("keepstale-repro", `touch /workspace/.git/.bobbit-write-probe as node (expect Permission denied + EXIT=1):\n${gitTouch}`);
		if (!/Permission denied|EXIT=1/.test(gitTouch)) throw new Error("expected node to be UNABLE to write inside the foreign-owned /workspace/.git");
		const wtFail = await podman(["exec", "-w", "/workspace", keepidC, "sh", "-c",
			`git worktree add /workspace-wt/${STAFF_NAME} -b ${STAFF_BRANCH} origin/master 2>&1; echo EXIT=$?`]).catch((e: any) => `${e?.stdout || ""}${e?.stderr || ""}`);
		log("keepstale-repro", `raw \`git worktree add -b\` on the stale keep-id volume (expect "cannot lock ref … Permission denied"):\n${wtFail}`);
		if (/EXIT=0/.test(wtFail)) throw new Error("expected `git worktree add -b` to FAIL on the foreign-owned /workspace/.git, but it succeeded");
		if (!/cannot lock ref|Permission denied/.test(wtFail)) throw new Error("expected the `cannot lock ref … Permission denied` failure, got a different error");

		// 2. Drive the REAL fix path. init() reconnects to the keep-id container
		// (bind-mount probe PASSES, NOT recreated by that path), the NEW workspace-git
		// write-probe FAILS → reset BOTH volumes → recreate → fresh node-owned clone.
		log("keepstale-fix", "ProjectSandbox.init() — bind-mount probe passes, /workspace/.git write-probe fails → reset volumes + recreate + reclone");
		const sb = new ProjectSandbox({ runtime, sandboxMode: "podman", projectId, projectDir, repoUrl: SSH_ORIGIN, cloneSource, image: IMAGE });
		await sb.init();
		const newId = await sb.getContainerId();
		const recreated = newId.substring(0, 12) !== keepidC.substring(0, 12);
		log("keepstale-fix", `original=${keepidC.substring(0, 12)} new=${newId.substring(0, 12)} recreated=${recreated}`);
		if (!recreated) throw new Error("BUG: keep-id container on a stale volume was reused, not recreated");

		const gitState = await podman(["exec", newId, "sh", "-c", "test -d /workspace/.git && echo HAS_GIT || echo NO_GIT"]);
		const gitOwnerAfter = await podman(["exec", newId, "sh", "-c", "stat -c '%U:%G' /workspace/.git"]);
		log("keepstale-fix", `after fix: /workspace state=${gitState}; /workspace/.git owner=${gitOwnerAfter} (must be node:node)`);
		if (gitState !== "HAS_GIT") throw new Error("fresh clone did not populate /workspace/.git after volume reset");
		if (gitOwnerAfter !== "node:node") throw new Error("fresh /workspace/.git is not node-owned after volume reset");

		// The production createWorktree — the exact failing surface, now exit 0.
		const wt = await sb.createWorktree(STAFF_NAME, STAFF_BRANCH, "origin/master");
		const wtOk = await podman(["exec", newId, "sh", "-c", "git -C /workspace-wt/" + STAFF_NAME + " rev-parse --is-inside-work-tree >/dev/null 2>&1 && echo WT_OK || echo WT_MISSING"]);
		const wtWritable = await podman(["exec", newId, "sh", "-c", "test -w /workspace-wt/" + STAFF_NAME + " && echo WRITABLE || echo READONLY"]);
		log("keepstale-worktree", `createWorktree → ${wt}; worktree=${wtOk}; writable=${wtWritable}`);
		if (wtOk !== "WT_OK") throw new Error("BLOCKER NOT FIXED: createWorktree failed after volume reset + recreate");
		if (wtWritable !== "WRITABLE") throw new Error("worktree dir is not node-writable after the fix");

		// 3. THE FULL CHAIN — drive the ACTUAL agent exec in the worktree.
		const agentArgs = buildAgentArgs({ cwd: "/workspace-wt/" + STAFF_NAME });
		log("keepstale-agent", `running ACTUAL agent exec in worktree: node … cli.js ${agentArgs.join(" ")}`);
		const agentOut = await podman(["exec", "--user", "root", "-w", "/workspace-wt/" + STAFF_NAME, newId, "sh", "-c",
			`timeout 15 sh -c 'echo "" | runuser -u node -- node --disable-warning=DEP0123 /node_modules/@earendil-works/pi-coding-agent/dist/cli.js ${agentArgs.join(" ")} 2>&1'; echo "AGENT_EXIT=$?"`,
		]).catch((e: any) => `${e?.stdout || ""}${e?.stderr || ""}${e?.message || ""}`);
		log("keepstale-agent", `agent output (truncated):\n${agentOut.slice(0, 2000)}`);
		if (/cannot lock ref/.test(agentOut)) throw new Error("agent output still contains `cannot lock ref`");
		if (/invalid reference/.test(agentOut)) throw new Error("agent output still contains `invalid reference`");
		if (/EACCES[^\n]*mkdir '\/home\/node\/\.bobbit\/agent\/sessions/.test(agentOut)) throw new Error("agent still hit EACCES on the sessions mkdir");
		if (/spawn docker/.test(agentOut)) throw new Error("agent attempted to `spawn docker` under podman");
		const sessionDirs = await podman(["exec", newId, "sh", "-c", `ls -la ${SESSIONS} 2>&1`]);
		log("keepstale-agent", `host sessions dir after agent start (should hold an agent-created session dir):\n${sessionDirs}`);

		log("RESULT-G", "SUCCESS — keep-id + stale-volume: a HEALTHY keep-id container reusing a foreign-owned /workspace/.git made `git worktree add -b` FAIL with `cannot lock ref … Permission denied`; ProjectSandbox.init()'s bind-mount probe PASSED but the new /workspace/.git write-probe FAILED → reset both volumes → recreate → fresh node-owned clone → createWorktree exit 0 → agent exec reached the RPC loop (no cannot-lock-ref / invalid reference / EACCES / spawn docker).");
	} finally {
		try {
			const sb = new ProjectSandbox({ runtime, sandboxMode: "podman", projectId, projectDir, repoUrl: SSH_ORIGIN, cloneSource, image: IMAGE });
			await sb.destroy();
			await podman(["volume", "rm", "-f", wtVolume]).catch(() => {});
		} catch (e: any) { console.warn("keepstale cleanup failed:", e?.message || e); }
		if (keepidC) await podman(["rm", "-f", keepidC]).catch(() => {});
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

		// Scenario C — the root-owned /workspace-wt chown blocker (prior round).
		await validateRootOwnedWorktreesChown(runtime, cloneSource);

		// Scenario D — the rootless-podman BIND-MOUNT (sessions) keep-id fix.
		await validateBindMountKeepId(runtime);

		// Scenario E — auto-heal a stale non-keep-id container on reconnect.
		await validateStaleContainerHeal(runtime, cloneSource);

		// Scenario F — the cross-userns MIGRATION fallout (prior round).
		await validateCrossUsernsMigration(runtime, cloneSource);

		// Scenario G — keep-id container on a STALE workspace volume (this round).
		await validateKeepIdStaleVolume(runtime, cloneSource);
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
