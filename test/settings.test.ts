import assert from "node:assert/strict";
import test from "node:test";
import { readJevSettings } from "../extensions/lib/settings.ts";

test("readJevSettings is inert without an API key", () => {
	const settings = readJevSettings({});
	assert.equal(settings.enabled, false);
	assert.equal(settings.route, true);
	assert.equal(settings.verify, true);
	assert.equal(settings.model, "jev-latest");
});

test("readJevSettings enables judgments when a key is present", () => {
	const settings = readJevSettings({ TYPESAFE_API_KEY: "sk-test", JEV_SUBAGENTS_MODEL: "jev-1.2.3" });
	assert.equal(settings.enabled, true);
	assert.equal(settings.model, "jev-1.2.3");
});

test("readJevSettings honors off switches and candidate lists", () => {
	const settings = readJevSettings({
		TYPESAFE_API_KEY: "sk-test",
		JEV_SUBAGENTS: "off",
		JEV_SUBAGENTS_ROUTE: "0",
		JEV_SUBAGENTS_VERIFY: "false",
		JEV_SUBAGENTS_CANDIDATES: "a/b, c/d",
		JEV_SUBAGENTS_MAX_CANDIDATES: "3",
	});
	assert.equal(settings.enabled, false);
	assert.equal(settings.route, false);
	assert.equal(settings.verify, false);
	assert.deepEqual(settings.candidates, ["a/b", "c/d"]);
	assert.equal(settings.maxCandidates, 3);
});

test("readJevSettings ignores a nonsensical candidate cap", () => {
	const settings = readJevSettings({ TYPESAFE_API_KEY: "sk-test", JEV_SUBAGENTS_MAX_CANDIDATES: "abc" });
	assert.equal(settings.maxCandidates, 12);
});
