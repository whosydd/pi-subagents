import assert from "node:assert/strict";
import test from "node:test";
import { addReportedCost, assistantTextOf, buildSystemPrompt, looksLikeAgentTool, providerFailureOf } from "../extensions/lib/session.ts";
import { EMPTY_USAGE, type UsageTotals } from "../extensions/lib/types.ts";

test("providerFailureOf surfaces a rejected request from the fields pi never throws", () => {
	// The shape a 403 lands on: stopReason "error", an empty content array, and
	// zero usage. Without this reader the run reports as completed with nothing.
	const failed = { stopReason: "error", errorMessage: '403 {"type":"error","message":"Model access is disabled"}', content: [] };
	assert.equal(providerFailureOf(failed), '403 {"type":"error","message":"Model access is disabled"}');
});

test("providerFailureOf treats an error without a message as a failure", () => {
	assert.equal(providerFailureOf({ stopReason: "error" }), "the model request failed");
	assert.equal(providerFailureOf({ stopReason: "error", errorMessage: "   " }), "the model request failed");
	assert.equal(providerFailureOf({ stopReason: "error", errorMessage: 42 }), "the model request failed");
});

test("providerFailureOf leaves finished and aborted turns unfailed", () => {
	// "aborted" is our own cancel, and its reason belongs to abortReason, not to
	// the error field — reporting it as a provider failure would mislabel it.
	for (const stopReason of ["stop", "toolUse", "length", "aborted"]) {
		assert.equal(providerFailureOf({ stopReason, content: [] }), undefined);
	}
	assert.equal(providerFailureOf({}), undefined);
	assert.equal(providerFailureOf(undefined), undefined);
});

test("assistantTextOf joins text parts and ignores other content", () => {
	const text = assistantTextOf({
		content: [{ type: "text", text: "Found it: " }, { type: "toolCall", name: "read" }, { type: "text", text: "/tmp/a.md" }],
	});
	assert.equal(text, "Found it: /tmp/a.md");
});

test("assistantTextOf returns empty when a message carries no text", () => {
	assert.equal(assistantTextOf({ content: [{ type: "toolCall", name: "read" }] }), "");
	assert.equal(assistantTextOf({ content: [] }), "");
	assert.equal(assistantTextOf({}), "");
	assert.equal(assistantTextOf(undefined), "");
	assert.equal(assistantTextOf({ content: "not-an-array" }), "");
});

test("assistantTextOf trims and ignores non-string text parts", () => {
	assert.equal(assistantTextOf({ content: [{ type: "text", text: "  hi  " }, { type: "text", text: 42 }] }), "hi");
});

test("addReportedCost sums the components when a provider reports no total", () => {
	const usage: UsageTotals = { ...EMPTY_USAGE };
	addReportedCost(usage, { input: 0.5, output: 2, cacheRead: 0.25, cacheWrite: 1 });
	assert.equal(usage.cost, 3.75, "a zero total must not make the run look free");
	assert.equal(usage.costInput, 0.5);
	assert.equal(usage.costOutput, 2);
	assert.equal(usage.costCacheRead, 0.25);
	assert.equal(usage.costCacheWrite, 1);
});

test("addReportedCost keeps a provider's total and accumulates across messages", () => {
	const usage: UsageTotals = { ...EMPTY_USAGE };
	// Each message is priced by the model that answered it, so a run on a
	// different model than its parent's still sums to what it actually cost.
	addReportedCost(usage, { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 });
	assert.equal(usage.cost, 10, "the provider's own total wins");
	addReportedCost(usage, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.5 });
	assert.equal(usage.cost, 10.5, "totals accumulate rather than being re-priced");
	assert.equal(usage.costInput, 1);
});

test("addReportedCost treats a missing cost as no charge, not as a crash", () => {
	const usage: UsageTotals = { ...EMPTY_USAGE };
	addReportedCost(usage, undefined);
	assert.equal(usage.cost, 0);
	assert.equal(usage.costInput, 0, "the components settle at zero rather than staying unset");
});

test("buildSystemPrompt scopes the child, names the cwd and inlines agent instructions", () => {
	const prompt = buildSystemPrompt(
		{ name: "auditor", description: "", systemPrompt: "Audit everything.", tools: ["read"] },
		"/tmp/project",
	);
	assert.match(prompt, /pi sub-agent/);
	assert.match(prompt, /sub_agent_context/);
	assert.match(prompt, /Working directory: \/tmp\/project/);
	assert.match(prompt, /<agent_instructions>\nAudit everything\.\n<\/agent_instructions>/);
});

test("buildSystemPrompt omits the instructions block for an agent without a body", () => {
	const prompt = buildSystemPrompt({ name: "general", description: "", systemPrompt: "" }, "/tmp");
	assert.doesNotMatch(prompt, /agent_instructions/);
});

test("buildSystemPrompt recommends the dedicated tools an agent actually has", () => {
	const prompt = buildSystemPrompt(
		{ name: "explore", description: "", systemPrompt: "", tools: ["read", "grep", "find", "ls"] },
		"/tmp",
	);
	assert.match(prompt, /Use the grep tool instead of bash grep\/rg/);
	assert.match(prompt, /Use the find tool instead of bash find\/ls/);
});

test("buildSystemPrompt does not recommend tools outside the agent's set", () => {
	// A default-tool agent (no `tools:` list) runs on read/bash/edit/write —
	// there is no grep or find tool to switch to, and the advice must not
	// send it hunting for one.
	const prompt = buildSystemPrompt({ name: "general", description: "", systemPrompt: "" }, "/tmp");
	assert.doesNotMatch(prompt, /Use the grep tool instead of bash grep\/rg/);
	assert.doesNotMatch(prompt, /Use the find tool instead of bash find\/ls/);
	assert.match(prompt, /Use the read tool instead of cat\/head\/tail/);
});

test("looksLikeAgentTool flags names that launch agents, camelCase included", () => {
	for (const name of ["Agent", "agent", "subagent", "sub-agent", "sub_agent", "get_subagent_result", "SpawnAgent", "MyAgentsTool", "agents_md"]) {
		assert.ok(looksLikeAgentTool(name), `expected "${name}" to look like an agent tool`);
	}
});

test("looksLikeAgentTool leaves names that merely contain agent-ish letters alone", () => {
	for (const name of ["useragent", "page", "manage", "delegation"]) {
		assert.equal(looksLikeAgentTool(name), false, `expected "${name}" not to look like an agent tool`);
	}
});
