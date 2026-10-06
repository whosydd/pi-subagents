import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { invalidateAgents, loadAgents, parseAgentFile } from "../extensions/lib/agents.ts";

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

test("parseAgentFile reads YAML list values", () => {
	const parsed = parseAgentFile(
		`---
description: list style
tools:
  - read
  - grep
disallowed_tools:
  - bash
---
body`,
		"lister",
	);
	assert.notEqual(typeof parsed, "string");
	const agent = parsed as Exclude<typeof parsed, string>;
	assert.deepEqual(agent.tools, ["read", "grep"]);
	assert.deepEqual(agent.disallowedTools, ["bash"]);
});

test("parseAgentFile tolerates a leading BOM and quoted list items", () => {
	const parsed = parseAgentFile('\ufeff---\ntools:\n  - "read"\n  - \'grep\'\n---\nbody', "bom");
	assert.notEqual(typeof parsed, "string");
	const agent = parsed as Exclude<typeof parsed, string>;
	assert.deepEqual(agent.tools, ["read", "grep"]);
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

/** Build a temp root with a global dir and a project dir, then clean up afterwards. */
function withAgentDirs(run: (projectDir: string, globalDir: string) => void): void {
	invalidateAgents();
	const root = mkdtempSync(join(tmpdir(), "pi-subagents-agents-"));
	try {
		const globalDir = join(root, "global");
		const projectDir = join(root, "project");
		mkdirSync(join(globalDir, "agents"), { recursive: true });
		mkdirSync(join(projectDir, ".pi", "agents"), { recursive: true });
		writeFileSync(join(globalDir, "agents", "worker.md"), "---\ndescription: global worker\n---\nglobal body");
		writeFileSync(join(globalDir, "agents", "globalonly.md"), "---\ndescription: only in the global dir\n---\nbody");
		writeFileSync(join(projectDir, ".pi", "agents", "worker.md"), "---\ndescription: project worker\n---\nproject body");
		writeFileSync(join(projectDir, ".pi", "agents", "general.md"), "---\ndescription: project general\n---\nproject body");
		writeFileSync(join(projectDir, ".pi", "agents", "broken.md"), "---\nthinking: turbo\n---\nbody");
		run(projectDir, globalDir);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

test("loadAgents with scope both layers built-ins, user files and project overrides", () => {
	withAgentDirs((projectDir, globalDir) => {
		const { agents, warnings } = loadAgents(projectDir, globalDir, "both");
		assert.ok(agents.has("general"));
		assert.ok(agents.has("explore"));
		assert.equal(agents.get("worker")?.description, "project worker");
		assert.equal(agents.get("worker")?.systemPrompt, "project body");
		assert.equal(agents.get("general")?.description, "project general", "project files may override built-ins when enabled");
		assert.equal(warnings.length, 1);
		assert.match(warnings[0], /broken\.md/);
	});
});

test("loadAgents defaults to user scope and ignores project agents", () => {
	withAgentDirs((projectDir, globalDir) => {
		const { agents, warnings } = loadAgents(projectDir, globalDir);
		assert.equal(agents.get("worker")?.description, "global worker");
		assert.notEqual(agents.get("general")?.description, "project general", "the built-in survives an untrusted repo");
		assert.equal(agents.get("general")?.systemPrompt, "");
		assert.equal(warnings.length, 0, "project files are not even read");
	});
});

test("loadAgents with project scope ignores the user directory", () => {
	withAgentDirs((projectDir, globalDir) => {
		const { agents } = loadAgents(projectDir, globalDir, "project");
		assert.equal(agents.get("worker")?.description, "project worker");
	});
});

test("loadAgents serves repeats from cache and re-reads after invalidateAgents", () => {
	withAgentDirs((projectDir, globalDir) => {
		const first = loadAgents(projectDir, globalDir, "both");
		assert.equal(loadAgents(projectDir, globalDir, "both"), first, "the same (cwd, agentDir, scope) is not re-read from disk");

		writeFileSync(join(globalDir, "agents", "worker.md"), "---\ndescription: rewritten worker\n---\nnew body");
		assert.equal(loadAgents(projectDir, globalDir, "both").agents.get("worker")?.description, "project worker", "a stale cache, until it is invalidated");

		invalidateAgents();
		assert.equal(loadAgents(projectDir, globalDir, "both").agents.get("worker")?.description, "project worker");

		invalidateAgents();
		const user = loadAgents(projectDir, globalDir, "user");
		assert.equal(user.agents.get("worker")?.description, "rewritten worker", "invalidating drops the cache, so the edited file is read");
	});
});

test("loadAgents keys its cache on the directory and scope, not just the cwd", () => {
	withAgentDirs((projectDir, globalDir) => {
		assert.equal(loadAgents(projectDir, globalDir, "both").agents.get("worker")?.description, "project worker");
		assert.equal(loadAgents(projectDir, globalDir, "user").agents.get("worker")?.description, "global worker", "a narrower scope is a different read");

		const otherDir = loadAgents(projectDir, join(globalDir, "other"), "both");
		assert.equal(otherDir.agents.get("globalonly"), undefined, "so is another agent directory");
		assert.equal(otherDir.agents.get("worker")?.description, "project worker", "the project directory still applies");
	});
});
