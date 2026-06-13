/**
 * Sandbox clone-source resolution.
 *
 * Picks the source `git clone` uses *inside* the Linux sandbox container.
 *
 * The historical bug: when a project had no `origin` remote, the bootstrap
 * fell back to the raw HOST directory path as the clone URL. On Windows the
 * drive-letter path (`C:/Users/...`) is misparsed by git as scp/SSH syntax
 * (`host:path`) → `cannot run ssh` / `unable to fork`; on any OS the host path
 * is unreachable from inside the container.
 *
 * The fix: this resolver NEVER emits a raw host path as the clone URL, and
 * NEVER derives a bind-mount source from the `origin` value.
 * - With a network `origin` remote → clone the remote URL directly.
 * - With no origin → bind-mount the CALLER-supplied canonical main-repo root
 *   (`mountSourcePath`) at a fixed container path and clone from `file://`.
 *   The resolver never touches the filesystem and never derives any path from
 *   `origin` — this removes the entire local-origin→mount attack surface (an
 *   in-root symlink pointing outside can no longer escape, because no path is
 *   ever derived from `origin`).
 * - With a LOCAL origin (file://, absolute/relative/UNC/drive-letter path):
 *   THROW a clear, actionable error. A local origin cannot be cloned into the
 *   container (the host path is unreachable / a drive-letter is misparsed as
 *   scp), so the caller must configure a clonable network remote or remove the
 *   origin to fall back to the mounted project repo.
 *
 * SSH/scp/git-protocol remotes are normalized to HTTPS for the container: the
 * sandbox image has NO ssh client or keys, so an SSH origin (`git@host:o/r`,
 * `ssh://…`, `git://…`) would fail with `cannot run ssh: No such file or
 * directory`. Containers authenticate over HTTPS via the built-in credential
 * helper (`username=x-access-token` / `password=$GITHUB_TOKEN`), so every
 * non-HTTP(S) remote is rewritten to `https://host/owner/repo` before cloning.
 */

import { stripTokenFromGitUrl } from "../skills/git.js";

/** Fixed container-internal mount point for the remote-less bind-mount source. */
export const MOUNTED_SRC_PATH = "/workspace-src";
/** Clone URL git uses inside the container for the bind-mounted source. */
export const MOUNTED_SRC_CLONE_URL = "file:///workspace-src";

/**
 * Rewrite an SSH/scp/git-protocol remote to its `https://` equivalent so the
 * in-container HTTPS credential helper (`x-access-token` / `$GITHUB_TOKEN`) can
 * authenticate — the sandbox image has no ssh client or keys.
 *
 * Handles:
 * - scp-style `git@host:owner/repo(.git)` → `https://host/owner/repo(.git)`
 * - `ssh://git@host[:port]/owner/repo(.git)` → `https://host/owner/repo(.git)`
 *   (drops `user@` and any `:port`)
 * - `git+ssh://…` → `https://…`
 * - `git://host/…` → `https://host/…`
 * - already `http://` / `https://` → returned unchanged (passthrough)
 */
export function toHttpsCloneUrl(origin: string): string {
	const url = origin.trim();
	if (!url) return url;

	// Already HTTP(S) → passthrough unchanged.
	if (/^https?:\/\//i.test(url)) return url;

	// URL-scheme forms: ssh://, git+ssh://, git://, ssh+git://, …
	const schemeMatch = url.match(/^([a-z][a-z0-9+.-]*):\/\/(.*)$/i);
	if (schemeMatch) {
		const scheme = schemeMatch[1].toLowerCase();
		if (scheme === "ssh" || scheme === "git" || scheme.includes("ssh")) {
			let rest = schemeMatch[2];
			// Strip leading `user@`.
			const at = rest.indexOf("@");
			const firstSlash = rest.indexOf("/");
			if (at >= 0 && (firstSlash < 0 || at < firstSlash)) {
				rest = rest.slice(at + 1);
			}
			// Drop `:port` from the host segment (text before the first slash).
			const slash = rest.indexOf("/");
			if (slash >= 0) {
				const hostPart = rest.slice(0, slash).replace(/:\d+$/, "");
				rest = hostPart + rest.slice(slash);
			} else {
				rest = rest.replace(/:\d+$/, "");
			}
			return `https://${rest}`;
		}
		// Any other explicit scheme (file://, https already handled) → unchanged.
		return url;
	}

	// scp-style `[user@]host:owner/repo` (colon before first slash).
	const slashIdx = url.indexOf("/");
	const colonIdx = url.indexOf(":");
	if (colonIdx > 0 && (slashIdx < 0 || colonIdx < slashIdx)) {
		let host = url.slice(0, colonIdx);
		const path = url.slice(colonIdx + 1);
		const at = host.lastIndexOf("@");
		if (at >= 0) host = host.slice(at + 1);
		// A single-character host is a Windows drive letter, not an scp host —
		// leave it untouched (the resolver classifies it as local and throws).
		if (host.length > 1) {
			return `https://${host}/${path}`;
		}
	}

	return url;
}

export type SandboxCloneSource =
	| { kind: "remote"; cloneUrl: string }
	| { kind: "mounted"; hostPath: string; mountPath: string; cloneUrl: string };

/**
 * URL-scheme network remote git can reach from inside the container.
 * Case-insensitive. Anything matching this is treated as a network remote.
 */
const URL_SCHEME_RE = /^(https?|git|ssh|git\+ssh|ftp|ftps):\/\//i;

/**
 * Decide whether `origin` is a network remote, mirroring git's own heuristic.
 *
 * A remote is either:
 * - a URL with a recognised network scheme (`https://`, `ssh://`, …), OR
 * - scp-style `[user@]host:path`: a colon appears BEFORE the first `/`, and the
 *   host part (text before that colon, with any leading `user@` stripped) is
 *   NOT a single drive letter.
 *
 * The single-letter-host exclusion is what keeps a Windows drive path
 * (`C:/Users/...`) from being misparsed as an scp remote — git itself treats a
 * single-letter "host" before a colon as a local drive path, not a remote.
 */
function isNetworkRemote(origin: string): boolean {
	if (URL_SCHEME_RE.test(origin)) return true;
	// Any other explicit URL scheme (`file://`, …) is a URL form, not scp-style —
	// and not a network scheme we clone directly. Treat it as local.
	if (/^[a-z][a-z0-9+.-]*:\/\//i.test(origin)) return false;

	const slashIdx = origin.indexOf("/");
	const colonIdx = origin.indexOf(":");
	// scp-style requires a colon before the first slash (`host:path`).
	if (colonIdx < 0) return false;
	if (slashIdx >= 0 && slashIdx < colonIdx) return false;

	// Host part is everything before the colon, minus an optional `user@`.
	let host = origin.slice(0, colonIdx);
	const at = host.lastIndexOf("@");
	if (at >= 0) host = host.slice(at + 1);
	// A single-character host (e.g. `C` in `C:/...`) is a Windows drive letter,
	// not an scp host → local path, not a remote.
	if (host.length <= 1) return false;
	return host.length > 0;
}

/**
 * Resolve the clone source for a sandbox container.
 *
 * @param opts.originUrl       The project's `origin` remote URL (or null/empty/undefined when absent).
 * @param opts.mountSourcePath The CANONICAL main-repo working directory to bind-mount when origin
 *                             is absent. Required. The caller resolves this (see
 *                             `resolveSandboxMountRoot`) — the resolver NEVER derives a path from
 *                             `origin` and NEVER touches the filesystem.
 * @param opts.mountPath       Container-internal mount point (default `/workspace-src`). Multi-repo
 *                             callers pass a per-repo path like `/workspace-src/web`.
 *
 * Classification:
 * - A network remote (URL scheme or scp-style `[user@]host:path`) →
 *   `{ kind: "remote", cloneUrl: stripTokenFromGitUrl(origin) }`, cloned directly.
 * - Absent/empty origin → bind-mount `mountSourcePath` (the caller-canonicalized
 *   main repo root — always safe) and clone via `file://<mountPath>`.
 * - A LOCAL origin (file://, absolute/relative/UNC/drive-letter) → THROW. A local
 *   origin can never be cloned into the container.
 *
 * Invariant: the returned `cloneUrl` is NEVER a raw host path or a Windows
 * drive-letter string. It is always a network remote URL or `file://<mountPath>`.
 */
export function resolveSandboxCloneSource(opts: {
	originUrl?: string | null;
	mountSourcePath: string;
	mountPath?: string;
}): SandboxCloneSource {
	const origin = (opts.originUrl ?? "").trim();
	const mountPath = opts.mountPath ?? MOUNTED_SRC_PATH;
	const cloneUrl = `file://${mountPath}`;

	// Network remote → clone directly.
	if (origin && isNetworkRemote(origin)) {
		return { kind: "remote", cloneUrl: stripTokenFromGitUrl(toHttpsCloneUrl(origin)) };
	}

	// Absent origin → mount the caller-supplied canonical main repo root (the
	// sandbox's own source). No path is derived from `origin`, so an in-root
	// symlink can never be used to escape and bind-mount an arbitrary host path.
	if (!origin) {
		return { kind: "mounted", hostPath: opts.mountSourcePath, mountPath, cloneUrl };
	}

	// Non-empty LOCAL origin (file://, absolute/relative/UNC/drive-letter). We do
	// NOT mount anything derived from `origin` — bind-mounting an origin-derived
	// path is the attack surface this fix removes. A local origin cannot be
	// cloned into the container (host path unreachable; a drive-letter is
	// misparsed as scp), so fail fast with an actionable message.
	throw new Error(
		`[sandbox] origin "${origin}" is a local path, which cannot be cloned into the sandbox. ` +
			`Configure a clonable network remote (https/ssh), or remove the origin to use the ` +
			`project's own repository as the mounted clone source.`,
	);
}
