# pi-subagents

Sub-agents for pi: delegate a task to a child agent that works in its own
session and context window, with its own model, its own tool set, and optional
background execution.

## Scope

This package covers only what pi cannot do without a second agent loop:

- **`Agent` tool** — spawn a sub-agent. Detached by default: the call returns an
  id and the parent's turn continues. `run_in_background: false` blocks instead.
- **`get_subagent_result` tool** — read a sub-agent's status and full output by
  id.
- **Agent types** — two built-ins (`general`, `explore`) plus markdown-defined agents from the user agent directory, and optionally from the project.
- **Per-run control** — model, thinking level, turn limit, wall-clock timeout, built-in tool narrowing, `isolated` for a child without extension tools.
- **Live activity panel** — a panel above the editor shows what each running agent does. A finished run keeps its `✓`/`✗` row for three seconds. `PI_SUBAGENTS_UI=off` hides the panel.

It does **not** orchestrate tools. Bulk tool calls, parallel fan-out, output
filtering, pipelines, and classifier calls belong to `codemode`; a sub-agent is
worth its extra model call only when the task needs an isolated context window,
a different model, a narrower tool set, or background execution.

## Install

Requires pi `>= 1.0.0`.

```bash
pi install git:github.com/whosydd/pi-subagents
```

From a local checkout: `pi install .` (or point pi at `extensions/index.ts`
directly; see `pi --help`).

## Usage

### Agent

| parameter | description |
| --- | --- |
| `prompt` | The task for the agent to perform. |
| `description` | Short (3-5 word) description, shown in notifications. |
| `subagent_type` | `general` (default), `explore`, or a custom agent name. |
| `model` | Optional override: an exact `provider/modelId` or an unambiguous bare id. Omit to use the agent-file pin, then the parent model. |
| `thinking` | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. Overrides the agent default and the parent session's level. |
| `max_turns` | Turn limit; the wrap-up steer lands after turn N (so a compliant run answers on N+1) and the run is aborted by N+3. |
| `timeout_ms` | Wall-clock limit; the run is aborted when it passes. Detached runs get `PI_SUBAGENTS_BACKGROUND_TIMEOUT_MS` when this is omitted — nothing else could stop them. |
| `run_in_background` | Default `true`: the call returns an id immediately and reports the result in a notification. `false` blocks, and puts the run's output *and* its token usage in this tool result. |
| `isolated` | `true` restricts the agent to built-in tools (no extension/MCP tools). |

Model precedence: explicit `model` parameter → agent-file `model:` pin → the
parent session's model. Thinking precedence: explicit `thinking` → agent-file
pin → the parent session's current level → pi's default.

`model` must be exact. A bare id that several providers ship is rejected with
the candidates, and a model without credentials is rejected before the spawn —
there is no fuzzy matching, because a silent near-match would pick a model the
caller never asked for.

### Activity panel

While runs are in flight, a panel sits above the editor:

```text
 ✻ 2 subagents running
   ⠹ explore · Map the TUI widget API · 3 turns · 12.0s
   ⠸ general · Write the renderer · 1 turn · 4.0s
```

Each row spins while its run is live. The spinner follows `Date.now()`, so a
queued run shows its wait. When a run ends, the row switches to `✓`. A failed
run and an aborted run switch to `✗`. The row drops out after three seconds.
The header counts running agents only, so it disappears with them.

The panel appears in TUI sessions only. Print and json sessions never show it.
An RPC client builds its own view from tool results and notifications. Set
`PI_SUBAGENTS_UI=off` to hide the panel in TUI sessions too.

### Agent files

```markdown
---
description: Security Code Reviewer
tools: read, grep, find, bash
model: anthropic/claude-haiku-4-5
thinking: off
max_turns: 10
---

You are a lightweight security auditor. ...
```

Supported frontmatter keys: `name` (defaults to the filename), `description`,
`model`, `thinking`, `tools`, `disallowed_tools`, `max_turns`.

**Locations and scope:**

- `~/.pi/agent/agents/*.md` — user agents, always loaded.
- `<cwd>/.pi/agents/*.md` — project agents, loaded only with
  `PI_SUBAGENTS_AGENT_SCOPE=project` or `both`.

Project agents are repo-controlled prompts that can override the built-in
`general` agent and run bash, so they are opt-in. User files override the
built-ins; project files override both.

## Runtime configuration

Environment variables, read once when the extension loads — reload pi to change them.

| variable | default | meaning |
| --- | --- | --- |
| `PI_SUBAGENTS_AGENT_SCOPE` | `user` | Which agent directories load: `user`, `project`, or `both`. |
| `PI_SUBAGENTS_PERSIST` | `off` | `on` writes child sessions to disk instead of keeping them in memory, so a finished sub-agent can be reopened as a pi session. |
| `PI_SUBAGENTS_SESSION_DIR` | pi default | Session directory used when persisting. |
| `PI_SUBAGENTS_MAX_CONCURRENCY` | `4` | Sub-agents allowed to run at once; further spawns queue. |
| `PI_SUBAGENTS_MAX_RECORDS` | `100` | Retained agent records; the oldest finished runs are evicted. |
| `PI_SUBAGENTS_MAX_RESULT_CHARS` | `8000` | Characters of a result the `Agent` tool carries inline. |
| `PI_SUBAGENTS_MAX_FULL_RESULT_CHARS` | `100000` | Characters `get_subagent_result` returns. Never falls below the inline cap — a truncation notice must not point at a reader that truncates the same text. |
| `PI_SUBAGENTS_MAX_NOTIFICATION_CHARS` | `800` | Characters of a result a completion notification carries. |
| `PI_SUBAGENTS_BACKGROUND_TIMEOUT_MS` | `1800000` | Wall-clock ceiling for detached runs. |
| `PI_SUBAGENTS_MAX_PROMPT_CHARS` | `2000` | Prompt characters kept in a record. |
| `PI_SUBAGENTS_UI` | `on` | `off` hides the live sub-agent activity panel above the editor. |

## Behaviour worth knowing

- **A spawn does not hold your turn.** The default is detached: you get an id,
  you keep working, and the result arrives as a notification. Ask for
  `run_in_background: false` only when the next step depends on the answer.
- **A completion notification is a steering message, not a follow-up.** If the
  parent is still mid-run, the notification is injected before its next model
  request, so the result reaches the report being written instead of landing
  after it. A parent that already stopped is woken with a fresh turn, and the
  notification asks it to reconcile whatever it said earlier.
- **The result is the agent's last substantive message**, not a transcript. Intermediate narration is dropped; there is no per-turn trace. Set `PI_SUBAGENTS_PERSIST=on` and open the child session file — its path is in the result — when you need the details.
- **The header line names the model, why it was chosen, and the thinking level**: `Sub-agent completed: explore · Haiku 4.5 (agent "auditor" model) · thinking off · 3 turns · 4.2s`.
- **Inline results are capped.** The full text stays in the record, and `get_subagent_result` returns up to `PI_SUBAGENTS_MAX_FULL_RESULT_CHARS` of it. Notifications carry a short excerpt and point at the id.
- **An abort says why**: turn limit, timeout, or the parent cancelling.
- **A rejected request is a failed run, not a quiet completion.** Providers report 401/403/429/5xx on the assistant message (`stopReason: "error"` + `errorMessage`) and pi does not throw for them, so a child that never watched those fields would "complete" with empty output and zero usage. The last assistant message decides: an error pi retried away is superseded by the message that followed it, and the surviving error is reported in the result, the notification, and `/cost` alike.
- **`tools:` narrows built-in tools only.** A "read-only" agent like `explore` still sees extension and MCP tools, because the extension uses a deny-list (an allow-list freezes pi's tool registry snapshot). Use `isolated: true` for a genuinely restricted child. The built-in set is read from pi itself, so a newly shipped built-in cannot slip past the deny-list; a `tools:` or `disallowed_tools:` entry that matches no built-in or extension tool is reported as a warning. A listed built-in that is not active by default (grep, find, ls) is activated for the child after its extensions register, and the child's tool-usage advice matches the set it actually gets.
- **Child sessions load the user's extensions by default** so sub-agents can use installed tools; this extension's own tools are excluded to prevent recursion. Extension load errors are reported in the result's warnings, and so is another extension registering an agent-spawning tool — nesting is flagged, not blocked.
- **Children do not get `codemode`, MCP, or `tool_search`**: pi loads those as CLI built-ins, and SDK-created child sessions do not. Children also skip skills, prompt templates, themes and project context files to keep their prompt small.
- **Agent files are read once per session.** Adding or editing one takes effect after `/reload` or a restart.
- **Blocking calls queue** behind `PI_SUBAGENTS_MAX_CONCURRENCY`; the tool call stays open while it waits, and cancelling the call drops it from the queue. Detached runs wait for a slot outside the tool call, which the parent never sees.
- **Background agents live inside the pi process.** They are cancelled when the session shuts down, and their records disappear when pi exits.

## Cost accounting

A blocking sub-agent's token usage is attached to the `Agent` tool result, so
the parent session's totals include it. A detached run's usage rides in
`get_subagent_result` instead, because a completion notification is not a tool
result and pi does not count it — the first read of that agent's output is where
its tokens enter the session total. Re-reading the same agent reports nothing,
so a background spend is counted once, if you read it at all.

**Sub-agent models are priced on their own terms.** pi adds `cost.total` off a
tool result to the session total as a number; it never re-prices those tokens
against the parent's model. A sub-agent on a more expensive model therefore
raises the session cost by what it actually cost, not by what the parent's model
would have charged for the same tokens.

Two things to know when reading `/cost`:

- Usage that arrives through a tool result has no model attribution, so pi
  groups it separately rather than under the parent's model. A sub-agent's spend
  shows up in that group, not under the model it ran on. The total still
  reconciles.
- A provider that does not report costs contributes tokens but no money, in a
  sub-agent run exactly as in a parent one.

Context-window accounting is unaffected: pi estimates it from message content,
so a sub-agent's usage never makes the parent look close to compaction.

## Known limitations

- No resume, steer, or abort tooling: a detached agent can only be read, never steered or cancelled early.
- No worktree isolation; child sessions run in the parent's working directory.
- Nested sub-agents are not prevented by this extension's tools alone — another extension registering an agent-spawning tool is reported as a warning, not blocked.

## Development

```bash
npm run check     # tsc --noEmit + node --test + headless load check
npm run smoke     # loads the extension through pi's loader (no model call)
```

```
extensions/
  index.ts            extension entry: tools, notifications
  lib/
    agents.ts         agent definitions (built-ins + markdown files, cached)
    builtin-tools.ts  built-in tool names, read from pi's own factories
    limiter.ts        concurrency cap with abort support
    model.ts          exact model resolution
    registry.ts       agent records + result/notification formatting
    session.ts        child-session creation and execution
    settings.ts       environment configuration
    spawn.ts          spawn planning: validation and precedence (pure)
    types.ts          shared types
smoke/load.ts         headless load check
test/                 unit tests (no network)
```
