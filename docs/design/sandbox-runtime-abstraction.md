# Design: Sandbox Container-Runtime Abstraction

**Status:** Draft for review
**Supersedes:** the "swap the binary name" approach (PR #4, reverted in #10)

## 1. Motivation

The first cut made the container CLI configurable by threading a binary-name
string (`"docker" | "podman"`) to every call site and reusing the Docker
argument arrays verbatim. That assumed Docker and Podman are
argument-for-argument identical. They are not, and the gaps leak across the
codebase:

- **`info --format` schema differs.** Docker flattens fields (`.ServerVersion`,
  `.NCPU`, `.MemTotal`); Podman nests them (`.Version.Version`, `.Host.CPUs`,
  `.Host.MemTotal`). The Docker template throws against Podman → "podman not
  available". We patched this with two `=== "podman"` branches, but it's a
  symptom.
- **`run` args are Docker-flavoured.** `--add-host=host.docker.internal:host-gateway`,
  bind-mount syntax without SELinux relabel (`:z`/`:Z`), no `--userns` — all fine
  for Docker, all potential issues under rootless Podman.
- **Future runtimes / quirks** (nerdctl, remote sockets, Docker Desktop path
  rewriting) would each add more scattered conditionals.

Threading a string means every new runtime difference becomes a new `if (bin ===
"podman")` somewhere. That does not scale and is hard to test. The fix is a
proper **provider interface**: one place per runtime that owns its quirks.

## 2. Goals / Non-goals

**Goals**
- A single `ContainerRuntime` interface that abstracts *all* container
  interactions the sandbox performs.
- Two implementations: `DockerRuntime`, `PodmanRuntime`.
- A config key selecting the provider, resolved to one runtime instance and
  injected where the binary name is threaded today.
- Each runtime owns its own arg/template/quirk differences; call sites become
  runtime-agnostic (no `=== "podman"` anywhere outside the impls).
- Contract tests that both implementations must satisfy; real-Podman validation.

**Non-goals (first cut)**
- Remote daemon/socket transports, podman-machine provisioning, nerdctl.
- A plugin system for third-party runtimes (interface is internal, not public).
- Changing the Dockerfile / image contents (shared build context stays).

## 3. The interface

`src/server/agent/container-runtime/types.ts`

```ts
/** Identifies the provider; derived from the single `sandbox` mode (`podman` → podman, else docker). */
export type RuntimeId = "docker" | "podman";

/** One-shot exec result. */
export interface ExecResult { stdout: string; stderr: string; }

export interface ExecOpts {
  cwd?: string;                      // -w
  user?: string;                     // -u (e.g. "root")
  env?: Record<string, string>;      // -e KEY=VAL
  interactive?: boolean;             // -i
  timeoutMs?: number;
}

/** Fully-resolved spec for a long-lived sandbox container (was DockerRunConfig). */
export interface ContainerRunSpec {
  image: string;
  name?: string;
  labels?: Record<string, string>;
  volumes?: VolumeMount[];           // { hostPathOrVolume, containerPath, readonly, relabel? }
  env?: Record<string, string>;
  network?: string;
  addHosts?: Record<string, string>; // logical host → ip; runtime maps to its flag
  resources?: { cpus?: string; memory?: string; pids?: string };
  restart?: "no" | "unless-stopped";
  command?: string[];                // default ["sleep", "infinity"]
}

export interface BuildSpec {
  image: string;
  contextDir: string;                // "docker/"
  buildArgs?: Record<string, string>;
  cwd?: string;
  timeoutMs?: number;
}

/**
 * Everything the sandbox subsystem needs from a container CLI. Implementations
 * own all binary-name, argument, and template differences. No caller branches
 * on the runtime.
 */
export interface ContainerRuntime {
  readonly id: RuntimeId;

  // ── Diagnostics ────────────────────────────────────────────────
  /** Engine version string. Throws if the runtime is unavailable. */
  getVersion(): Promise<string>;
  /** Daemon-reported CPU/mem, or null if unavailable (caller falls back to host). */
  getResourceLimits(): Promise<{ cpus: number; memBytes: number } | null>;
  /**
   * Actionable hint appended to the availability error when getVersion() fails,
   * or undefined if there is nothing runtime-specific to add. BaseCliRuntime /
   * DockerRuntime return undefined; PodmanRuntime returns the rootless/SELinux +
   * info-schema hint so the status row never just says "podman is not available".
   */
  availabilityHint(): string | undefined;

  // ── Images ─────────────────────────────────────────────────────
  buildImage(spec: BuildSpec): Promise<void>;
  imageExists(image: string): Promise<boolean>;
  getImageLabel(image: string, label: string): Promise<string | null>;

  // ── Container lifecycle ────────────────────────────────────────
  createContainer(spec: ContainerRunSpec): Promise<string /* containerId */>;
  findContainerByLabel(label: string): Promise<string | null>;
  isRunning(containerId: string): Promise<boolean>;
  getContainerImageId(containerId: string): Promise<string | null>;
  startContainer(containerId: string): Promise<void>;
  stopContainer(containerId: string, opts?: { timeoutMs?: number }): Promise<void>;
  removeContainer(containerId: string, opts?: { force?: boolean }): Promise<void>;

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
  buildExecCommand(containerId: string, argv: string[], opts?: ExecOpts):
    { file: string; args: string[]; env: NodeJS.ProcessEnv };

  // ── Files ──────────────────────────────────────────────────────
  copyToContainer(containerId: string, hostSrc: string, containerDest: string): Promise<void>;

  // ── Volumes & networks ─────────────────────────────────────────
  removeVolume(name: string, opts?: { force?: boolean }): Promise<void>;
  createNetwork(name: string, opts?: { driver?: string; internal?: boolean }): Promise<void>;
  removeNetwork(name: string): Promise<void>;
}
```

### Why `buildExecCommand` exists
Three call sites need a real `ChildProcess`, not a captured result:
- **rpc-bridge** pipes stdin/stdout to the agent CLI (`spawn` + stdio pipes).
- **bg-process-manager** tracks a long-running shell (`spawn`, injectable `SpawnFn`).
- **verification-harness** must route through `spawnTracked` (kill-tree; the
  "never `spawn({ timeout })`" rule).

The interface can't hide those behind an `async` method, so it exposes a pure
argv builder. The runtime owns the binary + `exec`-flag construction (`-i`,
`-w`, `-u`, `-e`, MSYS env shim); callers own spawning/tracking. This keeps the
kill-tree and stdio semantics exactly as today while removing the binary
literal.

## 4. Implementations

`src/server/agent/container-runtime/`
- `types.ts` — the interface above.
- `base-cli-runtime.ts` — `abstract class BaseCliRuntime implements ContainerRuntime`.
  Holds the shared CLI logic: `execFileAsync(this.bin, …)`, the
  cpu-diagnostics wrapper (today's `execDocker`), the MSYS env shim, and all
  argument arrays that ARE identical (`exec`, `cp`, `build`, `stop`, `start`,
  `rm`, `volume rm`, `network`, `ps --filter`, container/image `inspect`).
- `docker-runtime.ts` — `class DockerRuntime extends BaseCliRuntime`.
  Overrides only the Docker-specific bits: `infoVersionFormat = "{{.ServerVersion}}"`,
  resource format `"{{.NCPU}} {{.MemTotal}}"`, `--add-host` host-gateway, plain
  bind mounts, `toDockerPath` rewriting (Docker Desktop on Win/macOS).
- `podman-runtime.ts` — `class PodmanRuntime extends BaseCliRuntime`.
  Overrides: info templates (`.Version.Version`, `.Host.CPUs`/`.Host.MemTotal`),
  and the validated run-arg differences via `RunArgHooks` — `:Z` volume relabel
  under SELinux, `host.containers.internal` vs `host.docker.internal`, and
  `extraRunArgs()` emitting `--userns=keep-id:uid=1000,gid=1000` so the host
  user maps to the container's `node` (uid 1000) and writable HOST bind mounts
  (`/home/node/.bobbit/agent/sessions`, `/bobbit-state/*`, …) are node-writable
  without a host chown. Docker's `extraRunArgs()` is `[]` (byte-pinned output).
  The changes are confined to this file.

`container/inspect` templates (`.State.Running`, `.Image`, `.Id`,
`Config.Labels`) are Docker-API-compatible in Podman, so they live in the base
class; only `info` and run-args are overridden.

### Factory & wiring
`src/server/agent/container-runtime/index.ts`

```ts
export function createContainerRuntime(id: RuntimeId): ContainerRuntime {
  return id === "podman" ? new PodmanRuntime() : new DockerRuntime();
}
/** Resolve from project config (replaces runtimeBin(store)). */
export function resolveContainerRuntime(
  store: Pick<ProjectConfigStore, "getSandboxRuntime"> | null | undefined,
): ContainerRuntime {
  return createContainerRuntime(store?.getSandboxRuntime() ?? "docker");
}
```

Wherever `runtimeBin(store)` / an injected `runtimeBin` string is threaded
today, we thread a `ContainerRuntime` instance instead:
- `ProjectSandbox` takes `runtime: ContainerRuntime` in its options; all
  `execDocker(this.options.runtimeBin, …)` / `_dockerExec` become
  `this.runtime.exec(...)` / lifecycle calls.
- `SessionManager` resolves once and passes the runtime to `ProjectSandbox`,
  rpc-bridge options, and bg-process wiring; network create/rm call the runtime.
- `rpc-bridge` / `bg-process-manager` / `verification-harness` call
  `runtime.buildExecCommand(...)` then spawn/track as they do now.
- `sandbox-status.ts` (`checkDockerAvailability`, build, version/label checks)
  becomes thin wrappers over `runtime.getVersion()/imageExists()/getImageLabel()/buildImage()`.
- `server.ts` git-panel exec + availability cache call the runtime.

End state: `runtime-bin.ts` (string + template helpers) is replaced by the
`container-runtime/` module; `rg '"docker"' src/server` shows only the
DockerRuntime impl, the `sandbox` enable-value comparisons, and the
`docker/Dockerfile` build-context path.

## 5. Configuration

**Single-mode model (current).** Sandboxing is controlled by one config key,
`sandbox`, with three values:

- `"none"` — sandboxing off.
- `"docker"` — sandboxing on, `DockerRuntime`.
- `"podman"` — sandboxing on, `PodmanRuntime`.

The mode is both the enable flag and the provider selector — there is no separate
`sandbox_runtime` key. `ProjectConfigStore.getSandboxRuntime()` derives the
`RuntimeId` from `sandbox` (`"podman"` → podman; anything else → docker; never
throws), and `resolveContainerRuntime(projectConfigStore)` maps that id to an
instance.

**`sandbox_runtime` removed (no migration).** The earlier two-field design used a
separate `sandbox_runtime` provider key. That key was **removed entirely**: it is
never read, and a stale `sandbox_runtime` left in a `project.yaml` is silently
ignored (no migration, no warning). A project that selected Podman via the old
`sandbox: docker` + `sandbox_runtime: podman` combo falls back to Docker until
`sandbox` is set to `"podman"`.

**Settings UI.** Project Settings → **Container Sandbox** exposes a single
**Sandbox Mode** select with options `none` / `docker` / `podman`, wired to
`sandbox` via the existing `PUT /api/projects/:id/config` flow (no separate
Container Runtime dropdown). The sandbox status display is runtime-aware:
`GET /api/sandbox-status` returns a `runtime` field and the UI labels
availability and the build-command hint with the selected runtime; when a
Podman probe fails, `PodmanRuntime.availabilityHint()` enriches the error.

**Status probes the *selected* mode.** `GET /api/sandbox-status` accepts an
optional `?sandbox=<none|docker|podman>` param. The Settings UI passes the
*pending* dropdown selection so the Runtime Status row probes the backend the
user just picked — before saving — rather than the saved-config runtime. Without
the param it falls back to `resolveContainerRuntime(projectConfigStore)`. This
avoids the misleading case where selecting Podman would show Docker's
availability until the change was saved and the page reloaded. See
[internals.md → Container runtime abstraction](../internals.md#container-runtime-abstraction).

**Building the image (operations).** The agent image (default `bobbit-agent`) is
built from `docker/Dockerfile` via two npm scripts: `npm run sandbox:build:docker`
and `npm run sandbox:build:podman`. Both bake the host's `pi-coding-agent`
version (`--build-arg PI_AGENT_VERSION=<host>`) and honour `SANDBOX_IMAGE` to
override the tag. Docker mode auto-builds the image on first use; under Podman,
building the image (and installing/configuring rootless Podman) is the user's
responsibility — the Settings status row and **Build Image** button stay as-is.
This matches the abstraction's non-goal of changing image contents: the build
context is shared across runtimes; only the building binary differs.

## 6. Migration plan (incremental, behind the interface)

1. Add `container-runtime/` module (types + base + docker + podman + factory) with
   unit tests. No call-site changes yet — Docker behaviour identical.
2. Move `buildDockerRunArgs` logic into `BaseCliRuntime.createContainer` (Docker
   override = today's args). `ContainerRunSpec` replaces `DockerRunConfig`.
3. Migrate `ProjectSandbox` to hold a `ContainerRuntime`; delete `execDocker` /
   `_dockerExec` in favour of `runtime.exec` / lifecycle methods.
4. Migrate `sandbox-status.ts`, `session-manager.ts`, `rpc-bridge.ts`,
   `bg-process-manager.ts`, `verification-harness.ts`, `server.ts`.
5. Delete `runtime-bin.ts` (string resolver + template helpers); replace with
   `resolveContainerRuntime`.
6. Real-Podman validation by pointing the dev server at the worktree (§7).

Each step keeps Docker green; Podman parity is validated at the end against a
real rootless podman host.

## 7. Testing

- **Contract tests** — a shared suite run against both `DockerRuntime` and
  `PodmanRuntime` using an injected fake `execFile`/`spawn`, asserting the right
  binary + args + templates per runtime (e.g. podman version template is
  `.Version.Version`, never `.ServerVersion`; docker is the inverse).
- **Per-impl unit tests** — info templates, run-arg differences (host-gateway,
  relabel), exec argv (`-w`/`-u`/`-e`/`-i`).
- **`buildExecCommand` tests** — argv shape parity for the three streaming
  callers; verification path still routes through `spawnTracked`.
- **Guard test** — no spawned-binary `"docker"` literal outside
  `docker-runtime.ts`.
- **Real Podman** — dev server switched to this worktree (per below),
  `sandbox: podman`, drive a full session: create → exec → run a
  command step → cleanup. This is the validation the first cut skipped.

### Dev-server-on-worktree testing (process note)
Next time we validate sandboxing, point the running gateway at this feature
worktree (`…/goal-podman-sandbox-b380d4b8`) rather than the primary worktree,
so the live server runs the in-development code. Keep the pre-built
`bobbit-agent` podman image and `sandbox: podman` in that project's
config.

## 8. Open questions for review

1. **Interface granularity** — is `buildExecCommand` (argv builder) the right
   seam for the three streaming callers, or would you prefer the runtime expose
   a `spawnExec()` that returns a `ChildProcess` (and a `spawnTrackedExec()`
   variant)? The argv-builder keeps tracking/stdio with the caller; a
   spawn-returning method centralizes more but has to thread `spawnTracked`.
2. **Run-spec ownership** — move `buildDockerRunArgs` wholesale into the runtime
   (each runtime builds its own argv from `ContainerRunSpec`), or keep a shared
   builder that emits a neutral arg list the runtime post-processes? I lean
   "runtime builds its own" for clean Podman relabel/host-gateway handling.
3. **Config key name** — *Resolved:* there is no separate provider key. The
   provider is folded into the single `sandbox` mode (`none|docker|podman`);
   `sandbox_runtime` was removed.
4. **Module location** — `src/server/agent/container-runtime/` vs
   `src/server/agent/sandbox/runtime/`?
5. **Scope of Podman run-arg parity now** — implement SELinux `:Z` relabel and
   `host.containers.internal` in this cut (since we have a real podman host to
   test), or land the interface + info fix first and treat run-arg parity as a
   fast follow once we see real failures?
