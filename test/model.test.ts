import assert from "node:assert/strict";
import test from "node:test";
import type { Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describeModel, modelKey, resolveModelInput } from "../extensions/lib/model.ts";

type Registry = ExtensionContext["modelRegistry"];

function fakeModel(provider: string, id: string, name?: string): Model<any> {
	return { provider, id, name } as unknown as Model<any>;
}

function fakeRegistry(models: Model<any>[], unauthenticated: string[] = []): Registry {
	return {
		find: (provider: string, id: string) => models.find((model) => model.provider === provider && model.id === id),
		getAll: () => models,
		getAvailable: () => models,
		hasConfiguredAuth: (model: Model<any>) => !unauthenticated.includes(modelKey(model)),
	} as unknown as Registry;
}

const MODELS = [
	fakeModel("anthropic", "claude-haiku-4-5", "Claude Haiku 4.5"),
	fakeModel("anthropic", "claude-sonnet-4-5", "Claude Sonnet 4.5"),
	fakeModel("google", "gemma-4-31b-it", "Gemma 4 31B"),
	fakeModel("openrouter", "claude-haiku-4-5", "Claude Haiku 4.5"),
];

test("resolveModelInput resolves an exact provider/modelId", () => {
	const resolved = resolveModelInput("anthropic/claude-sonnet-4-5", fakeRegistry(MODELS));
	assert.notEqual(typeof resolved, "string");
	assert.equal(modelKey(resolved as Model<any>), "anthropic/claude-sonnet-4-5");
});

test("resolveModelInput resolves an unambiguous bare id", () => {
	const resolved = resolveModelInput("gemma-4-31b-it", fakeRegistry(MODELS));
	assert.notEqual(typeof resolved, "string");
	assert.equal(modelKey(resolved as Model<any>), "google/gemma-4-31b-it");
});

test("resolveModelInput refuses an id that several providers ship", () => {
	const resolved = resolveModelInput("claude-haiku-4-5", fakeRegistry(MODELS));
	assert.equal(typeof resolved, "string");
	assert.match(resolved as string, /several providers/);
	assert.match(resolved as string, /anthropic\/claude-haiku-4-5/);
	assert.match(resolved as string, /openrouter\/claude-haiku-4-5/);
});

test("resolveModelInput reports a model without credentials", () => {
	const resolved = resolveModelInput("anthropic/claude-haiku-4-5", fakeRegistry(MODELS, ["anthropic/claude-haiku-4-5"]));
	assert.equal(typeof resolved, "string");
	assert.match(resolved as string, /no configured credentials/);
});

test("resolveModelInput returns an error string listing available models", () => {
	const resolved = resolveModelInput("not-a-model", fakeRegistry(MODELS));
	assert.equal(typeof resolved, "string");
	assert.match(resolved as string, /Model not found: "not-a-model"/);
	assert.match(resolved as string, /anthropic\/claude-haiku-4-5/);
});

test("resolveModelInput rejects an empty spec", () => {
	const resolved = resolveModelInput("   ", fakeRegistry(MODELS));
	assert.equal(typeof resolved, "string");
	assert.match(resolved as string, /empty/);
});

test("describeModel strips the Claude prefix and keeps the canonical id", () => {
	const described = describeModel(fakeModel("anthropic", "claude-sonnet-4-5", "Claude Sonnet 4.5"));
	assert.deepEqual(described, { id: "anthropic/claude-sonnet-4-5", name: "Sonnet 4.5" });
});

test("describeModel keeps the case of names it does not rewrite", () => {
	assert.equal(describeModel(fakeModel("openai", "gpt-5", "GPT-5")).name, "GPT-5", "lowercasing would flatten a vendor's own casing");
	assert.equal(describeModel(fakeModel("custom", "my-model")).name, "my-model", "a model with no display name falls back to its id");
});
