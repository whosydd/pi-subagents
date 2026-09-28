import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import subagentsExtension from "../extensions/index.ts";

test("extension registers both tools and the /subagents command", () => {
	const tools: string[] = [];
	const commands: string[] = [];
	const fakeApi = {
		registerTool: (tool: { name: string }) => tools.push(tool.name),
		registerCommand: (name: string) => commands.push(name),
	} as unknown as ExtensionAPI;

	subagentsExtension(fakeApi);

	assert.deepEqual(tools.sort(), ["Agent", "get_subagent_result"]);
	assert.deepEqual(commands, ["subagents"]);
});

test("registered tools expose the expected parameters", () => {
	let agentTool: { parameters?: { properties?: Record<string, unknown> }; description?: string } | undefined;
	const fakeApi = {
		registerTool: (tool: typeof agentTool) => {
			if (tool?.parameters?.properties?.prompt) agentTool = tool;
		},
		registerCommand: () => {},
	} as unknown as ExtensionAPI;

	subagentsExtension(fakeApi);

	assert.ok(agentTool);
	const properties = Object.keys(agentTool.parameters?.properties ?? {});
	for (const expected of ["prompt", "description", "subagent_type", "model", "thinking", "max_turns", "run_in_background", "isolated"]) {
		assert.ok(properties.includes(expected), `missing parameter: ${expected}`);
	}
});
