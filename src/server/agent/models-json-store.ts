/**
 * Shared read/write helpers for the interactive agent's `models.json`.
 *
 * `~/.bobbit/agent/models.json` (or `$BOBBIT_AGENT_DIR/models.json`) is the
 * file pi-coding-agent subprocesses consult — alongside pi-ai's built-in
 * provider registry — to resolve a `(provider, modelId)` pair on `set_model`.
 *
 * Multiple writers mutate this file (aigw provider, Claude/Bedrock
 * contextWindow overrides, OpenAI model additions, and custom local
 * providers). They all share this single atomic-write implementation so a
 * concurrent/partial write can never corrupt the file: every write goes to a
 * unique temp path and is `rename`d into place.
 */

import fs from "node:fs";
import path from "node:path";
import { globalAgentDir } from "../bobbit-dir.js";

/** Absolute path to the agent's models.json. */
export function getModelsJsonPath(): string {
	return path.join(globalAgentDir(), "models.json");
}

/**
 * Read and parse models.json. Returns a `{ providers: {} }` skeleton when the
 * file is absent or unreadable so callers can always mutate `data.providers`.
 */
export function readModelsJson(): Record<string, any> {
	const p = getModelsJsonPath();
	try {
		if (fs.existsSync(p)) {
			return JSON.parse(fs.readFileSync(p, "utf-8"));
		}
	} catch (err) {
		console.error("[models-json] Failed to read models.json:", err);
	}
	return { providers: {} };
}

/**
 * Atomically write models.json: write to a unique temp file then rename into
 * place. Best-effort — logs and cleans up the temp file on failure.
 */
export function writeModelsJson(data: Record<string, any>): void {
	const p = getModelsJsonPath();
	let tmp = "";
	try {
		const dir = path.dirname(p);
		if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
		tmp = `${p}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
		fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
		fs.renameSync(tmp, p);
		console.log(`[models-json] Wrote models.json to ${p}`);
	} catch (err) {
		if (tmp) {
			try { fs.unlinkSync(tmp); } catch { /* best-effort */ }
		}
		console.error("[models-json] Failed to write models.json:", err);
	}
}
