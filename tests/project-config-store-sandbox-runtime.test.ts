/**
 * Unit tests for `ProjectConfigStore.getSandboxRuntime()` — the config
 * accessor `resolveContainerRuntime` consumes to pick the container provider.
 *
 * Invariants (see project-config-store.ts:getSandboxRuntime):
 *   - absent / empty / unknown → "docker" (never throws)
 *   - exact "podman" (after trim + lowercase) → "podman"
 *   - case-insensitive + whitespace-tolerant ("PODMAN", " podman ") → "podman"
 *   - anything else (incl. "Docker", garbage) → "docker"
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

describe("ProjectConfigStore — getSandboxRuntime()", () => {
	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pcs-runtime-"));
	});
	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("defaults to docker when sandbox_runtime is absent", () => {
		assert.equal(newStore().getSandboxRuntime(), "docker");
	});

	it("returns podman when set to exactly \"podman\"", () => {
		const store = newStore();
		store.set("sandbox_runtime", "podman");
		assert.equal(store.getSandboxRuntime(), "podman");
		// Round-trips across a fresh load from disk.
		assert.equal(newStore().getSandboxRuntime(), "podman");
	});

	it("normalizes case and whitespace to podman", () => {
		for (const raw of ["PODMAN", "Podman", "  podman  ", "\tpodman\n"]) {
			const store = newStore();
			store.set("sandbox_runtime", raw);
			assert.equal(store.getSandboxRuntime(), "podman", `input ${JSON.stringify(raw)} should resolve to podman`);
		}
	});

	it("falls back to docker for empty, unknown, or garbage values", () => {
		for (const raw of ["", "   ", "docker", "Docker", "DOCKER", "containerd", "nonsense"]) {
			const store = newStore();
			store.set("sandbox_runtime", raw);
			assert.equal(store.getSandboxRuntime(), "docker", `input ${JSON.stringify(raw)} should resolve to docker`);
		}
	});

	it("persists podman as native YAML and reloads it", () => {
		const store = newStore();
		store.set("sandbox_runtime", "podman");
		const yamlText = fs.readFileSync(path.join(tmpDir, "project.yaml"), "utf-8");
		assert.match(yamlText, /sandbox_runtime:\s*podman/);
		assert.equal(newStore().getSandboxRuntime(), "podman");
	});
});
