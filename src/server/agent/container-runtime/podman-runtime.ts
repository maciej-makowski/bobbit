/**
 * PodmanRuntime — Podman provider. Overrides only what genuinely differs from
 * Docker; the deltas are confined to this file.
 *
 * Validated against rootless podman 5.8.2 (CONTAINER_HOST). The validated
 * differences are:
 *   - `info --format` schema is nested (`.Version.Version`, `.Host.CPUs`,
 *     `.Host.MemTotal`) where Docker is flat (`.ServerVersion`, `.NCPU`,
 *     `.MemTotal`). Using the Docker template against Podman throws → the
 *     "podman not available" bug the binary-swap approach shipped.
 *   - host-gateway: Podman provides `host.containers.internal` natively and
 *     also honours the `:host-gateway` special value for arbitrary names, so we
 *     map `host.docker.internal` too for tooling that expects the Docker name.
 *   - SELinux relabel: on relabel-eligible bind mounts append `:Z` so a
 *     rootless/SELinux host can write into them (`:Z` = private relabel).
 *   - `network create` takes no Docker-specific `--opt` (the bridge ICC opt is
 *     a Docker plugin option Podman rejects).
 */

import { BaseCliRuntime, type RunArgHooks } from "./base-cli-runtime.js";
import type { RuntimeId, VolumeMount } from "./types.js";

/** Podman's native host-gateway hostname. */
export const PODMAN_HOST_GATEWAY = "host.containers.internal";

export const PODMAN_RUN_ARG_HOOKS: RunArgHooks = {
	hostGatewayArgs(): string[] {
		// Podman auto-provides host.containers.internal; the `:host-gateway`
		// special value lets us also expose the Docker-compatible name so agent
		// tooling that hardcodes `host.docker.internal` keeps working.
		return [
			`--add-host=${PODMAN_HOST_GATEWAY}:host-gateway`,
			"--add-host=host.docker.internal:host-gateway",
		];
	},
	// Relabel host bind mounts so rootless/SELinux hosts can access them.
	// `:Z` = relabel with a private (container-exclusive) label.
	volumeOptions(mount: VolumeMount): string[] {
		return mount.relabel ? ["Z"] : [];
	},
};

export class PodmanRuntime extends BaseCliRuntime {
	readonly id: RuntimeId = "podman";
	readonly bin = "podman";

	protected infoVersionFormat(): string {
		return "{{.Version.Version}}";
	}

	protected infoResourceFormat(): string {
		return "{{.Host.CPUs}} {{.Host.MemTotal}}";
	}

	protected runArgHooks(): RunArgHooks {
		return PODMAN_RUN_ARG_HOOKS;
	}

	protected networkCreateExtraArgs(): string[] {
		// Podman rejects Docker's `com.docker.network.bridge.*` opts. Inter-container
		// isolation under rootless podman is handled differently; keep this minimal
		// and revisit if isolation parity is needed.
		return [];
	}
}
