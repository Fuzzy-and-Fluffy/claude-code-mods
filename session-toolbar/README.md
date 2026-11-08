# session-toolbar

Buttons above the prompt: 进度, 交接, 压缩, 撤回, 旁问, 收尾. Install: see the repository README.

## Language

The buttons, messages, handoff note and every prompt the toolbar sends to Claude follow the
`language` setting. `auto` (the default) uses Chinese when the system language starts with `zh`
(from `LC_ALL`, `LC_MESSAGES` or `LANG`, else the system's first preferred language), and English
otherwise. `zh` or `en` forces one. Change it in `/config` under this plugin's options.
In English the buttons read Progress, Handoff, Compact, Rewind, Aside and Closeout.

## Button parity with Pelican Code

Compared on 2026-11-01 with Pelican's `w127-buttons` source and the owner's
`session-buttons-parity-rule.md`. Sections, function and owner outcome are the contract;
software-specific wording may differ. The daily 进度 request is unchanged, including its order.
The rows below distinguish implemented alignment from remaining capability gaps. A listed gap
is not a claim of full parity.

| Button | Sections | Function and refusals | End effect | Remaining differences from Pelican and reason |
|---|---|---|---|---|
| 进度 | 需要我决定的事 / 已经完成的事 / 下一步怎么推进; latest statement wins, evidence for finished work, 没核实 when unverified | Submit the fixed Chinese request as the owner; first check real state, start no new work; a busy turn finishes first; failed submission shows a retry message | A three-part report in this conversation; `/progress` sends the identical request | No content gap against Pelican's current `sessionButtonPrompts.ts`. Delivery uses Claude's `prompt.submit` queue; Pelican owns a persistent queue and phone bridge. The mod cannot supply Pelican's queue receipts. On a phone use `/progress` through Claude's command menu. |
| 交接 | 最初的目标 / 最近的指示（原话，最新的在最后） / Claude 最后的汇报 / 任务清单 / 改过的文件 / 最近的检查 / 代码状态 / 待办记录 / 原会话记录; kickoff: check folder and permissions, read note, verify reality, continue unfinished work, re-ask a pending decision, search old history only as needed | Build locally without a model; include all three work records with redaction; mark unreadable records and missing Git evidence explicitly; save a note, copy the kickoff, open a new chat prefilled and unsent; errors leave a retry path, never change permissions | The owner reviews and sends the new chat's kickoff; the old conversation is kept | `claude://code/new` and clipboard replace Pelican's reserved successor, retry/abandon lifecycle, queue forwarding, model/effort chooser and chain history. The mod has no supported successor/session-chain controls; new-chat model and mode are selected in Claude. Its first check names `get_session` / `change_directory` and Auto; Pelican uses its own folder/mode controls. The original is a local transcript path instead of a Pelican session link. `/handoff` on a phone opens the computer's chat, not a phone-native successor. These lifecycle/phone outcomes remain gaps. |
| 压缩 | One-line cold-cache confirmation when a reliable cache reading exists; no report | Run native `/compact`; cold cache: first press arms, second within 10 seconds runs; unknown/missing cache does not invent a warning | Claude compacts this conversation; original task continues with summarized context | Mod reads session-usage's cache; Pelican reads its Claude provider's cache. Without that mod, no cache hint. Claude owns execution, busy refusal/queueing and phone command handling; Pelican disables while busy and has bridge retry protection. The mod has no cross-client request receipt/idempotency store. On a phone `/compact` directly uses Claude and bypasses the toolbar's cache confirmation. |
| 撤回 | Select a readable user question; new-session kickoff points to a saved prefix ending with that question | `/toolbar-rewind` lists choices; `/toolbar-rewind N` or a choice button saves and reads back a separate text record, then requests a new Claude session with an unsent kickoff. It never invokes native `/rewind`, restores files or modifies the original transcript. Stale selections, a saturated message page, oversized records, failed save/readback or platform refusal do not fall back to rewind | Continue from the selected question in a separate session, with the original conversation and current project files intact; review and send the kickoff there | This is a text-context restart, not an exact native transcript fork. It omits media and tool results; compaction may already have replaced older text with a summary. The SDK has no documented selected-message session-creation API or client-open receipt; a successful launcher only says the request was sent. The visible chooser shows the latest 20 questions; the command lists all readable choices. From a phone the new session opens on the host computer. See the supported alternatives and evidence in REPORT-r2.md. |
| 旁问 | Question, answer, time and engine per conversation; earlier completed exchanges as context | Button shows saved history and prefills `/toolbar-ask ` without replacing a text draft; `/toolbar-ask QUESTION` calls the tool-less `model.fork`, saves pending before the call, then saves and reads back its answer or failure. Bare `/toolbar-ask` reloads history. Duplicate in-flight questions are refused. Save failures keep the answer visible with a copy/retry instruction | Independent Q&A with durable per-conversation history, outside the main task; subsequent side questions receive all completed earlier exchanges | Uses the mod’s own Q&A, not native `/btw` answer capture. The cached offline changelog confirms native history browsing exists; its answer is not a guaranteed `command.run.text` result. `model.fork` uses the last model-sent context, which may lag an active turn; it can refuse before the first request or after clear. Engine is Claude Code; `modelAtRequest` is the selected model, not a provider model receipt. Storage is local to this host/config, shared by its attached surfaces, not synchronized across computers. See REPORT-r2.md for exact API evidence and alternatives. |
| 收尾 | Local evidence card: verdict and done/missing/unknown facts; continuation: commit → push → PR → checks → merge → release/install if required → real-path acceptance; final report: 做了什么 / 需要我决定什么 / 下一步怎么推进 | Inspect Git/GitHub and OUTSTANDING.md, ACTIVE-WORK.md, HANDOVER.md; unreadable evidence never passes; changing HEAD/status/tracked or new-file contents voids done results; preserve all work and check ownership first; original permissions remain binding; the button commits, pushes, merges, releases and archives nothing | Owner sees what is missing or unknown, can prefill 接着做 unsent, or copy the same continuation from `/closeout` on a phone; run the check again after changes | Pelican has session edit attribution, child/helper and durable-job ownership, configured project ledgers (including `docs/handover`), PR check-rollup evidence, queue receipts and guarded archive integration. Mod conservatively checks whole-worktree Git state, at most 12 other worktrees, stashes and GitHub Actions, and the three standard ledgers in the chat folder and repo root; it cannot infer those host-owned facts or release/install/real acceptance, so delivery remains unknown for the conversation to verify. No “Git green means delivered” claim. Snapshot hashing is bounded to 200 new files; failure, truncation or a larger set voids the run. The mod's card is a snapshot, not a live archive authorization; recheck after subsequent edits. Pelican asks before replacing a draft (including attachments); the mod refuses to replace non-empty text and asks the owner to save/clear it first. Claude's `prompt.read` exposes only text/cursor, so attachment-only draft detection remains a gap. |

### Data and commands

- 交接 (`/handoff`) reads this chat's messages, proven completed checks and changed-file records,
  local Git status and latest commit, and `OUTSTANDING.md`, `ACTIVE-WORK.md`, `HANDOVER.md` in the
  working folder. Each record is clipped separately; unreadable and empty records are labelled.
  The note is saved under `~/.claude/handoffs/<time>-<project folder>.md`. The kickoff includes
  the note, or its path when it would exceed 12,000 characters. Credential shapes are masked
  throughout note and kickoff; patterns are not a guarantee. The original transcript is not
  masked. Review the note before sharing it.
- Clipboard and new-chat launch use `pbcopy` / `open` on macOS and `Set-Clipboard` /
  `Start-Process` on Windows. They require Claude's registered `claude://` handler. Platform
  permission refusals are not bypassed.
- 收尾 (`/closeout`) runs `git status`, `rev-parse`, `remote -v`, `stash list`, `worktree list`,
  `for-each-ref`, `merge-base`, `diff --no-ext-diff --no-textconv --binary`, `ls-files` and
  `hash-object --no-filters` (without `-w`), plus `ls-remote` and `fetch --prune`. Fetch talks to
  configured remotes and updates Git objects/remote-tracking refs; no working file is changed.
  GitHub facts use `gh run list` and `gh pr view` pinned to origin's repository and HEAD.
  These use existing sign-in. The continuation is a request to Claude, not execution by the button.
- The desktop/terminal row, pane and `/toolbar` output use the same six actions in the same order.
  Claude's Remote Control phone currently displays plain command output rather than plugin
  buttons; `/toolbar` lists `/progress`, `/handoff`, `/compact`, `/toolbar-rewind`, `/toolbar-ask`, `/closeout`. Native `/rewind` and `/btw` remain Claude commands, separate from these mod actions.
  Pane rendering tests do not prove the phone app attaches a drawable surface.

### Rewind and side-question records (0.5.13)

- **撤回** shows the latest 20 readable questions as numbered buttons. `/toolbar-rewind` prints
  the whole readable list; `/toolbar-rewind 2` selects its second question. A second read verifies
  the prefix before saving. New messages after the chosen question do not invalidate that prefix.
  The copy keeps ordered user/assistant text through the chosen question, without later answers.
  Joined tool outcomes are omitted because the SDK can attach a later result to an earlier row.
  The new session must read the copy, check the working folder and current files, and respect its
  own permissions before answering. It does not auto-send. The original remains usable.
- Branch copies are unredacted local JSON under `$CLAUDE_CONFIG_DIR/session-toolbar/<session>/`
  when configured, otherwise the user's `.claude/session-toolbar/<session>/`. Each copy gets a
  separate time/selection filename and an existing copy is never overwritten. The launcher uses
  the same macOS/Windows `claude://` helper as handoff. No new permission or browser workaround.
- **旁问** uses the SDK's persistent plugin store, key `side-questions:<session id>`, with
  `question`, `answer`, `at` (milliseconds), `engine`, `modelAtRequest` and `status` per exchange.
  The host keeps this JSON store across sessions and reloads; UI state alone is not persistence.
  Pending/failed entries remain visible but are excluded from later question context. An unreadable
  store is never replaced with an empty history. A pending entry after interruption is explicitly
  unfinished; re-ask it if needed. If the final save fails, copy the displayed answer before retrying.
- Opening history or the chooser makes no model call. Each sent side question uses the session's
  existing API client/account and consumes its normal quota. A cold/changed cache may bill the
  whole prefix again. No paid route, extra provider or automatic retry is added. The SDK's store
  has a 4 MiB total limit; this mod also refuses records/context above 1,000,000 characters instead
  of silently dropping history. No cleanup or automatic deletion is performed.
- These local records contain conversation text and are not credential-masked. The mod does not
  publish these files. A sent side question supplies its text/history to the session's provider;
  sending the new-session kickoff lets that session read the selected text copy. Native `/btw`
  history is not imported. Use the custom commands on a phone attached to the same host as well.

### Verification

Run from the repository root: `claude plugin test session-toolbar`,
`tsc -p session-toolbar` (with Claude's generated `.claude-plugin/types` available), and
`claude plugin validate --strict session-toolbar`. Tests exercise the local hook host without
installing the plugin. Tests cover prefix selection and preservation, platform launch failure, local Q&A persistence/readback, history context, concurrent refusal and failure recovery. They do not establish live client opening, real provider answers/cost, or cross-client lifecycle parity.

## Hooks

- `session.start`: registers the commands and starts a timer that redraws the band.
- `session.attach` from a phone: tries to open the toolbar pane there.
- `command.run` for `toolbar`, `progress`, `handoff`, `closeout`: the slash-command forms above.
- `tool.call`: after each tool call, notes the folder the chat works in, which 交接 uses when the
  chat started in a scratch folder; the call passes unchanged.
- `ui.render` for `AbovePrompt`, its own `Pane`, and `CommandOutput` of `/toolbar`: draws the
  buttons.
