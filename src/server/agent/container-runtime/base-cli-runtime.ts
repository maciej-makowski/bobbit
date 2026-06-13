/**
 * BaseCliRuntime — shared CLI logic for docker/podman-style runtimes.
 *
 * Holds everything that is identical across runtimes: the execFile wrapper with
 * the cpu-diagnostics instrumentation (ported from project-sandbox `execDocker`/
 * `dockerOperation`/`dockerChildLabel`), the MSYS env shim
 * (`MSYS_NO_PATHCONV`/`MSYS2_ARG_CONV_EXCL`), and all argument arrays that do
 * not vary by runtime (exec, cp, build, stop, start, rm, volume rm, network
 * create/rm, ps --filter, container/image inspect).
 *
 * The per-runtime differences are expressed as abstract members:
 *   - `id` / `bin`
 *   - `infoVersionFormat()` / `infoResourceFormat()`
 *   - `runArgHooks()` — host-gateway flag(s) + volume relabel options
 *   - `networkCreateExtraArgs()` — engine-specific `network create` opts
 *
 * Container/image `inspect` templates (`.State.Running`, `.Image`, `.Id`,
 * `Config.Labels`) are Docker-API-compatible in Podman, so they live here.
 *
 * See docs/design/sandbox-runtime-abstraction.md §4.
 */

import { execFile as execFileCb } from "node:child_process";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import { cpuDiagnosticsEnabled, getCpuDiagnostics } from "../cpu-diagnostics.js";
import type {
	BuildSpec,
	ContainerRunSpec,
	ContainerRuntime,
	ExecCommand,
	ExecOpts,
	ExecResult,
	RuntimeId,
	VolumeMount,
} from "./types.js";

const defaultExecFileAsync = promisify(execFileCb);

/**
 * Injectable execFile implementation. Production uses the promisified
 * node:child_process execFile; tests pass a fake that records `(file, args,
 * options)` and returns canned `{stdout, stderr}` so the contract/unit tests
 * run without a real docker/podman binary.
 */
export type ExecFileFn = (
	file: string,
	args: string[],
	options: { timeout?: number; env?: NodeJS.ProcessEnv; maxBuffer?: number; cwd?: string; windowsHide?: boolean } | undefined,
) => Promise<{ stdout: string; stderr: string }>;

/** Per-runtime hooks for the otherwise-shared `run` arg builder. */
export interface RunArgHooks {
	/** Args emitted for each `addHosts` entry whose value is `"host-gateway"`. */
	hostGatewayArgs(): string[];
	/** Extra `-v` options (beyond `ro`) for a bind mount — e.g. Podman `["Z"]`. */
	volumeOptions(mount: VolumeMount): string[];
}

/**
 * Serialize a {@link ContainerRunSpec} into a full `run …` argv (starting with
 * `"run"`). The skeleton order is fixed so a given runtime reproduces a stable
 * arg sequence; per-runtime differences are confined to `hooks`.
 *
 * Order: `run -d [--restart] [host-gateway add-hosts] [--memory] [--cpus]
 * [--pids-limit] [--network] [other add-hosts] [--label…] [--name] [-v…]
 * [-e…] <image> <command…>`.
 *
 * This is the single serializer used by both `DockerRuntime.createContainer`
 * and `docker-args.buildDockerRunArgs`; the latter pins Docker's output.
 */
export function serializeContainerRunSpec(spec: ContainerRunSpec, hooks: RunArgHooks): string[] {
	const args: string[] = ["run", "-d"];
	if (spec.restart) args.push(`--restart=${spec.restart}`);

	const addHosts = spec.addHosts ?? {};
	const gatewayEntries = Object.entries(addHosts).filter(([, v]) => v === "host-gateway");
	const literalHosts = Object.entries(addHosts).filter(([, v]) => v !== "host-gateway");

	if (gatewayEntries.length > 0) {
		args.push(...hooks.hostGatewayArgs());
	}

	if (spec.resources?.memory) args.push(`--memory=${spec.resources.memory}`);
	if (spec.resources?.cpus) args.push(`--cpus=${spec.resources.cpus}`);
	if (spec.resources?.pids && spec.resources.pids !== "0") args.push(`--pids-limit=${spec.resources.pids}`);

	if (spec.network) args.push(`--network=${spec.network}`);
	for (const [host, ip] of literalHosts) {
		args.push(`--add-host=${host}:${ip}`);
	}

	for (const [k, v] of Object.entries(spec.labels ?? {})) {
		args.push("--label", `${k}=${v}`);
	}

	if (spec.name) args.push("--name", spec.name);

	for (const mount of spec.volumes ?? []) {
		args.push("-v", formatVolume(mount, hooks));
	}

	for (const [k, v] of Object.entries(spec.env ?? {})) {
		args.push("-e", `${k}=${v}`);
	}

	args.push(spec.image, ...(spec.command ?? []));
	return args;
}

function formatVolume(mount: VolumeMount, hooks: RunArgHooks): string {
	const opts: string[] = [];
	if (mount.readonly) opts.push("ro");
	for (const extra of hooks.volumeOptions(mount)) opts.push(extra);
	const base = `${mount.hostPathOrVolume}:${mount.containerPath}`;
	return opts.length > 0 ? `${base}:${opts.join(",")}` : base;
}

function childErrorCode(err: unknown): string {
	const code = (err as { code?: unknown } | null)?.code;
	return typeof code === "string" || typeof code === "number" ? String(code) : "error";
}

export abstract class BaseCliRuntime implements ContainerRuntime {
	abstract readonly id: RuntimeId;
	abstract readonly bin: string;

	/** `info --format` template yielding the engine version string. */
	protected abstract infoVersionFormat(): string;
	/** `info --format` template yielding "<cpus> <memBytes>". */
	protected abstract infoResourceFormat(): string;
	/** Run-arg hooks for host-gateway flag + volume relabel. */
	protected abstract runArgHooks(): RunArgHooks;
	/** Engine-specific extra args for `network create` (after `--driver`). */
	protected networkCreateExtraArgs(): string[] {
		return [];
	}

	/**
	 * Default: no runtime-specific availability hint. Overridden by runtimes
	 * (e.g. Podman) that have common misconfiguration gotchas worth surfacing.
	 */
	availabilityHint(): string | undefined {
		return undefined;
	}

	private _resourceLimits: { cpus: number; memBytes: number } | null | undefined;
	protected readonly execFileFn: ExecFileFn;

	constructor(execFileFn?: ExecFileFn) {
		this.execFileFn = execFileFn
			?? ((file, args, options) => defaultExecFileAsync(file, args, options) as unknown as Promise<{ stdout: string; stderr: string }>);
	}

	/** Env config for runtime commands — suppresses MSYS path mangling on Windows. */
	protected runtimeEnv(extra?: Record<string, string>): NodeJS.ProcessEnv {
		return { ...process.env, MSYS_NO_PATHCONV: "1", MSYS2_ARG_CONV_EXCL: "*", ...(extra ?? {}) };
	}

	/** Operation label for cpu-diagnostics (runtime-agnostic). */
	private operation(args: readonly string[]): string {
		const cmd = args[0] || this.bin;
		if (cmd !== "exec") return cmd;
		let i = 1;
		while (i < args.length) {
			const arg = args[i];
			if (arg === "-w" || arg === "-e" || arg === "-u") { i += 2; continue; }
			if (arg?.startsWith("-")) { i += 1; continue; }
			break;
		}
		const inner = args[i + 1] || "unknown";
		const innerSub = args[i + 2];
		if (inner === "git" && innerSub) return `exec git ${innerSub}`;
		return `exec ${inner}`;
	}

	private childLabel(args: readonly string[]): string {
		const op = this.operation(args);
		if (op.startsWith("exec git")) return `${this.bin} exec git`;
		if (op.startsWith("exec ")) return `${this.bin} exec`;
		return `${this.bin} ${args[0] || "command"}`;
	}

	/**
	 * execFile wrapper around the runtime binary with cpu-diagnostics
	 * instrumentation (ported from project-sandbox `execDocker`).
	 */
	protected async run(
		args: readonly string[],
		options?: { timeout?: number; env?: NodeJS.ProcessEnv; maxBuffer?: number; cwd?: string },
	): Promise<ExecResult> {
		const opts = { windowsHide: true, ...options };
		if (!cpuDiagnosticsEnabled()) {
			return await this.execFileFn(this.bin, args as string[], opts);
		}
		const start = performance.now();
		let success = 0;
		let errorCode = "none";
		try {
			const result = await this.execFileFn(this.bin, args as string[], opts);
			success = 1;
			return result;
		} catch (err) {
			errorCode = childErrorCode(err);
			throw err;
		} finally {
			getCpuDiagnostics().recordChildProcess(this.childLabel(args), performance.now() - start, {
				operation: this.operation(args),
				success,
				errorCode,
				timeoutMs: typeof options?.timeout === "number" ? options.timeout : 0,
			});
		}
	}

	// ── Exec arg construction (shared) ─────────────────────────────

	/** Build the `exec [-i] [-w] [-u] [-e…] <id> <argv…>` argument array. */
	protected execArgs(containerId: string, argv: string[], opts?: ExecOpts): string[] {
		const args: string[] = ["exec"];
		if (opts?.interactive) args.push("-i");
		if (opts?.cwd) args.push("-w", opts.cwd);
		if (opts?.user) args.push("-u", opts.user);
		if (opts?.env) {
			for (const [key, value] of Object.entries(opts.env)) {
				args.push("-e", `${key}=${value}`);
			}
		}
		args.push(containerId, ...argv);
		return args;
	}

	async exec(containerId: string, argv: string[], opts?: ExecOpts): Promise<ExecResult> {
		return this.run(this.execArgs(containerId, argv, opts), {
			timeout: opts?.timeoutMs ?? 60_000,
			env: this.runtimeEnv(),
			maxBuffer: opts?.maxBuffer ?? 10 * 1024 * 1024,
		});
	}

	buildExecCommand(containerId: string, argv: string[], opts?: ExecOpts): ExecCommand {
		// `opts.env` becomes `-e KEY=VAL` flags (container env) via execArgs; the
		// returned `env` is only the spawned host-CLI process env (MSYS shim over
		// process.env), matching the pre-abstraction spawn behaviour. The caller's
		// secrets therefore never enter the host CLI's own environment.
		return {
			file: this.bin,
			args: this.execArgs(containerId, argv, opts),
			env: this.runtimeEnv(),
		};
	}

	// ── Diagnostics ────────────────────────────────────────────────

	async getVersion(): Promise<string> {
		try {
			const { stdout } = await this.run(["info", "--format", this.infoVersionFormat()], {
				timeout: 5_000,
				env: this.runtimeEnv(),
			});
			const version = stdout.trim();
			if (!version) throw new Error("empty version string");
			return version;
		} catch (err: any) {
			throw new Error(`${this.bin} is not available: ${err?.stderr || err?.message || String(err)}`);
		}
	}

	async getResourceLimits(): Promise<{ cpus: number; memBytes: number } | null> {
		if (this._resourceLimits !== undefined) return this._resourceLimits;
		try {
			const { stdout } = await this.run(["info", "--format", this.infoResourceFormat()], {
				timeout: 5_000,
				env: this.runtimeEnv(),
			});
			const parts = stdout.trim().split(/\s+/);
			const cpus = parseInt(parts[0], 10);
			const memBytes = parseInt(parts[1], 10);
			if (Number.isNaN(cpus) || Number.isNaN(memBytes) || cpus <= 0 || memBytes <= 0) {
				this._resourceLimits = null;
				return null;
			}
			this._resourceLimits = { cpus, memBytes };
			return this._resourceLimits;
		} catch {
			this._resourceLimits = null;
			return null;
		}
	}

	/** @internal — test hook. Resets the cached resource limits. */
	_resetResourceLimitsCache(): void {
		this._resourceLimits = undefined;
	}

	// ── Images ─────────────────────────────────────────────────────

	async buildImage(spec: BuildSpec): Promise<void> {
		const args: string[] = ["build"];
		for (const [k, v] of Object.entries(spec.buildArgs ?? {})) {
			args.push("--build-arg", `${k}=${v}`);
		}
		args.push("-t", spec.image, spec.contextDir);
		await this.run(args, { timeout: spec.timeoutMs ?? 300_000, env: this.runtimeEnv(), cwd: spec.cwd });
	}

	async imageExists(image: string): Promise<boolean> {
		try {
			await this.run(["image", "inspect", image], { timeout: 5_000, env: this.runtimeEnv() });
			return true;
		} catch {
			return false;
		}
	}

	async getImageLabel(image: string, label: string): Promise<string | null> {
		try {
			const { stdout } = await this.run(
				["inspect", "--format", `{{index .Config.Labels ${JSON.stringify(label)}}}`, image],
				{ timeout: 5_000, env: this.runtimeEnv() },
			);
			const value = stdout.trim();
			return value && value !== "<no value>" ? value : null;
		} catch {
			return null;
		}
	}

	// ── Container lifecycle ────────────────────────────────────────

	async createContainer(spec: ContainerRunSpec): Promise<string> {
		const args = serializeContainerRunSpec(spec, this.runArgHooks());
		const { stdout } = await this.run(args, { timeout: 60_000, env: this.runtimeEnv() });
		return stdout.trim();
	}

	async findContainerByLabel(label: string): Promise<string | null> {
		try {
			const { stdout } = await this.run(
				["ps", "-a", "--filter", `label=${label}`, "--format", "{{.ID}}"],
				{ timeout: 10_000, env: this.runtimeEnv() },
			);
			const ids = stdout.trim().split("\n").filter(Boolean);
			return ids[0] ?? null;
		} catch {
			return null;
		}
	}

	async isRunning(containerId: string): Promise<boolean> {
		try {
			const { stdout } = await this.run(
				["inspect", "--format", "{{.State.Running}}", containerId],
				{ timeout: 5_000, env: this.runtimeEnv() },
			);
			return stdout.trim() === "true";
		} catch {
			return false;
		}
	}

	async getContainerImageId(containerId: string): Promise<string | null> {
		try {
			const { stdout } = await this.run(
				["inspect", "--format", "{{.Image}}", containerId],
				{ timeout: 5_000, env: this.runtimeEnv() },
			);
			const value = stdout.trim();
			return value || null;
		} catch {
			return null;
		}
	}

	async getImageId(image: string): Promise<string | null> {
		try {
			const { stdout } = await this.run(
				["inspect", "--format", "{{.Id}}", image],
				{ timeout: 5_000, env: this.runtimeEnv() },
			);
			const value = stdout.trim();
			return value || null;
		} catch {
			return null;
		}
	}

	async startContainer(containerId: string, opts?: { timeoutMs?: number }): Promise<void> {
		await this.run(["start", containerId], { timeout: opts?.timeoutMs ?? 30_000, env: this.runtimeEnv() });
	}

	async stopContainer(containerId: string, opts?: { timeoutMs?: number }): Promise<void> {
		await this.run(["stop", containerId], { timeout: opts?.timeoutMs ?? 30_000, env: this.runtimeEnv() });
	}

	async removeContainer(containerId: string, opts?: { force?: boolean; timeoutMs?: number }): Promise<void> {
		const args = ["rm"];
		if (opts?.force) args.push("-f");
		args.push(containerId);
		await this.run(args, { timeout: opts?.timeoutMs ?? 15_000, env: this.runtimeEnv() });
	}

	// ── Files ──────────────────────────────────────────────────────

	async copyToContainer(containerId: string, hostSrc: string, containerDest: string): Promise<void> {
		await this.run(["cp", hostSrc, `${containerId}:${containerDest}`], {
			timeout: 30_000,
			env: this.runtimeEnv(),
		});
	}

	// ── Volumes & networks ─────────────────────────────────────────

	async removeVolume(name: string, opts?: { force?: boolean }): Promise<void> {
		const args = ["volume", "rm"];
		if (opts?.force) args.push("-f");
		args.push(name);
		await this.run(args, { timeout: 15_000, env: this.runtimeEnv() });
	}

	async createNetwork(name: string, opts?: { driver?: string; internal?: boolean }): Promise<void> {
		const args = ["network", "create", name];
		if (opts?.driver) args.push("--driver", opts.driver);
		if (opts?.internal) args.push("--internal");
		args.push(...this.networkCreateExtraArgs());
		await this.run(args, { timeout: 15_000, env: this.runtimeEnv() });
	}

	async removeNetwork(name: string): Promise<void> {
		await this.run(["network", "rm", name], { timeout: 10_000, env: this.runtimeEnv() });
	}
}
