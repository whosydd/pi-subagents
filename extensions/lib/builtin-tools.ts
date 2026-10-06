/**
 * Names of pi's built-in tools, derived from pi's own factories.
 *
 * The extension narrows a child agent's built-ins by *denying* every built-in
 * the agent's `tools:` list omits. That inverted form only works if the built-in
 * set is complete: a hardcoded list silently stops covering the day pi ships a
 * new built-in, and a "read-only" agent quietly gains it with no warning. Asking
 * pi for the names makes the deny-list track pi instead of this file.
 *
 * Resolved once and cached: the factories build tool objects, and their names do
 * not depend on the cwd passed in.
 */

import { createCodingTools, createPowerShellTool, createReadOnlyTools } from "@earendil-works/pi-coding-agent";

/**
 * Used only when pi's factories cannot be called at all (a signature change, for
 * instance). A stale list degrades to the previous behaviour, so it stays in
 * sync by hand.
 */
const FALLBACK_BUILTIN_TOOL_NAMES = ["read", "bash", "powershell", "edit", "write", "grep", "find", "ls"];

let cached: readonly string[] | undefined;

/** Built-in tool names, resolved from pi on first use. */
export function builtinToolNames(): readonly string[] {
	if (cached) return cached;
	let names: string[];
	try {
		const tools = [...createCodingTools(process.cwd()), ...createReadOnlyTools(process.cwd()), createPowerShellTool(process.cwd())];
		names = [...new Set(tools.map((tool) => tool.name))];
		if (names.length === 0) names = FALLBACK_BUILTIN_TOOL_NAMES;
	} catch {
		names = FALLBACK_BUILTIN_TOOL_NAMES;
	}
	cached = names;
	return cached;
}