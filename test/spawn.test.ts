import assert from "node:assert/strict";
import test from "node:test";
import { resolveSpawnPlan, type AgentToolParams, type PlanContext } from "../extensions/lib/spawn.ts";
import { EXPLORE_AGENT, GENERAL_AGENT } from "../extensions/lib/agents.ts";
import type { AgentDefinition, ModelLike, ThinkingLevel } from "../extensions/lib/types.ts";

const PARENT_MODEL = { provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" } as unknown as ModelLike;
const REQUESTED_MODEL = { provider: "openai", id: "gpt-5", name: "GPT-5" } as unknown as ModelLike;

function agents(...extra: AgentDefinition[]): Map<string, AgentDefinition> {
	return new Map([GENERAL_AGENT, EXPLORE_AGENT, ...extra].map((agent) => [agent.name, agent] as const));
}

/** Resolves one known spec and fails every other, so resolution is observable. */
function resolver(spec: string): ModelLike | string {
	if (spec === "openai/gpt-5") return REQUESTED_MODEL;
	if (spec === "anthropic/claude-sonnet-4-5") return PARENT_MODEL;
	return `Model not found: "${spec}".`;
}

function context(overrides: Partial<PlanContext> = {}): PlanContext {
	return { parentModel: PARENT_MODEL, parentThinking: "medium", backgroundTimeoutMs: 600_000, ...overrides };
}

function plan(params: AgentToolParams, ctx: PlanContext = context(), available = agents()) {
	const result = resolveSpawnPlan(params, available, resolver, ctx);
	assert.ok(result.ok, `expected a plan, got: ${result.ok ? "" : result.message}`);
	return result.plan;
}

function rejection(params: AgentToolParams, ctx: PlanContext = context(), available = agents()) {
	const result = resolveSpawnPlan(params, available, resolver, ctx);
	assert.equal(result.ok, false, "expected a rejection");
	assert.ok(!result.ok);
	return result;
}

/** An agent file definition, selected by name through `subagent_type`. */
function custom(overrides: Partial<AgentDefinition> & { name: string }): AgentDefinition {
	return { ...GENERAL_AGENT, ...overrides };
}
const PINNED = custom({ name: "pinned", thinking: "off", model: "openai/gpt-5", maxTurns: 10 });

test("a spawn is detached unless the caller asks it to block", () => {
	assert.equal(plan({ prompt: "go" }).background, true, "default is background");
	assert.equal(plan({ prompt: "go", run_in_background: false }).background, false);
	assert.equal(plan({ prompt: "go", run_in_background: true }).background, true);
});

test("a background run gets a wall-clock ceiling and a blocking one keeps the caller's signal", () => {
	assert.equal(plan({ prompt: "go" }).timeoutMs, 600_000, "nothing else can cancel a detached run");
	assert.equal(plan({ prompt: "go", timeout_ms: 1_234 }).timeoutMs, 1_234);
	assert.equal(plan({ prompt: "go", run_in_background: false }).timeoutMs, undefined);
	assert.equal(plan({ prompt: "go", run_in_background: false, timeout_ms: 5_000 }).timeoutMs, 5_000);
});

test("thinking precedence runs explicit parameter, then agent file, then parent session", () => {
	const withPin = agents(custom({ name: "pinned", thinking: "off" }));
	const type = { subagent_type: "pinned" };
	assert.equal(plan({ prompt: "go", ...type, thinking: "high" }, context(), withPin).thinking, "high");
	assert.equal(plan({ prompt: "go", ...type }, context(), withPin).thinking, "off", "the agent file's pin wins over the parent's level");
	assert.equal(plan({ prompt: "go" }).thinking, "medium", "an agent without a pin follows the parent session");
	assert.equal(plan({ prompt: "go" }, context({ parentThinking: undefined })).thinking, undefined);
});

test("model precedence runs explicit parameter, then agent file, then parent model", () => {
	const withPin = agents(custom({ name: "pinned", model: "openai/gpt-5" }));
	const explicit = plan({ prompt: "go", subagent_type: "pinned", model: "openai/gpt-5" }, context(), withPin);
	assert.equal(explicit.modelReason, "explicit model parameter");
	assert.equal(explicit.model, REQUESTED_MODEL);

	const inherited = plan({ prompt: "go" });
	assert.equal(inherited.model, PARENT_MODEL, "an agent without a pin inherits the parent model");
	assert.equal(inherited.modelReason, "parent session model");

	const headless = plan({ prompt: "go" }, context({ parentModel: undefined }));
	assert.equal(headless.model, undefined);
	assert.equal(headless.modelReason, "pi default");
});

test("an agent file's model pin wins over the parent model and is named as such", () => {
	const withPin = agents(custom({ name: "pinned", model: "openai/gpt-5" }));
	const fromFile = plan({ prompt: "go", subagent_type: "pinned" }, context(), withPin);
	assert.equal(fromFile.modelReason, `agent "pinned" model`);
	assert.equal(fromFile.model, REQUESTED_MODEL);
});

test("max turns and isolation come from the caller, then the agent file", () => {
	const withPin = agents(custom({ name: "pinned", maxTurns: 10 }));
	assert.equal(plan({ prompt: "go", subagent_type: "pinned" }, context(), withPin).maxTurns, 10);
	assert.equal(plan({ prompt: "go", subagent_type: "pinned", max_turns: 2 }, context(), withPin).maxTurns, 2);
	assert.equal(plan({ prompt: "go" }).maxTurns, undefined);
	assert.equal(plan({ prompt: "go" }).isolated, false);
	assert.equal(plan({ prompt: "go", isolated: true }).isolated, true);
});

test("an unknown agent type is refused with the available names", () => {
	const result = rejection({ prompt: "go", subagent_type: "nope" });
	assert.equal(result.kind, "unknown-agent");
	assert.equal(result.agentType, "nope");
	assert.match(result.message, /Unknown agent type "nope"/);
	assert.match(result.message, /Available types: explore \(Read-only agent for broad codebase exploration and research\.\), general /);
});

test("an empty or blank prompt is refused before anything is resolved", () => {
	let resolved = false;
	const result = resolveSpawnPlan({ prompt: "   " }, agents(), () => {
		resolved = true;
		return REQUESTED_MODEL;
	}, context());
	assert.ok(!result.ok);
	assert.equal(result.kind, "empty-prompt");
	assert.equal(resolved, false, "nothing is looked up for a call that cannot run");
});

test("an invalid thinking level is refused with the accepted levels", () => {
	const result = rejection({ prompt: "go", thinking: "loud" });
	assert.equal(result.kind, "invalid-thinking");
	assert.match(result.message, /Expected one of: off, minimal, low, medium, high, xhigh, max/);
});

test("a model the caller asked for that cannot be resolved surfaces the resolver's error", () => {
	const result = rejection({ prompt: "go", model: "openai/nope" });
	assert.equal(result.kind, "model-error");
	assert.match(result.message, /Model not found: "openai\/nope"/);
});

test("a bad agent-file pin says which agent pinned it", () => {
	const withPin = agents(custom({ name: "pinned", model: "openai/nope" }));
	const result = rejection({ prompt: "go", subagent_type: "pinned" }, context(), withPin);
	assert.equal(result.kind, "model-error");
	assert.match(result.message, /Agent "pinned" pins an unknown model\./);
	assert.match(result.message, /Model not found: "openai\/nope"/);
});

test("an explicit model wins over a bad agent-file pin", () => {
	const withPin = agents(custom({ name: "pinned", model: "openai/nope" }));
	const explicit = plan({ prompt: "go", subagent_type: "pinned", model: "openai/gpt-5" }, context(), withPin);
	assert.equal(explicit.modelReason, "explicit model parameter");
});

test("the agent type falls back to general and trims", () => {
	assert.equal(plan({ prompt: "go" }).typeName, "general");
	assert.equal(plan({ prompt: "go", subagent_type: "  " }).typeName, "general");
	assert.equal(plan({ prompt: "go", subagent_type: " explore " }).definition, EXPLORE_AGENT);
});

test("the agent file's own settings reach the plan", () => {
	const withPin = agents(PINNED);
	assert.equal(plan({ prompt: "go", subagent_type: "pinned" }, context(), withPin).thinking, "off");
	assert.equal(plan({ prompt: "go", subagent_type: "pinned" }, context(), withPin).maxTurns, 10);
});

test("thinking levels are the ones pi accepts", () => {
	const levels: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
	for (const level of levels) {
		assert.equal(plan({ prompt: "go", thinking: level }).thinking, level);
	}
});