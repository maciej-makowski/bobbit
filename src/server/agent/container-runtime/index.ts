/**
 * Container-runtime module entry point.
 *
 * `createContainerRuntime(id)` maps a {@link RuntimeId} to an instance.
 * `resolveContainerRuntime(store)` derives the provider from the project's
 * single `sandbox` mode (via `ProjectConfigStore.getSandboxRuntime()`, which
 * reads `sandbox` — `podman` → Podman, else Docker) and never throws —
 * unknown, empty, or missing values fall back to Docker.
 *
 * See docs/design/sandbox-runtime-abstraction.md §4.
 */

import { DockerRuntime } from "./docker-runtime.js";
import { PodmanRuntime } from "./podman-runtime.js";
import type { ContainerRuntime, RuntimeId } from "./types.js";

export type {
	BuildSpec,
	ContainerRunSpec,
	ContainerRuntime,
	ExecCommand,
	ExecOpts,
	ExecResult,
	RuntimeId,
	VolumeMount,
} from "./types.js";
export { BaseCliRuntime, serializeContainerRunSpec, type RunArgHooks } from "./base-cli-runtime.js";
export { DockerRuntime, DOCKER_RUN_ARG_HOOKS, DOCKER_HOST_GATEWAY } from "./docker-runtime.js";
export { PodmanRuntime, PODMAN_RUN_ARG_HOOKS, PODMAN_HOST_GATEWAY } from "./podman-runtime.js";
export {
	registerContainerRuntime,
	unregisterContainerRuntime,
	runtimeForContainerId,
	runtimeForContainerIdOrDocker,
} from "./registry.js";

/**
 * Minimal shape of the config accessor `resolveContainerRuntime` needs. The
 * provider is derived from the single `sandbox` mode (`none|docker|podman`);
 * there is no separate `sandbox_runtime` key.
 */
export interface SandboxRuntimeConfig {
	getSandboxRuntime(): RuntimeId;
}

/** Build a runtime instance for a known id. Defaults to Docker. */
export function createContainerRuntime(id: RuntimeId): ContainerRuntime {
	return id === "podman" ? new PodmanRuntime() : new DockerRuntime();
}

/**
 * Resolve a runtime from project config. Never throws — a null/undefined store
 * or an unrecognised key resolves to Docker (preserving today's behaviour).
 */
export function resolveContainerRuntime(
	store: SandboxRuntimeConfig | null | undefined,
): ContainerRuntime {
	const id = store?.getSandboxRuntime?.();
	return createContainerRuntime(id === "podman" ? "podman" : "docker");
}
