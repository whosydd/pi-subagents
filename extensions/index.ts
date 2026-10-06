/**
 * Sub-agents for pi — delegate tasks to autonomous child agents.
 *
 * Scope: this extension covers what pi cannot do without a second agent loop —
 * a child with its own context window, its own model, its own tool set, and
 * optional background execution. Bulk tool orchestration, output filtering,
 * and deterministic pipelines belong to codemode and are deliberately absent
 * here.
 *
 * A spawn is detached by default: it returns an id and leaves the parent's turn
 * running. A caller that needs the answer in this tool result asks for it
 * explicitly with `run_in_background: false`.
 *
 * Tools:
 *   - Agent: spawn a sub-agent (background by default)
 *   - get_subagent_result: read a sub-agent's status and output by id
 *
 * Configuration (environment, read once at load — reload to change):
 *   PI_SUBAGENTS_AGENT_SCOPE             user (default) | project | both
 *   PI_SUBAGENTS_PERSIST=on              persist child sessions to disk instead of memory
 *   PI_SUBAGENTS_SESSION_DIR             session directory used when persisting
 *   PI_SUBAGENTS_MAX_CONCURRENCY         concurrent sub-agents (default: 4)
 *   PI_SUBAGENTS_MAX_RECORDS             retained agent records (default: 100)
 *   PI_SUBAGENTS_MAX_RESULT_CHARS        inline result cap (default: 8000)
 *   PI_SUBAGENTS_MAX_FULL_RESULT_CHARS   get_subagent_result cap (default: 100000)
 *   PI_SUBAGENTS_MAX_NOTIFICATION_CHARS  background notification cap (default: 800)
 *   PI_SUBAGENTS_BACKGROUND_TIMEOUT_MS   background wall-clock ceiling (default: 1800000)
 *   PI_SUBAGENTS_MAX_PROMPT_CHARS        prompt characters kept in a record (default: 2000)
 */

import type { Usage } from "@earendil-works/pi-ai";
import { defineTool, getAgentDir, type AgentToolResult, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { invalidateAgents, loadAgents } from "./lib/agents.ts";
import { ConcurrencyLimiter } from "./lib/limiter.ts";
import { describeModel, resolveModelInput } from "./lib/model.ts";
import {
	AgentRegistry,
	claimUsageReport,
	formatBackgroundNotification,
	formatRunResult,
	mergeWarnings,
	newAgentRecord,
	type ResultFormatOptions,
} from "./lib/registry.ts";
import { resolveSpawnPlan, type AgentToolParams, type SpawnPlan } from "./lib/spawn.ts";
import { runAgent, SUBAGENT_TOOL_NAMES, type RunOptions, type RunOutcome } from "./lib/session.ts";
import { readRuntimeSettings } from "./lib/settings.ts";
import {
	EMPTY_USAGE,
	THINKING_LEVELS,
	type AbortReason,
	type AgentRecord,
	type AgentToolDetails,
	type ResultToolDetails,
	type UsageTotals,
} from "./lib/types.ts";

const AGENT_TOOL_DESCRIPTION = `Launch a sub-agent that works autonomously on a task and reports back.

The sub-agent runs in its own session with its own context window: it sees the task you give it plus its agent instructions, not this conversation.

By default the spawn is detached — this call returns an id and your turn continues; the sub-agent's final message arrives as a notification when it finishes. Pass run_in_background: false when you need the answer in this tool result before you can act on it.

Agent types: "general" (all tools), "explore" (read-only: read/grep/find/ls), plus custom agents from the configured agent directories.

Use a sub-agent when a task needs its own context window (broad exploration, multi-file research), its own model or tool set, or a long run you should not wait on. For bulk tool calls, output filtering, and deterministic pipelines, use codemode instead — this tool does not orchestrate tools.`;

function textResult<T>(
	text: string,
	details: T,
	usage?: Usage,
): { content: { type: "text"; text: string }[]; details: T; usage?: Usage } {
	return usage ? { content: [{ type: "text", text }], details, usage } : { content: [{ type: "text", text }], details };
}

/**
 * Project the extension's running totals into pi's Usage shape so the parent
 * session's cost accounting includes the tokens its sub-agents burned.
 */
function toUsage(totals: UsageTotals): Usage {
	return {
		input: totals.input,
		output: totals.output,
		cacheRead: totals.cacheRead,
		cacheWrite: totals.cacheWrite,
		totalTokens: totals.input + totals.output + totals.cacheRead + totals.cacheWrite,
		cost: {
			input: totals.costInput ?? 0,
			output: totals.costOutput ?? 0,
			cacheRead: totals.costCacheRead ?? 0,
			cacheWrite: totals.costCacheWrite ?? 0,
			total: totals.cost,
		},
	};
}

/** The ModelRuntime facade pi keeps behind the extension-facing registry. */
function modelRuntimeOf(ctx: ExtensionContext): unknown {
	return (ctx.modelRegistry as unknown as { runtime?: unknown }).runtime;
}

function abortedOutcome(reason: AbortReason): RunOutcome {
	return { text: "", turns: 0, usage: { ...EMPTY_USAGE }, aborted: true, abortReason: reason };
}

function failureOutcome(error: unknown, reason?: AbortReason): RunOutcome {
	return {
		text: "",
		turns: 0,
		usage: { ...EMPTY_USAGE },
		aborted: reason !== undefined,
		abortReason: reason,
		error: error instanceof Error ? error.message : String(error),
	};
}

export default function subagentsExtension(pi: ExtensionAPI) {
	const runtime = readRuntimeSettings();
	const registry = new AgentRegistry(runtime.maxRecords);
	const limiter = new ConcurrencyLimiter(runtime.maxConcurrent);
	/** Abort controllers for in-flight background spawns. */
	const background = new Set<AbortController>();
	let shuttingDown = false;

	// Agent files are cached to keep spawns off the filesystem; a reload is when
	// the user says they edited one.
	invalidateAgents();

	// Background spawns outlive the tool call, so they must not outlive the
	// session: cancel them here instead of leaving orphaned child sessions.
	pi.on("session_shutdown", () => {
		shuttingDown = true;
		for (const controller of background) controller.abort();
		background.clear();
	});

	/**
	 * How much of a result each reader may carry. The inline cap is smaller, and
	 * the truncation notice may only point at `get_subagent_result` while that
	 * reader really does return more.
	 */
	const inlineFormat: ResultFormatOptions = {
		maxChars: runtime.maxResultChars,
		fullOutputAvailable: runtime.maxFullResultChars > runtime.maxResultChars,
	};
	const fullFormat: ResultFormatOptions = { maxChars: runtime.maxFullResultChars, fullOutputAvailable: false };

	function finishRecord(record: AgentRecord, outcome: RunOutcome): void {
		record.completedAt = Date.now();
		record.turns = outcome.turns;
		record.usage = outcome.usage;
		record.result = outcome.text || undefined;
		record.error = outcome.error;
		record.modelId = outcome.modelId ?? record.modelId;
		record.modelName = outcome.modelName ?? record.modelName;
		record.thinking = outcome.thinking ?? record.thinking;
		record.abortReason = outcome.abortReason ?? record.abortReason;
		record.warnings = mergeWarnings(record.warnings, outcome.warnings);
		record.sessionFile = outcome.sessionFile;
		record.status = outcome.aborted ? "aborted" : outcome.error ? "failed" : "completed";
	}

	function detailsFor(record: AgentRecord): AgentToolDetails {
		return {
			agentId: record.id,
			status: record.status,
			agentType: record.type,
			modelId: record.modelId,
			modelName: record.modelName,
			modelReason: record.modelReason,
			thinking: record.thinking,
			turns: record.turns,
			durationMs: record.completedAt ? record.completedAt - record.startedAt : undefined,
			// Everything the run spent, cache traffic included; the money rides on
			// the result's usage, not here.
			tokens: record.usage.input + record.usage.output + record.usage.cacheRead + record.usage.cacheWrite,
		};
	}

	/** A persisted run's session file, so the transcript is reachable after the fact. */
	function persistNote(record: AgentRecord): string {
		return record.sessionFile ? `\n\nChild session written to ${record.sessionFile}` : "";
	}

	/** Everything one run needs, built once and shared by both spawn paths. */
	function buildRunOptions(
		ctx: ExtensionContext,
		plan: SpawnPlan,
		prompt: string,
		signal: AbortSignal | undefined,
		onTurn?: (turn: number) => void,
	): RunOptions {
		return {
			cwd: ctx.cwd,
			agentDir: getAgentDir(),
			agent: plan.definition,
			prompt,
			model: plan.model,
			thinkingLevel: plan.thinking,
			maxTurns: plan.maxTurns,
			timeoutMs: plan.timeoutMs,
			modelRuntime: modelRuntimeOf(ctx),
			loadExtensions: !plan.isolated,
			persistSession: runtime.persistSessions,
			sessionDir: runtime.sessionDir,
			signal,
			...(onTurn ? { onTurn } : {}),
		};
	}

	/** Detached run: the parent already holds an id, so it is told when the run ends. */
	function startBackgroundRun(ctx: ExtensionContext, plan: SpawnPlan, prompt: string, record: AgentRecord): void {
		const controller = new AbortController();
		background.add(controller);
		void (async () => {
			let acquired = false;
			try {
				try {
					// Wait for a slot outside the tool call: the parent was promised
					// a detach, and the queue position is invisible to it either way.
					await limiter.acquire(controller.signal);
					acquired = true;
				} catch {
					finishRecord(record, abortedOutcome("parent"));
					return;
				}
				let outcome: RunOutcome;
				try {
					outcome = await runAgent(
						buildRunOptions(ctx, plan, prompt, controller.signal, (turn) => {
							record.turns = turn;
						}),
					);
				} catch (error) {
					outcome = failureOutcome(error, controller.signal.aborted ? "parent" : undefined);
				}
				finishRecord(record, outcome);
				// A notification after shutdown has nowhere to go.
				if (!shuttingDown) {
					pi.sendMessage<AgentToolDetails>(
						{
							customType: "subagent-notification",
							content: formatBackgroundNotification(record, runtime.maxNotificationChars) + persistNote(record),
							display: true,
							details: detailsFor(record),
						},
						{ deliverAs: "followUp", triggerTurn: true },
					);
				}
			} finally {
				if (acquired) limiter.release();
				background.delete(controller);
			}
		})();
	}

	const agentTool = defineTool({
		name: SUBAGENT_TOOL_NAMES.AGENT,
		label: "Agent",
		description: AGENT_TOOL_DESCRIPTION,
		promptSnippet: "Launch autonomous sub-agents for complex, multi-step tasks",
		promptGuidelines: [
			"Use Agent for broad exploration or work that would flood the main context window, and for independent tasks that can run in parallel. Use direct tools when the target is already known.",
			"A spawn is detached by default. Keep working; the result arrives as a notification. Do not poll get_subagent_result for a running agent, and pass run_in_background: false only when you cannot continue without the answer.",
			"Do not use Agent to batch tool calls, filter large outputs, or run a fixed pipeline — codemode does that in one script without a second model.",
			"An agent's summary describes intent, not outcome — verify the actual changes before reporting work as done.",
		],
		parameters: Type.Object({
			prompt: Type.String({ description: "The task for the agent to perform." }),
			description: Type.String({ description: "A short (3-5 word) description of the task, shown in notifications." }),
			subagent_type: Type.Optional(
				Type.String({
					description:
						'Agent type: "general" (default), "explore", or a custom agent from the configured agent directories. Unknown names return the available list.',
				}),
			),
			model: Type.Optional(
				Type.String({
					description:
						'Optional model override: an exact "provider/modelId" or an unambiguous bare model id. Omit to use the agent-file pin, then the parent model.',
				}),
			),
			thinking: Type.Optional(Type.String({ description: `Thinking level: ${THINKING_LEVELS.join(", ")}. Overrides the agent default and the parent session's level.` })),
			max_turns: Type.Optional(
				Type.Number({ description: "Maximum agent turns before the agent is told to wrap up. Omit for the agent default.", minimum: 1 }),
			),
			timeout_ms: Type.Optional(
				Type.Number({ description: "Optional wall-clock limit in milliseconds; the run is aborted when it passes.", minimum: 1 }),
			),
			run_in_background: Type.Optional(
				Type.Boolean({
					description:
						"Defaults to true — the call returns an id immediately and the run continues after this turn, reporting its result in a notification. Set false to block until the agent finishes, which puts its full output (and its token usage) in this tool result.",
				}),
			),
			isolated: Type.Optional(Type.Boolean({ description: "If true the agent gets only built-in tools (no extension/MCP tools)." })),
		}),

		async execute(_toolCallId, params, signal, _onUpdate, ctx): Promise<AgentToolResult<AgentToolDetails>> {
			const { agents, warnings } = loadAgents(ctx.cwd, getAgentDir(), runtime.agentScope);
			const resolved = resolveSpawnPlan(
				params as AgentToolParams,
				agents,
				(spec) => resolveModelInput(spec, ctx.modelRegistry),
				{
					parentModel: ctx.model,
					parentThinking: ctx.thinkingLevel,
					backgroundTimeoutMs: runtime.backgroundTimeoutMs,
				},
			);
			if (!resolved.ok) {
				return textResult(resolved.message, { status: "failed", agentType: resolved.agentType });
			}
			const plan = resolved.plan;

			const described = plan.model ? describeModel(plan.model) : undefined;
			const record = newAgentRecord({
				type: plan.typeName,
				description: params.description || plan.typeName,
				prompt: params.prompt,
				modelReason: plan.modelReason,
				modelId: described?.id,
				modelName: described?.name,
				maxPromptChars: runtime.maxPromptChars,
			});
			// Agent-file warnings are seeded on the record so a detached spawn
			// surfaces them too: its start reply and completion notification are
			// the only places the parent sees them.
			if (warnings.length > 0) record.warnings = [...warnings];
			registry.add(record);

			const warningNote =
				warnings.length > 0 ? `\n\nAgent file warnings:\n${warnings.map((warning) => `- ${warning}`).join("\n")}` : "";

			if (plan.background) {
				startBackgroundRun(ctx, plan, params.prompt, record);
				return textResult(
					`Sub-agent "${record.id}" started in the background.\nType: ${plan.typeName}${record.modelName ? ` · Model: ${record.modelName}` : ""}\nKeep working; you will be notified when it finishes — do not poll. Pass run_in_background: false if you need the result before you can continue.${warningNote}`,
					detailsFor(record),
				);
			}

			try {
				await limiter.acquire(signal);
			} catch {
				finishRecord(record, abortedOutcome("parent"));
				return textResult(formatRunResult(record, inlineFormat), detailsFor(record));
			}
			let outcome: RunOutcome;
			try {
				outcome = await runAgent(buildRunOptions(ctx, plan, params.prompt, signal));
			} catch (error) {
				outcome = failureOutcome(error, signal?.aborted === true ? "parent" : undefined);
			} finally {
				limiter.release();
			}
			finishRecord(record, outcome);
			// This result carries the usage; a later read must not count it twice.
			record.usageReported = true;
			// formatRunResult renders the record's warnings (agent-file ones
			// included), so no separate note is needed here.
			return textResult(formatRunResult(record, inlineFormat) + persistNote(record), detailsFor(record), toUsage(record.usage));
		},
	});

	const resultTool = defineTool({
		name: SUBAGENT_TOOL_NAMES.GET_RESULT,
		label: "Get sub-agent result",
		description:
			"Read the status and output of a sub-agent by id. Use after a background sub-agent reports completion, or to re-read a finished agent's output. This is the full-text reader: it returns more than the Agent tool's inline result.",
		parameters: Type.Object({
			agent_id: Type.String({ description: 'The sub-agent id returned by Agent, e.g. "sa_..."' }),
		}),
		async execute(_toolCallId, params): Promise<AgentToolResult<ResultToolDetails>> {
			const record = registry.get(params.agent_id);
			if (!record) {
				return textResult(`Sub-agent not found: "${params.agent_id}"`, { agentId: params.agent_id, status: "failed", found: false });
			}
			// A running agent has no output to read yet; say so instead of handing
			// back an empty result the caller has to interpret.
			if (record.status === "running") {
				return textResult(
					`Sub-agent "${record.id}" (${record.type}) is still running — ${record.turns} turn${record.turns === 1 ? "" : "s"} so far.\nYou will be notified when it finishes; no need to poll.`,
					{ agentId: record.id, status: "running", found: true, turns: record.turns },
				);
			}

			const details: ResultToolDetails = { agentId: record.id, status: record.status, found: true, turns: record.turns };
			const text = formatRunResult(record, fullFormat) + persistNote(record);
			// A detached run's notification is not a tool result, so pi never
			// counted its tokens. This first read is where they enter the session
			// total; later reads of the same run would double-count.
			if (claimUsageReport(record)) {
				details.usageReported = true;
				return textResult(text, details, toUsage(record.usage));
			}
			details.usageReported = false;
			return textResult(text, details);
		},
	});

	pi.registerTool(agentTool);
	pi.registerTool(resultTool);
}