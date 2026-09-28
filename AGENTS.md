# Development Rules

## Commands

- `npm run check` — typecheck + tests (what CI runs).
- `npm run smoke` — headless load check through pi's own loader, no model call.
- `npm run typecheck` — `tsc --noEmit`.
- `npm run test` — `node --test test/*.test.ts`.

Tests must not hit the network. The jev client is tested through the injected
`fetchImpl` hook.

## Layout

- `extensions/index.ts` — pi extension entry: tool + command registration, notifications.
- `extensions/lib/` — implementation modules (see README).
- `test/` — unit tests, `smoke/` — integration load check.

## Invariants

- **Jev failures degrade silently.** A missing key, timeout, or API error must
  never block or fail a spawn; routing falls back to the parent model and
  verification is skipped. Actionable errors (401/402/403) warn at most once
  per 10 minutes. Any new judgment path must preserve this.
- **Model precedence:** explicit `model` parameter → agent-file pin → jev
  routing → parent model.
- **Child sessions load user extensions by default** so sub-agents can use
  installed tools; this extension's own tools are excluded to prevent
  recursion. `isolated: true` spawns turn extensions off.
- **Narrow built-ins with `excludeTools`, never a `tools` allowlist.** An
  allowlist freezes pi's tool-registry snapshot at session construction and
  permanently drops extension tools that register later.
- Type-only imports use `import type` (verbatimModuleSyntax); imports include
  the `.ts` extension (allowImportingTsExtensions).

## Git

Commits and pushes are manual — the user runs them. Never commit, push, tag,
or create branches unless explicitly asked.
