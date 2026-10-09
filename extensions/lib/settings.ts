/**
 * Configuration, read from the environment once when the extension loads.
 * `/reload` (or a pi restart) picks up changes.
 */

export type AgentScope = "user" | "project" | "both";

export interface RuntimeSettings {
	/** Persist child sessions to disk instead of keeping them in memory. */
	persistSessions: boolean;
	/** Session directory used when persisting (pi's default when unset). */
	sessionDir?: string;
	/** Upper bound on sub-agents running at the same time. */
	maxConcurrent: number;
	/** Upper bound on retained agent records. */
	maxRecords: number;
	/**
	 * Which agent directories load. `user` (the default) reads only
	 * `<agentDir>/agents`; project agents under `<cwd>/.pi/agents` can override
	 * built-ins and are therefore opt-in.
	 */
	agentScope: AgentScope;
	/** Characters of a run's result carried inline by the Agent tool. */
	maxResultChars: number;
	/**
	 * Characters `get_subagent_result` returns. It is the full-text escape hatch
	 * and must stay above `maxResultChars`, or the truncation notice would send
	 * the caller back to a limit that truncates the same text.
	 */
	maxFullResultChars: number;
	/** Characters of a run's result carried by a background notification. */
	maxNotificationChars: number;
	/**
	 * Wall-clock ceiling for background runs, which have no parent tool call to
	 * cancel them. A run that hits it aborts instead of holding a concurrency
	 * slot until the session ends.
	 */
	backgroundTimeoutMs: number;
	/** Prompt characters kept in the record; the rest is dropped. */
	maxPromptChars: number;
	/** Live sub-agent activity panel above the editor (TUI sessions only). */
	activityUi: boolean;
}

const DEFAULT_MAX_CONCURRENT = 4;
const DEFAULT_MAX_RECORDS = 100;
const DEFAULT_MAX_RESULT_CHARS = 8_000;
const DEFAULT_MAX_FULL_RESULT_CHARS = 100_000;
const DEFAULT_MAX_NOTIFICATION_CHARS = 800;
const DEFAULT_BACKGROUND_TIMEOUT_MS = 30 * 60_000;
const DEFAULT_MAX_PROMPT_CHARS = 2_000;

function parseToggle(value: string | undefined, fallback: boolean): boolean {
	if (value === undefined) return fallback;
	const normalized = value.trim().toLowerCase();
	if (["off", "0", "false", "no"].includes(normalized)) return false;
	if (["on", "1", "true", "yes"].includes(normalized)) return true;
	return fallback;
}

function parseScope(value: string | undefined): AgentScope {
	const normalized = value?.trim().toLowerCase();
	if (normalized === "project" || normalized === "both") return normalized;
	return "user";
}

/** A positive whole number from the environment, or the fallback. */
function readLimit(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
	const parsed = Number(env[key] ?? "");
	return Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : fallback;
}

export function readRuntimeSettings(env: NodeJS.ProcessEnv = process.env): RuntimeSettings {
	const maxResultChars = readLimit(env, "PI_SUBAGENTS_MAX_RESULT_CHARS", DEFAULT_MAX_RESULT_CHARS);
	return {
		persistSessions: parseToggle(env.PI_SUBAGENTS_PERSIST, false),
		sessionDir: env.PI_SUBAGENTS_SESSION_DIR?.trim() || undefined,
		maxConcurrent: readLimit(env, "PI_SUBAGENTS_MAX_CONCURRENCY", DEFAULT_MAX_CONCURRENT),
		maxRecords: readLimit(env, "PI_SUBAGENTS_MAX_RECORDS", DEFAULT_MAX_RECORDS),
		agentScope: parseScope(env.PI_SUBAGENTS_AGENT_SCOPE),
		maxResultChars,
		// The escape hatch never truncates below the inline limit, whatever the
		// two are configured to: a notice pointing at a smaller cap is the dead
		// end this pair exists to avoid.
		maxFullResultChars: Math.max(readLimit(env, "PI_SUBAGENTS_MAX_FULL_RESULT_CHARS", DEFAULT_MAX_FULL_RESULT_CHARS), maxResultChars),
		maxNotificationChars: readLimit(env, "PI_SUBAGENTS_MAX_NOTIFICATION_CHARS", DEFAULT_MAX_NOTIFICATION_CHARS),
		backgroundTimeoutMs: readLimit(env, "PI_SUBAGENTS_BACKGROUND_TIMEOUT_MS", DEFAULT_BACKGROUND_TIMEOUT_MS),
		maxPromptChars: readLimit(env, "PI_SUBAGENTS_MAX_PROMPT_CHARS", DEFAULT_MAX_PROMPT_CHARS),
		activityUi: parseToggle(env.PI_SUBAGENTS_UI, true),
	};
}
