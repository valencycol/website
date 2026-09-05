# Configuring AI Coding Agents to Write Less Code

Valency maintains an integration guide on colaco.se for **ponytail**
(https://github.com/DietrichGebert/ponytail) — a lightweight ruleset that makes
an LLM coding agent lazy about the solution and never about the reading.

## The ladder of seven questions

Before writing any new code the agent climbs a ladder and stops at the first
rung that applies:

1. Does this need to exist? If not, write nothing. (YAGNI)
2. Is it already in the codebase? Reuse it. Do not duplicate.
3. Is it in the standard library? Use that.
4. Is it a native platform/language feature? Use that.
5. Is there an already-installed dependency that does it? Use that.
6. Can it be done in one line of existing code? Write one line.
7. Only then: write the absolute minimum new code that works.

## Rules that go with the ladder

- Be lazy about the solution, never about the reading. Always read the relevant
  existing code, dependencies, and docs before proposing anything new.
- Prefer deleting over adding. Prefer composing over creating.
- Lazy, not negligent: trust-boundary validation, data-loss handling, security,
  and accessibility are NEVER cut to save lines.
- When you do add code, state which rung of the ladder you reached and why no
  earlier rung applied.
- Default to the smallest change that solves the problem correctly.

## Benchmark

Measured against an unguarded agent on the same tasks:
**−54% lines of code · −22% tokens · −20% cost · −27% time · 100% safe.**

## How to install it

**As a Claude Code plugin** (fastest):

    /plugin marketplace add DietrichGebert/ponytail
    /plugin install ponytail@ponytail

Run those as two separate prompts. For Codex, swap `/plugin` for
`codex plugin`.

**Toggling modes:**

    /ponytail            # default mode (full)
    /ponytail lite       # lighter guardrails
    /ponytail ultra      # strictest
    /ponytail off
    /ponytail-review     # review code against the ladder
    /ponytail-audit      # audit a path for over-engineering
    /ponytail-debt       # flag unnecessary complexity
    /ponytail-gain       # show savings vs. baseline
    /ponytail-help

**As a plain prompt** (most portable): paste the ladder and rules above into a
system prompt, a `.cursorrules` / `AGENTS.md` file, or the first message of a
chat.
