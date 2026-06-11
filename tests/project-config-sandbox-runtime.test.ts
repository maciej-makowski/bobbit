/**
 * Unit tests for ProjectConfigStore.getSandboxRuntime() — the config accessor
 * resolveContainerRuntime() consumes. Independent of the `sandbox` enable flag.
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

	it("defaults to docker when unset", () => {
		const store = new ProjectConfigStore(tmpDir);
		assert.equal(store.getSandboxRuntime(), "docker");
	});

	it("returns podman when sandbox_runtime: podman", () => {
		write("sandbox_runtime: podman\n");
		const store = new ProjectConfigStore(tmpDir);
		assert.equal(store.getSandboxRuntime(), "podman");
	});

	it("returns docker when sandbox_runtime: docker", () => {
		write("sandbox_runtime: docker\n");
		const store = new ProjectConfigStore(tmpDir);
		assert.equal(store.getSandboxRuntime(), "docker");
	});

	it("unknown / empty values fall back to docker", () => {
		write("sandbox_runtime: nerdctl\n");
		assert.equal(new ProjectConfigStore(tmpDir).getSandboxRuntime(), "docker");
		write("sandbox_runtime: ''\n");
		assert.equal(new ProjectConfigStore(tmpDir).getSandboxRuntime(), "docker");
	});

	it("is case/whitespace tolerant", () => {
		write('sandbox_runtime: "  Podman  "\n');
		assert.equal(new ProjectConfigStore(tmpDir).getSandboxRuntime(), "podman");
	});

	it("resolveContainerRuntime(store) maps the key to an instance", () => {
		write("sandbox_runtime: podman\n");
		assert.equal(resolveContainerRuntime(new ProjectConfigStore(tmpDir)).id, "podman");
		write("sandbox_runtime: docker\n");
		assert.equal(resolveContainerRuntime(new ProjectConfigStore(tmpDir)).id, "docker");
	});
});
