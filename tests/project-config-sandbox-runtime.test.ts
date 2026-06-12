/**
 * Unit tests for ProjectConfigStore.getSandboxRuntime() — the config accessor
 * resolveContainerRuntime() consumes. Under the single-mode model the provider
 * is derived from the `sandbox` mode (`none|docker|podman`); the legacy
 * `sandbox_runtime` key is NEVER read (no migration).
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { ProjectConfigStore } from "../src/server/agent/project-config-store.js";
import { resolveContainerRuntime } from "../src/server/agent/container-runtime/index.js";

let tmpDir: string;
function write(content: string) { fs.writeFileSync(path.join(tmpDir, "project.yaml"), content); }

describe("ProjectConfigStore.getSandboxRuntime", () => {
	beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pcs-runtime-")); });
	afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

	it("defaults to docker when sandbox is unset", () => {
		const store = new ProjectConfigStore(tmpDir);
		assert.equal(store.getSandboxRuntime(), "docker");
	});

	it("returns podman when sandbox: podman", () => {
		write("sandbox: podman\n");
		const store = new ProjectConfigStore(tmpDir);
		assert.equal(store.getSandboxRuntime(), "podman");
	});

	it("returns docker when sandbox: docker", () => {
		write("sandbox: docker\n");
		const store = new ProjectConfigStore(tmpDir);
		assert.equal(store.getSandboxRuntime(), "docker");
	});

	it("returns docker when sandbox: none", () => {
		write("sandbox: none\n");
		assert.equal(new ProjectConfigStore(tmpDir).getSandboxRuntime(), "docker");
	});

	it("unknown / empty values fall back to docker", () => {
		write("sandbox: nerdctl\n");
		assert.equal(new ProjectConfigStore(tmpDir).getSandboxRuntime(), "docker");
		write("sandbox: ''\n");
		assert.equal(new ProjectConfigStore(tmpDir).getSandboxRuntime(), "docker");
	});

	it("is case/whitespace tolerant on the sandbox mode", () => {
		write('sandbox: "  Podman  "\n');
		assert.equal(new ProjectConfigStore(tmpDir).getSandboxRuntime(), "podman");
	});

	it("never reads the legacy sandbox_runtime key", () => {
		// sandbox: docker maps to docker mode; the stale sandbox_runtime: podman
		// is NOT consulted at all (no migration, no auto-translation).
		write("sandbox: docker\nsandbox_runtime: podman\n");
		assert.equal(new ProjectConfigStore(tmpDir).getSandboxRuntime(), "docker");
		// sandbox: podman is the sole source of truth even when sandbox_runtime
		// says docker.
		write("sandbox: podman\nsandbox_runtime: docker\n");
		assert.equal(new ProjectConfigStore(tmpDir).getSandboxRuntime(), "podman");
	});

	it("resolveContainerRuntime(store) maps the mode to an instance", () => {
		write("sandbox: podman\n");
		assert.equal(resolveContainerRuntime(new ProjectConfigStore(tmpDir)).id, "podman");
		write("sandbox: docker\n");
		assert.equal(resolveContainerRuntime(new ProjectConfigStore(tmpDir)).id, "docker");
		write("sandbox: none\n");
		assert.equal(resolveContainerRuntime(new ProjectConfigStore(tmpDir)).id, "docker");
	});
});
