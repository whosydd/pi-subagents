import assert from "node:assert/strict";
import test from "node:test";
import { classifyJevFailure, JevError, jevEvaluate, renderJudgment, type JevQuestion } from "../extensions/lib/jev/client.ts";

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

const QUESTIONS: Record<string, JevQuestion> = {
	sufficiency: { type: "noul", instructions: "does it answer?" },
	next_action: { type: "choice", instructions: "what next?", criteria: { accept: "good enough" } },
};

test("jevEvaluate posts state and questions and returns answers", async () => {
	let captured: { url: string; init: RequestInit } | undefined;
	const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
		captured = { url: String(url), init: init ?? {} };
		return jsonResponse(200, { answers: { sufficiency: { type: "noul", noul: 0.9 } }, model: "jev-test" });
	}) as typeof fetch;

	const response = await jevEvaluate("key-123", "the state", QUESTIONS, { fetchImpl });
	assert.equal(response.model, "jev-test");
	assert.equal(captured?.url, "https://api.typesafe.ai/v1/systemone");
	assert.equal((captured?.init.headers as Record<string, string>).Authorization, "Bearer key-123");
	const body = JSON.parse(String(captured?.init.body));
	assert.equal(body.state, "the state");
	assert.equal(body.questions.next_action.type, "choice");
});

test("jevEvaluate retries 429 responses and then succeeds", async () => {
	let calls = 0;
	const fetchImpl = (async () => {
		calls += 1;
		if (calls === 1) return jsonResponse(429, { error: "slow down" }, { "retry-after": "0" });
		return jsonResponse(200, { answers: { sufficiency: { type: "noul", noul: 0.5 } } });
	}) as typeof fetch;

	const response = await jevEvaluate("key", "state", QUESTIONS, { fetchImpl });
	assert.equal(calls, 2);
	assert.equal(response.answers.sufficiency.type, "noul");
});

test("jevEvaluate surfaces HTTP errors as JevError with status", async () => {
	const fetchImpl = (async () => jsonResponse(401, { error: "bad key" })) as typeof fetch;
	await assert.rejects(
		() => jevEvaluate("bad", "state", QUESTIONS, { fetchImpl }),
		(error: unknown) => error instanceof JevError && error.status === 401,
	);
});

test("classifyJevFailure marks auth and billing errors actionable", () => {
	const failure = classifyJevFailure(new JevError("boom", 402));
	assert.equal(failure.kind, "actionable");
	assert.match(failure.reason, /payment required/);
	assert.equal(classifyJevFailure(new Error("network")).kind, "transient");
});

test("renderJudgment renders probabilities and choice meanings", () => {
	const rendered = renderJudgment(
		"jev-1.0",
		{ input_tokens: 42 },
		{
			sufficiency: { type: "noul", noul: 0.87 },
			next_action: { type: "choice", choice: "accept", probabilities: { accept: 0.8, fail: 0.2 }, confidence: 0.7 },
		},
		QUESTIONS,
	);
	assert.match(rendered, /jev-judge \(model jev-1\.0, 42 in-tokens\)/);
	assert.match(rendered, /sufficiency: 0\.87 — likely yes/);
	assert.match(rendered, /next_action: accept \(p=0\.80, conf=0\.70\) — good enough/);
});
