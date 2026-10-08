/**
 * In-process registry of sub-agent records plus the formatting helpers shared
 * by tool results and background notifications.
 */

import type { AgentRecord } from "./types.ts";
import { EMPTY_USAGE } from "./types.ts";

let sequence = 0;

/** Short unique agent id: `sa_<time36><counter>`. */
export function newAgentId(): string {
	sequence = (sequence + 1) % 46_656;
	return `sa_${Date.now().toString(36)}${sequence.toString(36).padStart(3, "0")}`;
}

export interface NewRecordInput {
	type: string;
	description: string;
	prompt: string;
	modelReason: string;
	modelId?: string;
	modelName?: string;
	/** Prompt characters kept in the record; a run's prompt can dwarf its result. */
	maxPromptChars: number;
}

/**
 * A fresh record in the `running` state.
 *
 * The prompt is kept truncated: a record exists to identify a run and read its
 * output, and a long prompt retained across the record cap is memory spent on
 * something nothing reads back.
 */
export function newAgentRecord(input: NewRecordInput): AgentRecord {
	const prompt =
		input.prompt.length > input.maxPromptChars ? `${input.prompt.slice(0, input.maxPromptChars)} […${input.prompt.length - input.maxPromptChars} more characters]` : input.prompt;
	return {
		id: newAgentId(),
		type: input.type,
		description: input.description,
		prompt,
		status: "running",
		startedAt: Date.now(),
		turns: 0,
		usage: { ...EMPTY_USAGE },
		modelReason: input.modelReason,
		modelId: input.modelId,
		modelName: input.modelName,
	};
}

export class AgentRegistry {
	private readonly records = new Map<string, AgentRecord>();
	private readonly maxRecords: number;

	// Written as an explicit field: Node's strip-only TypeScript loader rejects
	// constructor parameter properties.
	constructor(maxRecords = Number.POSITIVE_INFINITY) {
		this.maxRecords = maxRecords;
	}

	add(record: AgentRecord): AgentRecord {
		this.records.set(record.id, record);
		this.evict();
		return record;
	}

	/**
	 * Drop the oldest finished records once the cap is exceeded. Running agents
	 * are never evicted, so the cap can be exceeded while several are in flight.
	 */
	private evict(): void {
		if (this.records.size <= this.maxRecords) return;
		for (const record of this.all()) {
			if (this.records.size <= this.maxRecords) break;
			if (record.status === "running") continue;
			this.records.delete(record.id);
		}
	}

	get(id: string): AgentRecord | undefined {
		return this.records.get(id);
	}

	all(): AgentRecord[] {
		return [...this.records.values()].sort((a, b) => a.startedAt - b.startedAt);
	}
}

/**
 * Whether this read is the one that reports the run's usage into the parent
 * session's totals, and marks it reported either way.
 *
 * pi counts a tool result once, but a run can be read any number of times, and
 * a blocking run already reported its usage at the Agent call. Reporting on
 * every read would inflate the session total by a multiple of the real spend.
 */
export function claimUsageReport(record: AgentRecord): boolean {
	if (record.usageReported) return false;
	record.usageReported = true;
	return true;
}

/**
 * Combine warnings already on a record with a run's own, keeping order and
 * collapsing an empty result back to undefined.
 *
 * A record can carry warnings from before the run started (unreadable or
 * malformed agent files) as well as from the run itself (extension load
 * errors, tool-list typos); both must survive — for a detached spawn, the
 * completion notification is where the parent finally sees them.
 */
export function mergeWarnings(existing: string[] | undefined, incoming: string[] | undefined): string[] | undefined {
	const combined = [...(existing ?? []), ...(incoming ?? [])];
	return combined.length > 0 ? combined : undefined;
}

export function formatDuration(ms: number): string {
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
	const minutes = Math.floor(ms / 60_000);
	return `${minutes}m ${Math.round((ms % 60_000) / 1000)}s`;
}

/** Inline tool results are capped so a runaway child cannot flood the parent. */
const MAX_INLINE_RESULT_CHARS = 8_000;
/** A notification should point at the full result, not carry it. */
const MAX_NOTIFICATION_RESULT_CHARS = 800;

/**
 * How a completed background run reaches the parent conversation.
 *
 * `steer`, never `followUp`: steering is injected before the parent's next
 * model request, so a parent still working folds the result into the answer it
 * is writing. A follow-up waits until the parent would otherwise stop — by then
 * the report is already out, and the notification lands as a stale extra turn.
 *
 * `triggerTurn` only matters when the parent is idle: it is what wakes the
 * session up for a result that arrived after the last message.
 */
export const BACKGROUND_NOTIFICATION_DELIVERY = {
	deliverAs: "steer",
	triggerTurn: true,
} as const;

/** How much of a run's result a formatted message may carry. */
export interface ResultFormatOptions {
	/** Characters of the result to include. */
	maxChars: number;
	/**
	 * Whether `get_subagent_result` can hand back more than `maxChars`. When it
	 * cannot, the truncation notice must not point there: that sends the caller
	 * to a second read that truncates the same text at the same place.
	 */
	fullOutputAvailable: boolean;
}

/** Defaults for callers that do not configure their own caps. */
export const DEFAULT_RESULT_FORMAT: ResultFormatOptions = {
	maxChars: MAX_INLINE_RESULT_CHARS,
	fullOutputAvailable: true,
};

function cap(text: string, max: number): { text: string; truncated: boolean } {
	if (text.length <= max) return { text, truncated: false };
	return { text: text.slice(0, max), truncated: true };
}

function abortLabel(reason: AgentRecord["abortReason"]): string {
	if (reason === "turn-limit") return "aborted (turn limit reached)";
	if (reason === "timeout") return "aborted (timeout)";
	return "aborted";
}

/** Human phrase for a record's status; shared by the tool result and the notification. */
export function describeStatus(record: AgentRecord): string {
	switch (record.status) {
		case "running":
			return "still running";
		case "aborted":
			return abortLabel(record.abortReason);
		case "failed":
			return "failed";
		default:
			return "completed";
	}
}

function statsLine(record: AgentRecord): string {
	const model = record.modelName ?? record.modelId ?? "model";
	const parts = [
		record.modelReason ? `${model} (${record.modelReason})` : model,
		record.thinking ? `thinking ${record.thinking}` : undefined,
		`${record.turns} turn${record.turns === 1 ? "" : "s"}`,
		formatDuration((record.completedAt ?? Date.now()) - record.startedAt),
	].filter((part): part is string => part !== undefined);
	return parts.join(" · ");
}

function warningBlock(lines: string[], record: AgentRecord): void {
	if (!record.warnings || record.warnings.length === 0) return;
	lines.push("", "Warnings:", ...record.warnings.map((warning) => `- ${warning}`));
}

/** The text of an Agent tool result: status header, result, error, warnings. */
export function formatRunResult(record: AgentRecord, format: ResultFormatOptions = DEFAULT_RESULT_FORMAT): string {
	const lines = [`Sub-agent ${describeStatus(record)}: ${record.type} · ${statsLine(record)}`];
	if (record.result) {
		const capped = cap(record.result, format.maxChars);
		lines.push("", capped.text);
		if (capped.truncated) {
			lines.push(
				"",
				format.fullOutputAvailable
					? `[Truncated at ${format.maxChars} characters; read the full output with get_subagent_result.]`
					: `[Truncated at ${format.maxChars} characters, which is the configured full-output limit.]`,
			);
		}
	}
	if (record.error) lines.push("", `Error: ${record.error}`);
	warningBlock(lines, record);
	return lines.join("\n");
}

/** Notification text sent to the parent conversation when a background agent finishes. */
export function formatBackgroundNotification(record: AgentRecord, maxChars = MAX_NOTIFICATION_RESULT_CHARS): string {
	const duration = (record.completedAt ?? Date.now()) - record.startedAt;
	const lines = [`Background sub-agent "${record.description}" (${record.type}) ${describeStatus(record)} in ${formatDuration(duration)}.`];
	if (record.modelName ?? record.modelId) {
		const model = record.modelName ?? record.modelId ?? "model";
		lines.push(`Model: ${record.modelReason ? `${model} (${record.modelReason})` : model}${record.thinking ? ` · thinking ${record.thinking}` : ""}`);
	}
	lines.push(`Turns: ${record.turns}`);
	if (record.result) {
		const capped = cap(record.result, maxChars);
		lines.push("", "Result:", capped.text + (capped.truncated ? "\n[…truncated]" : ""));
	}
	if (record.error) lines.push("", `Error: ${record.error}`);
	warningBlock(lines, record);
	lines.push("", `Use get_subagent_result with agent_id "${record.id}" to read the full output.`);
	// A detached spawn keeps the parent's turn running; a report written before
	// this notification existed is not the final answer to the delegated task.
	lines.push("If you already answered the delegated task, reconcile that answer with this result before finishing.");
	return lines.join("\n");
}
