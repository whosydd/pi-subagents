/**
 * Shared types for the subagents extension.
 *
 * Scope note: this extension only covers what pi cannot do without a second
 * agent loop — an isolated context window, a per-run model/tool choice, and
 * background execution. Bulk tool orchestration is codemode's job and is
 * deliberately not modelled here (no task arrays, chains, or pipelines).
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
	/** `provider/modelId` pin. Absent means: the parent session's model. */
	model?: string;
	thinking?: ThinkingLevel;
	/** Built-in tool allowlist. Undefined means all built-in tools are available. */
	tools?: string[];
	/** Built-in tools removed from the default set. */
	disallowedTools?: string[];
	maxTurns?: number;
}

export interface UsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	/** Per-component cost, accumulated when the provider reports a breakdown. */
	costInput?: number;
	costOutput?: number;
	costCacheRead?: number;
	costCacheWrite?: number;
}

export const EMPTY_USAGE: UsageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };

/** Why a run stopped early. */
export type AbortReason = "turn-limit" | "parent" | "timeout";

export interface AgentRecord {
	id: string;
	type: string;
	description: string;
	prompt: string;
	status: "running" | "completed" | "failed" | "aborted";
	startedAt: number;
	completedAt?: number;
	/** Final assistant text, when the run produced one. */
	result?: string;
	error?: string;
	modelId?: string;
	modelName?: string;
	/** Thinking level the child session actually ran with. */
	thinking?: string;
	/** Where the child session was written, when sessions are persisted. */
	sessionFile?: string;
	/** Set when the run ended early; also carries the wording of the result header. */
	abortReason?: AbortReason;
	turns: number;
	usage: UsageTotals;
	/** Why this model was chosen (explicit parameter / agent file / parent). */
	modelReason?: string;
	/** Non-fatal problems observed while running (extension load errors, ...). */
	warnings?: string[];
	/**
	 * Set once this run's usage has been attached to a tool result. A run can be
	 * read repeatedly, and re-reporting its usage would inflate the parent
	 * session's totals every time.
	 */
	usageReported?: boolean;
}

/** Structured details attached to Agent tool results. */
export interface AgentToolDetails {
	agentId?: string;
	status: AgentRecord["status"];
	agentType: string;
	modelId?: string;
	modelName?: string;
	modelReason?: string;
	thinking?: string;
	turns?: number;
	durationMs?: number;
	tokens?: number;
}

/** Structured details attached to get_subagent_result results. */
export interface ResultToolDetails {
	agentId: string;
	status: AgentRecord["status"];
	found: boolean;
	/** Turns finished so far; meaningful while the run is still going. */
	turns?: number;
	/** Whether this read carried the run's usage into the session's totals. */
	usageReported?: boolean;
}
