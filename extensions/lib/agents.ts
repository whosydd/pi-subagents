/**
 * Agent definitions: two built-ins plus markdown files from the user agent
 * directory and, when explicitly enabled, the project agent directory.
 *
 * Project files override user files of the same name; both override the
 * built-ins. Project agents are opt-in (`PI_SUBAGENTS_AGENT_SCOPE`) because
 * they are repo-controlled prompts that can override `general` and run bash.
 * Files are parsed with a deliberately small frontmatter reader — flat
 * `key: value` pairs only, which is what the agent files in the wild use.
 *
 * {@link LoadedAgents} is cached and shared: callers must treat it as read-only.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentScope } from "./settings.ts";
import { isThinkingLevel, type AgentDefinition, type ThinkingLevel } from "./types.ts";

export const GENERAL_AGENT: AgentDefinition = {
	name: "general",
	description: "General-purpose agent for complex, multi-step tasks.",
	systemPrompt: "",
};

export const EXPLORE_AGENT: AgentDefinition = {
	name: "explore",
	description: "Read-only agent for broad codebase exploration and research.",
	systemPrompt:
		"You are a read-only exploration agent. Search broadly, then report findings concisely " +
		"with absolute file paths. Do not modify anything.",
	tools: ["read", "grep", "find", "ls"],
};

export interface LoadedAgents {
	agents: Map<string, AgentDefinition>;
	/** Non-fatal problems (unreadable or malformed files) for the caller to surface. */
	warnings: string[];
}

let cache: { key: string; loaded: LoadedAgents } | undefined;

/** YAML list item: `- read`. */
const LIST_ITEM = /^-\s+(.+)$/;

function unquote(value: string): string {
	if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
		return value.slice(1, -1);
	}
	return value;
}

function parseCsv(value: string | undefined): string[] | undefined {
	if (!value) return undefined;
	const inner = value.trim().replace(/^\[/, "").replace(/\]$/, "");
	const parts = inner
		.split(",")
		.map((part) => unquote(part.trim()))
		.filter(Boolean);
	return parts.length > 0 ? parts : undefined;
}

/**
 * Parse an agent markdown file. Returns the definition, or an error string for
 * files that are malformed enough to be skipped.
 */
export function parseAgentFile(content: string, fallbackName: string): AgentDefinition | string {
	// A leading BOM would keep the frontmatter fence from matching.
	const source = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
	let body = source;
	const meta: Record<string, string> = {};
	const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(source);
	if (frontmatter) {
		body = source.slice(frontmatter[0].length);
		const lines = frontmatter[1].split(/\r?\n/);
		for (let index = 0; index < lines.length; index += 1) {
			const line = lines[index].trim();
			if (!line || line.startsWith("#")) continue;
			const separator = line.indexOf(":");
			if (separator === -1) return `invalid frontmatter line: "${line}"`;
			const key = line.slice(0, separator).trim();
			let value = line.slice(separator + 1).trim();
			if (!value) {
				// A key with no inline value may own a YAML list:
				//   tools:
				//     - read
				//     - grep
				const items: string[] = [];
				while (index + 1 < lines.length) {
					const match = lines[index + 1].trim().match(LIST_ITEM);
					if (!match) break;
					items.push(unquote(match[1].trim()));
					index += 1;
				}
				if (items.length > 0) value = items.join(",");
			}
			meta[key] = unquote(value);
		}
	}

	const name = (meta.name?.trim() || fallbackName).trim();
	if (!name) return "agent name is empty";

	let thinking: ThinkingLevel | undefined;
	if (meta.thinking) {
		if (!isThinkingLevel(meta.thinking)) {
			return `invalid thinking level "${meta.thinking}" (expected: off, minimal, low, medium, high, xhigh, max)`;
		}
		thinking = meta.thinking;
	}

	let maxTurns: number | undefined;
	if (meta.max_turns) {
		const parsed = Number(meta.max_turns);
		if (!Number.isFinite(parsed) || parsed < 1) return `invalid max_turns "${meta.max_turns}"`;
		maxTurns = Math.floor(parsed);
	}

	return {
		name,
		description: meta.description?.trim() ?? "",
		systemPrompt: body.trim(),
		model: meta.model?.trim() || undefined,
		thinking,
		tools: parseCsv(meta.tools),
		disallowedTools: parseCsv(meta.disallowed_tools),
		maxTurns,
	};
}

/** Directories that load for a scope, in override order (later wins). */
function agentDirs(cwd: string, agentDir: string, scope: AgentScope): string[] {
	const dirs: string[] = [];
	if (scope === "user" || scope === "both") dirs.push(join(agentDir, "agents"));
	if (scope === "project" || scope === "both") dirs.push(join(cwd, ".pi", "agents"));
	return dirs;
}

/**
 * Load built-ins plus file-defined agents. Never throws; problems become warnings.
 *
 * Cached per (cwd, agentDir, scope): a spawn used to re-read every agent file
 * on the caller's event loop, on every call, to answer a question that rarely
 * changes. Agent files are authored by humans between sessions, so a stale read
 * until {@link invalidateAgents} costs nothing in practice.
 */
export function loadAgents(cwd: string, agentDir: string, scope: AgentScope = "user"): LoadedAgents {
	const key = `${cwd}\u0000${agentDir}\u0000${scope}`;
	const cached = cache?.key === key ? cache.loaded : undefined;
	if (cached) return cached;
	const loaded = readAgents(cwd, agentDir, scope);
	cache = { key, loaded };
	return loaded;
}

/**
 * Drop the cached agent files, so the next spawn re-reads them. Called when the
 * extension reloads, which is what a user does after editing an agent file.
 */
export function invalidateAgents(): void {
	cache = undefined;
}

function readAgents(cwd: string, agentDir: string, scope: AgentScope): LoadedAgents {
	const agents = new Map<string, AgentDefinition>();
	agents.set(GENERAL_AGENT.name, GENERAL_AGENT);
	agents.set(EXPLORE_AGENT.name, EXPLORE_AGENT);
	const warnings: string[] = [];

	for (const dir of agentDirs(cwd, agentDir, scope)) {
		if (!existsSync(dir)) continue;
		let files: string[];
		try {
			files = readdirSync(dir).filter((file) => file.endsWith(".md")).sort();
		} catch (error) {
			warnings.push(`cannot read ${dir}: ${error instanceof Error ? error.message : String(error)}`);
			continue;
		}
		for (const file of files) {
			const full = join(dir, file);
			let content: string;
			try {
				content = readFileSync(full, "utf-8");
			} catch (error) {
				warnings.push(`cannot read ${full}: ${error instanceof Error ? error.message : String(error)}`);
				continue;
			}
			const parsed = parseAgentFile(content, file.replace(/\.md$/, ""));
			if (typeof parsed === "string") {
				warnings.push(`${full}: ${parsed}`);
				continue;
			}
			agents.set(parsed.name, parsed);
		}
	}
	return { agents, warnings };
}
