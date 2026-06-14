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
	// Rootless podman maps the container's `node` (uid 1000) to a host SUBUID,
	// NOT the host user who owns the writable host bind mounts
	// (`/home/node/.bobbit/agent/sessions`, `/bobbit-state/*`, `/bobbit/preview*`,
	// `/tmp/session-prompts`). That mismatch makes those mounts EACCES for the
	// agent — the pi-coding-agent dies on `mkdir '/home/node/.bobbit/agent/
	// sessions/…'`. `--userns=keep-id:uid=1000,gid=1000` maps the HOST user to
	// container uid/gid 1000 (the image's `node`), so the container `node` and the
	// host user are the same identity: host bind mounts (owned by the host user)
	// are read/write inside the container AND the host gateway still owns/reads
	// them — no host chown, no `:U`. The explicit uid=1000/gid=1000 pins the
	// mapping to the image's `node` uid regardless of the host user's own uid.
	extraRunArgs(): string[] {
		return ["--userns=keep-id:uid=1000,gid=1000"];
	},
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

	availabilityHint(): string | undefined {
		return "Podman selected but not reachable. Common causes: (1) rootless Podman not started or `CONTAINER_HOST`/socket not set; (2) SELinux blocking the rootless socket; (3) a stale Docker-shaped `info --format` template — Podman nests `.Version.Version` / `.Host.CPUs` / `.Host.MemTotal`. Verify with `podman info`.";
	}
}
