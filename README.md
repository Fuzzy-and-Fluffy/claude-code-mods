# claude-code-mods

Three small mods for Claude Code: a sub-agent pane, a quick-button toolbar and a usage footer.
Their on-screen text is in Chinese.

Claude Code 的三个小 mod：子助手面板、一排快捷按钮、用量显示。界面文字是中文。

| Mod | What it shows |
|---|---|
| `agent-watch` | A band above the prompt and a 子助手 pane: every sub-agent of the chat with its status, latest activity, steps and elapsed time. Codex runs this chat started through Bash (`codex exec`) show as rows too. |
| `session-toolbar` | Buttons above the prompt: 进度 (ask for progress and decisions), 交接 (write a handoff note without a model call and open a new chat with it), 压缩 (`/compact`), 撤回 (`/rewind`), 旁问 (`/btw`), 收尾 (check commit, push, merge and CI). |
| `session-usage` | Plan usage, prompt cache and context in the prompt footer; a click opens details with a pace estimate. |

## Install

Mods run in the Claude Code CLI and in the Code tab of the Claude desktop app.

```bash
claude plugin marketplace add Fuzzy-and-Fluffy/claude-code-mods
claude plugin install agent-watch@wondering-mods
claude plugin install session-toolbar@wondering-mods
claude plugin install session-usage@wondering-mods
```

Then run `/reload-plugins` in a session, or restart the app. Update later with
`claude plugin marketplace update wondering-mods` and `claude plugin update <name>@wondering-mods`.

## What they read and write

None of them has a server of its own or sends analytics. The only network calls the mods make
themselves are 收尾's `git` and `gh` commands to your project's own remote; buttons such as 进度
and 压缩 send an ordinary Claude request, as typing it would.

- `agent-watch` reads the engine's sub-agent list and the Codex run records of the last week under
  `~/.codex/sessions` (or `$CODEX_HOME/sessions`), and shows only the runs that started in this
  chat's project or in a folder a Codex command of this chat named: a run's model, first prompt line
  and latest message line.
- `session-toolbar`:
  - 交接 reads the chat's messages and transcript, the project's `OUTSTANDING.md` if there is one,
    and `git status` / `git log`. It writes the note to `~/.claude/handoffs/`, copies it to the
    clipboard and opens a new chat prefilled with it (a note too long for the prompt box is passed
    by its path instead). Text that looks like a credential (API keys,
    tokens, passwords, bearer headers) is replaced with `[已隐去]`; a pattern list can miss one, so
    read the note before you share it.
  - 收尾 runs `git fetch --prune` (which updates your remote-tracking branches), other `git`
    commands, and `gh run list` / `gh pr view` against the project's GitHub repository. It
    changes no files and pushes nothing.
- `session-usage` reads the usage, cost and cache figures Claude Code already reports, and the
  prompt-cache settings (the `CLAUDE_CODE_PROMPT_CACHE_TTL`, `FORCE_PROMPT_CACHING_5M` and
  `ENABLE_PROMPT_CACHING_1H` variables and the `promptCacheTtl` setting).

## Check a change

```bash
claude plugin validate <mod folder>
claude plugin test <mod folder>
```

## License

MIT, see `LICENSE`.
