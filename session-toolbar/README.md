# session-toolbar

Buttons above the prompt: 进度, 交接, 压缩, 撤回, 旁问, 收尾. Install: see the repository README.

## What each button does

- **进度** submits one fixed prompt as you, asking Claude for the decisions waiting on you, what is
  done and what comes next. It carries no other text. Same as `/progress`.
- **交接** (`/handoff`) builds a handoff note without a model call, from this chat's messages and
  transcript, the project's `OUTSTANDING.md` if there is one, and `git status --short --branch` and
  `git log -1`. Text shaped like a credential (API keys, tokens, passwords, bearer headers) is
  replaced with `[已隐去]`; a pattern list can miss one, so read the note before you share it.
  It then:
  - writes the note to `~/.claude/handoffs/<time>-<project folder>.md`, a plain Markdown file;
  - builds a kickoff text for a new chat. It asks that chat to take over the work: check that it
    runs in the project folder (and move there with `change_directory` if not) and in Auto mode
    (and tell you if not), read the note, check the current state, continue only what is left, and
    search the old chat's transcript, whose path the note gives, when it needs more detail. The
    credential masking covers the note and kickoff text, not that transcript.
    It holds the whole note, or, when that would pass 12,000 characters, the note's path instead;
  - copies the kickoff text to the clipboard with `pbcopy` (macOS) or PowerShell `Set-Clipboard`
    (Windows);
  - opens a new Claude Code chat with the kickoff text in its prompt box through a `claude://`
    link, with `open` (macOS) or PowerShell `Start-Process` (Windows). Nothing is sent until you
    press Enter there.
- **压缩** runs `/compact`. When session-usage reports the prompt cache as expired, the first press
  only warns and a second press within a short time runs it. **撤回** runs `/rewind`, **旁问** puts
  `/btw ` in the prompt box. They run only when you press the button.
- **收尾** (`/closeout`) checks whether the work is committed, pushed, merged and green, with no
  model call. It reads `OUTSTANDING.md` in the chat's folder and the repository root, if present,
  to count open items. It runs read-only `git` commands in the project (`status`, also in up to
  12 other worktrees of the repository, `rev-parse`, `remote -v`, `stash list`, `worktree list`,
  `for-each-ref`, `merge-base`), plus `ls-remote` and `fetch --prune`, which talk to the project's own remotes; the fetch updates the repository's
  remote-tracking branches and objects. It also runs `gh run list` / `gh pr view` for the
  project's GitHub repository. Both use your existing `git` and `gh` sign-in. It changes no file in
  your working tree and pushes nothing. Its 接着做 button puts what is left in the prompt box,
  unsent.

It also reads session-usage's prompt-cache reading, when that mod is installed, for the 压缩
warning and the band.

## Hooks

- `session.start`: registers the commands and starts a timer that redraws the band.
- `session.attach` from a phone: tries to open the toolbar pane there.
- `command.run` for `toolbar`, `progress`, `handoff`, `closeout`: the slash-command forms above.
- `tool.call`: after each tool call, notes the folder the chat works in, which 交接 uses when the
  chat started in a scratch folder; the call passes unchanged.
- `ui.render` for `AbovePrompt`, its own `Pane`, and `CommandOutput` of `/toolbar`: draws the
  buttons.
