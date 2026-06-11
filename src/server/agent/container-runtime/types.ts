/**
 * Container-runtime abstraction — provider interface.
 *
 * One interface (`ContainerRuntime`) abstracts every container interaction the
 * sandbox subsystem performs. Two implementations (`DockerRuntime`,
 * `PodmanRuntime`) own all binary-name, argument, and template differences so
 * no call site branches on the runtime.
 *
 * See docs/design/sandbox-runtime-abstraction.md §3.
 */

/** Identifies the provider; also the value of the `sandbox_runtime` config key. */
export type RuntimeId = "docker" | "podman";

/** One-shot exec result. */
export interface ExecResult {
	stdout: string;
	stderr: string;
}

export interface ExecOpts {
	/** Container working directory — maps to `-w`. */
	cwd?: string;
	/** Run as a specific user — maps to `-u` (e.g. "root"). */
	user?: string;
	/** Env vars injected into the exec — maps to `-e KEY=VAL`. */
	env?: Record<string, string>;
	/** Keep STDIN open — maps to `-i`. */
	interactive?: boolean;
	/** One-shot exec timeout in ms (ignored by `buildExecCommand`). */
	timeoutMs?: number;
	/** Max stdout/stderr buffer for one-shot `exec` (bytes). */
	maxBuffer?: number;
}

/** A single bind/volume mount for a long-lived container. */
export interface VolumeMount {
	/** Host path (bind mount) or named volume (e.g. `bobbit-workspace-<id>`). */
	hostPathOrVolume: string;
	/** Container-internal mount target. */
	containerPath: string;
	/** Mount read-only (`:ro`). */
	readonly?: boolean;
	/**
	 * Eligible for SELinux relabel under runtimes that need it (Podman `:z`/`:Z`).
	 * Set true for host bind mounts; leave false/undefined for named volumes.
	 * Docker ignores this flag entirely.
	 */
	relabel?: boolean;
}

/**
 * Fully-resolved spec for a long-lived sandbox container (was DockerRunConfig).
 *
 * Note on `addHosts`: the magic value `"host-gateway"` denotes the host-gateway
 * mapping. Each runtime emits its own host-gateway flag(s) for those entries
 * (Docker `host.docker.internal`, Podman `host.containers.internal`). Entries
 * with literal IP values (metadata black-holes) are emitted verbatim by every
 * runtime.
 */
export interface ContainerRunSpec {
	image: string;
	name?: string;
	labels?: Record<string, string>;
	volumes?: VolumeMount[];
	env?: Record<string, string>;
	network?: string;
	/** logical host → ip (or `"host-gateway"`); runtime maps to its flag. */
	addHosts?: Record<string, string>;
	resources?: { cpus?: string; memory?: string; pids?: string };
	restart?: "no" | "unless-stopped";
	/** Default ["sleep", "infinity"] is the caller's responsibility to set. */
	command?: string[];
}

export interface BuildSpec {
	image: string;
	/** Build context directory, e.g. "docker/". */
	contextDir: string;
	buildArgs?: Record<string, string>;
	/** Working directory the build runs from (the project dir). */
	cwd?: string;
	timeoutMs?: number;
}

/** Pure argv builder result for streaming/long-lived exec callers. */
export interface ExecCommand {
	file: string;
	args: string[];
	env: NodeJS.ProcessEnv;
}

/**
 * Everything the sandbox subsystem needs from a container CLI. Implementations
 * own all binary-name, argument, and template differences. No caller branches
 * on the runtime.
 */
export interface ContainerRuntime {
	readonly id: RuntimeId;
	/** The spawned binary name (e.g. "docker", "podman"). */
	readonly bin: string;

	// ── Diagnostics ────────────────────────────────────────────────
	/** Engine version string. Throws if the runtime is unavailable. */
	getVersion(): Promise<string>;
	/** Daemon-reported CPU/mem, or null if unavailable (caller falls back to host). */
	getResourceLimits(): Promise<{ cpus: number; memBytes: number } | null>;

	// ── Images ─────────────────────────────────────────────────────
	buildImage(spec: BuildSpec): Promise<void>;
	imageExists(image: string): Promise<boolean>;
	getImageLabel(image: string, label: string): Promise<string | null>;

	// ── Container lifecycle ────────────────────────────────────────
	createContainer(spec: ContainerRunSpec): Promise<string /* containerId */>;
	findContainerByLabel(label: string): Promise<string | null>;
	isRunning(containerId: string): Promise<boolean>;
	getContainerImageId(containerId: string): Promise<string | null>;
	/** Resolve the content id (`.Id`) of an image tag, or null if uninspectable. */
	getImageId(image: string): Promise<string | null>;
	startContainer(containerId: string, opts?: { timeoutMs?: number }): Promise<void>;
	stopContainer(containerId: string, opts?: { timeoutMs?: number }): Promise<void>;
	removeContainer(containerId: string, opts?: { force?: boolean; timeoutMs?: number }): Promise<void>;

	// ── Exec (two modes) ───────────────────────────────────────────
	/** One-shot, captures output. Used by the bulk of operations. */
	exec(containerId: string, argv: string[], opts?: ExecOpts): Promise<ExecResult>;
	/**
	 * Build the argv for a streaming/long-lived exec WITHOUT spawning. Callers
	 * that need a live ChildProcess (rpc-bridge agent process, bg-process,
	 * verification-harness via spawnTracked) own the spawn + stdio + kill-tree.
	 * Returns the binary, args, and env so the caller's spawn stays identical
	 * across runtimes.
	 */
	buildExecCommand(containerId: string, argv: string[], opts?: ExecOpts): ExecCommand;

	// ── Files ──────────────────────────────────────────────────────
	copyToContainer(containerId: string, hostSrc: string, containerDest: string): Promise<void>;

	// ── Volumes & networks ─────────────────────────────────────────
	removeVolume(name: string, opts?: { force?: boolean }): Promise<void>;
	createNetwork(name: string, opts?: { driver?: string; internal?: boolean }): Promise<void>;
	removeNetwork(name: string): Promise<void>;
}
