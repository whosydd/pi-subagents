/**
 * In-process registry of sub-agent records plus the formatting helpers shared
 * by tool results, notifications and the /subagents command.
 */

import type { AgentRecord } from "./types.ts";

let sequence = 0;

/** Short unique agent id: `sa_<time36><counter>`. */
export function newAgentId(): string {
	sequence = (sequence + 1) % 46_656;
	return `sa_${Date.now().toString(36)}${sequence.toString(36).padStart(3, "0")}`;
}

export class AgentRegistry {
	private readonly records = new Map<string, AgentRecord>();

	add(record: AgentRecord): AgentRecord {
		this.records.set(record.id, record);
		return record;
	}

	get(id: string): AgentRecord | undefined {
		return this.records.get(id);
	}

	all(): AgentRecord[] {
		return [...this.records.values()].sort((a, b) => a.startedAt - b.startedAt);
	}

	running(): AgentRecord[] {
		return this.all().filter((record) => record.status === "running");
	}
}

export function formatDuration(ms: number): string {
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
	const minutes = Math.floor(ms / 60_000);
	return `${minutes}m ${Math.round((ms % 60_000) / 1000)}s`;
}

export function formatTokens(count: number): string {
	if (count >= 1000) return `${(count / 1000).toFixed(1)}k`;
	return `${count}`;
}

/** One-line status for command output. */
export function formatRecordStatus(record: AgentRecord): string {
	const duration = (record.completedAt ?? Date.now()) - record.startedAt;
	const parts = [
		record.modelName ?? record.modelId ?? "model",
		`${record.turns} turn${record.turns === 1 ? "" : "s"}`,
		formatDuration(duration),
	];
	return `${record.id} (${record.type}) — ${record.status} · ${parts.join(" · ")}`;
}

/** Notification text sent to the parent conversation when a background agent finishes. */
export function formatBackgroundNotification(record: AgentRecord, maxResultChars = 800): string {
	const duration = (record.completedAt ?? Date.now()) - record.startedAt;
	const lines = [`Background sub-agent "${record.description}" (${record.type}) ${record.status} in ${formatDuration(duration)}.`];
	if (record.modelName ?? record.modelId) lines.push(`Model: ${record.modelName ?? record.modelId}`);
	if (record.result) {
		const result = record.result.length > maxResultChars ? `${record.result.slice(0, maxResultChars)}\n[…truncated]` : record.result;
		lines.push("", "Result:", result);
	}
	if (record.error) lines.push("", `Error: ${record.error}`);
	if (record.jev?.verify) lines.push("", record.jev.verify);
	lines.push("", `Use get_subagent_result with agent_id "${record.id}" to read the full output.`);
	return lines.join("\n");
}
