/**
 * Defensive localStorage wrappers.
 *
 * `localStorage.setItem` / `getItem` can THROW, not just no-op:
 *   - Quota exceeded (`QuotaExceededError`) once the origin's storage is full.
 *   - Storage disabled / partitioned (Safari private mode historically threw on
 *     every write; some embedded webviews and locked-down enterprise profiles
 *     deny access entirely so even reads throw `SecurityError`).
 *   - SSR / non-window contexts where `localStorage` is undefined.
 *
 * Persisted UI state (sidebar expand/collapse sets, widths, etc.) is a
 * convenience, never load-bearing. A storage failure must never abort a code
 * path — most dangerously the boot-critical `refreshSessions()` path, where a
 * thrown `setItem` used to bubble into `state.sessionsError` and render the raw
 * "Failed to execute 'setItem' on 'Storage'" string in the sidebar right before
 * the UI loaded.
 *
 * These helpers never let a storage exception escape so callers can treat
 * persistence as best-effort. Failures are not silent, though: each swallowed
 * exception is warn-logged (once per failed call) before the fallback is
 * returned, so quota/security/corruption problems stay observable in the
 * console without ever aborting a code path. This is the single source of
 * truth — prefer it over scattered inline `try { localStorage… } catch {}`
 * blocks.
 */

function hasLocalStorage(): boolean {
	try {
		return typeof localStorage !== "undefined";
	} catch {
		// Accessing `localStorage` itself can throw (SecurityError) in some
		// locked-down contexts. Deliberately silent: this probe (and the
		// SSR/`localStorage`-undefined early returns below) are EXPECTED,
		// non-error conditions that recur on every call in non-browser/SSR
		// contexts — warning here would spam the console. Only genuine
		// access failures inside the wrappers below are warn-logged.
		return false;
	}
}

/** Best-effort `localStorage.setItem`. Never throws. */
export function safeSetItem(key: string, value: string): void {
	if (!hasLocalStorage()) return;
	try {
		localStorage.setItem(key, value);
	} catch (err) {
		// Quota exceeded / storage disabled — persistence is best-effort.
		console.warn("[safe-storage] setItem(" + key + ") failed (persistence is best-effort):", err);
	}
}

/** Best-effort `localStorage.removeItem`. Never throws. */
export function safeRemoveItem(key: string): void {
	if (!hasLocalStorage()) return;
	try {
		localStorage.removeItem(key);
	} catch (err) {
		console.warn("[safe-storage] removeItem(" + key + ") failed (persistence is best-effort):", err);
	}
}

/** Best-effort `localStorage.getItem`. Returns `null` on any failure. */
export function safeGetItem(key: string): string | null {
	if (!hasLocalStorage()) return null;
	try {
		return localStorage.getItem(key);
	} catch (err) {
		console.warn("[safe-storage] getItem(" + key + ") failed (persistence is best-effort):", err);
		return null;
	}
}

/**
 * Read and JSON.parse a localStorage value, returning `fallback` if the key is
 * absent, storage is unavailable, or the stored value is corrupted (so a single
 * bad write can never break module load via an uncaught `SyntaxError`).
 */
export function safeGetJSON<T>(key: string, fallback: T): T {
	// Read delegates to `safeGetItem`, which already warns once on a storage
	// read failure (and returns null → fallback here, no extra warn). Only the
	// JSON.parse branch below adds its own warn, so corrupted JSON → 1 warn and
	// a read failure → 1 warn (never two).
	const raw = safeGetItem(key);
	if (raw === null) return fallback;
	try {
		return JSON.parse(raw) as T;
	} catch (err) {
		console.warn("[safe-storage] parse(" + key + ") failed (using fallback):", err);
		return fallback;
	}
}
