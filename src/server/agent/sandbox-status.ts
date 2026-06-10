import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PI_AI_BEDROCK_HEADERS_PATCH_LABEL } from "./pi-ai-bedrock-headers-patch.js";
import { DockerRuntime } from "./container-runtime/docker-runtime.js";
import type { ContainerRuntime } from "./container-runtime/types.js";

/**
 * Default runtime used when a caller doesn't inject one (preserves today's
 * Docker behaviour). Sandbox-enabled call sites pass the project's resolved
 * runtime so podman projects build/inspect via podman.
 */
const _defaultRuntime: ContainerRuntime = new DockerRuntime();

const AGENT_VERSION_LABEL = "bobbit.pi-agent-version";
const BEDROCK_UA_PATCH_LABEL = "bobbit.pi-ai-bedrock-ua-patch";

export interface SandboxStatus {
	available: boolean;
	error?: string;
	dockerVersion?: string;
	imageExists?: boolean;
	dockerfileExists?: boolean;
	buildCommand?: string;
	pool?: { total: number; idle: number; claimed: number; warming: number };
}

let _building = false;

export function isBuildingImage(): boolean {
	return _building;
}

export async function buildSandboxImage(
	imageName: string,
	projectDir: string,
	runtime: ContainerRuntime = _defaultRuntime,
): Promise<{ success: boolean; error?: string }> {
	_building = true;
	try {
		console.log(`[sandbox] Building ${runtime.bin} image "${imageName}" from docker/Dockerfile...`);
		await runtime.buildImage({ image: imageName, contextDir: "docker/", cwd: projectDir, timeoutMs: 300_000 });
		console.log(`[sandbox] Image "${imageName}" built successfully`);
		return { success: true };
	} catch (err: any) {
		const errorMsg = err.stderr || err.message || String(err);
		console.error(`[sandbox] Failed to build image "${imageName}": ${errorMsg}`);
		return { success: false, error: errorMsg };
	} finally {
		_building = false;
	}
}

/**
 * Check if the image has the expected pi-coding-agent version baked in.
 * Returns the image version (or null if not labelled / image missing).
 */
export async function getImageAgentVersion(
	imageName: string,
	runtime: ContainerRuntime = _defaultRuntime,
): Promise<string | null> {
	return runtime.getImageLabel(imageName, AGENT_VERSION_LABEL);
}

export async function getImageBedrockHeadersPatchLabel(
	imageName: string,
	runtime: ContainerRuntime = _defaultRuntime,
): Promise<string | null> {
	return runtime.getImageLabel(imageName, BEDROCK_UA_PATCH_LABEL);
}

/** Get the host's installed pi-coding-agent version. */
export function getHostAgentVersion(): string | null {
	try {
		const mainUrl = import.meta.resolve("@earendil-works/pi-coding-agent");
		const mainPath = fileURLToPath(mainUrl);
		const pkgPath = path.resolve(path.dirname(mainPath), "..", "package.json");
		const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
		return pkg.version || null;
	} catch {
		return null;
	}
}

/**
 * Ensure the sandbox image has the correct pi-coding-agent version.
 * Rebuilds automatically if the version is stale or missing.
 * Returns true if the image is ready.
 */
export async function ensureImageAgentVersion(
	imageName: string,
	projectDir: string,
	runtime: ContainerRuntime = _defaultRuntime,
): Promise<boolean> {
	const hostVersion = getHostAgentVersion();
	if (!hostVersion) {
		console.warn("[sandbox] Cannot determine host pi-coding-agent version, skipping image version check");
		return true;
	}

	const imageVersion = await getImageAgentVersion(imageName, runtime);
	const imagePatchLabel = await getImageBedrockHeadersPatchLabel(imageName, runtime);
	if (imageVersion === hostVersion && imagePatchLabel === PI_AI_BEDROCK_HEADERS_PATCH_LABEL) {
		console.log(`[sandbox] Image "${imageName}" has pi-coding-agent@${imageVersion} and Bedrock headers patch ${imagePatchLabel} (matches host)`);
		return true;
	}

	const reason = imageVersion
		? imagePatchLabel === PI_AI_BEDROCK_HEADERS_PATCH_LABEL
			? `image has v${imageVersion}, host has v${hostVersion}`
			: `image missing Bedrock headers patch ${PI_AI_BEDROCK_HEADERS_PATCH_LABEL}, host has v${hostVersion}`
		: `image missing version label, host has v${hostVersion}`;
	console.log(`[sandbox] Rebuilding image "${imageName}": ${reason}`);

	_building = true;
	try {
		await runtime.buildImage({
			image: imageName,
			contextDir: "docker/",
			buildArgs: { PI_AGENT_VERSION: hostVersion },
			cwd: projectDir,
			timeoutMs: 180_000,
		});
		console.log(`[sandbox] Image "${imageName}" rebuilt with pi-coding-agent@${hostVersion} and Bedrock headers patch ${PI_AI_BEDROCK_HEADERS_PATCH_LABEL}`);
		return true;
	} catch (err: any) {
		const errorMsg = err.stderr || err.message || String(err);
		console.error(`[sandbox] Failed to rebuild image "${imageName}": ${errorMsg}`);
		return false;
	} finally {
		_building = false;
	}
}

export async function checkDockerAvailability(
	imageName?: string,
	runtime: ContainerRuntime = _defaultRuntime,
): Promise<SandboxStatus> {
	try {
		const version = await runtime.getVersion();
		const status: SandboxStatus = { available: true, dockerVersion: version };
		if (imageName) {
			if (await runtime.imageExists(imageName)) {
				status.imageExists = true;
			} else {
				status.imageExists = false;
				// Check if Dockerfile exists so UI can show build instructions
				if (fs.existsSync(path.join(process.cwd(), "docker", "Dockerfile"))) {
					status.dockerfileExists = true;
					status.buildCommand = `${runtime.bin} build -t ${imageName} docker/`;
				}
			}
		}
		return status;
	} catch (err) {
		// getVersion throws an error naming the runtime when the binary is missing.
		return { available: false, error: String(err) };
	}
}
