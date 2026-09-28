/**
 * Model routing: ask jev to pick the model for a spawn that has no explicit
 * model and no agent-file pin.
 *
 * The judge sees the task text, the agent type, and the candidate list, and
 * answers a single multiple-choice question. Its pick is only honored when the
 * calibrated probability and confidence clear the thresholds; otherwise the
 * caller falls back to the parent's model (the verdict is still returned for
 * display, so a weak signal is visible rather than silently discarded).
 */

import { classifyJevFailure, jevEvaluate, renderJudgment, type ChoiceAnswer, type JevFailure, type JevQuestion } from "./client.ts";

/** Below these, a pick is "no calibrated opinion" — fall back to the parent model. */
export const ROUTE_MIN_PROBABILITY = 0.5;
export const ROUTE_MIN_CONFIDENCE = 0.4;
const MAX_TASK_CHARS = 4000;

export interface RouteCandidateRef {
	key: string;
	label: string;
}

export interface RouteDecision {
	/** Selected candidate key, when the pick cleared the thresholds. */
	chosen?: string;
	/** Rendered judgment block (empty when the request failed). */
	verdict: string;
	judgeModel?: string;
	failure?: JevFailure;
}

function truncate(text: string, max: number): string {
	if (text.length <= max) return text;
	return `${text.slice(0, max)}\n[…truncated]`;
}

export async function judgeModelRoute(args: {
	apiKey: string;
	task: string;
	agentType: string;
	agentDescription?: string;
	candidates: RouteCandidateRef[];
	/** Candidate key that would be used without routing (the parent's model). */
	parentKey?: string;
	model?: string;
	signal?: AbortSignal;
	fetchImpl?: typeof fetch;
}): Promise<RouteDecision | undefined> {
	const { candidates } = args;
	if (candidates.length < 2) return undefined;

	const criteria: Record<string, string> = {};
	for (const candidate of candidates) {
		criteria[candidate.key] =
			candidate.key === args.parentKey ? `${candidate.label} — the model this spawn would use without routing` : candidate.label;
	}
	const questions: Record<string, JevQuestion> = {
		model: {
			type: "choice",
			instructions:
				"A sub-agent is about to be spawned for a task. Pick the single candidate model best suited to complete the task, balancing capability against cost: prefer the cheapest model that can plausibly complete the task well.",
			criteria,
		},
	};
	const state = [
		"Tool: Agent (spawn a sub-agent to work autonomously on a task)",
		`Sub-agent type: ${args.agentType}${args.agentDescription ? ` (${args.agentDescription})` : ""}`,
		"",
		"Task:",
		truncate(args.task, MAX_TASK_CHARS),
		"",
		"Candidate models:",
		...candidates.map((candidate) => `- ${candidate.key}: ${candidate.label}`),
	].join("\n");

	try {
		const data = await jevEvaluate(args.apiKey, state, questions, {
			signal: args.signal,
			fetchImpl: args.fetchImpl,
			model: args.model,
		});
		const answer = data.answers.model as ChoiceAnswer;
		const probability = answer?.type === "choice" ? answer.probabilities?.[answer.choice] : undefined;
		const confidence = answer?.type === "choice" ? answer.confidence : undefined;
		const eligible =
			answer?.type === "choice" &&
			candidates.some((candidate) => candidate.key === answer.choice) &&
			typeof probability === "number" &&
			probability >= ROUTE_MIN_PROBABILITY &&
			(confidence === undefined || confidence >= ROUTE_MIN_CONFIDENCE);
		return {
			chosen: eligible ? answer.choice : undefined,
			verdict: renderJudgment(data.model ?? args.model ?? "jev", data.usage, data.answers, questions),
			judgeModel: data.model,
		};
	} catch (error) {
		return { verdict: "", failure: classifyJevFailure(error) };
	}
}
