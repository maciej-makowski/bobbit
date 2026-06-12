/**
 * Docker argument builder for sandbox pool containers.
 *
 * Builds `docker run -d ... sleep infinity` args for detached containers
 * managed by the sandbox pool. All sandbox sessions use pool containers
 * (pre-warmed or created on-demand).
 *
 * Multi-repo layout (Phase 4a):
 *   - `bobbit-workspace-<projectId>` at `/workspace`: single-repo holds the
 *     repo at the volume root; multi-repo holds one subdir per declared
 *     repo (`/workspace/<repo>/`).
 *   - `bobbit-worktrees-<projectId>` at `/workspace-wt/`: single-repo lays
 *     out worktrees as `/workspace-wt/<branchSlug>/`; multi-repo lays them
 *     out as `/workspace-wt/<branchSlug>/<repo>/` side-by-side.
 *
 * Mount args are identical for both shapes — the volume is just a flat
 * filesystem and the layout differences live in the worktree-creation paths
 * (see `ProjectSandbox._runInitSequenceMultiRepo` and `createWorktreeSet`).
 * `toDockerPath` host-path rewriting is unchanged and works for both modes.
 * See docs/design/multi-repo-components.md §7.2.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { bobbitDir, globalAgentDir } from "../bobbit-dir.js";
import { resolveBuiltinPacksDir } from "./builtin-packs.js";
import { ensureSandboxAgentAuthFile } from "./host-tokens.js";
import { BUILTIN_PACKS_CONTAINER_DIR, toDockerPath } from "./rpc-bridge.js";
import { TOOLS_DIR } from "./tool-manager.js";
import { serializeContainerRunSpec } from "./container-runtime/base-cli-runtime.js";
import { DOCKER_RUN_ARG_HOOKS } from "./container-runtime/docker-runtime.js";
import type { ContainerRunSpec, VolumeMount } from "./container-runtime/types.js";
import type { PreferencesStore } from "./preferences-store.js";
import type { ToolManager } from "./tool-manager.js";

// ── Config ─────────────────────────────────────────────────────────────────

export interface DockerRunConfig {
	image: string;
	/** Host path to mount as /workspace (used for bind-mount mode when projectId is not set). */
	workspaceDir: string;

	// ── Labels ───────────────────────────────────────────────────────────
	/** Label value for the label prefix. */
	label?: string;
	/** Label version string (e.g. "2" for sandbox-pool). */
	labelVersion?: string;
	/** Label prefix — e.g. "bobbit-project" or "bobbit-sandbox". */
	labelPrefix?: string;
	/** Worktree path label for sandbox-pool containers. */
	worktreePath?: string;

	// ── Per-project container ────────────────────────────────────────────
	/** Project ID — when set, uses a named Docker volume instead of bind mount for /workspace. */
	projectId?: string;
	/** Host state directory — when set, bind-mounted to /bobbit-state for session logs. */
	stateDir?: string;
	/**
	 * Per-session preview mount (WP-A/F).
	 *
	 * - Per-session containers (sessionId set, projectId unset): the host
	 *   directory `<stateDir>/preview/<sessionId>` is bind-mounted at
	 *   `/bobbit/preview` so the agent can read back its own preview tree.
	 * - Per-project containers (projectId set): `<stateDir>/preview/` is
	 *   bind-mounted at `/bobbit/preview-root` so every session sharing the
	 *   long-lived container can resolve its own subtree by
	 *   `BOBBIT_SESSION_ID`.
	 *
	 * Note: the gateway runs the actual writes (via `mount.writeInline` /
	 * `mount.mountFile`) — the bind-mount mainly exists for symmetry, so
	 * tools that read back what they wrote see the same bytes the gateway
	 * just persisted. The agent never needs the host path; it always POSTs
	 * to `/api/preview/mount` (WP-D).
	 */
	sessionId?: string;

	// ── Resource limits ──────────────────────────────────────────────────
	/** Container memory limit (default: "32g"). */
	memoryLimit?: string;
	/** Container CPU limit (default: "12"). */
	cpuLimit?: string;
	/** Container PID limit (default: "512"). */
	pidsLimit?: string;

	// ── Sandbox config ───────────────────────────────────────────────────
	sandboxMounts?: string[];
	sandboxCredentials?: Record<string, string>;
	/** Docker network to attach the container to (e.g. "bobbit-sandbox-net"). */
	sandboxNetwork?: string;
	/** Tool manager for resolving builtin tools directory (optional — falls back to TOOLS_DIR only). */
	toolManager?: ToolManager;
	/** Whether sandbox policy permits mounting host OpenAI Codex auth into auth.json. */
	sandboxAgentAuthAllowed?: boolean;
	/** Preferences store used to include preference-backed OpenAI Codex credentials when policy allows. */
	sandboxAgentAuthPrefs?: PreferencesStore | null;
	/** Scope for the generated auth.json file; defaults to projectId when present. */
	sandboxAgentAuthScope?: string;

	/**
	 * Extra read-only bind mounts as `{ hostPath, mountPath }` pairs. Used for
	 * the remote-less sandbox clone source: the host repo is mounted read-only
	 * at a container-internal path so `git clone file://<mountPath>` works
	 * without ever passing a raw host path (or Windows drive letter) to git.
	 * Host paths are rewritten via `toDockerPath` for Docker Desktop on
	 * Windows/macOS.
	 */
	extraReadonlyMounts?: Array<{ hostPath: string; mountPath: string }>;
}

// ── Builder ────────────────────────────────────────────────────────────────

/**
 * Build a runtime-neutral {@link ContainerRunSpec} from a {@link DockerRunConfig}.
 *
 * This is the single source of truth for the long-lived sandbox container's
 * mounts/env/labels/resources. It performs all host-side prep (mkdir of bind
 * sources, `toDockerPath` rewriting, auth.json generation, git identity) and
 * emits a structured spec; the runtime serializes it to argv. Bind mounts are
 * tagged `relabel: true` so SELinux-aware runtimes (Podman) can relabel them;
 * named volumes are not.
 *
 * `buildDockerRunArgs` below is the Docker serialization of this spec and stays
 * byte-equivalent (as a multiset) to its historical output — pinned by
 * tests/container-runtime-run-args.test.ts.
 */
export function buildContainerRunSpec(config: DockerRunConfig): ContainerRunSpec {
	const {
		image, workspaceDir,
		label, labelVersion, labelPrefix, worktreePath,
		projectId, stateDir, sessionId,
		sandboxMounts, sandboxCredentials,
		sandboxNetwork,
		extraReadonlyMounts,
	} = config;

	const toolsDir = TOOLS_DIR;
	const builtinToolsDir = config.toolManager?.getBuiltinToolsDir();
	const builtinPacksDir = resolveBuiltinPacksDir();

	// ── Add-hosts: host-gateway (always) + cloud-metadata black-holes (network). ──
	// Insertion order matters: the serializer emits the `"host-gateway"` entry in
	// the resource block and the literal-IP entries after `--network`.
	const addHosts: Record<string, string> = { "host.docker.internal": "host-gateway" };
	if (sandboxNetwork) {
		addHosts["metadata.google.internal"] = "0.0.0.0";
		addHosts["metadata.internal"] = "0.0.0.0";
		addHosts["169.254.169.254"] = "0.0.0.0";
	}

	const labels: Record<string, string> = {};
	if (label && labelPrefix) {
		labels[labelPrefix] = label;
		if (labelVersion) labels[`${labelPrefix}-version`] = labelVersion;
		if (worktreePath) labels[`${labelPrefix}-wt`] = worktreePath;
	}

	const volumes: VolumeMount[] = [];
	const bind = (hostPathOrVolume: string, containerPath: string, readonly = false): void => {
		volumes.push({ hostPathOrVolume, containerPath, readonly, relabel: true });
	};

	// ── Bind mounts / volumes ──────────────────────────────────────────
	if (projectId) {
		// Per-project container: named volumes (survive container recreation) — no relabel.
		volumes.push({ hostPathOrVolume: `bobbit-workspace-${projectId}`, containerPath: "/workspace" });
		volumes.push({ hostPathOrVolume: `bobbit-worktrees-${projectId}`, containerPath: "/workspace-wt" });
	} else if (workspaceDir) {
		// Legacy pool mode: bind-mount host directory as /workspace
		bind(toDockerPath(workspaceDir), "/workspace");
	}
	// pi-coding-agent is baked into the image (avoids slow bind-mount I/O on
	// Docker Desktop). No node_modules mount needed.
	bind(toDockerPath(toolsDir), "/tools", true);

	if (builtinToolsDir && builtinToolsDir !== toolsDir) {
		bind(toDockerPath(builtinToolsDir), "/tools-builtin", true);
	}

	// Mount shipped first-party market packs so pack-owned bobbit-extension tools
	// (and any shared pack modules they import) resolve inside Docker sandboxes.
	try {
		if (fs.statSync(builtinPacksDir).isDirectory()) {
			bind(toDockerPath(builtinPacksDir), BUILTIN_PACKS_CONTAINER_DIR, true);
		}
	} catch {
		// Built-in pack dir is absent in source-only/dev test layouts before build:packs.
	}

	// ── Per-session preview mount (WP-A/F) ────────────────────────────
	if (stateDir && projectId) {
		const previewRoot = path.join(stateDir, "preview");
		fs.mkdirSync(previewRoot, { recursive: true });
		bind(toDockerPath(previewRoot), "/bobbit/preview-root");
	} else if (stateDir && sessionId) {
		const previewMount = path.join(stateDir, "preview", sessionId);
		fs.mkdirSync(previewMount, { recursive: true });
		bind(toDockerPath(previewMount), "/bobbit/preview");
	}

	// Bind ONLY specific state subdirectories — never the full state dir (which
	// contains the host gateway token, TLS keys, sessions.json, etc.)
	if (stateDir) {
		for (const sub of ["sessions", "tool-guard", "html-snapshots"]) {
			const hostPath = path.join(stateDir, sub);
			fs.mkdirSync(hostPath, { recursive: true });
			bind(toDockerPath(hostPath), `/bobbit-state/${sub}`);
		}
	}

	// Host agent sessions dir — mount ONLY sessions, not the full agent dir, to
	// keep auth.json credentials out of the sandbox.
	const hostAgentDir = globalAgentDir();
	const hostSessionsDir = path.join(hostAgentDir, "sessions");
	fs.mkdirSync(hostSessionsDir, { recursive: true });
	bind(toDockerPath(hostSessionsDir), "/home/node/.bobbit/agent/sessions");

	// Mount models.json (read-only) so the agent can discover available models.
	const hostModelsJson = path.join(hostAgentDir, "models.json");
	try {
		if (fs.statSync(hostModelsJson).isFile()) {
			bind(toDockerPath(hostModelsJson), "/home/node/.bobbit/agent/models.json", true);
		}
	} catch {
		// models.json doesn't exist — agent will rely on env vars for model discovery
	}

	// Mount a sandbox-scoped auth.json. When sandbox token policy does not allow
	// OpenAI/Codex credentials, the file is an empty non-secret object.
	const sandboxAuthJson = ensureSandboxAgentAuthFile({
		prefs: config.sandboxAgentAuthPrefs,
		includeCodexAuth: config.sandboxAgentAuthAllowed === true,
		scope: config.sandboxAgentAuthScope || projectId,
	});
	bind(toDockerPath(sandboxAuthJson), "/home/node/.bobbit/agent/auth.json", true);

	// Session prompts directory
	const sessionPromptsDir = path.join(bobbitDir(), "state", "session-prompts");
	fs.mkdirSync(sessionPromptsDir, { recursive: true });
	bind(toDockerPath(sessionPromptsDir), "/tmp/session-prompts");

	// Extra read-only bind mounts (e.g. remote-less sandbox clone source).
	if (extraReadonlyMounts) {
		for (const { hostPath, mountPath } of extraReadonlyMounts) {
			if (!hostPath || !mountPath) continue;
			bind(toDockerPath(hostPath), mountPath, true);
		}
	}

	// User-configured mounts (`host:container[:ro]`). Common forms map exactly;
	// the host segment is rewritten via toDockerPath and `:ro` becomes readonly.
	if (sandboxMounts) {
		for (const mount of sandboxMounts) {
			const parts = mount.split(":");
			if (parts.length >= 2) {
				bind(toDockerPath(parts[0]), parts[1], parts.slice(2).includes("ro"));
			}
		}
	}

	// ── Environment variables ──────────────────────────────────────────
	// NOTE: BOBBIT_GATEWAY_URL and BOBBIT_TOKEN are intentionally NOT set here.
	// PID 1 (sleep infinity) does not need them, and exposing them would leak
	// the gateway auth token via /proc/1/environ. The agent process receives
	// its scoped sandbox token via `<runtime> exec -e` in rpc-bridge.ts.
	const env: Record<string, string> = {
		NODE_TLS_REJECT_UNAUTHORIZED: "0",
		NODE_OPTIONS: "--no-warnings",
		PI_CODING_AGENT_DIR: "/home/node/.bobbit/agent",
	};

	// Propagate PI_OFFLINE so pi-coding-agent in the sandbox skips GitHub
	// fd/rg downloads when the host gateway detected no internet at startup.
	if (process.env.PI_OFFLINE && process.env.PI_OFFLINE !== "") {
		env.PI_OFFLINE = process.env.PI_OFFLINE;
	}

	// Sandbox credentials
	if (sandboxCredentials) {
		for (const [key, value] of Object.entries(sandboxCredentials)) {
			if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
				console.warn(`[docker-args] Skipping invalid credential key: ${key}`);
				continue;
			}
			env[key] = value;
		}
	}

	// ── Git identity ───────────────────────────────────────────────────
	// Inherit the host user's git identity so agents can commit without manual
	// `git config` setup. Uses env vars (highest priority in git).
	const gitIdentity = getHostGitIdentity();
	if (gitIdentity.name) {
		env.GIT_AUTHOR_NAME = gitIdentity.name;
		env.GIT_COMMITTER_NAME = gitIdentity.name;
	}
	if (gitIdentity.email) {
		env.GIT_AUTHOR_EMAIL = gitIdentity.email;
		env.GIT_COMMITTER_EMAIL = gitIdentity.email;
	}

	// ── MCP extensions ─────────────────────────────────────────────────
	const mcpExtDir = path.join(bobbitDir(), "state", "mcp-extensions");
	try {
		if (fs.statSync(mcpExtDir).isDirectory()) {
			bind(toDockerPath(mcpExtDir), "/mcp-extensions", true);
		}
	} catch {
		// MCP extensions dir doesn't exist — skip
	}

	return {
		image,
		labels: Object.keys(labels).length > 0 ? labels : undefined,
		volumes,
		env,
		network: sandboxNetwork,
		addHosts,
		resources: {
			memory: config.memoryLimit ?? "32g",
			cpus: config.cpuLimit ?? "12",
			pids: config.pidsLimit ?? "512",
		},
		restart: "unless-stopped",
		command: ["sleep", "infinity"],
	};
}

/**
 * Serialize the sandbox container spec to a Docker `run …` argv.
 *
 * Thin adapter over {@link buildContainerRunSpec} + the shared serializer with
 * Docker run-arg hooks. Output is a multiset-equivalent of the historical
 * hand-rolled builder (arg order among `-v`/`-e` may differ, which is
 * semantically irrelevant to `docker run`). Retained as the Docker pinning
 * reference and for the sandbox security tests.
 */
export function buildDockerRunArgs(config: DockerRunConfig): string[] {
	return serializeContainerRunSpec(buildContainerRunSpec(config), DOCKER_RUN_ARG_HOOKS);
}

// ── Helpers ────────────────────────────────────────────────────────────────

/** Cache the host git identity so we only shell out once per process. */
let _gitIdentityCache: { name: string; email: string } | undefined;

function getHostGitIdentity(): { name: string; email: string } {
	if (_gitIdentityCache) return _gitIdentityCache;
	const read = (key: string): string => {
		try {
			return execFileSync("git", ["config", "--global", key], {
				encoding: "utf-8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"],
			}).trim();
		} catch { return ""; }
	};
	_gitIdentityCache = { name: read("user.name"), email: read("user.email") };
	return _gitIdentityCache;
}
