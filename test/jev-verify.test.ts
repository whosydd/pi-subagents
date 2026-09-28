import assert from "node:assert/strict";
import test from "node:test";
import { judgeSubagentResult } from "../extensions/lib/jev/verify.ts";

function jsonResponse(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

test("judgeSubagentResult returns sufficiency, action and a rendered verdict", async () => {
	const fetchImpl = (async () =>
		jsonResponse(200, {
			answers: {
				sufficiency: { type: "noul", noul: 0.93 },
				next_action: { type: "choice", choice: "accept", probabilities: { accept: 0.88, escalate: 0.12 }, confidence: 0.8 },
			},
			model: "jev-test",
		})) as typeof fetch;

	const decision = await judgeSubagentResult({
		apiKey: "key",
		task: "audit the login flow",
		agentType: "auditor",
		result: "Found two issues: ...",
		fetchImpl,
	});
	assert.equal(decision?.sufficiency, 0.93);
	assert.equal(decision?.action, "accept");
	assert.match(decision?.verdict ?? "", /sufficiency: 0\.93 — likely yes/);
	assert.match(decision?.verdict ?? "", /next_action: accept/);
});

test("judgeSubagentResult skips empty results and reports failures", async () => {
	const empty = await judgeSubagentResult({ apiKey: "key", task: "t", agentType: "general", result: "  " });
	assert.equal(empty, undefined);

	const fetchImpl = (async () => jsonResponse(500, { error: "boom" })) as typeof fetch;
	const failed = await judgeSubagentResult({ apiKey: "key", task: "t", agentType: "general", result: "output", fetchImpl });
	assert.equal(failed?.sufficiency, undefined);
	assert.equal(failed?.failure?.kind, "transient");
});
