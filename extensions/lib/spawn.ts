/**
 * Spawn planning: everything a tool call decides before a session exists.
 *
 * Kept pure and free of pi imports so the precedence rules and the exact
 * wording of every rejection can be tested without a model call or a session —
 * they are the part of the Agent tool a caller actually gets wrong.
 */

import { isThinkingLevel, THINKING_LEVELS, type AgentDefinition, type ModelLike, type ThinkingLevel } from "./types.ts";

/** The Agent tool's parameters, spelled out rather than inferred from the schema. */
export interface AgentToolParams {
	prompt: string;
	description?: string;
	subagent_type?: string;
	model?: string;
	thinking?: string;
	max_turns?: number;
	timeout_ms?: number;
	run_in_background?: boolean;
	isolated?: boolean;
}

/** Resolves a model spec to a model, or to an error string to surface verbatim. */
export type ModelResolver = (spec: string) => ModelLike | string;

export interface PlanContext {
	/** The parent session's model, when it has one. */
	parentModel?: ModelLike;
	/** The parent session's current thinking level. */
	parentThinking?: ThinkingLevel;
	/**
	 * Wall-clock ceiling applied to background runs, which no parent tool call
	 * can cancel. Blocking runs keep the caller's own timeout, or none.
	 */
	backgroundTimeoutMs: number;
}

export interface SpawnPlan {
	typeName: string;
	definition: AgentDefinition;
	/** Explicit parameter, else agent-file pin, else the parent session's level. */
	thinking?: ThinkingLevel;
	model?: ModelLike;
	modelReason: string;
	/** Default true: a spawn never holds the parent's turn unless asked to. */
	background: boolean;
	isolated: boolean;
	/** Explicit parameter, else the agent-file pin. */
	maxTurns?: number;
	/** Explicit parameter, else the background ceiling for background runs. */
	timeoutMs?: number;
}

export type PlanFailureKind = "empty-prompt" | "unknown-agent" | "invalid-thinking" | "model-error";

export type PlanResult = { ok: true; plan: SpawnPlan } | { ok: false; kind: PlanFailureKind; agentType: string; message: string };

function availableList(agents: ReadonlyMap<string, AgentDefinition>): string {
	return [...agents.values()]
		.sort((a, b) => a.name.localeCompare(b.name))
		.map((agent) => (agent.description ? `${agent.name} (${agent.description})` : agent.name))
		.join(", ");
}

/**
 * Validate one spawn and decide what it will run as.
 *
 * `resolveModel` is injected rather than reached for through a registry so the
 * model branch — the only one that can fail on something other than the
 * caller's own arguments — is testable too.
 */
export function resolveSpawnPlan(
	params: AgentToolParams,
	agents: ReadonlyMap<string, AgentDefinition>,
	resolveModel: ModelResolver,
	context: PlanContext,
): PlanResult {
	// An empty prompt still costs a round trip and an agent turn, so it is
	// rejected before anything is resolved.
	if (!params.prompt.trim()) {
		return { ok: false, kind: "empty-prompt", agentType: "general", message: "prompt is empty — describe the task for the sub-agent." };
	}

	const typeName = params.subagent_type?.trim() || "general";
	const definition = agents.get(typeName);
	if (!definition) {
		return { ok: false, kind: "unknown-agent", agentType: typeName, message: `Unknown agent type "${typeName}". Available types: ${availableList(agents)}` };
	}

	if (params.thinking !== undefined && !isThinkingLevel(params.thinking)) {
		return {
			ok: false,
			kind: "invalid-thinking",
			agentType: typeName,
			message: `Invalid thinking level "${params.thinking}". Expected one of: ${THINKING_LEVELS.join(", ")}`,
		};
	}

	let model = context.parentModel;
	let modelReason = context.parentModel ? "parent session model" : "pi default";
	if (params.model) {
		const resolved = resolveModel(params.model);
		if (typeof resolved === "string") return { ok: false, kind: "model-error", agentType: typeName, message: resolved };
		model = resolved;
		modelReason = "explicit model parameter";
	} else if (definition.model) {
		const resolved = resolveModel(definition.model);
		if (typeof resolved === "string") {
			return { ok: false, kind: "model-error", agentType: typeName, message: `Agent "${typeName}" pins an unknown model.\n\n${resolved}` };
		}
		model = resolved;
		modelReason = `agent "${typeName}" model`;
	}

	const background = params.run_in_background !== false;
	return {
		ok: true,
		plan: {
			typeName,
			definition,
			thinking: (params.thinking as ThinkingLevel | undefined) ?? definition.thinking ?? context.parentThinking,
			model,
			modelReason,
			background,
			isolated: params.isolated === true,
			maxTurns: params.max_turns ?? definition.maxTurns,
			// A background run has no tool call left to cancel it, so it always
			// gets a ceiling. Blocking runs answer to the caller's signal instead.
			timeoutMs: params.timeout_ms ?? (background ? context.backgroundTimeoutMs : undefined),
		},
	};
}