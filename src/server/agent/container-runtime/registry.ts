/**
 * Container → runtime registry.
 *
 * A long-lived sandbox container belongs to exactly one project and therefore
 * one runtime (docker/podman). Server-side git-panel helpers (commit, push,
 * status, squash-merge, diff) only have a `containerId` in scope, not the
 * project's resolved runtime. Rather than thread a runtime through dozens of
 * call sites, ProjectSandbox registers its `containerId → runtime` mapping when
 * the container becomes ready; helpers look it up and fall back to Docker when
 * a container isn't registered (e.g. legacy/unknown ids).
 */

import type { ContainerRuntime } from "./types.js";
import { DockerRuntime } from "./docker-runtime.js";

const _registry = new Map<string, ContainerRuntime>();

/** Default runtime used when a container id isn't registered. */
let _fallback: ContainerRuntime | null = null;
function fallbackRuntime(): ContainerRuntime {
	if (!_fallback) _fallback = new DockerRuntime();
	return _fallback;
}

export function registerContainerRuntime(containerId: string, runtime: ContainerRuntime): void {
	if (containerId) _registry.set(containerId, runtime);
}

export function unregisterContainerRuntime(containerId: string): void {
	if (containerId) _registry.delete(containerId);
}

/** Resolve the runtime for a container id, or undefined if not registered. */
export function runtimeForContainerId(containerId: string | undefined): ContainerRuntime | undefined {
	return containerId ? _registry.get(containerId) : undefined;
}

/**
 * Resolve the runtime for a container id, falling back to Docker. Use this at
 * call sites that only have a container id and must spawn against *some*
 * runtime (the fallback preserves today's Docker behaviour for unregistered
 * ids).
 */
export function runtimeForContainerIdOrDocker(containerId: string | undefined): ContainerRuntime {
	return runtimeForContainerId(containerId) ?? fallbackRuntime();
}
