# Development Rules

## Commands

- `npm run check` — typecheck + tests + headless load check.
- `npm run smoke` — headless load check through pi's own loader, no model call.
- `npm run typecheck` — `tsc --noEmit`.
- `npm run test` — `node --test test/*.test.ts`.

Tests must not hit the network.

## Layout

- `extensions/index.ts` — pi extension entry: tool registration, background spawns, notifications.
- `extensions/lib/` — implementation modules (see README).
- `lib/spawn.ts` is pure and owns the spawn decision (validation, model and
  thinking precedence, defaults); keep the wiring in `index.ts` thin so it stays
  testable without a session or a model call.
- `test/` — unit tests, `smoke/` — integration load check.

## Invariants

- **Scope: fill gaps, do not duplicate codemode.** No task arrays, chains, or
  pipeline modes; bulk tool calls, output filtering, and classifier calls are
  codemode's job. A sub-agent is justified only by context isolation, model
  choice, tool scoping, or background execution.
- **A spawn is detached by default.** `run_in_background: false` is the opt-in
  that blocks the parent's turn and reports usage in the tool result. Changing
  the default changes the cost accounting, so it needs a test.
- **A run's result is the last assistant message that produced text**, never the
  concatenation of every turn, and no per-turn transcript is kept.
- **A rejected request is a failed run, never a quiet completion.** pi reports
  provider errors (401/403/429/5xx, disabled upstream) on the assistant message
  as `stopReason: "error"` with `errorMessage`, empty content and zero usage —
  `prompt()` resolves normally, so nothing throws. `runAgent` folds every
  assistant message through `foldAssistantMessage` (`providerFailureOf` is the
  reader) and lets the last message win: an error pi retried away is superseded
  by the message that followed it, and a surviving error makes the record
  `failed` with the provider's message attached. `stopReason: "aborted"` is
  pi's cancellation shape and must NOT count as a provider failure —
  `abortReason` owns it. Records classify status by truthiness, so the two
  error sources meet in `resolveRunFailure`, which never returns `""`: a thrown
  `Error("")` must not reopen the silence the fold just closed.
- **Inline results and notifications are capped; `get_subagent_result` is the
  wider reader.** Its cap must never fall to or below the inline cap: a
  truncation notice pointing at a reader that truncates the same text is a dead
  end, not an escape hatch. Say "configured full-output limit" instead when
  there is nothing further to read.
- **Tool results that spent tokens must report `usage`** so the parent session's
  cost accounting includes blocking sub-agents. A detached run reports its usage
  through the first `get_subagent_result` that reads it, guarded by
  `usageReported` so a re-read does not double-count.
- **A sub-agent's cost is priced on the model it ran on, never on the parent's.**
  pi sums `cost.total` from a tool result as a number, so report a cost that is
  already correct for the child: `addReportedCost` falls back to the component
  sum when a provider leaves `total` at zero, because a zero total would make a
  paid run look free. Do not re-price child tokens against the parent model, and
  do not expect `/cost` to break the run out per model — tool usage lands in pi's
  unattributed group, and `ExtensionContext.sessionManager` is read-only.
- **Abort reasons are explicit** (`turn-limit` | `parent` | `timeout`); result
  and notification wording must never guess.
- **Model resolution is exact.** `provider/modelId`, or a bare id that exactly
  one available model carries; ambiguous or credential-less specs return an
  error string instead of a near-match.
- **Built-in tool names come from pi, not from a list in this repo.** `tools:`
  narrows by *denying* built-ins the agent did not ask for, so a stale local
  list silently grants a "read-only" agent a newly shipped write tool.
- **Project agents are opt-in.** `PI_SUBAGENTS_AGENT_SCOPE` defaults to `user`;
  project files under `<cwd>/.pi/agents` may override built-in agents and run
  bash, so they load only when asked for.
- **Agent files are cached per (cwd, agentDir, scope)** so a spawn does not read
  the filesystem on every call; `invalidateAgents()` runs when the extension
  loads, which is what `/reload` gives the user after editing an agent file.
- **Model precedence:** explicit `model` parameter → agent-file pin → parent
  model. Thinking precedence: explicit `thinking` → agent-file pin → parent
  session level.
- **Child sessions load user extensions by default** so sub-agents can use
  installed tools; this extension's own tools are excluded to prevent
  recursion. `isolated: true` spawns turn extensions off. A child run's
  extension load errors surface as warnings, never silently vanish.
- **Narrow built-ins with `excludeTools`, never a `tools` allowlist.** An
  allowlist freezes pi's tool-registry snapshot at session construction and
  permanently drops extension tools that register later.
- **Background work dies with the session.** `session_shutdown` aborts every
  in-flight background agent, and no notification is delivered after shutdown.
  A detached run also gets a wall-clock ceiling, since no parent tool call is
  left to cancel it.
- **No TypeScript constructor parameter properties** — Node's strip-only loader
  rejects them. Declare the field and assign it in the constructor.
- Type-only imports use `import type` (verbatimModuleSyntax); imports include
  the `.ts` extension (allowImportingTsExtensions).

## Git

Commits and pushes are manual — the user runs them. Never commit, push, tag,
or create branches unless explicitly asked.
