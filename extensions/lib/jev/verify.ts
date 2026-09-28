/**
 * Result verification: ask jev whether a finished sub-agent's output actually
 * answers the task, and what the orchestrator should do next.
 *
 * v1 is deliberately informational — the verdict is appended to the result the
 * parent sees, so the orchestrator decides. Automatic retry/escalation can be
 * layered on later without changing the judgment shape.
 */

import { classifyJevFailure, jevEvaluate, renderJudgment, type ChoiceAnswer, type JevFailure, type JevQuestion, type NoulAnswer } from "./client.ts";

const MAX_TASK_CHARS = 3000;
const MAX_RESULT_CHARS = 6000;

export interface VerifyDecision {
	/** Probability the result directly answers the task. */
	sufficiency?: number;
	/** accept | continue | escalate | fail — jev's recommended next action. */
	action?: string;
	verdict: string;
	judgeModel?: string;
	failure?: JevFailure;
}

function truncate(text: string, max: number): string {
	if (text.length <= max) return text;
	return `${text.slice(0, max)}\n[…truncated]`;
}

export async function judgeSubagentResult(args: {
	apiKey: string;
	task: string;
	agentType: string;
	result: string;
	model?: string;
	signal?: AbortSignal;
	fetchImpl?: typeof fetch;
}): Promise<VerifyDecision | undefined> {
	if (!args.result.trim()) return undefined;

	const questions: Record<string, JevQuestion> = {
		sufficiency: {
			type: "noul",
			instructions:
				"One yes/no probability: does the agent's result directly and completely address the task it was given, as opposed to being partial, off-target, or merely a progress report?",
		},
		next_action: {
			type: "choice",
			instructions: "Pick the single best next action for the orchestrator given this result.",
			criteria: {
				accept: "The result addresses the task; report it to the user as-is.",
				continue:
					"The direction is right but the work is incomplete — a follow-up instruction to the same agent would plausibly finish it.",
				escalate:
					"The result is too weak for this task; re-running with a stronger model (or more turns) is more likely to succeed than continuing.",
				fail: "The agent failed in a way the orchestrator must handle itself (missing access, contradictory requirements, repeated error).",
			},
		},
	};
	const state = [
		"A sub-agent has finished working on a task.",
		`Sub-agent type: ${args.agentType}`,
		"",
		"Task:",
		truncate(args.task, MAX_TASK_CHARS),
		"",
		"Agent result:",
		truncate(args.result, MAX_RESULT_CHARS),
	].join("\n");

	try {
		const data = await jevEvaluate(args.apiKey, state, questions, {
			signal: args.signal,
			fetchImpl: args.fetchImpl,
			model: args.model,
		});
		const sufficiencyAnswer = data.answers.sufficiency as NoulAnswer | undefined;
		const actionAnswer = data.answers.next_action as ChoiceAnswer | undefined;
		return {
			sufficiency: sufficiencyAnswer?.type === "noul" ? sufficiencyAnswer.noul : undefined,
			action: actionAnswer?.type === "choice" ? actionAnswer.choice : undefined,
			verdict: renderJudgment(data.model ?? args.model ?? "jev", data.usage, data.answers, questions),
			judgeModel: data.model,
		};
	} catch (error) {
		return { verdict: "", failure: classifyJevFailure(error) };
	}
}
