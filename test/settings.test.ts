import assert from "node:assert/strict";
import test from "node:test";
import { readRuntimeSettings } from "../extensions/lib/settings.ts";

test("readRuntimeSettings defaults preserve the previous behaviour", () => {
	const settings = readRuntimeSettings({});
	assert.equal(settings.persistSessions, false);
	assert.equal(settings.sessionDir, undefined);
	assert.equal(settings.maxConcurrent, 4);
	assert.equal(settings.maxRecords, 100);
	assert.equal(settings.agentScope, "user", "project agents are opt-in");
	assert.equal(settings.maxResultChars, 8000);
	assert.equal(settings.maxFullResultChars, 100_000);
	assert.equal(settings.maxNotificationChars, 800);
	assert.equal(settings.backgroundTimeoutMs, 30 * 60_000, "background runs get a ceiling; nothing else would stop them");
	assert.equal(settings.maxPromptChars, 2000);
});

test("readRuntimeSettings reads overrides and rejects nonsense", () => {
	const settings = readRuntimeSettings({
		PI_SUBAGENTS_PERSIST: "on",
		PI_SUBAGENTS_SESSION_DIR: "/tmp/pi-sessions",
		PI_SUBAGENTS_MAX_CONCURRENCY: "2",
		PI_SUBAGENTS_MAX_RECORDS: "5",
		PI_SUBAGENTS_AGENT_SCOPE: "both",
	});
	assert.equal(settings.persistSessions, true);
	assert.equal(settings.sessionDir, "/tmp/pi-sessions");
	assert.equal(settings.maxConcurrent, 2);
	assert.equal(settings.maxRecords, 5);
	assert.equal(settings.agentScope, "both");

	const nonsense = readRuntimeSettings({
		PI_SUBAGENTS_MAX_CONCURRENCY: "0",
		PI_SUBAGENTS_MAX_RECORDS: "many",
		PI_SUBAGENTS_AGENT_SCOPE: "everything",
	});
	assert.equal(nonsense.maxConcurrent, 4);
	assert.equal(nonsense.maxRecords, 100);
	assert.equal(nonsense.agentScope, "user");
});

test("readRuntimeSettings reads the project and both scopes", () => {
	assert.equal(readRuntimeSettings({ PI_SUBAGENTS_AGENT_SCOPE: "project" }).agentScope, "project");
	assert.equal(readRuntimeSettings({ PI_SUBAGENTS_AGENT_SCOPE: " user " }).agentScope, "user");
});

test("readRuntimeSettings reads the result caps and keeps the escape hatch wider than the inline cap", () => {
	const settings = readRuntimeSettings({
		PI_SUBAGENTS_MAX_RESULT_CHARS: "2000",
		PI_SUBAGENTS_MAX_FULL_RESULT_CHARS: "50000",
		PI_SUBAGENTS_MAX_NOTIFICATION_CHARS: "200",
		PI_SUBAGENTS_BACKGROUND_TIMEOUT_MS: "60000",
		PI_SUBAGENTS_MAX_PROMPT_CHARS: "100",
	});
	assert.equal(settings.maxResultChars, 2000);
	assert.equal(settings.maxFullResultChars, 50_000);
	assert.equal(settings.maxNotificationChars, 200);
	assert.equal(settings.backgroundTimeoutMs, 60_000);
	assert.equal(settings.maxPromptChars, 100);

	const inverted = readRuntimeSettings({
		PI_SUBAGENTS_MAX_RESULT_CHARS: "9000",
		PI_SUBAGENTS_MAX_FULL_RESULT_CHARS: "100",
	});
	assert.equal(inverted.maxFullResultChars, 9000, "a narrower full-text cap would make the truncation notice a dead end");
});

test("readRuntimeSettings falls back when a cap is nonsense", () => {
	const settings = readRuntimeSettings({
		PI_SUBAGENTS_MAX_RESULT_CHARS: "-5",
		PI_SUBAGENTS_MAX_FULL_RESULT_CHARS: "lots",
		PI_SUBAGENTS_BACKGROUND_TIMEOUT_MS: "0",
		PI_SUBAGENTS_MAX_PROMPT_CHARS: "",
	});
	assert.equal(settings.maxResultChars, 8000);
	assert.equal(settings.maxFullResultChars, 100_000);
	assert.equal(settings.backgroundTimeoutMs, 30 * 60_000);
	assert.equal(settings.maxPromptChars, 2000);
});
