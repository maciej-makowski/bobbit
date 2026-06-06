/**
 * Regression test for the "Failed to execute 'setItem' on 'Storage'" error
 * that rendered in the sidebar right before the UI loaded.
 *
 * Root cause: boot-critical persistence writers (notably `saveExpandedGoals()`
 * in src/app/state.ts, invoked from the initial `refreshSessions()` path) called
 * `localStorage.setItem` directly. When storage throws — quota exceeded, Safari
 * private mode, or a locked-down/partitioned context — the exception bubbled
 * into `refreshSessions()`'s catch, which on initial load assigns the raw error
 * message to `state.sessionsError`. The sidebar then rendered that string in red.
 *
 * Fix: src/app/safe-storage.ts wraps every localStorage access so persistence is
 * best-effort and NEVER throws. These tests pin that contract directly against
 * the source helper (no DOM / browser needed) by installing a `localStorage`
 * global whose `setItem` throws like a real quota failure.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { safeSetItem, safeGetItem, safeRemoveItem, safeGetJSON } from "../src/app/safe-storage.ts";

const realLocalStorage = (globalThis as any).localStorage;
const realWarn = console.warn;
let warnings: unknown[][] = [];

function installThrowingStorage(): void {
	(globalThis as any).localStorage = {
		setItem() { throw new DOMException("exceeded the quota", "QuotaExceededError"); },
		getItem() { throw new DOMException("denied", "SecurityError"); },
		removeItem() { throw new DOMException("denied", "SecurityError"); },
	};
}

function installMapStorage(): Map<string, string> {
	const map = new Map<string, string>();
	(globalThis as any).localStorage = {
		setItem: (k: string, v: string) => { map.set(k, String(v)); },
		getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
		removeItem: (k: string) => { map.delete(k); },
	};
	return map;
}

beforeEach(() => {
	warnings = [];
	console.warn = (...args: unknown[]) => { warnings.push(args); };
});

afterEach(() => {
	console.warn = realWarn;
	if (realLocalStorage === undefined) delete (globalThis as any).localStorage;
	else (globalThis as any).localStorage = realLocalStorage;
});

function warnMessages(): string[] {
	return warnings.map((args) => String(args[0]));
}

describe("safe-storage — never throws on hostile storage", () => {
	beforeEach(() => installThrowingStorage());

	it("safeSetItem swallows a quota/security exception and warns once", () => {
		assert.doesNotThrow(() => safeSetItem("k", "v"));
		assert.strictEqual(warnings.length, 1);
		assert.match(warnMessages()[0], /safe-storage/);
		assert.match(warnMessages()[0], /setItem/);
	});

	it("safeGetItem returns null instead of throwing and warns once", () => {
		assert.strictEqual(safeGetItem("k"), null);
		assert.strictEqual(warnings.length, 1);
		assert.match(warnMessages()[0], /safe-storage/);
		assert.match(warnMessages()[0], /getItem/);
	});

	it("safeRemoveItem swallows a security exception and warns once", () => {
		assert.doesNotThrow(() => safeRemoveItem("k"));
		assert.strictEqual(warnings.length, 1);
		assert.match(warnMessages()[0], /safe-storage/);
		assert.match(warnMessages()[0], /removeItem/);
	});

	it("safeGetJSON returns the fallback instead of throwing and warns at most once on read failure", () => {
		assert.deepStrictEqual(safeGetJSON<string[]>("k", ["fallback"]), ["fallback"]);
		// The read failed inside safeGetItem (raw === null → fallback, no parse
		// branch), so exactly ONE warn must be emitted — never two.
		assert.strictEqual(warnings.length, 1);
		assert.match(warnMessages()[0], /safe-storage/);
		assert.match(warnMessages()[0], /getItem/);
	});
});

describe("safe-storage — round-trips when storage works", () => {
	let map: Map<string, string>;
	beforeEach(() => { map = installMapStorage(); });

	it("safeSetItem / safeGetItem round-trip without warning", () => {
		safeSetItem("hello", "world");
		assert.strictEqual(map.get("hello"), "world");
		assert.strictEqual(safeGetItem("hello"), "world");
		assert.deepStrictEqual(warnings, []);
	});

	it("safeGetJSON parses stored JSON without warning", () => {
		safeSetItem("ids", JSON.stringify(["a", "b"]));
		assert.deepStrictEqual(safeGetJSON<string[]>("ids", []), ["a", "b"]);
		assert.deepStrictEqual(warnings, []);
	});

	it("safeGetJSON falls back on corrupted JSON rather than throwing and warns once", () => {
		safeSetItem("ids", "{not valid json");
		assert.deepStrictEqual(safeGetJSON<string[]>("ids", []), []);
		// Storage read succeeded; only the parse branch warns → exactly one warn.
		assert.strictEqual(warnings.length, 1);
		assert.match(warnMessages()[0], /safe-storage/);
		assert.match(warnMessages()[0], /parse/);
	});

	it("safeRemoveItem deletes the key without warning", () => {
		safeSetItem("gone", "soon");
		safeRemoveItem("gone");
		assert.strictEqual(safeGetItem("gone"), null);
		assert.deepStrictEqual(warnings, []);
	});
});
