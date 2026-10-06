/**
 * Coverage for the run-failure path: which message decides the outcome, and
 * what the record ends up carrying.
 *
 * These drive `foldAssistantMessage` — the same reducer `runAgent` runs for
 * every assistant `message_end` — over the exact message shapes pi emits, so
 * the wiring is tested rather than a copy of it. `runAgent` itself builds a
 * live session and cannot run without a model, which the no-network rule for
 * tests puts out of reach; what it does around the fold (assign on every
 * message, `error: resolveRunFailure(thrown, folded)`) is what these cases
 * hold it to.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { assistantTextOf, foldAssistantMessage, providerFailureOf, resolveRunFailure, type RunFold } from "../extensions/lib/session.ts";
import { EMPTY_USAGE } from "../extensions/lib/types.ts";

/** A run's fold before any message arrives — the state `runAgent` starts from. */
const emptyFold = (): RunFold => ({ text: "", usage: { ...EMPTY_USAGE } });

/** Feed `messages` through the reducer exactly as the subscription does. */
function foldMessages(messages: unknown[]): RunFold {
	const fold = emptyFold();
	for (const message of messages) {
		if ((message as { role?: string }).role !== "assistant") continue;
		foldAssistantMessage(fold, message);
	}
	return fold;
}

const assistant = (fields: Record<string, unknown>): Record<string, unknown> => ({ role: "assistant", content: [], ...fields });

test("error promotion trims surrounding whitespace off errorMessage", () => {
	const message = assistant({ stopReason: "error", errorMessage: "  429 rate limited  \n" });
	assert.equal(providerFailureOf(message), "429 rate limited");
	assert.equal(foldMessages([message]).error, "429 rate limited");
});

test("error promotion ignores a case-variant stopReason", () => {
	// The comparison is strictly against pi's own spelling; "Error" is a
	// near-miss string, not the failure pi encodes.
	const message = assistant({ stopReason: "Error", errorMessage: "boom" });
	assert.equal(providerFailureOf(message), undefined);
	assert.equal(foldMessages([message]).error, undefined);
});

test("error promotion falls back when the errorMessage key is absent", () => {
	const message = assistant({ stopReason: "error" });
	assert.equal(providerFailureOf(message), "the model request failed");
	assert.equal(foldMessages([message]).error, "the model request failed");
});

test("a cancelled run is not a provider failure", () => {
	// pi synthesizes `stopReason: "aborted"` for a cancelled run, with an empty
	// text part and an errorMessage. The reason belongs to abortReason, which
	// outranks an error in the record, so promoting it here would mislabel a
	// parent cancel as a model failure.
	const message = assistant({ stopReason: "aborted", errorMessage: "Aborted", content: [{ type: "text", text: "" }] });
	assert.equal(providerFailureOf(message), undefined);
	assert.equal(foldMessages([message]).error, undefined);
});

test("a failure after a success is the error the run reports (last-wins)", () => {
	const fold = foldMessages([
		assistant({ stopReason: "stop", content: [{ type: "text", text: "all done" }] }),
		assistant({ stopReason: "error", errorMessage: "500 upstream error" }),
	]);
	assert.equal(fold.error, "500 upstream error");
	assert.equal(fold.text, "all done", "the erroring message must not blank the last real answer");
	// The record this produces is failed with a body, which is the truth: the
	// child got an answer out before the provider cut it off.
	assert.equal(resolveRunFailure(undefined, fold.error), "500 upstream error");
});

test("a success after a failure clears the error (pi's internal recovery)", () => {
	// pi retries a transient error inside one prompt(); the retry's message is
	// what the run ends on, and a recovered run must not be reported failed.
	const fold = foldMessages([
		assistant({ stopReason: "error", errorMessage: "503 unavailable" }),
		assistant({ stopReason: "stop", content: [{ type: "text", text: "recovered" }] }),
	]);
	assert.equal(fold.error, undefined);
	assert.equal(fold.text, "recovered");
});

test("a text-less toolCall message keeps the text and still promotes the error", () => {
	const failingToolTurn = assistant({ stopReason: "error", errorMessage: "tool turn failed", content: [{ type: "toolCall", name: "read" }] });
	const fold = foldMessages([assistant({ stopReason: "toolUse", content: [{ type: "text", text: "looking" }] }), failingToolTurn]);
	assert.equal(fold.text, "looking", "a text-less turn must not blank the collected text");
	assert.equal(fold.error, "tool turn failed");

	const alone = foldMessages([failingToolTurn]);
	assert.equal(alone.text, "");
	assert.equal(alone.error, "tool turn failed");
});

test("non-assistant message_end events never touch the promoted error", () => {
	// runAgent's branch is gated on role === "assistant"; a trailing tool
	// message must not clear a promoted failure.
	const fold = foldMessages([
		assistant({ stopReason: "error", errorMessage: "401 unauthorized" }),
		{ role: "tool", content: [{ type: "text", text: "noise" }] },
	]);
	assert.equal(fold.error, "401 unauthorized");
});

test("the fold accumulates usage across messages, failed ones included", () => {
	const fold = foldMessages([
		assistant({ stopReason: "error", errorMessage: "500", usage: { input: 100, output: 0, cost: { input: 0.1, output: 0, total: 0.1 } } }),
		assistant({ stopReason: "stop", content: [{ type: "text", text: "ok" }], usage: { input: 50, output: 10, cost: { input: 0.05, output: 0.01, total: 0.06 } } }),
	]);
	assert.equal(fold.usage.input, 150);
	assert.equal(fold.usage.output, 10);
	assert.equal(fold.usage.cost, 0.16, "a rejected request still bills the tokens it read");
});

test("resolveRunFailure keeps a throw from going quiet as an empty string", () => {
	// The hole that classifies a failed run as completed: `prompt()` rejecting
	// with an empty message, an error the record's truthiness check reads as
	// success.
	assert.equal(resolveRunFailure("", "403 access disabled"), "403 access disabled", "an empty throw yields to the provider's message");
	assert.equal(resolveRunFailure(""), "the sub-agent run failed", "an empty throw with nothing else to say still fails");
	assert.equal(resolveRunFailure("boom", "403 access disabled"), "boom", "a real throw is the louder source");
	assert.equal(resolveRunFailure("   "), "the sub-agent run failed");
	assert.equal(resolveRunFailure(undefined, undefined), undefined, "no throw and no failed message is a clean run");
	assert.equal(resolveRunFailure(undefined, "403 access disabled"), "403 access disabled");
});

test("assistantTextOf and the fold agree on what counts as text", () => {
	const message = assistant({ stopReason: "stop", content: [{ type: "text", text: " answer " }, { type: "thinking", text: "hmm" }] });
	assert.equal(assistantTextOf(message), "answer");
	assert.equal(foldMessages([message]).text, "answer");
});
