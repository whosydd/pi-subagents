# pi-subagents

Sub-agents for pi: delegate tasks to autonomous child agents, with Jev (TypeSafe) calibrated model routing and result verification.

## What it does

- **`Agent` tool** — spawn a sub-agent that works in its own session and context window. Blocking by default; `run_in_background: true` detaches and notifies you on completion.
- **`get_subagent_result` tool** — read a sub-agent's status and output by id.
- **Agent types** — two built-ins (`general`, `explore`) plus markdown-defined agents from `.pi/agents/*.md` (project) and `<agentDir>/agents/*.md` (global).
- **Jev judgments** (when `TYPESAFE_API_KEY` is set) — model routing for spawns without an explicit model, and result verification after a run. Everything degrades silently when the judge is unavailable.

## Install

```bash
pi install git:github.com/whosydd/pi-subagents
```

From a local checkout: `pi install .` (or point pi at `extensions/index.ts` directly; see `pi --help`).

## Usage

### Agent

| parameter | description |
| --- | --- |
| `prompt` | The task for the agent to perform. |
| `description` | Short (3-5 word) description, shown in notifications. |
| `subagent_type` | `general` (default), `explore`, or a custom agent name. |
| `model` | Optional override: `provider/modelId` or a fuzzy name (e.g. `haiku`). |
| `thinking` | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. |
| `max_turns` | Turn limit; the agent is told to wrap up at the limit and is aborted 3 turns later. |
| `run_in_background` | Default `false`. `true` returns an id immediately and sends a completion notification. |
| `isolated` | `true` restricts the agent to built-in tools (no extension/MCP tools). |

Model precedence: explicit `model` parameter → agent-file `model:` pin → jev routing → the parent session's model.

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

Supported frontmatter keys: `name` (defaults to the filename), `description`, `model`, `thinking`, `tools`, `disallowed_tools`, `max_turns`. Project agents override global agents of the same name; both override the built-ins.

### Commands

- `/subagents` — jev configuration, agent types, running agents.

## Jev configuration

| variable | default | meaning |
| --- | --- | --- |
| `TYPESAFE_API_KEY` | — | Enables all jev judgments when set. |
| `JEV_SUBAGENTS` | on | Set to `off` to disable jev entirely. |
| `JEV_SUBAGENTS_MODEL` | `jev-latest` | Jev model id. |
| `JEV_SUBAGENTS_ROUTE` | on | `off` disables model routing. |
| `JEV_SUBAGENTS_VERIFY` | on | `off` disables result verification. |
| `JEV_SUBAGENTS_CANDIDATES` | all available | Comma-separated `provider/modelId` routing candidates. |
| `JEV_SUBAGENTS_MAX_CANDIDATES` | `12` | Cap on candidates sent to the router. |

**Routing.** The judge sees the task, the agent type, and the candidate list (the parent's model is always a candidate). Its pick is honored only when the calibrated probability is `>= 0.5` and confidence `>= 0.4`; otherwise the parent model is used. The judgment is attached to the tool result details so the decision stays traceable.

**Verification.** After a run finishes, the judge answers a sufficiency probability and a recommended next action (`accept` / `continue` / `escalate` / `fail`). The verdict is appended to the result — v1 is informational, the parent model decides what to do.

**Failure behavior.** No key, timeouts (15s), exhausted retries, or HTTP errors all leave the spawn untouched; routing falls back to the parent model and verification is skipped. Auth/billing errors (401/402/403) surface as a throttled user warning so calibration does not die silently. The task text and a result excerpt (truncated) are sent to the TypeSafe API — keep that in mind for sensitive content.

## Development

```bash
npm run check     # tsc --noEmit + node --test
npm run smoke     # loads the extension through pi's loader (no model call)
```

```
extensions/
  index.ts            extension entry: tools, command, notifications
  lib/
    agents.ts         agent definitions (built-ins + markdown files)
    model.ts          model resolution, routing candidates
    session.ts        child-session creation and execution
    registry.ts       agent records + formatting
    settings.ts       environment configuration
    jev/              TypeSafe client, routing, verification
smoke/load.ts         headless load check
test/                 unit tests (no network; jev via injected fetch)
```

### Known limitations (v1)

- No resume / steer / abort tooling; background agents are read-only via `get_subagent_result`.
- Child sessions always run in the parent's working directory (no worktree isolation).
- Skills, memory injection, scheduling, nested sub-agents, and a live widget are not implemented yet.
