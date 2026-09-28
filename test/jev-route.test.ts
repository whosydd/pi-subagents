import assert from "node:assert/strict";
import test from "node:test";
import { judgeModelRoute } from "../extensions/lib/jev/route.ts";

function jsonResponse(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const CANDIDATES = [
	{ key: "anthropic/claude-haiku-4-5", label: "haiku (anthropic)" },
	{ key: "anthropic/claude-sonnet-4-5", label: "sonnet (anthropic)" },
];

test("judgeModelRoute skips the call with fewer than two candidates", async () => {
	let called = false;
	const fetchImpl = (async () => {
		called = true;
		return jsonResponse(200, { answers: {} });
	}) as typeof fetch;
	const decision = await judgeModelRoute({
		apiKey: "key",
		task: "task",
		agentType: "general",
		candidates: [CANDIDATES[0]],
		fetchImpl,
	});
	assert.equal(decision, undefined);
	assert.equal(called, false);
});

test("judgeModelRoute honors a confident pick", async () => {
	const fetchImpl = (async () =>
		jsonResponse(200, {
			answers: {
				model: {
					type: "choice",
					choice: "anthropic/claude-haiku-4-5",
					probabilities: { "anthropic/claude-haiku-4-5": 0.82, "anthropic/claude-sonnet-4-5": 0.18 },
					confidence: 0.9,
				},
			},
			model: "jev-test",
		})) as typeof fetch;

	const decision = await judgeModelRoute({
		apiKey: "key",
		task: "summarize a file",
		agentType: "general",
		candidates: CANDIDATES,
		parentKey: "anthropic/claude-sonnet-4-5",
		fetchImpl,
	});
	assert.equal(decision?.chosen, "anthropic/claude-haiku-4-5");
	assert.match(decision?.verdict ?? "", /model: anthropic\/claude-haiku-4-5/);
});

test("judgeModelRoute withholds a low-probability pick but keeps the verdict", async () => {
	const fetchImpl = (async () =>
		jsonResponse(200, {
			answers: {
				model: {
					type: "choice",
					choice: "anthropic/claude-haiku-4-5",
					probabilities: { "anthropic/claude-haiku-4-5": 0.4, "anthropic/claude-sonnet-4-5": 0.35 },
					confidence: 0.3,
				},
			},
		})) as typeof fetch;

	const decision = await judgeModelRoute({ apiKey: "key", task: "task", agentType: "general", candidates: CANDIDATES, fetchImpl });
	assert.equal(decision?.chosen, undefined);
	assert.match(decision?.verdict ?? "", /jev-judge/);
});

test("judgeModelRoute degrades to a classified failure on request errors", async () => {
	const fetchImpl = (async () => jsonResponse(403, { error: "nope" })) as typeof fetch;
	const decision = await judgeModelRoute({ apiKey: "key", task: "task", agentType: "general", candidates: CANDIDATES, fetchImpl });
	assert.equal(decision?.chosen, undefined);
	assert.equal(decision?.failure?.kind, "actionable");
	assert.equal(decision?.verdict, "");
});
