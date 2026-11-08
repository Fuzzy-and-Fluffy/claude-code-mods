# session-usage

Context and prompt cache in the prompt footer; a click opens plan usage and a pace estimate.
Install: see the repository README.

The footer stays 上下文 N% | 缓存 Nm. Only the cache text turns amber during its final five
minutes; a renewed, expired, unused or unknown cache uses the normal text color. The existing
one-per-response expiry toast for large cached conversations is unchanged.

## What it reads, runs and sends

- **Sends nothing** and writes no files. Only when the language is `auto` and no `LC_ALL`, `LC_MESSAGES`
  or `LANG` variable names one, it runs `defaults read -g AppleLanguages` (macOS) or
  `powershell -NoProfile -Command "(Get-UICulture).Name"` (Windows) once to read the system language.
- **Reads** the usage, cost, context and cache figures Claude Code already reports, and the
  prompt-cache settings: the `CLAUDE_CODE_PROMPT_CACHE_TTL`, `FORCE_PROMPT_CACHING_5M` and
  `ENABLE_PROMPT_CACHING_1H` variables and the `promptCacheTtl` setting. These are on/off and
  duration values, not credentials.

## Hooks

- `session.start`, `session.measure`, `turn.step`, `turn.complete`, `session.compact`: watch only,
  to keep the figures current and to show a toast when a usage window runs high or the prompt
  cache is about to expire; each passes the event on unchanged.
- `ui.render` for `SessionMode` and `AbovePrompt`: draws the footer and the details.

## Language

The on-screen text follows the system language: Chinese if it starts with `zh`, otherwise English.
The `language` setting overrides it: `auto` (default), `zh` or `en`. Change it in `/config`.
