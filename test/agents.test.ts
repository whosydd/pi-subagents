import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadAgents, parseAgentFile } from "../extensions/lib/agents.ts";

test("parseAgentFile reads frontmatter fields and the instruction body", () => {
	const parsed = parseAgentFile(
		`---
description: Security Code Reviewer
tools: read, grep, find, bash
model: anthropic/claude-haiku-4-5
thinking: off
max_turns: 10
---
You are a lightweight security auditor.`,
		"auditor",
	);
	assert.equal(typeof parsed, "object");
	const agent = parsed as Exclude<typeof parsed, string>;
	assert.equal(agent.name, "auditor");
	assert.equal(agent.description, "Security Code Reviewer");
	assert.deepEqual(agent.tools, ["read", "grep", "find", "bash"]);
	assert.equal(agent.model, "anthropic/claude-haiku-4-5");
	assert.equal(agent.thinking, "off");
	assert.equal(agent.maxTurns, 10);
	assert.equal(agent.systemPrompt, "You are a lightweight security auditor.");
});

test("parseAgentFile treats a file without frontmatter as pure instructions", () => {
	const parsed = parseAgentFile("Just do the thing.", "worker");
	assert.notEqual(typeof parsed, "string");
	const agent = parsed as Exclude<typeof parsed, string>;
	assert.equal(agent.name, "worker");
	assert.equal(agent.systemPrompt, "Just do the thing.");
});

test("parseAgentFile rejects an invalid thinking level", () => {
	const parsed = parseAgentFile("---\nthinking: turbo\n---\nbody", "x");
	assert.equal(typeof parsed, "string");
	assert.match(parsed as string, /invalid thinking level/);
});

test("parseAgentFile rejects an invalid max_turns", () => {
	const parsed = parseAgentFile("---\nmax_turns: many\n---\nbody", "x");
	assert.equal(typeof parsed, "string");
	assert.match(parsed as string, /invalid max_turns/);
});

test("loadAgents layers built-ins, global files and project overrides", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-subagents-agents-"));
	try {
		const globalDir = join(root, "global");
		const projectDir = join(root, "project");
		mkdirSync(join(globalDir, "agents"), { recursive: true });
		mkdirSync(join(projectDir, ".pi", "agents"), { recursive: true });
		writeFileSync(join(globalDir, "agents", "worker.md"), "---\ndescription: global worker\n---\nglobal body");
		writeFileSync(join(projectDir, ".pi", "agents", "worker.md"), "---\ndescription: project worker\n---\nproject body");
		writeFileSync(join(projectDir, ".pi", "agents", "broken.md"), "---\nthinking: turbo\n---\nbody");

		const { agents, warnings } = loadAgents(projectDir, globalDir);
		assert.ok(agents.has("general"));
		assert.ok(agents.has("explore"));
		assert.equal(agents.get("worker")?.description, "project worker");
		assert.equal(agents.get("worker")?.systemPrompt, "project body");
		assert.equal(warnings.length, 1);
		assert.match(warnings[0], /broken\.md/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
