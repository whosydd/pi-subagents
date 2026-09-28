import assert from "node:assert/strict";
import test from "node:test";
import type { Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describeModel, modelKey, resolveModelInput, routeCandidates } from "../extensions/lib/model.ts";

type Registry = ExtensionContext["modelRegistry"];

function fakeModel(provider: string, id: string, name?: string): Model<any> {
	return { provider, id, name } as unknown as Model<any>;
}

function fakeRegistry(models: Model<any>[]): Registry {
	return {
		find: (provider: string, id: string) => models.find((model) => model.provider === provider && model.id === id),
		getAll: () => models,
		getAvailable: () => models,
	} as unknown as Registry;
}

const MODELS = [
	fakeModel("anthropic", "claude-haiku-4-5", "Claude Haiku 4.5"),
	fakeModel("anthropic", "claude-sonnet-4-5", "Claude Sonnet 4.5"),
	fakeModel("google", "gemma-4-31b-it", "Gemma 4 31B"),
];

test("resolveModelInput resolves an exact provider/modelId", () => {
	const resolved = resolveModelInput("anthropic/claude-sonnet-4-5", fakeRegistry(MODELS));
	assert.notEqual(typeof resolved, "string");
	assert.equal(modelKey(resolved as Model<any>), "anthropic/claude-sonnet-4-5");
});

test("resolveModelInput resolves a fuzzy display-name fragment", () => {
	const resolved = resolveModelInput("haiku", fakeRegistry(MODELS));
	assert.notEqual(typeof resolved, "string");
	assert.equal((resolved as Model<any>).id, "claude-haiku-4-5");
});

test("resolveModelInput normalizes dots and dashes in versions", () => {
	const resolved = resolveModelInput("claude-haiku-4.5", fakeRegistry(MODELS));
	assert.notEqual(typeof resolved, "string");
	assert.equal((resolved as Model<any>).id, "claude-haiku-4-5");
});

test("resolveModelInput returns an error string listing available models", () => {
	const resolved = resolveModelInput("not-a-model", fakeRegistry(MODELS));
	assert.equal(typeof resolved, "string");
	assert.match(resolved as string, /Model not found: "not-a-model"/);
	assert.match(resolved as string, /anthropic\/claude-haiku-4-5/);
});

test("describeModel strips the Claude prefix and keeps the canonical id", () => {
	const described = describeModel(fakeModel("anthropic", "claude-sonnet-4-5", "Claude Sonnet 4.5"));
	assert.deepEqual(described, { id: "anthropic/claude-sonnet-4-5", name: "sonnet 4.5" });
});

test("routeCandidates always includes the parent model and honors the cap", () => {
	const registry = fakeRegistry(MODELS);
	const parent = MODELS[1];
	const { candidates, warnings } = routeCandidates({ registry, parent, cap: 2 });
	assert.deepEqual(warnings, []);
	assert.equal(candidates.length, 2);
	assert.ok(candidates.some((candidate) => candidate.key === "anthropic/claude-sonnet-4-5"));
});

test("routeCandidates warns about unresolvable explicit entries", () => {
	const registry = fakeRegistry(MODELS);
	const { candidates, warnings } = routeCandidates({ registry, spec: ["anthropic/claude-haiku-4-5", "nope/nope"], cap: 10 });
	assert.equal(candidates.length, 1);
	assert.equal(warnings.length, 1);
	assert.match(warnings[0], /nope\/nope/);
});
