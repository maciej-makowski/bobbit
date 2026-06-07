/**
 * Container-runtime contract + per-impl unit tests.
 *
 * The contract suite runs the SAME assertions against both DockerRuntime and
 * PodmanRuntime via an injected fake execFile, proving each emits the right
 * binary + args + info templates. Per-impl tests pin the differences (info
 * templates, host-gateway flag, SELinux relabel, network opts). The run-args
 * pin proves DockerRuntime.createContainer argv == legacy buildDockerRunArgs.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
	DockerRuntime,
	PodmanRuntime,
	createContainerRuntime,
	resolveContainerRuntime,
	serializeContainerRunSpec,
	DOCKER_RUN_ARG_HOOKS,
	type ContainerRuntime,
	type ContainerRunSpec,
} from "../src/server/agent/container-runtime/index.ts";
import type { ExecFileFn } from "../src/server/agent/container-runtime/base-cli-runtime.ts";
import { buildContainerRunSpec, buildDockerRunArgs } from "../src/server/agent/docker-args.ts";

interface RecordedCall { file: string; args: string[]; options: any }

function makeFakeExec(responder?: (file: string, args: string[]) => { stdout?: string; stderr?: string } | undefined) {
	const calls: RecordedCall[] = [];
	const fn: ExecFileFn = async (file, args, options) => {
		calls.push({ file, args: [...args], options });
		const r = responder?.(file, args) ?? {};
		return { stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
	};
	return { fn, calls };
}

/** Find the single `<runtime> run …` invocation and return its argv. */
function lastCall(calls: RecordedCall[]): RecordedCall {
	return calls[calls.length - 1];
}

// ── Contract suite — runs against both implementations ──────────────────────

interface RuntimeCase {
	name: string;
	bin: string;
	versionTemplate: string;
	resourceTemplate: string;
	make: (exec: ExecFileFn) => ContainerRuntime;
}

const CASES: RuntimeCase[] = [
	{
		name: "DockerRuntime",
		bin: "docker",
		versionTemplate: "{{.ServerVersion}}",
		resourceTemplate: "{{.NCPU}} {{.MemTotal}}",
		make: (exec) => new DockerRuntime(exec),
	},
	{
		name: "PodmanRuntime",
		bin: "podman",
		versionTemplate: "{{.Version.Version}}",
		resourceTemplate: "{{.Host.CPUs}} {{.Host.MemTotal}}",
		make: (exec) => new PodmanRuntime(exec),
	},
];

for (const c of CASES) {
	describe(`ContainerRuntime contract — ${c.name}`, () => {
		it("reports the right binary and id", () => {
			const rt = c.make(makeFakeExec().fn);
			assert.equal(rt.bin, c.bin);
			assert.equal(rt.id, c.bin);
		});

		it("getVersion uses the runtime's info version template", async () => {
			const { fn, calls } = makeFakeExec(() => ({ stdout: "9.9.9\n" }));
			const rt = c.make(fn);
			const v = await rt.getVersion();
			assert.equal(v, "9.9.9");
			const call = lastCall(calls);
			assert.equal(call.file, c.bin);
			assert.deepEqual(call.args, ["info", "--format", c.versionTemplate]);
		});

		it("getResourceLimits uses the runtime's info resource template and parses output", async () => {
			const { fn, calls } = makeFakeExec(() => ({ stdout: "8 17179869184\n" }));
			const rt = c.make(fn);
			const limits = await rt.getResourceLimits();
			assert.deepEqual(limits, { cpus: 8, memBytes: 17179869184 });
			assert.deepEqual(lastCall(calls).args, ["info", "--format", c.resourceTemplate]);
		});

		it("getVersion throws (naming the runtime) when the binary is unavailable", async () => {
			const fn: ExecFileFn = async () => { throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); };
			const rt = c.make(fn);
			await assert.rejects(() => rt.getVersion(), new RegExp(`${c.bin} is not available`));
		});

		it("imageExists runs `image inspect`", async () => {
			const { fn, calls } = makeFakeExec();
			const rt = c.make(fn);
			assert.equal(await rt.imageExists("bobbit-agent"), true);
			assert.deepEqual(lastCall(calls).args, ["image", "inspect", "bobbit-agent"]);
		});

		it("getImageLabel uses the Config.Labels inspect template", async () => {
			const { fn, calls } = makeFakeExec(() => ({ stdout: "0.77.0\n" }));
			const rt = c.make(fn);
			const v = await rt.getImageLabel("bobbit-agent", "bobbit.pi-agent-version");
			assert.equal(v, "0.77.0");
			assert.deepEqual(lastCall(calls).args, [
				"inspect", "--format", '{{index .Config.Labels "bobbit.pi-agent-version"}}', "bobbit-agent",
			]);
		});

		it("getImageLabel returns null for <no value>", async () => {
			const { fn } = makeFakeExec(() => ({ stdout: "<no value>\n" }));
			assert.equal(await c.make(fn).getImageLabel("img", "x"), null);
		});

		it("buildImage passes build-args, tag and context dir", async () => {
			const { fn, calls } = makeFakeExec();
			await c.make(fn).buildImage({ image: "bobbit-agent", contextDir: "docker/", buildArgs: { PI_AGENT_VERSION: "0.77.0" }, cwd: "/proj" });
			const call = lastCall(calls);
			assert.deepEqual(call.args, ["build", "--build-arg", "PI_AGENT_VERSION=0.77.0", "-t", "bobbit-agent", "docker/"]);
			assert.equal(call.options.cwd, "/proj");
		});

		it("findContainerByLabel uses ps -a --filter", async () => {
			const { fn, calls } = makeFakeExec(() => ({ stdout: "abc123\n" }));
			const id = await c.make(fn).findContainerByLabel("bobbit-project=p1");
			assert.equal(id, "abc123");
			assert.deepEqual(lastCall(calls).args, ["ps", "-a", "--filter", "label=bobbit-project=p1", "--format", "{{.ID}}"]);
		});

		it("isRunning uses the State.Running inspect template", async () => {
			const { fn, calls } = makeFakeExec(() => ({ stdout: "true\n" }));
			assert.equal(await c.make(fn).isRunning("abc"), true);
			assert.deepEqual(lastCall(calls).args, ["inspect", "--format", "{{.State.Running}}", "abc"]);
		});

		it("getContainerImageId uses the .Image inspect template", async () => {
			const { fn, calls } = makeFakeExec(() => ({ stdout: "sha256:deadbeef\n" }));
			assert.equal(await c.make(fn).getContainerImageId("abc"), "sha256:deadbeef");
			assert.deepEqual(lastCall(calls).args, ["inspect", "--format", "{{.Image}}", "abc"]);
		});

		it("start/stop/removeContainer use the shared verbs", async () => {
			const { fn, calls } = makeFakeExec();
			const rt = c.make(fn);
			await rt.startContainer("abc");
			assert.deepEqual(lastCall(calls).args, ["start", "abc"]);
			await rt.stopContainer("abc");
			assert.deepEqual(lastCall(calls).args, ["stop", "abc"]);
			await rt.removeContainer("abc", { force: true });
			assert.deepEqual(lastCall(calls).args, ["rm", "-f", "abc"]);
		});

		it("removeVolume / removeNetwork use the shared verbs", async () => {
			const { fn, calls } = makeFakeExec();
			const rt = c.make(fn);
			await rt.removeVolume("bobbit-workspace-p1", { force: true });
			assert.deepEqual(lastCall(calls).args, ["volume", "rm", "-f", "bobbit-workspace-p1"]);
			await rt.removeNetwork("bobbit-sandbox-net");
			assert.deepEqual(lastCall(calls).args, ["network", "rm", "bobbit-sandbox-net"]);
		});

		it("copyToContainer uses cp host id:dest", async () => {
			const { fn, calls } = makeFakeExec();
			await c.make(fn).copyToContainer("abc", "/host/file", "/container/dest");
			assert.deepEqual(lastCall(calls).args, ["cp", "/host/file", "abc:/container/dest"]);
		});

		it("exec builds `exec [-i] -w -u -e id argv` and uses the runtime binary", async () => {
			const { fn, calls } = makeFakeExec(() => ({ stdout: "ok\n" }));
			const rt = c.make(fn);
			const r = await rt.exec("abc", ["git", "status"], {
				cwd: "/workspace", user: "root", env: { FOO: "bar" }, interactive: true,
			});
			assert.equal(r.stdout, "ok\n");
			const call = lastCall(calls);
			assert.equal(call.file, c.bin);
			assert.deepEqual(call.args, ["exec", "-i", "-w", "/workspace", "-u", "root", "-e", "FOO=bar", "abc", "git", "status"]);
		});
	});
}

// ── buildExecCommand (pure argv builder — no spawn) ─────────────────────────

describe("buildExecCommand", () => {
	for (const c of CASES) {
		it(`${c.name}: returns {file:bin, args, env} with -i/-w/-u/-e and the MSYS shim`, () => {
			const rt = c.make(makeFakeExec().fn);
			const cmd = rt.buildExecCommand("abc", ["node", "cli.js"], {
				cwd: "/workspace/wt", user: "node", interactive: true, env: { BOBBIT_SESSION_ID: "s1" },
			});
			assert.equal(cmd.file, c.bin);
			assert.deepEqual(cmd.args, [
				"exec", "-i", "-w", "/workspace/wt", "-u", "node", "-e", "BOBBIT_SESSION_ID=s1", "abc", "node", "cli.js",
			]);
			// MSYS shim is always applied; injected env is merged in.
			assert.equal(cmd.env.MSYS_NO_PATHCONV, "1");
			assert.equal(cmd.env.MSYS2_ARG_CONV_EXCL, "*");
			assert.equal(cmd.env.BOBBIT_SESSION_ID, "s1");
		});
	}

	it("omits -i when not interactive", () => {
		const cmd = new DockerRuntime(makeFakeExec().fn).buildExecCommand("abc", ["echo", "hi"], { cwd: "/x" });
		assert.deepEqual(cmd.args, ["exec", "-w", "/x", "abc", "echo", "hi"]);
	});
});

// ── Per-impl: info templates never cross over ───────────────────────────────

describe("info templates are runtime-specific (the shipped bug)", () => {
	it("podman version template is .Version.Version and NEVER .ServerVersion", async () => {
		const { fn, calls } = makeFakeExec(() => ({ stdout: "5.8.2\n" }));
		await new PodmanRuntime(fn).getVersion();
		const tmpl = lastCall(calls).args[2];
		assert.equal(tmpl, "{{.Version.Version}}");
		assert.ok(!tmpl.includes("ServerVersion"));
	});
	it("docker version template is .ServerVersion and NEVER .Version.Version", async () => {
		const { fn, calls } = makeFakeExec(() => ({ stdout: "27.0\n" }));
		await new DockerRuntime(fn).getVersion();
		const tmpl = lastCall(calls).args[2];
		assert.equal(tmpl, "{{.ServerVersion}}");
		assert.ok(!tmpl.includes(".Version.Version"));
	});
	it("podman resource template uses .Host.CPUs/.Host.MemTotal; docker uses .NCPU/.MemTotal", async () => {
		const p = makeFakeExec(() => ({ stdout: "4 8\n" }));
		await new PodmanRuntime(p.fn).getResourceLimits();
		assert.deepEqual(lastCall(p.calls).args, ["info", "--format", "{{.Host.CPUs}} {{.Host.MemTotal}}"]);
		const d = makeFakeExec(() => ({ stdout: "4 8\n" }));
		await new DockerRuntime(d.fn).getResourceLimits();
		assert.deepEqual(lastCall(d.calls).args, ["info", "--format", "{{.NCPU}} {{.MemTotal}}"]);
	});
});

// ── Per-impl: run-arg differences (host-gateway, relabel, network opts) ─────

const RUN_SPEC: ContainerRunSpec = {
	image: "bobbit-agent",
	restart: "unless-stopped",
	addHosts: { "host.docker.internal": "host-gateway", "metadata.internal": "0.0.0.0" },
	network: "bobbit-sandbox-net",
	resources: { memory: "8g", cpus: "4", pids: "512" },
	labels: { "bobbit-project": "p1" },
	volumes: [
		{ hostPathOrVolume: "bobbit-workspace-p1", containerPath: "/workspace" },
		{ hostPathOrVolume: "/host/tools", containerPath: "/tools", readonly: true, relabel: true },
	],
	env: { NODE_OPTIONS: "--no-warnings" },
	command: ["sleep", "infinity"],
};

describe("run-arg differences are confined to each runtime", () => {
	it("docker uses host.docker.internal and no SELinux relabel", async () => {
		const { fn, calls } = makeFakeExec(() => ({ stdout: "cid\n" }));
		const id = await new DockerRuntime(fn).createContainer(RUN_SPEC);
		assert.equal(id, "cid");
		const args = lastCall(calls).args;
		assert.ok(args.includes("--add-host=host.docker.internal:host-gateway"));
		assert.ok(!args.some((a) => a.includes("host.containers.internal")));
		// metadata host emitted verbatim after --network
		assert.ok(args.includes("--add-host=metadata.internal:0.0.0.0"));
		// bind mount has NO :Z relabel
		assert.ok(args.includes("/host/tools:/tools:ro"));
		assert.ok(!args.some((a) => a.endsWith(":ro,Z") || a.endsWith(":Z")));
	});

	it("podman uses host.containers.internal (+docker alias) and :Z relabel on bind mounts", async () => {
		const { fn, calls } = makeFakeExec(() => ({ stdout: "cid\n" }));
		await new PodmanRuntime(fn).createContainer(RUN_SPEC);
		const args = lastCall(calls).args;
		assert.ok(args.includes("--add-host=host.containers.internal:host-gateway"));
		assert.ok(args.includes("--add-host=host.docker.internal:host-gateway"));
		// SELinux relabel only on relabel-eligible bind mounts, not named volumes
		assert.ok(args.includes("/host/tools:/tools:ro,Z"));
		assert.ok(args.includes("bobbit-workspace-p1:/workspace"));
		assert.ok(!args.includes("bobbit-workspace-p1:/workspace:Z"));
	});

	it("createNetwork: docker adds the bridge ICC opt; podman does not", async () => {
		const d = makeFakeExec();
		await new DockerRuntime(d.fn).createNetwork("net", { driver: "bridge" });
		assert.deepEqual(lastCall(d.calls).args, ["network", "create", "net", "--driver", "bridge", "--opt", "com.docker.network.bridge.enable_icc=false"]);
		const p = makeFakeExec();
		await new PodmanRuntime(p.fn).createNetwork("net", { driver: "bridge" });
		assert.deepEqual(lastCall(p.calls).args, ["network", "create", "net", "--driver", "bridge"]);
	});
});

// ── Pin: DockerRuntime run-args == legacy buildDockerRunArgs ─────────────────

describe("DockerRuntime run-args parity with buildDockerRunArgs (no Docker behaviour change)", () => {
	const config = {
		image: "bobbit-agent",
		workspaceDir: "/tmp/ws",
		projectId: "proj-xyz",
		stateDir: "/tmp/state-xyz",
		sandboxNetwork: "bobbit-sandbox-net",
		memoryLimit: "8g",
		cpuLimit: "4",
		pidsLimit: "0",
		sandboxCredentials: { ANTHROPIC_API_KEY: "sk-test" },
	};

	it("createContainer sends exactly buildDockerRunArgs(config) (as an ordered argv)", async () => {
		const expected = buildDockerRunArgs(config);
		const { fn, calls } = makeFakeExec(() => ({ stdout: "cid\n" }));
		await new DockerRuntime(fn).createContainer(buildContainerRunSpec(config));
		assert.deepEqual(lastCall(calls).args, expected);
	});

	it("serializer with docker hooks equals buildDockerRunArgs (multiset)", () => {
		const direct = serializeContainerRunSpec(buildContainerRunSpec(config), DOCKER_RUN_ARG_HOOKS);
		const legacy = buildDockerRunArgs(config);
		assert.deepEqual([...direct].sort(), [...legacy].sort());
		assert.deepEqual(direct.slice(0, 3), ["run", "-d", "--restart=unless-stopped"]);
		assert.deepEqual(direct.slice(-3), ["bobbit-agent", "sleep", "infinity"]);
	});

	it("podman run-args differ from docker only in host-gateway + relabel", () => {
		const docker = buildDockerRunArgs(config);
		const podman = serializeContainerRunSpec(buildContainerRunSpec(config), {
			hostGatewayArgs: () => ["--add-host=host.containers.internal:host-gateway", "--add-host=host.docker.internal:host-gateway"],
			volumeOptions: (m) => (m.relabel ? ["Z"] : []),
		});
		// Same image + command tail.
		assert.deepEqual(podman.slice(-3), docker.slice(-3));
		// Podman gained host.containers.internal.
		assert.ok(podman.includes("--add-host=host.containers.internal:host-gateway"));
		assert.ok(!docker.includes("--add-host=host.containers.internal:host-gateway"));
		// Podman relabels the bind mount of /tools (named volumes untouched).
		assert.ok(podman.some((a) => a.endsWith(":/tools:ro,Z")));
		assert.ok(podman.includes(`bobbit-workspace-${config.projectId}:/workspace`));
	});
});

// ── Factory + config resolution ─────────────────────────────────────────────

describe("createContainerRuntime / resolveContainerRuntime", () => {
	it("createContainerRuntime maps ids to instances", () => {
		assert.ok(createContainerRuntime("docker") instanceof DockerRuntime);
		assert.ok(createContainerRuntime("podman") instanceof PodmanRuntime);
	});

	it("resolveContainerRuntime: null/undefined store -> docker", () => {
		assert.equal(resolveContainerRuntime(null).id, "docker");
		assert.equal(resolveContainerRuntime(undefined).id, "docker");
	});

	it("resolveContainerRuntime: reads getSandboxRuntime()", () => {
		assert.equal(resolveContainerRuntime({ getSandboxRuntime: () => "podman" }).id, "podman");
		assert.equal(resolveContainerRuntime({ getSandboxRuntime: () => "docker" }).id, "docker");
	});

	it("resolveContainerRuntime: unknown value falls back to docker (never throws)", () => {
		assert.equal(resolveContainerRuntime({ getSandboxRuntime: () => "nerdctl" as any }).id, "docker");
	});
});
