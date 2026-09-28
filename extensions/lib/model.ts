/**
 * Model resolution: exact `provider/modelId` first, then fuzzy matching by id
 * or display name. Returns the model, or an error string listing the registry
 * contents so the caller can self-correct.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ModelLike } from "./types.ts";

/** The subset of pi's model registry this extension uses. */
export interface RegistryFacade {
	find(provider: string, modelId: string): ModelLike | undefined;
	getAll(): ModelLike[];
	getAvailable?(): ModelLike[];
}

export function modelKey(model: { provider: string; id: string }): string {
	return `${model.provider}/${model.id}`;
}

export function describeModel(model: { provider: string; id: string; name?: string }): { id: string; name: string } {
	return {
		id: modelKey(model),
		name: (model.name ?? model.id).replace(/^Claude\s+/i, "").toLowerCase(),
	};
}

export function availableModels(registry: ExtensionContext["modelRegistry"]): ModelLike[] {
	const facade = registry as unknown as RegistryFacade;
	const models = facade.getAvailable?.() ?? facade.getAll?.() ?? [];
	return [...models].sort((a, b) => modelKey(a).localeCompare(modelKey(b)));
}

/**
 * Resolve a model string to a Model instance. Mirrors pi's own resolver
 * behavior closely enough for tool parameters and frontmatter pins: an
 * exact `provider/modelId` (when authenticated), then a fuzzy match where a
 * dotted version (`4.5`) and a dashed one (`4-5`) are the same token.
 */
export function resolveModelInput(input: string, registry: ExtensionContext["modelRegistry"]): ModelLike | string {
	const models = availableModels(registry);
	const available = new Set(models.map((model) => modelKey(model).toLowerCase()));

	const slash = input.indexOf("/");
	if (slash !== -1 && available.has(input.toLowerCase())) {
		const facade = registry as unknown as RegistryFacade;
		const found = facade.find(input.slice(0, slash), input.slice(slash + 1));
		if (found) return found;
	}

	const normalize = (value: string) => value.toLowerCase().replace(/\./g, "-");
	const query = normalize(input);
	let best: ModelLike | undefined;
	let bestScore = 0;
	for (const model of models) {
		const id = normalize(model.id);
		const name = normalize(model.name ?? model.id);
		const full = normalize(modelKey(model));
		let score = 0;
		if (id === query || full === query) {
			score = 100;
		} else if (id.includes(query) || full.includes(query)) {
			score = 60 + (query.length / id.length) * 30;
		} else if (name.includes(query)) {
			score = 40 + (query.length / name.length) * 20;
		} else {
			const parts = query.split(/[\s\-/]+/);
			if (parts.every((part) => /^\d{8}$/.test(part) || id.includes(part) || name.includes(part) || model.provider.toLowerCase().includes(part))) {
				score = 20;
			}
		}
		if (score > bestScore) {
			bestScore = score;
			best = model;
		}
	}
	if (best && bestScore >= 20) return best;

	const list = models.map((model) => `  ${modelKey(model)}`).join("\n");
	return `Model not found: "${input}".\n\nAvailable models:\n${list}`;
}

export interface RouteCandidate {
	key: string;
	label: string;
	model: ModelLike;
}

/**
 * Build the candidate set handed to the jev router. The parent's model is
 * always included, so "no change" is a choice the judge can make. With no
 * explicit list, available models are taken in a stable order and capped —
 * a choice question with dozens of options is worse than a small, sane set.
 */
export function routeCandidates(args: {
	registry: ExtensionContext["modelRegistry"];
	parent?: ModelLike;
	spec?: string[];
	cap: number;
}): { candidates: RouteCandidate[]; warnings: string[] } {
	const byKey = new Map<string, RouteCandidate>();
	const push = (model: ModelLike) => {
		const key = modelKey(model);
		if (!byKey.has(key)) {
			const described = describeModel(model);
			byKey.set(key, { key, label: `${described.name} (${model.provider})`, model });
		}
	};
	if (args.parent) push(args.parent);

	const warnings: string[] = [];
	if (args.spec && args.spec.length > 0) {
		for (const entry of args.spec) {
			const resolved = resolveModelInput(entry, args.registry);
			if (typeof resolved === "string") {
				warnings.push(`jev candidate "${entry}" not found`);
				continue;
			}
			push(resolved);
		}
	} else {
		for (const model of availableModels(args.registry)) {
			if (byKey.size >= args.cap) break;
			push(model);
		}
	}
	return { candidates: [...byKey.values()], warnings };
}
