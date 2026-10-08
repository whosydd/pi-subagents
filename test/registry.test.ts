import assert from "node:assert/strict";
import test from "node:test";
import { AgentRegistry, BACKGROUND_NOTIFICATION_DELIVERY, claimUsageReport, formatBackgroundNotification, formatRunResult, mergeWarnings, newAgentRecord } from "../extensions/lib/registry.ts";
import { EMPTY_USAGE, type AgentRecord } from "../extensions/lib/types.ts";

function record(id: string, status: AgentRecord["status"], startedAt: number): AgentRecord {
	return {
		id,
		type: "general",
		description: id,
		prompt: "do the thing",
		status,
		startedAt,
		turns: 0,
		usage: { ...EMPTY_USAGE },
	};
}

test("AgentRegistry evicts the oldest finished records and keeps running ones", () => {
	const registry = new AgentRegistry(2);
	registry.add(record("running", "running", 0));
	registry.add(record("old", "completed", 1));
	registry.add(record("new", "completed", 2));

	assert.equal(registry.get("old"), undefined, "oldest finished record is evicted first");
	assert.ok(registry.get("new"));
	assert.ok(registry.get("running"), "a running agent is never evicted");
});

test("AgentRegistry keeps everything under the cap", () => {
	const registry = new AgentRegistry(10);
	registry.add(record("a", "completed", 0));
	registry.add(record("b", "completed", 1));
	assert.equal(registry.all().length, 2);
});

test("formatRunResult reports the model, its reason and the thinking level", () => {
	const base = record("sa_1", "completed", Date.now());
	const finished: AgentRecord = {
		...base,
		completedAt: base.startedAt + 5_000,
		turns: 3,
		modelName: "haiku 4.5",
		modelReason: 'agent "auditor" model',
		thinking: "off",
		result: "all clear",
	};
	const text = formatRunResult(finished);
	assert.match(text, /Sub-agent completed: general · haiku 4\.5 \(agent "auditor" model\) · thinking off · 3 turns/);
	assert.match(text, /all clear/);
});

test("formatRunResult names the abort reason instead of guessing", () => {
	const turnLimit = formatRunResult({ ...record("sa_2", "aborted", Date.now()), abortReason: "turn-limit" });
	assert.match(turnLimit, /aborted \(turn limit reached\)/);
	const timeout = formatRunResult({ ...record("sa_3", "aborted", Date.now()), abortReason: "timeout" });
	assert.match(timeout, /aborted \(timeout\)/);
	const parent = formatRunResult({ ...record("sa_4", "aborted", Date.now()), abortReason: "parent" });
	assert.match(parent, /Sub-agent aborted:/);
});

test("formatRunResult reports failures and warnings", () => {
	const failed = formatRunResult({
		...record("sa_5", "failed", Date.now()),
		error: "provider exploded",
		warnings: ["/tmp/x.ts failed in session_start: boom"],
	});
	assert.match(failed, /Sub-agent failed/);
	assert.match(failed, /Error: provider exploded/);
	assert.match(failed, /Warnings:/);
	assert.match(failed, /session_start: boom/);
});

test("formatRunResult caps the inline result and points at the full text", () => {
	const huge = formatRunResult({ ...record("sa_6", "completed", Date.now()), result: "x".repeat(9000) });
	assert.match(huge, /Truncated at 8000 characters/);
	assert.match(huge, /get_subagent_result/);
	assert.ok(huge.length < 9000, "the inline result stays capped");
});

test("formatRunResult honours a wider full-text cap than the inline one", () => {
	const finished = { ...record("sa_8", "completed", Date.now()), result: "x".repeat(9_000) };
	const inline = formatRunResult(finished, { maxChars: 8_000, fullOutputAvailable: true });
	const full = formatRunResult(finished, { maxChars: 100_000, fullOutputAvailable: false });
	assert.match(inline, /Truncated at 8000 characters; read the full output with get_subagent_result\./);
	assert.doesNotMatch(full, /Truncated/, "the escape hatch actually returns more than the inline result");
	assert.ok(full.length > inline.length);
});

test("formatRunResult stops pointing at the escape hatch when it is not one", () => {
	const text = formatRunResult({ ...record("sa_9", "completed", Date.now()), result: "x".repeat(2_000) }, { maxChars: 100, fullOutputAvailable: false });
	assert.match(text, /Truncated at 100 characters, which is the configured full-output limit\./);
	assert.doesNotMatch(text, /get_subagent_result/, "pointing at a reader with the same cap is a dead end");
});

test("newAgentRecord keeps a long prompt truncated and a short one whole", () => {
	const short = newAgentRecord({ type: "general", description: "d", prompt: "short", modelReason: "parent session model", maxPromptChars: 10 });
	assert.equal(short.prompt, "short");
	assert.equal(short.status, "running");
	assert.equal(short.usageReported, undefined);

	const long = newAgentRecord({ type: "general", description: "d", prompt: "y".repeat(1_000), modelReason: "parent session model", maxPromptChars: 10 });
	assert.equal(long.prompt.length, "y".repeat(10).length + " […990 more characters]".length);
	assert.ok(!long.id.startsWith("y"), "the retained prefix is the prompt, not the id");
});

test("claimUsageReport lets exactly one read report a run's usage", () => {
	const run = record("sa_11", "completed", Date.now());
	assert.equal(claimUsageReport(run), true, "the first read of a detached run carries its tokens");
	assert.equal(run.usageReported, true);
	assert.equal(claimUsageReport(run), false, "a re-read must not count the same spend twice");
	assert.equal(claimUsageReport(run), false);
});

test("claimUsageReport declines a run whose usage the Agent call already reported", () => {
	const run = { ...record("sa_12", "completed", Date.now()), usageReported: true };
	assert.equal(claimUsageReport(run), false, "a blocking run was already counted at the spawn");
});

test("formatBackgroundNotification caps its excerpt at the configured length", () => {
	const finished: AgentRecord = {
		...record("sa_10", "completed", Date.now()),
		completedAt: Date.now() + 1_000,
		result: "z".repeat(5_000),
	};
	assert.match(formatBackgroundNotification(finished, 100), /\[…truncated\]/);
	assert.doesNotMatch(formatBackgroundNotification(finished, 10_000), /\[…truncated\]/);
});

test("mergeWarnings keeps pre-run and run warnings in order", () => {
	assert.deepEqual(mergeWarnings(["agent file warning"], ["extension load error"]), ["agent file warning", "extension load error"]);
});

test("mergeWarnings keeps whichever side is present", () => {
	assert.deepEqual(mergeWarnings(["agent file warning"], undefined), ["agent file warning"], "a run without warnings must not erase the seeded ones");
	assert.deepEqual(mergeWarnings(undefined, ["extension load error"]), ["extension load error"]);
});

test("mergeWarnings collapses an empty result back to undefined", () => {
	assert.equal(mergeWarnings(undefined, undefined), undefined);
	assert.equal(mergeWarnings([], []), undefined);
});

test("formatBackgroundNotification points at the full result by id", () => {
	const finished: AgentRecord = {
		...record("sa_7", "completed", Date.now()),
		completedAt: Date.now() + 1_000,
		turns: 2,
		modelName: "haiku 4.5",
		modelReason: "explicit model parameter",
		thinking: "low",
		result: "found it",
	};
	const text = formatBackgroundNotification(finished);
	assert.match(text, /Background sub-agent "sa_7" \(general\) completed/);
	assert.match(text, /Model: haiku 4\.5 \(explicit model parameter\) · thinking low/);
	assert.match(text, /Turns: 2/);
	assert.match(text, /found it/);
	assert.match(text, /agent_id "sa_7"/);
});

test("formatBackgroundNotification asks the parent to reconcile an earlier answer", () => {
	// The notification is injected before the parent's next model request; a
	// report the parent wrote earlier must not be left standing as final.
	const finished: AgentRecord = { ...record("sa_8", "completed", Date.now()), completedAt: Date.now() + 1_000, result: "late" };
	assert.match(formatBackgroundNotification(finished), /reconcile that answer with this result/);
});

test("a background notification steers rather than follows up", () => {
	// `followUp` is only drained once the parent would stop, so the notification
	// would always land after the report it was meant to inform. The delivery
	// mode is the whole fix: keep it on `steer`.
	assert.deepEqual(BACKGROUND_NOTIFICATION_DELIVERY, { deliverAs: "steer", triggerTurn: true });
});
