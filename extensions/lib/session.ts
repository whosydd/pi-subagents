/**
 * Child-session execution: create a pi session for an agent definition, run
 * one prompt, collect the result, dispose.
 *
 * Extensions load in the child session by default, so sub-agents can use the
 * tools the user installed. This extension's own orchestration tools are
 * excluded to prevent recursion. `loadExtensions: false` (the `isolated` spawn
 * option) turns extensions off entirely and leaves the built-in tools.
 *
 * The child gets a self-contained system prompt instead of pi's base prompt:
 * its job is narrow, and pi's tool/docs sections would only be paid for.
 */

import {
	createAgentSession,
	DefaultResourceLoader,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { builtinToolNames } from "./builtin-tools.ts";
import { describeModel } from "./model.ts";
import { EMPTY_USAGE, type AbortReason, type AgentDefinition, type ModelLike, type ThinkingLevel, type UsageTotals } from "./types.ts";

/** Tools registered by this extension that child sessions must not inherit. */
export const SUBAGENT_TOOL_NAMES = {
	AGENT: "Agent",
	GET_RESULT: "get_subagent_result",
} as const;

const EXCLUDED_TOOL_NAMES: string[] = Object.values(SUBAGENT_TOOL_NAMES);

export interface RunOptions {
	cwd: string;
	agentDir: string;
	agent: AgentDefinition;
	prompt: string;
	model?: ModelLike;
	thinkingLevel?: ThinkingLevel;
	maxTurns?: number;
	/** Wall-clock limit; the run is aborted when it passes. */
	timeoutMs?: number;
	/** Opaque ModelRuntime facade read off the parent ExtensionContext, when available. */
	modelRuntime?: unknown;
	/** Load user/project extensions inside the child session (default true). */
	loadExtensions?: boolean;
	/** Write the child session to disk instead of keeping it in memory. */
	persistSession?: boolean;
	/** Session directory used when persisting (pi's default when unset). */
	sessionDir?: string;
	signal?: AbortSignal;
	/** Called after every finished turn so a background run's live status stays current. */
	onTurn?: (turn: number) => void;
}

export interface RunOutcome {
	text: string;
	turns: number;
	usage: UsageTotals;
	aborted: boolean;
	/** Set when the run ended early; also carries the wording of the result header. */
	abortReason?: AbortReason;
	error?: string;
	modelId?: string;
	modelName?: string;
	/** Thinking level the child session actually ran with. */
	thinking?: string;
	/** Non-fatal problems observed while running (extension load errors, ...). */
	warnings?: string[];
	/** Where the child session was written, when persisting. */
	sessionFile?: string;
}

/** Number of grace turns after the soft limit before the run is aborted. */
const GRACE_TURNS = 3;

/** The cost fields of one reported message, as a provider may fill them in. */
interface ReportedCost {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	total?: number;
}

/**
 * Add one message's cost to the running total.
 *
 * The parent session sums `cost.total` off a tool result and never re-prices it
 * against its own model, so this total has to be right on its own: a provider
 * that reports the components but leaves `total` at zero must not make a run
 * look free. A missing or zero total falls back to the components' sum.
 */
export function addReportedCost(usage: UsageTotals, reported: ReportedCost | undefined): void {
	const input = reported?.input ?? 0;
	const output = reported?.output ?? 0;
	const cacheRead = reported?.cacheRead ?? 0;
	const cacheWrite = reported?.cacheWrite ?? 0;
	usage.cost += reported?.total && reported.total > 0 ? reported.total : input + output + cacheRead + cacheWrite;
	usage.costInput = (usage.costInput ?? 0) + input;
	usage.costOutput = (usage.costOutput ?? 0) + output;
	usage.costCacheRead = (usage.costCacheRead ?? 0) + cacheRead;
	usage.costCacheWrite = (usage.costCacheWrite ?? 0) + cacheWrite;
}

/**
 * Text of an assistant message, or "" when it carries none.
 *
 * Only the last assistant message that produced text becomes the run's result:
 * accumulating every turn's deltas would splice intermediate narration
 * ("let me look at the file…") into what the parent sees as the answer.
 */
export function assistantTextOf(message: unknown): string {
	const content = (message as { content?: unknown })?.content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is { type: "text"; text: string } => {
			const candidate = part as { type?: unknown; text?: unknown };
			return candidate?.type === "text" && typeof candidate.text === "string";
		})
		.map((part) => part.text)
		.join("")
		.trim();
}

/**
 * The provider failure a message reports, or undefined when it did not fail.
 *
 * A request that the provider rejects (401/403/429/5xx, disabled upstream) is
 * how a sub-agent most often dies, and pi never throws for it: `prompt()`
 * resolves normally and the failure lands only on the assistant message as
 * `stopReason: "error"` plus `errorMessage`, with empty content and zero
 * usage. A run that is not watching those fields reports as completed with no
 * body — the parent then acts on a success that never happened. An empty
 * errorMessage still fails: "the model request failed" beats a silent one.
 *
 * An `aborted` message is not a failure here: pi marks a cancelled run with
 * that stopReason, and its reason belongs to `abortReason`, which outranks an
 * error when the record is classified.
 */
export function providerFailureOf(message: unknown): string | undefined {
	const candidate = message as { stopReason?: unknown; errorMessage?: unknown };
	if (candidate?.stopReason !== "error") return undefined;
	const detail = typeof candidate.errorMessage === "string" ? candidate.errorMessage.trim() : "";
	return detail || "the model request failed";
}

/** What the assistant messages of one run have contributed so far. */
export interface RunFold {
	/** Text of the last message that produced one. */
	text: string;
	/** Failure of the most recent message, cleared by one that did not fail. */
	error?: string;
	usage: UsageTotals;
}

/**
 * Fold one assistant message into a run's result, failure, and usage.
 *
 * Every field is assigned, not merged, on each message: the run's outcome is
 * what its last assistant message said. pi retries a transient provider error
 * inside the same run, so a message that did not fail must clear the error the
 * one before it carried — otherwise a recovered run reports as failed. The
 * text guard keeps an erroring message's empty content from blanking the last
 * real answer, so a run can carry both a result and a failure.
 */
export function foldAssistantMessage(fold: RunFold, message: unknown): RunFold {
	fold.error = providerFailureOf(message);
	const chunk = assistantTextOf(message);
	if (chunk) fold.text = chunk;
	const reported = (
		message as {
			usage?: {
				input?: number;
				output?: number;
				cacheWrite?: number;
				cacheRead?: number;
				cost?: ReportedCost;
			};
		}
	).usage;
	if (reported) {
		fold.usage.input += reported.input ?? 0;
		fold.usage.output += reported.output ?? 0;
		fold.usage.cacheWrite += reported.cacheWrite ?? 0;
		fold.usage.cacheRead += reported.cacheRead ?? 0;
		addReportedCost(fold.usage, reported.cost);
	}
	return fold;
}

/**
 * The run's failure, out of the two ways a child run can die.
 *
 * A throw is louder than a message-level failure, so it wins — but it must
 * never be an empty string. Records are classified by truthiness, so a thrown
 * `Error("")` reported as `""` would settle the run at `completed`, which is
 * the exact silence {@link providerFailureOf} exists to end.
 */
export function resolveRunFailure(thrown: string | undefined, folded?: string): string | undefined {
	if (thrown === undefined) return folded;
	// A throw is the louder source, but only when it actually says something:
	// an empty message would classify the record as completed, so it yields to
	// whatever the provider reported, and to a placeholder if nothing did.
	return thrown.trim() || folded || "the sub-agent run failed";
}

export function buildSystemPrompt(agent: AgentDefinition, cwd: string): string {
	// The file advice follows the agent's effective tool set: an agent without a
	// `tools:` list runs on pi's default set (read/bash/edit/write) and has no
	// grep/find/ls to switch to. pi lists only active tools in its prompt, so
	// recommending one the set lacks just spends tokens on a call that cannot run.
	const tools = new Set<string>(agent.tools ?? ["read", "bash", "edit", "write"]);
	const advice: string[] = [];
	if (tools.has("read")) advice.push("- Use the read tool instead of cat/head/tail");
	if (tools.has("edit")) advice.push("- Use the edit tool instead of sed/awk");
	if (tools.has("write")) advice.push("- Use the write tool instead of echo/heredoc");
	if (tools.has("grep")) advice.push("- Use the grep tool instead of bash grep/rg for content search");
	if (tools.has("find") || tools.has("ls")) advice.push("- Use the find tool instead of bash find/ls for file search");
	advice.push("- Make independent tool calls in parallel", "- Use absolute file paths", "- Be concise but complete");

	const bridge = `<sub_agent_context>\nYou are operating as a sub-agent invoked to handle a specific task.\n${advice.join("\n")}\n</sub_agent_context>`;

	const environment = `# Environment
Working directory: ${cwd}
Platform: ${process.platform}`;

	const instructions = agent.systemPrompt.trim()
		? `\n\n<agent_instructions>\n${agent.systemPrompt.trim()}\n</agent_instructions>`
		: "";

	return `You are a pi sub-agent. You were spawned to handle a specific task autonomously, then report the result back to the agent that spawned you.\n\n${bridge}\n\n${environment}${instructions}`;
}

/** A tool name that looks like it launches agents, camelCase compounds included. */
export function looksLikeAgentTool(name: string): boolean {
	// Split camelCase pairs first so "SpawnAgent" and "MyAgents" match while
	// "useragent" does not; the boundary check itself only knows non-letters.
	const spaced = name.replace(/([a-z])([A-Z])/g, "$1 $2");
	return /(^|[^a-z])(sub[-_ ]?)?agents?($|[^a-z])/i.test(spaced);
}

/** Tool names registered by the extensions the child session loaded. */
function extensionToolNames(loader: DefaultResourceLoader): Set<string> {
	const names = new Set<string>();
	for (const extension of loader.getExtensions().extensions) {
		for (const toolName of extension.tools?.keys() ?? []) names.add(toolName);
	}
	return names;
}

/** Agent-spawning tools registered by extensions other than this one. */
function foreignAgentToolNames(names: ReadonlySet<string>): string[] {
	const foreign = new Set<string>();
	for (const toolName of names) {
		if (!EXCLUDED_TOOL_NAMES.includes(toolName) && looksLikeAgentTool(toolName)) foreign.add(toolName);
	}
	return [...foreign];
}

export async function runAgent(options: RunOptions): Promise<RunOutcome> {
	// An already-aborted signal never fires the abort listener, so short-circuit
	// here instead of spawning a session that would run to completion anyway.
	if (options.signal?.aborted) {
		return abortedOutcome("parent", "Aborted before the run started");
	}

	const agentDir = options.agentDir;
	const systemPrompt = buildSystemPrompt(options.agent, options.cwd);
	const warnings: string[] = [];

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

	const loadedToolNames = extensionToolNames(loader);
	// This extension excludes its own tools from the child, but another
	// sub-agent extension loaded alongside it would still be reachable — and the
	// parent would pay for grandchildren it never asked for. Flag it rather than
	// guessing at names to block.
	for (const name of foreignAgentToolNames(loadedToolNames)) {
		warnings.push(`another extension registers "${name}", which may also spawn sub-agents; nesting is not prevented`);
	}

	const builtins = builtinToolNames();
	const knownTools = new Set<string>([...builtins, ...loadedToolNames]);
	const excludeTools = new Set<string>(EXCLUDED_TOOL_NAMES);
	for (const tool of options.agent.disallowedTools ?? []) {
		excludeTools.add(tool);
		// Unlike `tools:`, naming an extension tool is legitimate here — the
		// exclusion applies to every registered tool, extension ones included.
		// A name matching neither, though, is a typo the caller would otherwise
		// discover as a silent no-op.
		if (!knownTools.has(tool)) {
			warnings.push(`agent "${options.agent.name}": disallowed_tools lists "${tool}", which matches no built-in or extension tool (ignored)`);
		}
	}
	if (options.agent.tools) {
		// `tools:` names built-ins only, so an extension tool listed there is a
		// typo the caller would otherwise discover as a silent no-op.
		for (const tool of options.agent.tools) {
			if (!builtins.includes(tool)) warnings.push(`agent "${options.agent.name}": tools: lists "${tool}", which is not a built-in tool (ignored)`);
		}
		// Narrow built-ins with a deny-list rather than an allowlist: an
		// allowlist freezes pi's registry snapshot at construction and
		// permanently drops extension tools that register later.
		for (const builtin of builtins) {
			if (!options.agent.tools.includes(builtin)) excludeTools.add(builtin);
		}
	}

	const sessionManager = options.persistSession
		? SessionManager.create(options.cwd, options.sessionDir)
		: SessionManager.inMemory(options.cwd);

	const sessionOptions = {
		cwd: options.cwd,
		agentDir,
		sessionManager,
		settingsManager: SettingsManager.create(options.cwd, agentDir),
		resourceLoader: loader,
		excludeTools: [...excludeTools],
		...(options.model ? { model: options.model } : {}),
		...(options.modelRuntime ? { modelRuntime: options.modelRuntime } : {}),
		...(options.thinkingLevel ? { thinkingLevel: options.thinkingLevel } : {}),
	} as Parameters<typeof createAgentSession>[0];

	const { session } = await createAgentSession(sessionOptions);

	/** Result, failure, and spend of the run as its assistant messages arrive. */
	const fold: RunFold = { text: "", usage: { ...EMPTY_USAGE } };
	let turns = 0;
	let abortReason: AbortReason | undefined;
	let softLimitReached = false;
	const maxTurns = options.maxTurns;

	const abort = (reason: AbortReason) => {
		if (abortReason !== undefined) return;
		abortReason = reason;
		void Promise.resolve(session.abort()).catch(() => {});
	};

	const unsubscribe = session.subscribe((event) => {
		// An abort that landed while the session was idle was a no-op: pi has
		// nothing to abort, and a starting run clears its flag at the top of every
		// run. agent_start is the first moment the run can actually be stopped, so
		// re-issue a pending abort there instead of letting it vanish.
		if (event.type === "agent_start" && abortReason !== undefined) {
			void Promise.resolve(session.abort()).catch(() => {});
		}
		if (event.type === "turn_end") {
			turns += 1;
			options.onTurn?.(turns);
			if (maxTurns != null) {
				if (!softLimitReached && turns >= maxTurns) {
					softLimitReached = true;
					void Promise.resolve(
						session.steer("You have reached your turn limit. Wrap up immediately and provide your final answer now."),
					).catch(() => {});
				} else if (softLimitReached && turns >= maxTurns + GRACE_TURNS) {
					abort("turn-limit");
				}
			}
			return;
		}
		if (event.type === "message_end" && event.message.role === "assistant") {
			foldAssistantMessage(fold, event.message);
		}
	});

	const onParentAbort = () => abort("parent");
	options.signal?.addEventListener("abort", onParentAbort, { once: true });
	const timer =
		options.timeoutMs && options.timeoutMs > 0 ? setTimeout(() => abort("timeout"), options.timeoutMs) : undefined;

	let error: string | undefined;
	try {
		// Extensions loaded into the child need session_start to fire before the run.
		await session.bindExtensions({
			onError: (extensionError) => {
				warnings.push(`${extensionError.extensionPath} failed in ${extensionError.event}: ${extensionError.error}`);
			},
		});
		// `tools:` lists built-ins to use, and excludeTools can only deny: pi's
		// default active set is read/bash/edit/write, so a listed tool that is not
		// default-active (grep, find, ls) would never come on. Re-derive the set
		// here, after binding, when every extension tool is registered — extension
		// tools keep flowing (an allowlist passed at construction would drop the
		// later ones), and the listed built-ins join it.
		if (options.agent.tools) {
			const desired = new Set<string>(session.getActiveToolNames());
			for (const tool of options.agent.tools) {
				if (builtins.includes(tool)) desired.add(tool);
			}
			for (const tool of excludeTools) desired.delete(tool);
			session.setActiveToolsByName([...desired]);
		}
		// Creation is async, so the parent may have aborted in the meantime. An
		// idle abort is a no-op in pi, and a prompt() issued afterwards runs the
		// whole task anyway — with the ceiling spent (timeout) or the parent gone
		// (parent). Skip the prompt; the agent_start guard above only covers an
		// abort landing after the prompt is already in flight.
		if (options.signal?.aborted && abortReason === undefined) abort("parent");
		if (abortReason === undefined) {
			await session.prompt(options.prompt);
		}
	} catch (promptError) {
		error = promptError instanceof Error ? promptError.message : String(promptError);
	} finally {
		if (timer) clearTimeout(timer);
		options.signal?.removeEventListener("abort", onParentAbort);
		unsubscribe();
	}

	const liveModel = session.model;
	const described = liveModel ? describeModel(liveModel) : undefined;
	// A virtual model can pick a different thinking level per turn, so prefer
	// the routed one and fall back to what the session was configured with.
	const liveThinking = session.routedModel?.thinkingLevel ?? session.thinkingLevel;
	const resolvedText = fold.text || (session.getLastAssistantText()?.trim() ?? "");
	// Read before disposing: the caller needs the path to make sense of a run it
	// can no longer see the inside of.
	const sessionFile = options.persistSession ? session.sessionFile : undefined;
	session.dispose();

	return {
		text: resolvedText,
		turns,
		usage: fold.usage,
		aborted: abortReason !== undefined,
		abortReason,
		// A throw outranks a message-level failure, and neither may reach the
		// record as an empty string: an empty error classifies as completed.
		error: resolveRunFailure(error, fold.error),
		modelId: described?.id,
		modelName: described?.name,
		thinking: liveThinking,
		warnings: warnings.length > 0 ? warnings : undefined,
		sessionFile,
	};
}

function abortedOutcome(reason: AbortReason, error?: string): RunOutcome {
	return { text: "", turns: 0, usage: { ...EMPTY_USAGE }, aborted: true, abortReason: reason, error };
}
