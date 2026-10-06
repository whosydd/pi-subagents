import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import subagentsExtension from "../extensions/index.ts";

function fakeApi(): { api: ExtensionAPI; tools: string[]; commands: string[] } {
	const tools: string[] = [];
	const commands: string[] = [];
	const api = {
		registerTool: (tool: { name: string }) => tools.push(tool.name),
		registerCommand: (name: string) => commands.push(name),
		on: () => () => {},
	} as unknown as ExtensionAPI;
	return { api, tools, commands };
}

test("extension registers both tools and no commands", () => {
	const { api, tools, commands } = fakeApi();
	subagentsExtension(api);

	assert.deepEqual(tools.sort(), ["Agent", "get_subagent_result"]);
	assert.deepEqual(commands, [], "the extension stays out of the command surface");
});

interface CapturedTool {
	parameters?: { properties?: Record<string, unknown> };
	description?: string;
	promptGuidelines?: string[];
}

/** Loads the extension against a fake API and returns the Agent tool it registered. */
function captureAgentTool(): CapturedTool {
	let agentTool: CapturedTool | undefined;
	const fake = {
		registerTool: (tool: CapturedTool) => {
			if (tool?.parameters?.properties?.prompt) agentTool = tool;
		},
		registerCommand: () => {},
		on: () => () => {},
	} as unknown as ExtensionAPI;

	subagentsExtension(fake);
	assert.ok(agentTool, "the Agent tool was registered");
	return agentTool;
}

test("registered tools expose the expected parameters", () => {
	const agentTool = captureAgentTool();
	const properties = Object.keys(agentTool.parameters?.properties ?? {});
	for (const expected of [
		"prompt",
		"description",
		"subagent_type",
		"model",
		"thinking",
		"max_turns",
		"timeout_ms",
		"run_in_background",
		"isolated",
	]) {
		assert.ok(properties.includes(expected), `missing parameter: ${expected}`);
	}
	assert.match(agentTool.description ?? "", /codemode/, "the description keeps the codemode boundary visible");
});

test("the tool description states that a spawn is detached by default", () => {
	// A default the model cannot see is a default it will guess wrong about.
	const agentTool = captureAgentTool();
	assert.match(agentTool.description ?? "", /[Bb]y default the spawn is detached/);
	for (const guideline of agentTool.promptGuidelines ?? []) {
		assert.doesNotMatch(guideline, /run_in_background: true/, "guidance must not contradict the default");
	}
});
