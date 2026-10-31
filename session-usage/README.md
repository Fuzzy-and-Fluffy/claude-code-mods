# session-usage

Context and prompt cache in the prompt footer; a click opens plan usage and a pace estimate.
Install: see the repository README.

## What it reads, runs and sends

- **Sends nothing**, runs no programs and writes no files.
- **Reads** the usage, cost, context and cache figures Claude Code already reports, and the
  prompt-cache settings: the `CLAUDE_CODE_PROMPT_CACHE_TTL`, `FORCE_PROMPT_CACHING_5M` and
  `ENABLE_PROMPT_CACHING_1H` variables and the `promptCacheTtl` setting. These are on/off and
  duration values, not credentials.

## Hooks

- `session.start`, `session.measure`, `turn.step`, `turn.complete`, `session.compact`: watch only,
  to keep the figures current and to show a toast when a usage window runs high or the prompt
  cache is about to expire; each passes the event on unchanged.
- `ui.render` for `SessionMode` and `AbovePrompt`: draws the footer and the details.
