/**
 * Client-side pin for the goal-proposal form-mirror rehydrate fix.
 *
 * Contract under test (two production code paths in
 * `src/app/session-manager.ts`):
 *
 *   1. The unified `remote.onProposal` callback MUST mirror a rehydrated /
 *      updated goal proposal's `fields.{title,spec,cwd,workflow}` into the
 *      goal-assistant form-mirror state (`state.previewTitle` /
 *      `state.previewSpec` / `state.previewCwd` / selected workflow) when the
 *      active session is a goal assistant (`state.assistantType === "goal"`)
 *      and the user has not hand-edited the field.
 *
 *   2. The goal-draft `serialize()` MUST NOT persist an empty `previewSpec`
 *      over a still-populated `activeProposals.goal.fields.spec` (defence
 *      against the navigate-away/back debounce race that wrote a corrupt
 *      draft with `previewSpec:""`).
 *
 * Why this exists:
 *   The goal-assistant panel renders `state.previewSpec`, NOT the proposal
 *   slot (proposal-panels.ts `goalPreviewPanel` → `renderGoalForm`). Both
 *   rehydrate entry points — the `connectToSession` fast-path
 *   (`rehydrateProposalsForSession`) and the full-reload WS
 *   `proposal_update {source:"rehydrate"}` handler — funnel ONLY through the
 *   unified `onProposal` callback, never the legacy `onGoalProposal` that
 *   historically performed the form-mirror. Without (1) the panel shows
 *   "_No spec content yet_" after navigate-away/back even though the slot is
 *   intact; (2) stops a stale debounce timer from corrupting the on-disk
 *   draft so the safety-net `restoreGoalDraft` can't clobber the good body.
 *   The companion E2E `tests/e2e/ui/proposal-spec-survives-navigate.spec.ts`
 *   exercises the full user journey; this unit pin keeps both contracts
 *   testable at the layer where they're defined and immune to refactors that
 *   silently drop either mechanism (the E2E would still catch it, but slowly).
 *
 * Strategy — source-level guards. The production logic lives inside a closure
 * (`setupSessionSubscription` wires `remote.onProposal`) that reads global
 * `state` and a lazily-imported `setSelectedWorkflowId`, so a behavioural
 * unit harness would have to reconstruct most of the module. Instead we read
 * `session-manager.ts` off disk and assert the live code shape, mirroring the
 * existing source-level guard in `proposal-rehydrate-client.test.ts`.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

function readSessionManager(): string {
	return fs.readFileSync(
		path.join(process.cwd(), "src/app/session-manager.ts"),
		"utf-8",
	);
}

describe("unified onProposal — goal form-mirror invariant", () => {
	const src = readSessionManager();

	it("mirrors goal fields into the form-mirror when assistantType === 'goal'", () => {
		// Anchor on the gate that scopes the mirror to the goal assistant.
		const gateIdx = src.indexOf('if (type === "goal" && state.assistantType === "goal") {');
		assert.ok(
			gateIdx > 0,
			"unified onProposal must gate the goal form-mirror on assistantType === 'goal'",
		);

		// The mirror block must run AFTER the slot is committed so a dismissed
		// first-emit (which returns early before the slot assignment) never
		// reaches it.
		const slotAssignIdx = src.indexOf("state.activeProposals[type] = slot;");
		assert.ok(slotAssignIdx > 0, "could not find slot assignment");
		assert.ok(
			gateIdx > slotAssignIdx,
			"goal form-mirror must run AFTER state.activeProposals[type] = slot",
		);

		// Slice the mirror block and pin each mirrored field + hand-edit guard.
		const block = src.slice(gateIdx, gateIdx + 1200);
		assert.match(
			block,
			/!state\.previewTitleEdited[^\n]*state\.previewTitle\s*=\s*gf\.title/,
			"must mirror title into state.previewTitle when not hand-edited",
		);
		assert.match(
			block,
			/!state\.previewSpecEdited[^\n]*state\.previewSpec\s*=\s*gf\.spec/,
			"must mirror spec into state.previewSpec when not hand-edited",
		);
		assert.match(
			block,
			/!state\.previewCwdEdited[^\n]*state\.previewCwd\s*=\s*gf\.cwd/,
			"must mirror cwd into state.previewCwd when not hand-edited",
		);
		assert.match(
			block,
			/setSelectedWorkflowId\(gf\.workflow\)/,
			"must restore the selected workflow from the rehydrated proposal",
		);
	});
});

describe("goal-draft serialize — empty-spec guard invariant", () => {
	const src = readSessionManager();

	it("never persists an empty previewSpec over a populated slot spec", () => {
		// Anchor on the goal-draft serialize body's slot-fields read.
		const anchorIdx = src.indexOf(
			"const slotFields = (state.activeProposals.goal?.fields ?? {})",
		);
		assert.ok(
			anchorIdx > 0,
			"goal-draft serialize must read the live slot fields for the empty-spec guard",
		);

		const block = src.slice(anchorIdx, anchorIdx + 900);

		// The guard must prefer the slot spec only when previewSpec is empty,
		// the slot carries a spec, and the user has not hand-edited.
		assert.match(
			block,
			/!state\.previewSpecEdited[^\n]*!previewSpec[^\n]*slotFields\.spec[^\n]*previewSpec\s*=\s*slotFields\.spec/,
			"serialize must fall back to slotFields.spec when previewSpec is empty and not hand-edited",
		);

		// The returned draft must use the (possibly slot-backed) local, not the
		// raw global, so the guard actually takes effect.
		const returnIdx = block.indexOf("return {");
		assert.ok(returnIdx > 0, "serialize must return a draft object");
		const returned = block.slice(returnIdx, returnIdx + 400);
		assert.match(
			returned,
			/previewSpec\s*,/,
			"serialize must persist the guarded local previewSpec (shorthand), not state.previewSpec directly",
		);
	});
});
