/**
 * Model resolution for the `model` parameter and agent-file pins: an exact
 * `provider/modelId`, or a bare id when it is unambiguous across providers.
 *
 * Fuzzy matching is deliberately absent. A near-match would spawn on a model
 * the caller never asked for, and model choice is the one decision here that
 * is not verified afterwards.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ModelLike } from "./types.ts";

export function modelKey(model: { provider: string; id: string }): string {
	return `${model.provider}/${model.id}`;
}

export function describeModel(model: { provider: string; id: string; name?: string }): { id: string; name: string } {
	return {
		id: modelKey(model),
		// pi's catalogue already names models for people ("Claude Haiku 4.5"), so
		// only the vendor prefix is dropped — never the case. Lower-casing the
		// name would flatten "GPT-5" and "Sonnet" into noise for no saving.
		name: (model.name ?? model.id).replace(/^Claude\s+/i, ""),
	};
}

function availableModels(registry: ExtensionContext["modelRegistry"]): ModelLike[] {
	return [...registry.getAvailable()].sort((a, b) => modelKey(a).localeCompare(modelKey(b)));
}

/** The list is context the parent pays for, so it is capped. */
function formatModelList(models: readonly ModelLike[], limit = 60): string {
	const shown = models.slice(0, limit).map((model) => `  ${modelKey(model)}`);
	if (models.length > limit) shown.push(`  … and ${models.length - limit} more`);
	return shown.join("\n");
}

/**
 * Resolve a model string to a model, or return an error string the caller can
 * surface verbatim. Credentials are checked up front so a spawn does not fail
 * halfway through with a provider auth error.
 */
export function resolveModelInput(input: string, registry: ExtensionContext["modelRegistry"]): ModelLike | string {
	const spec = input.trim();
	if (!spec) return "Model name is empty.";

	const slash = spec.indexOf("/");
	if (slash !== -1) {
		const found = registry.find(spec.slice(0, slash), spec.slice(slash + 1));
		if (!found) return notFound(spec, registry);
		if (!registry.hasConfiguredAuth(found)) {
			return `Model "${spec}" has no configured credentials. Authenticate its provider or pick another model.`;
		}
		return found;
	}

	const wanted = spec.toLowerCase();
	const matches = availableModels(registry).filter((model) => model.id.toLowerCase() === wanted);
	if (matches.length === 1) return matches[0];
	if (matches.length > 1) {
		const list = matches.map((model) => `  ${modelKey(model)}`).join("\n");
		return `Model id "${spec}" exists for several providers:\n\n${list}\n\nPass "provider/modelId".`;
	}
	return notFound(spec, registry);
}

function notFound(spec: string, registry: ExtensionContext["modelRegistry"]): string {
	return `Model not found: "${spec}".\n\nAvailable models:\n${formatModelList(availableModels(registry))}`;
}
