/**
 * Minimal TypeSafe (Jev) System One client.
 *
 * Judgments are data, not conclusions: the API returns calibrated
 * probabilities plus the meaning of the chosen option; callers decide what to
 * do with them. Every failure path is designed to degrade silently — a broken
 * or unconfigured judge must never break a sub-agent spawn.
 *
 * Protocol: POST {base}/systemone with `{ state, model, questions }`, where a
 * question is one of:
 *   - `noul`: a single yes/no probability
 *   - `choice`: one option out of a set (with per-option probabilities and an
 *     overall confidence)
 */

const API_BASE = "https://api.typesafe.ai/v1";
const DEFAULT_MODEL = "jev-latest";
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RETRIES = 2;

export interface NoulQuestion {
	type: "noul";
	instructions: string;
}

export interface ChoiceQuestion {
	type: "choice";
	instructions: string;
	criteria: Record<string, string>;
}

export type JevQuestion = NoulQuestion | ChoiceQuestion;

export interface NoulAnswer {
	type: "noul";
	noul: number;
}

export interface ChoiceAnswer {
	type: "choice";
	choice: string;
	probabilities?: Record<string, number>;
	confidence?: number;
}

/** Unknown shapes are surfaced verbatim by the renderer instead of being guessed at. */
export type JevAnswer = NoulAnswer | ChoiceAnswer | { type: string; [key: string]: unknown };

export interface JevResponse {
	answers: Record<string, JevAnswer>;
	usage?: { input_tokens?: number };
	model?: string;
}

export class JevError extends Error {
	readonly status?: number;

	constructor(message: string, status?: number) {
		super(message);
		this.name = "JevError";
		this.status = status;
	}
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(signal?.reason instanceof Error ? signal.reason : new Error("Aborted"));
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

export async function jevEvaluate(
	apiKey: string,
	state: string,
	questions: Record<string, JevQuestion>,
	opts: { signal?: AbortSignal; fetchImpl?: typeof fetch; model?: string; baseUrl?: string } = {},
): Promise<JevResponse> {
	const fetchImpl = opts.fetchImpl ?? fetch;
	const model = opts.model ?? DEFAULT_MODEL;
	const baseUrl = opts.baseUrl ?? API_BASE;
	const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
	const signal = opts.signal ? (AbortSignal.any([opts.signal, timeout])) : timeout;

	let attempt = 0;
	for (;;) {
		let response: Response;
		try {
			response = await fetchImpl(`${baseUrl}/systemone`, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${apiKey}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ state, model, questions }),
				signal,
			});
		} catch (error) {
			if (attempt < MAX_RETRIES && (error as { name?: string })?.name !== "TimeoutError" && (error as { name?: string })?.name !== "AbortError") {
				await sleep(500 * 2 ** attempt, opts.signal);
				attempt++;
				continue;
			}
			throw error;
		}
		if (response.ok) {
			const data = (await response.json()) as JevResponse;
			if (!data?.answers) throw new JevError("unexpected TypeSafe response shape");
			return data;
		}
		if ((response.status === 429 || response.status === 529) && attempt < MAX_RETRIES) {
			const retryAfter = response.headers.get("retry-after");
			await sleep(retryAfter ? Number(retryAfter) * 1000 : 1000 * 2 ** attempt, opts.signal);
			attempt++;
			continue;
		}
		const body = await response.text().catch(() => "");
		throw new JevError(`TypeSafe API error ${response.status}: ${body.slice(0, 200)}`, response.status);
	}
}

export interface JevFailure {
	failure: true;
	/** actionable = the user can fix it (key/balance); transient = may self-heal. */
	kind: "actionable" | "transient";
	status?: number;
	reason: string;
	remedy?: string;
	detail: string;
}

/** Classify a failed judge request; 401/402/403 need the user, the rest may self-heal. */
export function classifyJevFailure(error: unknown): JevFailure {
	const status = error instanceof JevError ? error.status : undefined;
	const detail = error instanceof Error ? error.message : String(error);
	const common = { failure: true as const, status, detail };
	if (status === 402) {
		return { ...common, kind: "actionable", reason: "TypeSafe reports payment required — the account balance is likely exhausted", remedy: "top up your TypeSafe balance (docs.typesafe.ai)" };
	}
	if (status === 401) {
		return { ...common, kind: "actionable", reason: "TypeSafe rejected the API key", remedy: "check TYPESAFE_API_KEY" };
	}
	if (status === 403) {
		return { ...common, kind: "actionable", reason: "TypeSafe denied access to this endpoint or model", remedy: "check your TypeSafe plan and key permissions" };
	}
	return { ...common, kind: "transient", reason: detail || "unknown TypeSafe request failure" };
}

export function buildJevFailureWarning(failure: JevFailure): string {
	const status = failure.status ? ` (HTTP ${failure.status})` : "";
	const remedy = failure.remedy ? ` ${failure.remedy};` : "";
	return `jev-subagents: TypeSafe judging failed — ${failure.reason}${status}.${remedy} sub-agent results pass through uncalibrated until then.`;
}

const FAILURE_WARN_INTERVAL_MS = 10 * 60_000;
let lastFailureWarnAt = 0;

export function shouldWarnAboutJevFailure(now: number = Date.now()): boolean {
	return now - lastFailureWarnAt >= FAILURE_WARN_INTERVAL_MS;
}

export function markJevFailureWarned(now: number = Date.now()): void {
	lastFailureWarnAt = now;
}

function confidenceVerdict(probability: number): string {
	if (probability >= 0.75) return "likely yes";
	if (probability > 0.6) return "leaning yes (weak)";
	if (probability >= 0.4) return "uncertain (near 0.5: genuinely undecided)";
	if (probability > 0.35) return "leaning no (weak)";
	return "likely no";
}

function optionDescription(question: JevQuestion | undefined, option: string): string | undefined {
	if (question?.type !== "choice") return undefined;
	return question.criteria[option];
}

/** Render a judgment block: probabilities plus the meaning of each choice. */
export function renderJudgment(
	model: string,
	usage: { input_tokens?: number } | undefined,
	answers: Record<string, JevAnswer>,
	questions: Record<string, JevQuestion>,
): string {
	const lines: string[] = [];
	const tokens = usage?.input_tokens;
	lines.push(`jev-judge (model ${model}${tokens ? `, ${tokens} in-tokens` : ""}):`);
	for (const [id, answer] of Object.entries(answers)) {
		if (answer?.type === "noul" && typeof (answer as NoulAnswer).noul === "number") {
			const probability = (answer as NoulAnswer).noul;
			lines.push(`- ${id}: ${probability.toFixed(2)} — ${confidenceVerdict(probability)}`);
		} else if (answer?.type === "choice" && typeof (answer as ChoiceAnswer).choice === "string") {
			const typed = answer as ChoiceAnswer;
			const probability = typed.probabilities?.[typed.choice];
			const confidence = typed.confidence;
			const description = optionDescription(questions[id], typed.choice);
			let line = `- ${id}: ${typed.choice}`;
			if (typeof probability === "number") line += ` (p=${probability.toFixed(2)}`;
			if (typeof confidence === "number") line += typeof probability === "number" ? `, conf=${confidence.toFixed(2)}` : ` (conf=${confidence.toFixed(2)}`;
			if (typeof probability === "number") line += ")";
			if (description) line += ` — ${description}`;
			const runnerUp = Object.entries(typed.probabilities ?? {})
				.filter(([key]) => key !== typed.choice)
				.sort((a, b) => b[1] - a[1])[0];
			if (runnerUp && runnerUp[1] > 0) line += ` [next: ${runnerUp[0]} ${runnerUp[1].toFixed(2)}]`;
			lines.push(line);
		} else {
			lines.push(`- ${id}: ${JSON.stringify(answer)}`);
		}
	}
	lines.push("(calibrated probabilities from Jev; treat anything below 0.75 or with low confidence as a weak signal, not a verdict)");
	return lines.join("\n");
}
