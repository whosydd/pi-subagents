/**
 * Child-session execution: create a pi session for an agent definition, run
 * one prompt, collect the result, dispose.
 *
 * Extensions load in the child session by default, so sub-agents can use the
 * tools the user installed (web search, MCP, ...). This extension's own
 * orchestration tools are excluded to prevent recursion. `loadExtensions:
 * false` (the `isolated` spawn option) turns extensions off entirely and
 * leaves the built-in tools.
 */

import {
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { describeModel } from "./model.ts";
import { EMPTY_USAGE, type AgentDefinition, type ModelLike, type ThinkingLevel, type UsageTotals } from "./types.ts";

/** Tools registered by this extension that child sessions must not inherit. */
export const SUBAGENT_TOOL_NAMES = {
	AGENT: "Agent",
	GET_RESULT: "get_subagent_result",
} as const;

const EXCLUDED_TOOL_NAMES: string[] = Object.values(SUBAGENT_TOOL_NAMES);

/** pi's built-in tool names. */
export const BUILTIN_TOOL_NAMES = ["read", "bash", "powershell", "edit", "write", "grep", "find", "ls"] as const;

export interface RunUpdate {
	text: string;
	turn: number;
	toolName?: string;
}

export interface RunOptions {
	cwd: string;
	agentDir: string;
	agent: AgentDefinition;
	prompt: string;
	model?: ModelLike;
	thinkingLevel?: ThinkingLevel;
	maxTurns?: number;
	/** Opaque ModelRuntime facade read off the parent ExtensionContext, when available. */
	modelRuntime?: unknown;
	/** Load user/project extensions inside the child session (default true). */
	loadExtensions?: boolean;
	signal?: AbortSignal;
	onUpdate?: (update: RunUpdate) => void;
}

export interface RunOutcome {
	text: string;
	turns: number;
	usage: UsageTotals;
	aborted: boolean;
	error?: string;
	model?: ModelLike;
	modelId?: string;
	modelName?: string;
}

/** Number of grace turns after the soft limit before the run is aborted. */
const GRACE_TURNS = 3;

export function buildSystemPrompt(agent: AgentDefinition, cwd: string): string {
	const bridge = `<sub_agent_context>
You are operating as a sub-agent invoked to handle a specific task.
- Use the read tool instead of cat/head/tail
- Use the edit tool instead of sed/awk
- Use the write tool instead of echo/heredoc
- Use the find tool instead of bash find/ls for file search
- Use the grep tool instead of bash grep/rg for content search
- Make independent tool calls in parallel
- Use absolute file paths
- Be concise but complete
</sub_agent_context>`;

	const environment = `# Environment
Working directory: ${cwd}
Platform: ${process.platform}`;

	const instructions = agent.systemPrompt.trim()
		? `\n\n<agent_instructions>\n${agent.systemPrompt.trim()}\n</agent_instructions>`
		: "";

	return `You are a pi sub-agent. You were spawned to handle a specific task autonomously, then report the result back to the agent that spawned you.\n\n${bridge}\n\n${environment}${instructions}`;
}

export async function runAgent(options: RunOptions): Promise<RunOutcome> {
	const agentDir = options.agentDir || getAgentDir();
	const systemPrompt = buildSystemPrompt(options.agent, options.cwd);

	const loader = new DefaultResourceLoader({
		cwd: options.cwd,
		agentDir,
		noExtensions: options.loadExtensions === false,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		systemPromptOverride: () => systemPrompt,
		appendSystemPromptOverride: () => [],
	});
	await loader.reload();

	const excludeTools = new Set<string>(EXCLUDED_TOOL_NAMES);
	for (const tool of options.agent.disallowedTools ?? []) excludeTools.add(tool);
	if (options.agent.tools) {
		// Narrow built-ins with a deny-list rather than an allowlist: an
		// allowlist freezes pi's registry snapshot at construction and
		// permanently drops extension tools that register later.
		for (const builtin of BUILTIN_TOOL_NAMES) {
			if (!options.agent.tools.includes(builtin)) excludeTools.add(builtin);
		}
	}

	const sessionOptions = {
		cwd: options.cwd,
		agentDir,
		sessionManager: SessionManager.inMemory(options.cwd),
		settingsManager: SettingsManager.create(options.cwd, agentDir),
		resourceLoader: loader,
		excludeTools: [...excludeTools],
		...(options.model ? { model: options.model } : {}),
		...(options.modelRuntime ? { modelRuntime: options.modelRuntime } : {}),
		...(options.thinkingLevel ? { thinkingLevel: options.thinkingLevel } : {}),
	} as Parameters<typeof createAgentSession>[0];

	const { session } = await createAgentSession(sessionOptions);

	let text = "";
	let turns = 0;
	const usage: UsageTotals = { ...EMPTY_USAGE };
	let aborted = false;
	let softLimitReached = false;
	const maxTurns = options.maxTurns ?? options.agent.maxTurns;

	const unsubscribe = session.subscribe((event) => {
		if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
			text += event.assistantMessageEvent.delta;
			options.onUpdate?.({ text, turn: turns });
			return;
		}
		if (event.type === "turn_end") {
			turns += 1;
			options.onUpdate?.({ text, turn: turns });
			if (maxTurns != null) {
				if (!softLimitReached && turns >= maxTurns) {
					softLimitReached = true;
					void session.steer("You have reached your turn limit. Wrap up immediately and provide your final answer now.");
				} else if (softLimitReached && turns >= maxTurns + GRACE_TURNS) {
					aborted = true;
					void session.abort();
				}
			}
			return;
		}
		if (event.type === "tool_execution_start") {
			options.onUpdate?.({ text, turn: turns, toolName: event.toolName });
			return;
		}
		if (event.type === "message_end" && event.message.role === "assistant") {
			const reported = (
				event.message as {
					usage?: { input?: number; output?: number; cacheWrite?: number; cacheRead?: number; cost?: { total?: number } };
				}
			).usage;
			if (reported) {
				usage.input += reported.input ?? 0;
				usage.output += reported.output ?? 0;
				usage.cacheWrite += reported.cacheWrite ?? 0;
				usage.cacheRead += reported.cacheRead ?? 0;
				usage.cost += reported.cost?.total ?? 0;
			}
		}
	});

	// Extensions loaded into the child need session_start to fire before the run.
	await session.bindExtensions({ onError: () => {} });

	const onAbort = () => {
		aborted = true;
		void session.abort();
	};
	options.signal?.addEventListener("abort", onAbort, { once: true });

	let error: string | undefined;
	try {
		await session.prompt(options.prompt);
	} catch (promptError) {
		error = promptError instanceof Error ? promptError.message : String(promptError);
	} finally {
		options.signal?.removeEventListener("abort", onAbort);
		unsubscribe();
	}

	const liveModel = session.model;
	const described = liveModel ? describeModel(liveModel) : undefined;
	const finalText = text.trim() || (session.getLastAssistantText()?.trim() ?? "");
	session.dispose();

	return {
		text: finalText,
		turns,
		usage,
		aborted,
		error,
		model: liveModel,
		modelId: described?.id,
		modelName: described?.name,
	};
}
