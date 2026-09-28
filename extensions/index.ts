/**
 * Sub-agents for pi — delegate tasks to autonomous child agents.
 *
 * Tools:
 *   - Agent: spawn a sub-agent (blocking by default; background optional)
 *   - get_subagent_result: read a sub-agent's status and output by id
 *
 * When TYPESAFE_API_KEY is set, jev (TypeSafe) judges two decisions:
 *   - model routing for spawns with no explicit model and no agent-file pin
 *   - result sufficiency after a run (informational — the parent decides)
 *
 * Configuration (environment):
 *   TYPESAFE_API_KEY           enables jev judgments when set
 *   JEV_SUBAGENTS=off          disable all jev judgments
 *   JEV_SUBAGENTS_MODEL        jev model id (default: jev-latest)
 *   JEV_SUBAGENTS_ROUTE=off    disable model routing
 *   JEV_SUBAGENTS_VERIFY=off   disable result verification
 *   JEV_SUBAGENTS_CANDIDATES   comma-separated provider/modelId candidates
 *   JEV_SUBAGENTS_MAX_CANDIDATES  router candidate cap (default: 12)
 */

import {
	defineTool,
	getAgentDir,
	type AgentToolResult,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { describeAgents, loadAgents } from "./lib/agents.ts";
import { buildJevFailureWarning, markJevFailureWarned, shouldWarnAboutJevFailure, type JevFailure } from "./lib/jev/client.ts";
import { judgeModelRoute } from "./lib/jev/route.ts";
import { judgeSubagentResult } from "./lib/jev/verify.ts";
import { describeModel, modelKey, resolveModelInput, routeCandidates } from "./lib/model.ts";
import { AgentRegistry, formatBackgroundNotification, formatDuration, formatRecordStatus, newAgentId } from "./lib/registry.ts";
import { runAgent, SUBAGENT_TOOL_NAMES, type RunOutcome } from "./lib/session.ts";
import { readJevSettings } from "./lib/settings.ts";
import {
	EMPTY_USAGE,
	isThinkingLevel,
	THINKING_LEVELS,
	type AgentRecord,
	type AgentToolDetails,
	type ResultToolDetails,
} from "./lib/types.ts";

const AGENT_TOOL_DESCRIPTION = `Launch a sub-agent that works autonomously on a task and reports back.

The sub-agent runs in its own session with its own context window: it sees the task you give it plus its agent instructions, not this conversation. Its final message becomes this tool's result. When TYPESAFE_API_KEY is configured, Jev picks the model for spawns without an explicit model (the model parameter and agent-file pins win) and judges the result's sufficiency.

Agent types: "general" (all tools), "explore" (read-only: read/grep/find/ls), plus custom agents from .pi/agents/*.md (project) and the global agents directory.

Use sub-agents for work that would flood this context window (broad exploration, multi-file research) or that can run in parallel. When the target is already known, use direct tools instead.`;

function textResult<T>(text: string, details: T): { content: { type: "text"; text: string }[]; details: T } {
	return { content: [{ type: "text", text }], details };
}

/** The ModelRuntime facade pi keeps behind the extension-facing registry. */
function modelRuntimeOf(ctx: ExtensionContext): unknown {
	return (ctx.modelRegistry as unknown as { runtime?: unknown }).runtime;
}

function failureOutcome(error: unknown): RunOutcome {
	return {
		text: "",
		turns: 0,
		usage: { ...EMPTY_USAGE },
		aborted: false,
		error: error instanceof Error ? error.message : String(error),
	};
}

export default function subagentsExtension(pi: ExtensionAPI) {
	const registry = new AgentRegistry();

	function warnIfActionable(ctx: ExtensionContext, failure: JevFailure): void {
		if (failure.kind !== "actionable" || !ctx.hasUI || !shouldWarnAboutJevFailure()) return;
		markJevFailureWarned();
		ctx.ui.notify(buildJevFailureWarning(failure), "warning");
	}

	function finishRecord(record: AgentRecord, outcome: RunOutcome): void {
		record.completedAt = Date.now();
		record.turns = outcome.turns;
		record.usage = outcome.usage;
		record.result = outcome.text || undefined;
		record.error = outcome.error;
		record.modelId = outcome.modelId ?? record.modelId;
		record.modelName = outcome.modelName ?? record.modelName;
		record.status = outcome.error ? "failed" : outcome.aborted ? "aborted" : "completed";
	}

	async function verifyRecord(ctx: ExtensionContext, record: AgentRecord, signal?: AbortSignal): Promise<void> {
		const jev = readJevSettings();
		if (!jev.enabled || !jev.verify || !jev.apiKey || !record.result) return;
		const decision = await judgeSubagentResult({
			apiKey: jev.apiKey,
			task: record.prompt,
			agentType: record.type,
			result: record.result,
			model: jev.model,
			signal,
		});
		if (!decision) return;
		if (decision.failure) {
			warnIfActionable(ctx, decision.failure);
			return;
		}
		if (decision.verdict) record.jev = { ...(record.jev ?? {}), verify: decision.verdict };
	}

	function detailsFor(record: AgentRecord): AgentToolDetails {
		return {
			agentId: record.id,
			status: record.status,
			agentType: record.type,
			modelId: record.modelId,
			modelName: record.modelName,
			modelReason: record.modelReason,
			turns: record.turns,
			durationMs: record.completedAt ? record.completedAt - record.startedAt : undefined,
			tokens: record.usage.input + record.usage.output,
			jev: record.jev,
		};
	}

	function formatRunResult(record: AgentRecord): string {
		const duration = (record.completedAt ?? Date.now()) - record.startedAt;
		const statusLine =
			record.status === "running"
				? "Sub-agent still running"
				: record.status === "aborted"
					? "Sub-agent aborted (turn limit reached)"
					: record.status === "failed"
						? "Sub-agent failed"
						: "Sub-agent completed";
		const stats = [
			record.modelName ?? record.modelId ?? "model",
			`${record.turns} turn${record.turns === 1 ? "" : "s"}`,
			formatDuration(duration),
		];
		const lines = [`${statusLine}: ${record.type} · ${stats.join(" · ")}`];
		if (record.result) lines.push("", record.result);
		if (record.error) lines.push("", `Error: ${record.error}`);
		if (record.jev?.verify) lines.push("", "---", record.jev.verify);
		return lines.join("\n");
	}

	const agentTool = defineTool({
		name: SUBAGENT_TOOL_NAMES.AGENT,
		label: "Agent",
		description: AGENT_TOOL_DESCRIPTION,
		promptSnippet: "Launch autonomous sub-agents for complex, multi-step tasks",
		promptGuidelines: [
			"Use Agent for broad exploration or work that would flood the main context window, and for independent tasks that can run in parallel. Use direct tools when the target is already known.",
			"An agent's summary describes intent, not outcome — verify the actual changes before reporting work as done.",
		],
		parameters: Type.Object({
			prompt: Type.String({ description: "The task for the agent to perform." }),
			description: Type.String({ description: "A short (3-5 word) description of the task, shown in notifications." }),
			subagent_type: Type.Optional(
				Type.String({
					description:
						'Agent type: "general" (default), "explore", or a custom agent from .pi/agents/*.md. Unknown names return the available list.',
				}),
			),
			model: Type.Optional(
				Type.String({
					description:
						'Optional model override: "provider/modelId" or a fuzzy name (e.g. "haiku"). Omit to use the agent-file pin, jev routing, or the parent model.',
				}),
			),
			thinking: Type.Optional(Type.String({ description: `Thinking level: ${THINKING_LEVELS.join(", ")}. Overrides the agent default.` })),
			max_turns: Type.Optional(
				Type.Number({ description: "Maximum agent turns before the agent is told to wrap up. Omit for the agent default.", minimum: 1 }),
			),
			run_in_background: Type.Optional(
				Type.Boolean({
					description:
						"Defaults to false — the call blocks and returns the agent's full output inline. Set true to detach and receive a completion notification instead; use it when you have other work to do in parallel.",
				}),
			),
			isolated: Type.Optional(Type.Boolean({ description: "If true the agent gets only built-in tools (no extension/MCP tools)." })),
		}),

		async execute(_toolCallId, params, signal, onUpdate, ctx): Promise<AgentToolResult<AgentToolDetails>> {
			const agentDir = getAgentDir();
			const { agents, warnings } = loadAgents(ctx.cwd, agentDir);
			const typeName = params.subagent_type?.trim() || "general";
			const definition = agents.get(typeName);
			if (!definition) {
				return textResult(`Unknown agent type "${typeName}". Available types: ${[...agents.keys()].sort().join(", ")}`, {
					status: "failed",
					agentType: typeName,
				});
			}

			if (params.thinking !== undefined && !isThinkingLevel(params.thinking)) {
				return textResult(`Invalid thinking level "${params.thinking}". Expected one of: ${THINKING_LEVELS.join(", ")}`, {
					status: "failed",
					agentType: typeName,
				});
			}
			const thinking = params.thinking ?? definition.thinking;

			// Model precedence: explicit parameter > agent-file pin > jev routing > parent model.
			let model = ctx.model;
			let modelReason = ctx.model ? "parent session model" : "pi default";
			let routeVerdict: string | undefined;
			const jev = readJevSettings();

			if (params.model) {
				const resolved = resolveModelInput(params.model, ctx.modelRegistry);
				if (typeof resolved === "string") return textResult(resolved, { status: "failed", agentType: typeName });
				model = resolved;
				modelReason = "explicit model parameter";
			} else if (definition.model) {
				const resolved = resolveModelInput(definition.model, ctx.modelRegistry);
				if (typeof resolved === "string") {
					return textResult(`Agent "${typeName}" pins an unknown model.\n\n${resolved}`, { status: "failed", agentType: typeName });
				}
				model = resolved;
				modelReason = `agent "${typeName}" model`;
			} else if (jev.enabled && jev.route && jev.apiKey) {
				const routed = routeCandidates({
					registry: ctx.modelRegistry,
					parent: ctx.model,
					spec: jev.candidates,
					cap: jev.maxCandidates,
				});
				warnings.push(...routed.warnings);
				if (routed.candidates.length >= 2) {
					const decision = await judgeModelRoute({
						apiKey: jev.apiKey,
						task: params.prompt,
						agentType: typeName,
						agentDescription: definition.description,
						candidates: routed.candidates.map((candidate) => ({ key: candidate.key, label: candidate.label })),
						parentKey: ctx.model ? modelKey(ctx.model) : undefined,
						model: jev.model,
						signal,
					});
					if (decision?.failure) warnIfActionable(ctx, decision.failure);
					if (decision?.verdict) routeVerdict = decision.verdict;
					if (decision?.chosen) {
						const chosen = routed.candidates.find((candidate) => candidate.key === decision.chosen);
						if (chosen) {
							model = chosen.model;
							modelReason = "jev routing";
						}
					}
				}
			}

			const described = model ? describeModel(model) : undefined;
			const record: AgentRecord = {
				id: newAgentId(),
				type: typeName,
				description: params.description || typeName,
				prompt: params.prompt,
				definition,
				status: "running",
				startedAt: Date.now(),
				turns: 0,
				usage: { ...EMPTY_USAGE },
				modelReason,
				modelId: described?.id,
				modelName: described?.name,
				jev: routeVerdict ? { route: routeVerdict } : undefined,
			};
			registry.add(record);

			if (params.run_in_background === true) {
				void (async () => {
					try {
						const outcome = await runAgent({
							cwd: ctx.cwd,
							agentDir,
							agent: definition,
							prompt: params.prompt,
							model,
							thinkingLevel: thinking,
							maxTurns: params.max_turns ?? definition.maxTurns,
							modelRuntime: modelRuntimeOf(ctx),
							loadExtensions: params.isolated !== true,
						});
						finishRecord(record, outcome);
						await verifyRecord(ctx, record);
					} catch (error) {
						finishRecord(record, failureOutcome(error));
					}
					pi.sendMessage<AgentToolDetails>(
						{
							customType: "subagent-notification",
							content: formatBackgroundNotification(record),
							display: true,
							details: detailsFor(record),
						},
						{ deliverAs: "followUp", triggerTurn: true },
					);
				})();
				return textResult(
					`Sub-agent "${record.id}" started in the background.\nType: ${typeName}${record.modelName ? ` · Model: ${record.modelName}` : ""}\nYou will be notified when it finishes — do not poll.`,
					detailsFor(record),
				);
			}

			let outcome: RunOutcome;
			try {
				outcome = await runAgent({
					cwd: ctx.cwd,
					agentDir,
					agent: definition,
					prompt: params.prompt,
					model,
					thinkingLevel: thinking,
					maxTurns: params.max_turns ?? definition.maxTurns,
					modelRuntime: modelRuntimeOf(ctx),
					loadExtensions: params.isolated !== true,
					signal,
					onUpdate: onUpdate
						? (update) => {
								const preview = update.toolName ? `[${update.toolName}] ${update.text}` : update.text;
								onUpdate({ content: [{ type: "text", text: preview || "…" }], details: detailsFor(record) });
							}
						: undefined,
				});
			} catch (error) {
				outcome = failureOutcome(error);
			}
			finishRecord(record, outcome);
			await verifyRecord(ctx, record, signal);

			const warningNote = warnings.length > 0 ? `\n\n(agent file warnings: ${warnings.join("; ")})` : "";
			return textResult(formatRunResult(record) + warningNote, detailsFor(record));
		},
	});

	const resultTool = defineTool({
		name: SUBAGENT_TOOL_NAMES.GET_RESULT,
		label: "Get sub-agent result",
		description:
			"Read the status and output of a sub-agent by id. Use after a background sub-agent reports completion, or to re-read a finished agent's output.",
		parameters: Type.Object({
			agent_id: Type.String({ description: 'The sub-agent id returned by Agent, e.g. "sa_..."' }),
		}),
		async execute(_toolCallId, params): Promise<AgentToolResult<ResultToolDetails>> {
			const record = registry.get(params.agent_id);
			if (!record) {
				return textResult(`Sub-agent not found: "${params.agent_id}"`, { agentId: params.agent_id, status: "failed", found: false });
			}
			record.consumed = true;
			return textResult(formatRunResult(record), { agentId: record.id, status: record.status, found: true });
		},
	});

	pi.registerTool(agentTool);
	pi.registerTool(resultTool);

	pi.registerCommand("subagents", {
		description: "Show sub-agent status: jev configuration, agent types, running agents",
		handler: async (_args, ctx) => {
			const jev = readJevSettings();
			const { agents, warnings } = loadAgents(ctx.cwd, getAgentDir());
			const lines = [
				`jev: ${jev.enabled ? `on — model ${jev.model} (route ${jev.route ? "on" : "off"}, verify ${jev.verify ? "on" : "off"})` : "off — set TYPESAFE_API_KEY to enable"}`,
				`     candidates: ${jev.candidates.length > 0 ? jev.candidates.join(", ") : `all available models (cap ${jev.maxCandidates})`}`,
				"",
				"Agent types:",
				describeAgents(agents),
			];
			const running = registry.running();
			if (running.length > 0) lines.push("", "Running:", ...running.map((record) => `- ${formatRecordStatus(record)}`));
			if (warnings.length > 0) lines.push("", "Warnings:", ...warnings.map((warning) => `- ${warning}`));
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
