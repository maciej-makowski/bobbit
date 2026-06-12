/**
 * Store-level tests for `ProjectConfigStore.getSandboxRuntime()` — the config
 * accessor `resolveContainerRuntime` consumes to pick the container provider.
 *
 * Single-mode model: the provider is derived from the `sandbox` mode
 * (`none|docker|podman`). The legacy `sandbox_runtime` key is NEVER read.
 *
 * Invariants (see project-config-store.ts:getSandboxRuntime):
 *   - absent / empty / unknown sandbox → "docker" (never throws)
 *   - sandbox == "podman" (after trim + lowercase) → "podman"
 *   - case-insensitive + whitespace-tolerant ("PODMAN", " podman ") → "podman"
 *   - anything else (incl. "docker", "none", garbage) → "docker"
 *   - a stale `sandbox_runtime` key is ignored entirely (no migration)
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { ProjectConfigStore } from "../src/server/agent/project-config-store.js";

let tmpDir: string;

function newStore(): ProjectConfigStore {
	return new ProjectConfigStore(tmpDir);
}
function writeYaml(content: string) {
	fs.writeFileSync(path.join(tmpDir, "project.yaml"), content);
}

describe("ProjectConfigStore — getSandboxRuntime()", () => {
	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pcs-runtime-"));
	});
	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("defaults to docker when sandbox is absent", () => {
		assert.equal(newStore().getSandboxRuntime(), "docker");
	});

	it("returns podman when sandbox is exactly \"podman\"", () => {
		const store = newStore();
		store.set("sandbox", "podman");
		assert.equal(store.getSandboxRuntime(), "podman");
		// Round-trips across a fresh load from disk.
		assert.equal(newStore().getSandboxRuntime(), "podman");
	});

	it("normalizes case and whitespace to podman", () => {
		for (const raw of ["PODMAN", "Podman", "  podman  ", "\tpodman\n"]) {
			const store = newStore();
			store.set("sandbox", raw);
			assert.equal(store.getSandboxRuntime(), "podman", `input ${JSON.stringify(raw)} should resolve to podman`);
		}
	});

	it("falls back to docker for docker/none/unknown sandbox values", () => {
		for (const raw of ["", "   ", "docker", "Docker", "DOCKER", "none", "containerd", "nonsense"]) {
			const store = newStore();
			store.set("sandbox", raw);
			assert.equal(store.getSandboxRuntime(), "docker", `input ${JSON.stringify(raw)} should resolve to docker`);
		}
	});

	it("persists podman as native YAML and reloads it", () => {
		const store = newStore();
		store.set("sandbox", "podman");
		const yamlText = fs.readFileSync(path.join(tmpDir, "project.yaml"), "utf-8");
		assert.match(yamlText, /sandbox:\s*podman/);
		assert.equal(newStore().getSandboxRuntime(), "podman");
	});

	it("ignores a stale sandbox_runtime key entirely (no migration)", () => {
		// sandbox: docker maps to docker mode; sandbox_runtime: podman is never read.
		writeYaml("sandbox: docker\nsandbox_runtime: podman\n");
		assert.equal(newStore().getSandboxRuntime(), "docker");
		// sandbox: podman is the sole source even when sandbox_runtime says docker.
		writeYaml("sandbox: podman\nsandbox_runtime: docker\n");
		assert.equal(newStore().getSandboxRuntime(), "podman");
	});
});
