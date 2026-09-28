/**
 * Configuration, read from the environment at call time.
 *
 * Every knob is optional. Absent `TYPESAFE_API_KEY` (or `JEV_SUBAGENTS=off`)
 * turns every jev judgment off; the extension then behaves like a plain
 * sub-agent runner.
 */

export interface JevSettings {
	/** True when a key is configured and judgements are not switched off. */
	enabled: boolean;
	apiKey?: string;
	/** Jev model id passed to the TypeSafe API. */
	model: string;
	/** Judge the model choice before a spawn that has no explicit model. */
	route: boolean;
	/** Judge the result after a run finishes. */
	verify: boolean;
	/** Explicit candidate list (`provider/modelId` entries); empty means "all available". */
	candidates: string[];
	/** Upper bound on candidates sent to the router. */
	maxCandidates: number;
}

const DEFAULT_MODEL = "jev-latest";
const DEFAULT_MAX_CANDIDATES = 12;

function parseToggle(value: string | undefined, fallback: boolean): boolean {
	if (value === undefined) return fallback;
	const normalized = value.trim().toLowerCase();
	if (["off", "0", "false", "no"].includes(normalized)) return false;
	if (["on", "1", "true", "yes"].includes(normalized)) return true;
	return fallback;
}

export function readJevSettings(env: NodeJS.ProcessEnv = process.env): JevSettings {
	const apiKey = env.TYPESAFE_API_KEY?.trim() || undefined;
	const disabled = parseToggle(env.JEV_SUBAGENTS, true) === false;
	const candidates = (env.JEV_SUBAGENTS_CANDIDATES ?? "")
		.split(",")
		.map((entry) => entry.trim())
		.filter(Boolean);
	const max = Number(env.JEV_SUBAGENTS_MAX_CANDIDATES ?? "");
	return {
		enabled: Boolean(apiKey) && !disabled,
		apiKey,
		model: env.JEV_SUBAGENTS_MODEL?.trim() || DEFAULT_MODEL,
		route: parseToggle(env.JEV_SUBAGENTS_ROUTE, true),
		verify: parseToggle(env.JEV_SUBAGENTS_VERIFY, true),
		candidates,
		maxCandidates: Number.isFinite(max) && max >= 2 ? Math.floor(max) : DEFAULT_MAX_CANDIDATES,
	};
}
