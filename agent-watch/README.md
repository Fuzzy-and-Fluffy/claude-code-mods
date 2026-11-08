# agent-watch

A band above the prompt and a 子助手 pane: every sub-agent of the chat with its status, latest
activity, steps and elapsed time, plus Codex runs that look like this chat's. Install: see the
repository README.

Rows use ● 在跑, ◐ 等待 / 停住 N 分钟, ✔︎ 完成 and ✖︎ 失败 (text presentation).
The half-filled circle is U+25D0, filled on the left. Ten minutes without an observed spawn,
tool call/result or model step marks a sub-agent stalled; Codex uses its record's last write.
Stalled rows stay visible before other active rows. Within each priority group, nested agents
stay under their parent. A Codex record with no ending and no write for 15 minutes ends with
结束方式未知, using its last write as the end time.
Finished rows fold under 已完成 N. 打开 on an engine sub-agent shows its latest 20 messages
inside the pane; ‹ returns to the list. This is a local read, not a resume or a stop action.
Codex rows and background tasks have no engine-agent transcript to open through this API.
Background tasks expose status snapshots, without activity timestamps; they are not assigned
invented stall times. The mod API does not expose a list of independently started child chats
or their parent-chat relationship, so no 子任务 count is guessed from folder proximity.

## Language

The band, the pane, toasts and command output follow the system language: Chinese when it starts
with `zh`, English otherwise. The `language` setting overrides this: `auto` (default), `zh` or
`en`. Change it in `/config`. With `auto` the system language is read from `LC_ALL`, `LC_MESSAGES`
and `LANG`, then from the macOS or Windows UI language.

## What it reads, runs and sends

- **Sends nothing.** It has no server, makes no network call and submits no prompt.
- **Reads**, only to show in its band and pane, on whichever surface of this chat draws them (a
  connected phone can draw the pane):
  - the engine's list of this chat's sub-agents and background tasks, and the count of its
    scheduled tasks;
  - a sub-agent's messages via `session.messages({ agentId })`, when its 打开 button is pressed;
  - this chat's tool calls as they run: a sub-agent's latest tool call (for a Bash call, its
    description or the start of its command) can show as that row's latest activity, and a Bash
    command that mentions Codex has the folders it names noted;
  - the Codex run records (`rollout-*.jsonl`) under `~/.codex/sessions` (or
    `$CODEX_HOME/sessions`) changed since this chat started, from the last week at most, whichever
    Codex app wrote them. Of these it shows only command-line (`codex exec`) runs that count as
    this chat's: started after this chat did, in this chat's project or in a folder such a command
    named. That is inferred from folder and time, so another run in the same folder can show too.
    Its row shows the model, a title taken from the brief, and, while it runs, its latest message
    line.
- **Runs** two programs, only for a Codex record of 4 MiB or more, which the engine's file read
  refuses: `head -c 262144 <record>` and `tail -c 1048576 <record>`, to read its start and end.
  Either may run on any record it reads, shown or not. With `language` on `auto` and no language
  in the environment variables, it also runs `defaults read -g AppleLanguages` (macOS) or
  `powershell -NoProfile -Command "(Get-UICulture).Name"` (Windows) once, to read the UI language.
  Nothing else is started.
- **Writes** no files.

## Hooks

- `session.start`: registers `/agent-watch` and marks agents a reload missed as ended.
- `agent.spawn`: adds the new agent's row and, when the engine reports a phone surface, tries to
  open the pane there.
- `tool.call`, `turn.step`, `classic.Stop`, `turn.complete`: watch only, to keep the rows and the
  background-task count current; each passes the event on unchanged.
- `ui.close` on its own pane: notes that the pane was closed.
- `ui.render` for `AbovePrompt` and its own `Pane`: draws the band and the pane.
- `command.run` for `agent-watch`: opens the pane.
