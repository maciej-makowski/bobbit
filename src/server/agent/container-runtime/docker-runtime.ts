/**
 * DockerRuntime — the default provider. Overrides only the Docker-specific
 * bits; everything else comes from BaseCliRuntime. Docker's run-arg output must
 * equal today's `buildDockerRunArgs` (pinned by tests/container-runtime-run-args.test.ts).
 */

import { BaseCliRuntime, type RunArgHooks } from "./base-cli-runtime.js";
import type { RuntimeId, VolumeMount } from "./types.js";

/** Docker host-gateway hostname (Docker Desktop / engine convention). */
export const DOCKER_HOST_GATEWAY = "host.docker.internal";

/** The run-arg hooks Docker uses — exported so the pinning test can assert parity. */
export const DOCKER_RUN_ARG_HOOKS: RunArgHooks = {
	hostGatewayArgs(): string[] {
		return [`--add-host=${DOCKER_HOST_GATEWAY}:host-gateway`];
	},
	// Docker ignores SELinux relabel flags — never append any.
	volumeOptions(_mount: VolumeMount): string[] {
		return [];
	},
};

export class DockerRuntime extends BaseCliRuntime {
	readonly id: RuntimeId = "docker";
	readonly bin = "docker";

	protected infoVersionFormat(): string {
		return "{{.ServerVersion}}";
	}

	protected infoResourceFormat(): string {
		return "{{.NCPU}} {{.MemTotal}}";
	}

	protected runArgHooks(): RunArgHooks {
		return DOCKER_RUN_ARG_HOOKS;
	}

	protected networkCreateExtraArgs(): string[] {
		// Disable inter-container comms on the sandbox bridge (defense-in-depth).
		return ["--opt", "com.docker.network.bridge.enable_icc=false"];
	}
}
