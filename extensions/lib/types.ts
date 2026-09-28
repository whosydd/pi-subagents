/**
 * Shared types for the subagents extension.
 */

import type { Model } from "@earendil-works/pi-ai";

/** Thinking levels accepted by pi. Mirrors pi-ai's `ModelThinkingLevel`. */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export function isThinkingLevel(value: string): value is ThinkingLevel {
	return (THINKING_LEVELS as readonly string[]).includes(value);
}

/**
 * The concrete model shape pi hands out (pi-ai's `Model` is generic over the
 * API dialect; a subagent spawn is dialect-agnostic, so `any` is the only
 * parameter that keeps every provider assignable).
 */
export type ModelLike = Model<any>;

/** An agent type: built-in or parsed from an agent markdown file. */
export interface AgentDefinition {
	name: string;
	description: string;
	/** Markdown body of the agent file (frontmatter stripped) — the agent's instructions. */
	systemPrompt: string;
	/** `provider/modelId` pin. Absent means: jev routing (when enabled) or the parent model. */
	model?: string;
	thinking?: ThinkingLevel;
	/** Built-in tool allowlist. Undefined means all built-in tools are available. */
	tools?: string[];
	/** Built-in tools removed from the default set. */
	disallowedTools?: string[];
	maxTurns?: number;
	/** True for the hard-coded fallback agents. */
	builtin?: boolean;
	/** Absolute path when loaded from a file. */
	file?: string;
}

export interface UsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

export const EMPTY_USAGE: UsageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };

export interface AgentRecord {
	id: string;
	type: string;
	description: string;
	prompt: string;
	/** The definition this run was spawned from. */
	definition: AgentDefinition;
	status: "running" | "completed" | "failed" | "aborted";
	startedAt: number;
	completedAt?: number;
	/** Final assistant text, when the run produced one. */
	result?: string;
	error?: string;
	modelId?: string;
	modelName?: string;
	turns: number;
	usage: UsageTotals;
	/** True once the parent has fetched the result via get_subagent_result. */
	consumed?: boolean;
	/** Human-readable jev judgments (routing / verification). */
	jev?: { route?: string; verify?: string };
	/** Why this model was chosen (explicit / agent file / jev / parent). */
	modelReason?: string;
}

/** Structured details attached to Agent tool results. */
export interface AgentToolDetails {
	agentId?: string;
	status: AgentRecord["status"] | "background";
	agentType: string;
	modelId?: string;
	modelName?: string;
	modelReason?: string;
	turns?: number;
	durationMs?: number;
	tokens?: number;
	jev?: AgentRecord["jev"];
}

/** Structured details attached to get_subagent_result results. */
export interface ResultToolDetails {
	agentId: string;
	status: AgentRecord["status"];
	found: boolean;
}
