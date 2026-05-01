Now I have everything needed. Here's the full spec:

---

# Spec: Telegram Multi-Session Forum Topics

## Goals

1. **Isolation** — each Athena session gets its own Telegram Forum topic; messages never bleed across sessions
2. **Parallel sessions** — N Athena sessions on the same machine produce N independent topics, routable without ambiguity
3. **Session spawning** — a new session connecting to the daemon automatically creates and owns a topic
4. **Session resume** — going back to a topic after Athena closes and reopens resumes the correct session naturally
5. **Backward compatibility** — existing flat-chat setups continue to work unchanged (opt-in via `forum_mode`)

---

## Architecture Overview

```
Telegram Forum Supergroup
├── General topic           ← bot commands only (/status, /newsession, /help)
├── Topic T1 (thread 42)   ← Athena session abc123
├── Topic T2 (thread 85)   ← Athena session def456
└── Topic T3 (thread 91)   ← pending (no session yet)

Bot subprocess (singleton, long-lived)
  sessionTopics: Map<session_id → thread_id>    (in-memory + persisted)
  topicSessions: Map<thread_id → session_id>    (reverse index, derived)
  pendingTopics: thread_id[]                    (pre-created, unclaimed)

Channel Daemon (unchanged)
  sessions: Map<session_id → Set<Socket>>

Athena Session Process
  Registry → daemon socket → bot subprocess
  session_id = stable UUID from ~/.config/athena/sessions/{id}/session.db
```

The daemon and registry require **no changes**. All logic lives in the Telegram bot subprocess.

---

## Prerequisites

The setup requires a **Telegram Forum supergroup** (not a private chat or regular group):

- Create a supergroup → Settings → Topics → Enable
- Add the bot as admin with "Manage Topics" permission
- `default_chat_id` in options must be this group's chat ID

The bot detects forum mode from `options.forum_mode: true`. Without it, behavior is identical to today.

---

## State Model

### RuntimeState additions

```ts
type RuntimeState = {
	// existing fields unchanged
	bot: TelegramBot | null;
	allowedUserIds: Set<string>;
	defaultChatId: string | number | null;
	pendingMessages: Map<string, PendingMessage>;
	inFlightSends: Set<string>;
	cancelDuringSend: Map<string, string>;

	// NEW — forum fields (only populated when forum_mode: true)
	forumMode: boolean;
	sessionTopics: Map<string, number>; // session_id → message_thread_id
	topicSessions: Map<number, string>; // thread_id → session_id (reverse)
	pendingTopics: number[]; // pre-created topics awaiting a session
	statePath: string | null; // path to telegram-state.json
};
```

### Persisted State File

Location: `~/.config/athena/channel-state/telegram-{chatId}.json`

One file per forum group (keyed by chat ID, so multiple bot tokens pointing to different groups don't collide).

```json
{
	"version": 1,
	"forum_chat_id": -100123456789,
	"session_topics": {
		"abc123-uuid": 42,
		"def456-uuid": 85
	},
	"pending_topics": [91]
}
```

Loaded on bot startup before polling begins. Saved after every mutation (topic create, topic assign, topic close). Writes are atomic (write to `.tmp`, rename).

---

## Protocol Changes

### New method message: `session.update`

Athena → bot. Sent by the registry when the session gets a label (first prompt extracted or user-set label).

```ts
// types.ts addition
| {
    session_id: string;
    method: 'session.update';
    params: { label: string };
  }
```

Bot response: rename the forum topic via `editForumTopic(chatId, threadId, {name: label.slice(0, 128)})`.

The registry sends this whenever `SessionStore.updateLabel()` is called, which already happens today on first user prompt.

### `init` options additions

```ts
options: {
  bot_token: string;
  default_chat_id: string | number;
  forum_mode?: boolean;      // NEW: enable forum topic routing
  session_label?: string;    // NEW: initial topic name (session label if known at startup)
}
```

### New Telegram Bot API methods needed

```ts
// bot.ts additions
createForumTopic(chatId, name: string): Promise<{message_thread_id: number}>
editForumTopic(chatId, messageThreadId: number, params: {name?: string}): Promise<void>
closeForumTopic(chatId, messageThreadId: number): Promise<void>  // marks as resolved/archived
```

`sendMessage` and `editMessageText` already accept an options bag — just pass `message_thread_id` there.

---

## Component Changes

### 1. `TelegramBot` class (`bot.ts`)

Add three new API methods. `sendMessage` and `editMessageText` already take an `options` parameter that gets spread into the API call params — add `message_thread_id` to `SendMessageOptions`:

```ts
type SendMessageOptions = {
	parse_mode?: ParseMode;
	reply_markup?: ReplyMarkup;
	message_thread_id?: number; // NEW
};
```

No other changes to `TelegramBot`.

### 2. `RuntimeState` initialization (`index.ts`)

```ts
const state: RuntimeState = {
	// existing
	bot: null,
	allowedUserIds: new Set(),
	defaultChatId: null,
	pendingMessages: new Map(),
	inFlightSends: new Set(),
	cancelDuringSend: new Map(),
	// new
	forumMode: false,
	sessionTopics: new Map(),
	topicSessions: new Map(),
	pendingTopics: [],
	statePath: null,
};
```

### 3. `handleMethod` — `init` case

```
On init:
  1. If first init:
     a. Start bot polling
     b. Set BOT_COMMANDS (add /newsession when forum_mode)
  2. Always:
     a. Update allowedUserIds (merge, don't overwrite — fixes multi-session allowlist bug)
     b. If forum_mode:
        - Load state from statePath if not yet loaded
        - If session already has a topic → no-op (reconnect case)
        - Else if pendingTopics has entries → claim oldest pending topic,
          assign to this session_id, save state
        - Else → call createForumTopic(chatId, label ?? "Session {shortId}"),
          assign to this session_id, save state
        - Send "Session started" notification in the topic with a tg:// deep link
     c. Emit ready event
```

Reconnect detection: `state.sessionTopics.has(session_id)` — if true, the topic already exists, nothing to create. This handles the case where Athena closes and reopens with the same `session_id`.

### 4. `handleMethod` — all outbound message methods

Every method that calls `sendMessage` or `editMessageText` gains one helper:

```ts
function threadId(state: RuntimeState, sessionId: string): number | undefined {
	return state.forumMode ? state.sessionTopics.get(sessionId) : undefined;
}
```

Pass `message_thread_id: threadId(state, message.session_id)` into all `sendMessage` / `sendAndTrack` calls. When `undefined`, the existing flat-chat path is used automatically (no `message_thread_id` in params = posts to main chat). Zero behavioral change in non-forum mode.

### 5. `handleMethod` — `session.update` case (new)

```
On session.update:
  Resolve thread_id = sessionTopics.get(session_id)
  If thread_id exists:
    Call editForumTopic(chatId, thread_id, {name: label.slice(0, 128)})
  saveState()
```

### 6. `handleMethod` — `shutdown` case

```
On shutdown:
  If forum_mode:
    Resolve thread_id = sessionTopics.get(session_id)
    If thread_id:
      closeForumTopic(chatId, thread_id)  // marks topic as resolved
  Existing shutdown logic unchanged
```

Closing the topic gives the user a visual signal in Telegram that the session ended. The mapping is **kept** in `sessionTopics` — the topic still exists and can be re-opened when Athena reconnects.

### 7. `handleIncomingMessage` — routing rewrite

This is the core routing change. Current fallthrough logic becomes:

```
Parse message.message_thread_id → threadId

If threadId is undefined or threadId === GENERAL_TOPIC_ID:
  → General topic handler (commands only, guidance for free text)

Else:
  sessionId = topicSessions.get(threadId)

  If sessionId is undefined:
    → Unknown topic: "This topic is not linked to any session."
    Return

  If it's a command (/help, /status, /cancel):
    → handle scoped to this session
    Return

  If it's a verdict reply:
    → look up pending in pendingMessages, route verdict to sessionId
    Return

  If it's a question answer:
    → route answer to sessionId
    Return

  If it's free text:
    → send targeted: {session_id: sessionId, event: 'chat.message', content, meta}
    (No broadcast. Never CHANNEL_BROADCAST_SESSION_ID.)
    Return
```

**General topic handler:**

- `/help` → show help text
- `/status` → list all sessions with their topic links (`tg://...`) and active/inactive status
- `/newsession` → `createForumTopic(chatId, "New Session")`, add to `pendingTopics`, save state, reply with "Topic created — start Athena to claim it"
- Free text → "Please use a session topic to send messages. Tap /status to see active sessions."

### 8. Session `init` allowlist merge fix

Currently each `init` **overwrites** `allowedUserIds`. With multiple sessions using different allowlists this is a bug. Change to a **union merge**:

```ts
for (const id of message.params.allowed_user_ids) {
	state.allowedUserIds.add(String(id));
}
```

Sender validation remains the same — a message from an allowed user in any topic is accepted.

### 9. Registry sends `session.update` (`registry.ts`)

The registry already calls `daemonClient.send(method)` for other methods. Add one call after `SessionStore.updateLabel()` completes:

```ts
this.send({
	session_id: this.sessionId,
	method: 'session.update',
	params: {label},
});
```

This wires up automatic topic renaming with zero TUI changes.

---

## Session Lifecycle

```
┌─────────────────────────────────────────────────────────────┐
│ NEW SESSION                                                  │
│  init received → createForumTopic → sessionTopics[id]=tid   │
│  Notify General: "Session started" + [Open →] button        │
│  Messages: all use message_thread_id = tid                  │
└─────────────────────────────────────────────────────────────┘
                        │
                        ▼
┌─────────────────────────────────────────────────────────────┐
│ ACTIVE (harness running)                                    │
│  Permission/question prompts → topic                        │
│  Notifications → topic                                      │
│  User free text in topic → chat.message to session_id       │
└─────────────────────────────────────────────────────────────┘
                        │
              ┌─────────┴──────────┐
              │                    │
              ▼                    ▼
┌─────────────────────┐  ┌────────────────────────────────────┐
│ IDLE (harness done) │  │ DISCONNECTED (Athena closed)       │
│ Socket still open   │  │ Socket gone, daemon idle timer     │
│ All routing works   │  │ Messages arrive → bot buffers?     │
│                     │  │ OR → "Session inactive. Resume:"   │
└─────────────────────┘  └────────────────────────────────────┘
                                      │
                                      ▼
                        ┌────────────────────────────────────┐
                        │ RESUMED (Athena reopened same id)  │
                        │ init received, topic already in map│
                        │ No topic created (reuse existing)  │
                        │ All routing resumes                │
                        └────────────────────────────────────┘
```

**Disconnected state handling:** when a `chat.message` arrives for a session not currently connected (socket not in daemon's map), the bot cannot deliver it. Two options ranked by complexity:

- **Option A (simple, ship first):** Bot sends in the topic: `"⚠️ Session inactive. Resume with:\nathena --continue {sessionId}"`. Message is lost but the user knows what to do.
- **Option B (future):** Bot buffers up to N messages per topic in `RuntimeState`. On reconnect (`init` for an existing session_id), drain the buffer as `chat.message` events.

Ship Option A, plan Option B.

---

## `/newsession` Flow — Pre-created Topics

```
User sends /newsession in General
  Bot calls createForumTopic(chatId, "New Session")
  Gets thread_id = T3
  state.pendingTopics.push(T3)
  saveState()
  Bot replies in General: "Topic created [Open →]"
                          "Run `athena` on your machine to connect."

Later: User runs `athena` on their machine
  init received for session xyz789
  state.sessionTopics has no entry for xyz789
  state.pendingTopics has [T3]
  → pop T3, assign: sessionTopics[xyz789] = T3, topicSessions[T3] = xyz789
  → editForumTopic(chatId, T3, {name: "Session xyz789"})
  saveState()
  Bot sends in T3: "✅ Session connected"
```

If Athena never starts, the pending topic sits idle. `/status` shows it as "pending — no session connected". A future cleanup command (`/cleanup`) can delete stale pending topics.

---

## State Persistence

### Write path

Every mutation to `sessionTopics`, `topicSessions`, or `pendingTopics` calls `saveState()`:

```ts
function saveState(state: RuntimeState): void {
	if (!state.statePath) return;
	const data = JSON.stringify(
		{
			version: 1,
			forum_chat_id: state.defaultChatId,
			session_topics: Object.fromEntries(state.sessionTopics),
			pending_topics: state.pendingTopics,
		},
		null,
		2,
	);
	fs.writeFileSync(state.statePath + '.tmp', data, 'utf8');
	fs.renameSync(state.statePath + '.tmp', state.statePath);
}
```

Atomic rename prevents corruption on crash.

### Read path

Called once at bot startup before polling:

```ts
function loadState(state: RuntimeState): void {
	if (!state.statePath || !fs.existsSync(state.statePath)) return;
	const raw = JSON.parse(fs.readFileSync(state.statePath, 'utf8'));
	if (raw.version !== 1) return; // ignore incompatible
	for (const [sid, tid] of Object.entries(raw.session_topics ?? {})) {
		state.sessionTopics.set(sid, tid as number);
		state.topicSessions.set(tid as number, sid);
	}
	state.pendingTopics = raw.pending_topics ?? [];
}
```

### State file path

Derived at runtime in the `init` handler:

```ts
const stateDir = path.join(os.homedir(), '.config', 'athena', 'channel-state');
fs.mkdirSync(stateDir, {recursive: true});
state.statePath = path.join(stateDir, `telegram-${state.defaultChatId}.json`);
loadState(state);
```

---

## Parallel Session Correctness

With N sessions running simultaneously:

| Concern                                                  | Resolution                                                                                              |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Two sessions creating topics at the same time            | Each `init` is processed serially by the bot (single-threaded Node, sequential stdin parsing by daemon) |
| Same `session_id` sending `init` twice (reconnect)       | `sessionTopics.has(sid)` guard → no-op on second init                                                   |
| Two sessions with overlapping `channelRequestId`         | Already handled by `sessionId:channelRequestId` key format                                              |
| Broadcast `chat.message` reaching wrong sessions         | Eliminated — all `chat.message` events now carry the specific `session_id` from `topicSessions` lookup  |
| Allowlist collision across sessions with different users | Fixed by union-merge in `init` handler                                                                  |
| `/cancel` in a topic cancelling another session's prompt | `/cancel` is scoped to the topic's session: only cancels `pendingMessages` matching that `session_id`   |

---

## What Does Not Change

- **Daemon** (`daemon.ts`) — no changes
- **ChannelRegistry** (`registry.ts`) — one addition: send `session.update` after label changes
- **AppShell** / **RuntimeProvider** — no changes
- **Permission relay / Question relay** — no changes
- **Non-forum Telegram setups** — identical behavior when `forum_mode` is absent
- **Other channels (future Slack etc.)** — spec is Telegram-specific; the pattern applies to Slack threads with the same primitives

---

## Implementation Phases

**Phase 1 — Foundation (no UX change yet)**

- Add `createForumTopic`, `editForumTopic`, `closeForumTopic` to `TelegramBot`
- Add `message_thread_id` to `SendMessageOptions`
- Add forum fields to `RuntimeState`
- Implement `loadState` / `saveState`
- Wire `forum_mode` opt-in in `init` handler — create topics but don't change routing yet

**Phase 2 — Routing**

- Rewrite `handleIncomingMessage` with `message_thread_id`-based dispatch
- Change `chat.message` from broadcast to targeted
- Add General topic command handler
- Fix allowlist union-merge bug

**Phase 3 — Lifecycle**

- `shutdown` → `closeForumTopic`
- `session.update` method in protocol and registry
- Disconnected-session reply ("session inactive, resume with...")
- `/newsession` → pending topic queue

**Phase 4 — Polish**

- `/status` lists all sessions with topic links and active/inactive status
- Message buffering for disconnected sessions (Option B)
- Stale pending topic cleanup
