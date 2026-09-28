/**
 * Agent definitions: two built-ins plus markdown files from
 * `<cwd>/.pi/agents/*.md` (project) and `<agentDir>/agents/*.md` (global).
 *
 * Project files override global ones of the same name; both override the
 * built-ins. Files are parsed with a deliberately small frontmatter reader —
 * flat `key: value` pairs only, which is what the agent files in the wild use.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isThinkingLevel, type AgentDefinition, type ThinkingLevel } from "./types.ts";

export const GENERAL_AGENT: AgentDefinition = {
	name: "general",
	description: "General-purpose agent for complex, multi-step tasks.",
	systemPrompt: "",
	builtin: true,
};

export const EXPLORE_AGENT: AgentDefinition = {
	name: "explore",
	description: "Read-only agent for broad codebase exploration and research.",
	systemPrompt:
		"You are a read-only exploration agent. Search broadly, then report findings concisely " +
		"with absolute file paths. Do not modify anything.",
	tools: ["read", "grep", "find", "ls"],
	builtin: true,
};

export interface LoadedAgents {
	agents: Map<string, AgentDefinition>;
	/** Non-fatal problems (unreadable or malformed files), for the /subagents command. */
	warnings: string[];
}

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
	let body = content;
	const meta: Record<string, string> = {};
	const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(content);
	if (frontmatter) {
		body = content.slice(frontmatter[0].length);
		for (const rawLine of frontmatter[1].split(/\r?\n/)) {
			const line = rawLine.trim();
			if (!line || line.startsWith("#")) continue;
			const separator = line.indexOf(":");
			if (separator === -1) return `invalid frontmatter line: "${line}"`;
			meta[line.slice(0, separator).trim()] = unquote(line.slice(separator + 1).trim());
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

/** Load built-ins plus file-defined agents. Never throws; problems become warnings. */
export function loadAgents(cwd: string, agentDir: string): LoadedAgents {
	const agents = new Map<string, AgentDefinition>();
	agents.set(GENERAL_AGENT.name, GENERAL_AGENT);
	agents.set(EXPLORE_AGENT.name, EXPLORE_AGENT);
	const warnings: string[] = [];

	// Global first, project second — later writes win, so project overrides global.
	for (const dir of [join(agentDir, "agents"), join(cwd, ".pi", "agents")]) {
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
			const existing = agents.get(parsed.name);
			agents.set(parsed.name, { ...parsed, file: full, builtin: existing?.builtin });
		}
	}
	return { agents, warnings };
}

/** One-line-per-agent summary for the system prompt / command output. */
export function describeAgents(agents: Map<string, AgentDefinition>): string {
	return [...agents.values()]
		.sort((a, b) => a.name.localeCompare(b.name))
		.map((agent) => `- ${agent.name}: ${agent.description || "(no description)"}`)
		.join("\n");
}
