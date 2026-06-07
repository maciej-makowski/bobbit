/**
 * Reproducer — goal proposal panel renders empty after navigate-away/back.
 *
 * Manual repro (reported by user):
 *   1. Open a goal-assistant session; agent streams a `propose_goal`.
 *   2. (Optionally) add an inline comment on the spec.
 *   3. Navigate away (sidebar click, browser back, full reload — anywhere).
 *   4. Navigate back to the same session.
 *   5. Panel is still visible (correct), but the spec body is empty (BUG)
 *      and — if a comment was added — an "orphaned annotations" UI appears
 *      because the in-memory annotation cache survived but its anchored
 *      text didn't.
 *
 * This file pins the user-visible contract across THREE navigation shapes:
 *
 *   1. sidebar nav (the `connectToSession` fast-path — cached chatPanel reuse)
 *   2. full page reload (the slow-path fresh connect + WS-auth rehydrate)
 *   3. fast-path nav AFTER an inline comment — additionally asserts no
 *      "orphaned annotations" UI appears (the comment must re-anchor).
 *
 * Three plausible causes (the diagnostics dump below isolates which):
 *
 *   A) connectToSession fast-path (session-manager.ts) drops + re-fetches the
 *      proposal slot on switch-back, but the rehydrate path that repopulates
 *      it (`rehydrateProposalsForSession` → unified `onProposal`) restores
 *      `state.activeProposals.goal.fields` only and never touches the
 *      assistant form-mirror `state.previewSpec` that the rendered body is
 *      bound to.
 *
 *   B) The goal-assistant body is bound to `state.previewSpec`
 *      (proposal-panels.ts `goalPreviewPanel` → `renderGoalForm({ spec:
 *      state.previewSpec })`), NOT the non-assistant `_proposalSpec` mirror —
 *      so any `syncProposalFormState` identity-key staleness is downstream of
 *      whatever leaves `state.previewSpec` empty.
 *
 *   C) The on-disk persistence the restore paths read from is missing the
 *      spec:
 *        - the goal DRAFT (`GET /api/sessions/<sid>/draft?type=goal`,
 *          restored by `restoreGoalDraft` → `state.previewSpec`), and/or
 *        - the proposal FILE (`GET /api/sessions/<sid>/proposals`, restored
 *          by the rehydrate path → `state.activeProposals.goal.fields`).
 *
 * The rendered <commentable-markdown> `.markdown` property reflects
 * `state.previewSpec` (falling back to the "_No spec content yet_"
 * placeholder when empty), so the assertions read it directly. On failure
 * the `[DIAG]` block prints the rehydrate payload, the on-disk goal draft,
 * the live `state.activeProposals.goal.fields`, the live `state.previewSpec`
 * form-mirror, and the `previewSpecEdited` flag so we can pinpoint A/B/C.
 */
import { test, expect } from "../gateway-harness.js";
import type { Page } from "@playwright/test";
import { openApp, sendMessage, navigateToHash } from "./ui-helpers.js";
import { createSession, waitForHealth } from "../e2e-setup.js";

/** Open a goal-assistant session and drive a propose_goal. */
async function openGoalAssistantWithProposal(page: Page) {
	test.setTimeout(120_000);
	await openApp(page);
	const newGoalBtn = page.locator("button[title='New goal (Alt+G)']").first();
	await expect(newGoalBtn).toBeVisible({ timeout: 10_000 });
	await expect(newGoalBtn).toBeEnabled({ timeout: 10_000 });
	const sessionCreated = page.waitForResponse(
		(resp) =>
			resp.url().includes("/api/sessions") &&
			resp.request().method() === "POST" &&
			resp.ok(),
		{ timeout: 60_000 },
	);
	await newGoalBtn.click();
	await sessionCreated;
	await page.waitForURL(/#\/session\//, { timeout: 10_000 });
	const textarea = page.locator("textarea").first();
	await expect(textarea).toBeVisible({ timeout: 10_000 });
	await sendMessage(page, "Please create a GOAL_PROPOSAL for testing");
	const titleInput = page.locator("input[placeholder='Goal title']").first();
	await expect(titleInput).toBeVisible({ timeout: 20_000 });
	await expect(titleInput).toHaveValue("E2E Test Goal", { timeout: 15_000 });
	const goalPanel = page.locator('[data-panel="goal-proposal"]').first();
	await expect(goalPanel).toBeVisible({ timeout: 10_000 });
	return goalPanel;
}

/** Read the current spec text shown inside the proposal panel's <commentable-markdown>. */
async function getRenderedSpecText(page: Page): Promise<string> {
	return page.evaluate(() => {
		const cm = document.querySelector("commentable-markdown");
		if (!cm) return "<<no commentable-markdown>>";
		// markdown is set as a property; reflect from the live DOM.
		const md = (cm as any).markdown ?? "<<no .markdown property>>";
		return md as string;
	});
}

/**
 * Pull both server-side persistence stores AND the live in-memory state so a
 * single dump isolates A vs B vs C. Runs inside the page so it reuses the
 * authenticated gateway origin + token (mirrors `gatewayFetch`).
 */
async function captureDiagnostics(page: Page, sid: string): Promise<Record<string, unknown>> {
	return page.evaluate(async (sid) => {
		const url = localStorage.getItem("gateway.url") || window.location.origin;
		const token = localStorage.getItem("gateway.token") || "";
		const gf = async (path: string) => {
			try {
				const r = await fetch(`${url}${path}`, {
					headers: { Authorization: `Bearer ${token}` },
				});
				if (!r.ok) return { __status: r.status };
				return await r.json();
			} catch (e) {
				return { __err: String(e) };
			}
		};
		const proposalsPayload = await gf(`/api/sessions/${sid}/proposals`);
		const draftEnvelope: any = await gf(`/api/sessions/${sid}/draft?type=goal`);
		const onDiskDraft = draftEnvelope && typeof draftEnvelope === "object" && "data" in draftEnvelope
			? draftEnvelope.data
			: draftEnvelope;
		const s = (window as any).bobbitState;
		const slot = s?.activeProposals?.goal;
		const cm = document.querySelector("commentable-markdown") as any;
		const specOf = (v: unknown) =>
			typeof v === "string" ? { len: v.length, preview: v.slice(0, 80) } : v ?? null;
		return {
			// (C) proposal FILE — what the rehydrate path reads.
			rehydratePayload: proposalsPayload,
			// (C) goal DRAFT — what restoreGoalDraft reads.
			onDiskGoalDraft_previewSpec: specOf(onDiskDraft?.previewSpec),
			onDiskGoalDraft_activeGoalProposalSpec: specOf(onDiskDraft?.activeGoalProposal?.fields?.spec),
			onDiskGoalDraft_keys: onDiskDraft && typeof onDiskDraft === "object" ? Object.keys(onDiskDraft) : null,
			// (A) live proposal slot fields (rehydrate target).
			liveSlotSpec: specOf(slot?.fields?.spec),
			liveSlotTitle: slot?.fields?.title ?? null,
			// (A/B) live form-mirror — the rendered body is bound to THIS.
			statePreviewSpec: specOf(s?.previewSpec),
			statePreviewSpecEdited: s?.previewSpecEdited ?? null,
			stateAssistantType: s?.assistantType ?? null,
			// rendered DOM
			renderedMarkdown: specOf(cm?.markdown),
		};
	}, sid);
}

/**
 * Poll the rendered spec body until it equals `expected`. On timeout, dump
 * the A/B/C diagnostics to the Node-side test log and re-throw the ORIGINAL
 * assertion error (so the failure message stays about the assertion, not the
 * diagnostics fetch).
 */
async function expectSpecRestored(
	page: Page,
	sid: string,
	expected: string,
	label: string,
): Promise<void> {
	try {
		await expect(async () => {
			const rendered = await getRenderedSpecText(page);
			expect(rendered, "rendered markdown after nav-back").toBe(expected);
		}).toPass({ timeout: 15_000, intervals: [500, 1000, 2000] });
	} catch (err) {
		try {
			const diag = await captureDiagnostics(page, sid);
			// eslint-disable-next-line no-console
			console.log(`\n[DIAG ${label}]\n${JSON.stringify(diag, null, 2)}\n`);
		} catch (diagErr) {
			// eslint-disable-next-line no-console
			console.log(`\n[DIAG ${label}] capture failed: ${String(diagErr)}\n`);
		}
		throw err;
	}
}

test.describe("Goal proposal spec survives navigate-away/back", () => {
	test.beforeAll(async () => {
		await waitForHealth();
	});

	test("@repro spec body persists after sidebar nav + return", async ({ page }) => {
		await openGoalAssistantWithProposal(page);

		// Capture the spec body the user is about to comment on. This is
		// the rendered <commentable-markdown>'s `markdown` property which
		// reflects the LIVE form-mirror state (`state.previewSpec`).
		const originalSpec = await getRenderedSpecText(page);
		expect(originalSpec.length, "proposal spec must be non-empty before nav").toBeGreaterThan(20);

		// Capture the active session ID (target of nav-back).
		const sidA = await page.evaluate(
			() => (window as any).bobbitState?.selectedSessionId as string | null,
		);
		expect(sidA, "must have an active session id").toBeTruthy();

		// Create a second session to nav AWAY to (avoids the pure-reload
		// path; this exercises the connectToSession fast-path the manual
		// repro hits).
		const sidB = await createSession();

		// Navigate to session B.
		await navigateToHash(page, `#/session/${sidB}`);
		await expect(page.locator("textarea").first()).toBeVisible({ timeout: 15_000 });

		// Navigate back to session A.
		await navigateToHash(page, `#/session/${sidA!}`);
		await expect(page.locator("textarea").first()).toBeVisible({ timeout: 15_000 });

		// Wait for the goal-proposal panel to re-render. The fast-path
		// rehydrate is fire-and-forget; we poll the rendered markdown body
		// directly until it matches the pre-nav value.
		const panelAfter = page.locator('[data-panel="goal-proposal"]').first();
		await expect(panelAfter).toBeVisible({ timeout: 15_000 });

		await expectSpecRestored(page, sidA!, originalSpec, "fast-path/sidebar-nav");
	});

	test("@repro spec body persists after full page reload", async ({ page }) => {
		await openGoalAssistantWithProposal(page);

		const originalSpec = await getRenderedSpecText(page);
		expect(originalSpec.length, "proposal spec must be non-empty before reload").toBeGreaterThan(20);

		const sidA = await page.evaluate(
			() => (window as any).bobbitState?.selectedSessionId as string | null,
		);
		expect(sidA, "must have an active session id").toBeTruthy();

		// Full reload — exercises the slow-path fresh connect + the WS-auth
		// `proposal_update {source:"rehydrate"}` broadcast (a different
		// restore path than the fast-path REST rehydrate above).
		await page.reload();
		await expect(
			page.locator("button").filter({ hasText: "Settings" }).first(),
		).toBeVisible({ timeout: 20_000 });
		await page.waitForFunction(
			(sid) => (window as any).bobbitState?.selectedSessionId === sid,
			sidA,
			{ timeout: 20_000 },
		);

		const panelAfter = page.locator('[data-panel="goal-proposal"]').first();
		await expect(panelAfter).toBeVisible({ timeout: 20_000 });

		await expectSpecRestored(page, sidA!, originalSpec, "full-reload");
	});

	test("@repro inline comment re-anchors after nav + no orphaned-annotations UI", async ({ page }) => {
		const panel = await openGoalAssistantWithProposal(page);

		const originalSpec = await getRenderedSpecText(page);
		expect(originalSpec.length, "proposal spec must be non-empty before nav").toBeGreaterThan(20);

		const sidA = await page.evaluate(
			() => (window as any).bobbitState?.selectedSessionId as string | null,
		);
		expect(sidA, "must have an active session id").toBeTruthy();

		// Add an inline comment anchored to a phrase the spec body contains.
		// Mirrors proposal-inline-comments.spec.ts::injectAnnotation — drives
		// the same backend + annotation-change event the popover-submit path
		// emits (driving real text-annotator selection is too flaky for E2E).
		await page.evaluate(() => {
			const sid = (window as any).bobbitState?.selectedSessionId as string;
			if (!sid) throw new Error("no active session id");
			const cm: any = document.querySelector("commentable-markdown");
			if (!cm) throw new Error("no <commentable-markdown> in DOM");
			const rd: any = cm.querySelector("review-document");
			if (!rd) throw new Error("no <review-document> inside <commentable-markdown>");
			const backend = rd.backend;
			if (!backend) throw new Error("review-document.backend missing");
			const bucket = "proposal:goal";
			const quote = "test goal created";
			const md = (window as any).bobbitState?.activeProposals?.goal?.fields?.spec ?? "";
			const start = md.indexOf(quote);
			const ann = {
				id: `e2e-ann-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
				quote,
				comment: "Please clarify this sentence",
				start: start >= 0 ? start : 0,
				end: start >= 0 ? start + quote.length : quote.length,
			};
			backend.add({ sessionId: sid, bucket }, ann);
			cm.dispatchEvent(
				new CustomEvent("annotation-change", {
					detail: { count: backend.count({ sessionId: sid, bucket }) },
					bubbles: true,
					composed: true,
				}),
			);
		});

		// The comment badge confirms the annotation registered.
		await expect(panel.locator('[data-testid="proposal-comment-count"]')).toBeVisible({
			timeout: 5_000,
		});

		// Nav away (fast-path) and back.
		const sidB = await createSession();
		await navigateToHash(page, `#/session/${sidB}`);
		await expect(page.locator("textarea").first()).toBeVisible({ timeout: 15_000 });
		await navigateToHash(page, `#/session/${sidA!}`);
		await expect(page.locator("textarea").first()).toBeVisible({ timeout: 15_000 });

		const panelAfter = page.locator('[data-panel="goal-proposal"]').first();
		await expect(panelAfter).toBeVisible({ timeout: 15_000 });

		// 1. Spec body must come back (so the annotation has text to anchor to).
		await expectSpecRestored(page, sidA!, originalSpec, "inline-comment/fast-path");

		// 2. No "orphaned annotations" UI: the comment must re-anchor against
		//    the restored body. On the buggy path the body is empty, the quote
		//    can't be found, and the annotation falls into the "Detached
		//    Comments" list with an "… orphaned" re-anchor banner.
		await expect(
			page.locator(".review-detached"),
			"orphaned-annotations UI must not appear after nav-back",
		).toHaveCount(0, { timeout: 5_000 });
	});
});
