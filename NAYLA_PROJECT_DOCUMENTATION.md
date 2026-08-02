# Nayla — WhatsApp Vibe Bot
## Complete Project Documentation & Handoff Reference (v4)

**Owner/Creator:** Jackie
**Purpose of this document:** A full account of what this bot is, why it exists, exactly how it works, every service it depends on, and the complete history of every bug found and every decision made — written so that any future developer, or any AI assistant (including a future instance of Claude with no memory of this conversation), can pick up `index.js` cold and continue without re-deriving anything, and — just as importantly — **without reintroducing bugs that have already been fixed once.** Section 13 exists specifically for that last part; read it before touching identity detection, media handling, or AI prompts.

This supersedes v3 of this document. Everything from v3 is preserved and updated here; nothing was dropped.

**What's new in v4:** three of the six bugs listed as unfixed in v3's Section 19 are now fixed (mute/ignore airtightness, the `.kick`/`.promote`/`.demote` self-target guard, and the vibe-check economy fix) — see **Section 20**, which also covers the two remaining open items renumbered from Section 19. Separately, real-world testing surfaced **the most significant bug found since this document began**: quoted-message understanding was silently broken for almost anything replying to one of the bot's own messages — which is most of what happens in a DM, and covers `.eli5`/`.tts`/the combined analyzer replying to command output in groups too. Root-caused to a missing `deviceSentMessage` wrapper check (Section 20.6) — a real, protocol-level gap, as opposed to a pasted third-party diagnosis that proposed a different, incorrect fix along the way (debunked in Section 20.8, and folded into the recurring-pattern list as Section 13.11). **Section 19 in v3 is now split**: fixed items moved into Section 20 with a resolution note; still-open items renumbered and carried forward as the new Section 19.

**What was new in v3, for reference:** that revision was produced by auditing the actual, current `index.js` against v2 line-by-line. A substantial amount of real, working code had drifted out of documentation — some of it directly contradicting v2's own "explicitly not built" claims (Section 15). Section 18 covers everything found undocumented at that time (connection/session reliability hardening, raid protection, command-response memory capture, the ElevenLabs voice fix, real OGG/Opus TTS transcoding, the Gemini model swap, and more).

---

## 1. What This Project Is

Nayla is a WhatsApp bot that runs as a real linked device on Jackie's WhatsApp account (via the multi-device API), sitting in group chats and DMs. It is a **"vibe bot"** — a companion with a selectable personality that chats when addressed, remembers small things about people (scoped per-conversation — see Section 11), searches the web, looks at photos/stickers, listens to voice notes, generates images, and occasionally comments on notable moments in a group. It is deliberately **not** a moderation bot — it never deletes messages or issues formal warnings. That was an early design direction that was explicitly and permanently reversed (Section 12.6).

**Core design constraints that shaped almost every decision:**
- Hosted on **Render's free tier** — roughly 512MB RAM, and **ephemeral disk storage** (anything written to disk is wiped on every restart/redeploy).
- Render's free tier **sleeps the container after inactivity** unless something keeps it warm.
- **MongoDB Atlas free tier (M0)** — roughly 512MB total storage, a second, completely separate constraint from Render's RAM.
- The person running this is a solo, non-professional developer iterating fast via chat with AI assistants across many sessions/days, not a dev team — so the code has to be defensive, self-explanatory, and forgiving of missing configuration.

---

## 2. The Files That Matter

| File | Purpose |
|---|---|
| `index.js` | The entire bot. Single file, ~2,900+ lines as of this writing. Everything lives here. |
| `pair.js` | A **separate, one-time-use script**, run manually/locally, NOT part of the deployed bot. Opens a Baileys connection, prints a QR/pair code, links the device, saves the resulting session. Never modified in this project's history — mentioned only because its output is what `index.js` depends on. **If a future pairing issue seems to "not take effect," check whether `pair.js` writes to the exact same `MONGODB_URI` database/collection that `index.js` reads from** — this was flagged as a real open question and never fully confirmed either way. |
| `package.json` | Dependencies. One confirmed change is documented in Section 2.1. `ffmpeg-static` and `sharp` are both optional dependencies referenced by `index.js` — see Section 8. |

### 2.1 Baileys version — a real, confirmed fix
At one point the bot's WhatsApp connection started closing immediately on every deploy. Jackie diagnosed this as an outdated `@whiskeysockets/baileys` version and updated `package.json` to a newer release (reported as roughly `7.x`, an RC build — the exact version string was not confirmed in this conversation). **This fixed the disconnect.** Takeaway for future maintenance: if the bot starts failing to establish or hold a WhatsApp connection with no other obvious cause, check whether Baileys itself has moved on to a new protocol version — WhatsApp's multi-device protocol changes periodically and old Baileys versions can simply stop working. Keeping Baileys reasonably current is a real, recurring maintenance need for this kind of project, not a one-time fix. **See also Section 7.9 — a related, separate protocol-version issue was found and fixed independently of the Baileys package version itself.**

---

## 3. Why MongoDB Exists At All (The Ephemeral Storage Problem)

Render's free tier does **not** persist disk writes across restarts. Baileys normally saves the WhatsApp session (encryption keys) as local files. On Render, that folder is wiped on every restart — which would mean scanning a new QR/pair code every single time, making production deployment unworkable.

**The fix:** `index.js` uploads the entire session folder to a `Session` collection in MongoDB Atlas every time credentials update, and downloads it back to disk *before* Baileys reads it on startup. This is why `💾 Session successfully synced & uploaded to MongoDB Atlas!` appears constantly in the logs.

**This sync is no longer triggered only by `creds.update`.** A separate, module-scoped 60-second interval also uploads the session folder unconditionally — this closes a real gap where per-contact session/sender-key files (written directly to disk by Baileys on every message exchange) were going stale in MongoDB between `creds.update` events, eventually causing "Bad MAC" decryption errors after a restart. Full technical detail is in **Section 7.11** — this is one of the most important fixes in the project's history and deserves to be read in full, not just skimmed here.

Beyond session storage, MongoDB now also holds:
- **User stats** (XP, message counts) — `UserStat` collection, global per person. **Now carries a 1-year inactivity TTL** (new since v2 — see Section 3.1).
- **Per-chat personal facts** — `UserChatFacts` collection, scoped per person **and** per conversation (Section 11) — this is a newer, corrected design; see Section 12 for why it changed.
- **Per-group configuration** (mute state, ignore list, mood, lock status, Movie Mode date, Daily Newspaper date, movie/newsletter toggles) — `GroupConfig` collection. Writes now retry with backoff and are periodically reverified — see Section 7.12.
- **Archived conversation memory** — `ConversationArchive` collection, write-only, TTL-expired after 30 days.
- **Activity heatmap buckets** — `ActivityLog` collection, one tiny doc per group per day, TTL-expired after 8 days (Section 17.10).

If `MONGODB_URI` is missing, the bot does **not** crash — it logs a warning and degrades gracefully (session won't persist across restarts, but the bot still runs). This "missing config degrades a feature, never crashes the process" pattern is applied everywhere in this codebase, deliberately, and should be preserved in anything new.

**⚠️ Corrected in v1 of this document, still accurate:** the MongoDB env var is `MONGODB_URI`, not `MONGO_URI`. (Internally, the JS variable holding it is still named `MONGO_URI` — that's just a local variable name, the env var itself is `MONGODB_URI`.)

### 3.1 MongoDB Retention Policy — All Collections, Consolidated (new in v3)
This table was assembled from a single large rationale comment in the code (written together, not decided piecemeal) so a future maintainer doesn't have to re-derive it collection-by-collection:

| Collection | TTL | Why |
|---|---|---|
| `UserChatFacts` | 30 days of inactivity | A "fact" genuinely goes stale — no reason to remember something from months ago. |
| `ConversationArchive` | 30 days | Write-only dump of old chat history with fast-diminishing value; nothing in the bot ever reads it back in. |
| `ActivityLog` | 8 days | `.activity` only ever looks at the last 7 days, so 8 is exactly enough buffer. |
| `Session` | **None** | This is the live WhatsApp login. Expiring it would log the bot out — deliberate, not an oversight. |
| `GroupConfig` | **None** | Mood/mute/ignore-list/toggles are active configuration, not accumulating junk. A group quiet for months shouldn't silently lose its settings; the doc size (one small doc/group) is trivial regardless of gap length. |
| `UserStat` | **1 year** of inactivity *(new since v2)* | XP/rank is meant to be a lasting achievement — deliberately NOT the same aggressive 30-day window as facts/archives. 1 year is long enough to never affect anyone using the bot with any regularity, while still bounding truly-abandoned entries if this bot scales to many more users later. |

---

## 4. Keeping Render Awake

Two mechanisms:
1. **A bound HTTP server** (`http`/`https`, `PORT` env var) started at module scope, not inside the reconnect-capable `startBot()` function (doing it there caused `EADDRINUSE` crashes on reconnect). Exists purely to satisfy Render's port-binding health check; serves no real traffic.
2. **A self-ping loop** using `RENDER_EXTERNAL_URL` (auto-set by Render) to periodically hit its own health endpoint, using `https` or `http` correctly depending on the URL scheme.

---

## 5. The AI System — Multi-Provider Failover Chain

### 5.1 The current chain (`PROVIDER_DEFS` in the code)

Tried **strictly in this order, one at a time — never in parallel**:

| Order | Provider | Env var base | Endpoint | Model |
|---|---|---|---|---|
| 1 | Groq | `GROQ_API_KEY` | `https://api.groq.com/openai/v1` | `llama-3.3-70b-versatile` |
| 2 | Cerebras | `CEREBRAS_API_KEY` | `https://api.cerebras.ai/v1` | `llama-3.3-70b` |
| 3 | Google Gemini | `GEMINI_API_KEY` | `https://generativelanguage.googleapis.com/v1beta/openai` | `gemini-flash-latest`* |
| 4 | OpenRouter | `OPENROUTER_API_KEY` | `https://openrouter.ai/api/v1` | `meta-llama/llama-3.3-70b-instruct:free` |
| 5 | Mistral | `MISTRAL_API_KEY` | `https://api.mistral.ai/v1` | `mistral-small-latest` |

*\*Changed since v2 — was `gemini-2.5-flash`. **Confirmed bug, fixed:** `gemini-2.5-flash` started returning hard 404s ("no longer available") for many accounts well ahead of its official Oct 16 2026 retirement date. Google's Gemini retirement cadence has been aggressive (2.0 fully dead, 2.5 mid-retirement). Pinning to any specific version string means this breaks again at the next retirement. `gemini-flash-latest` is Google's own auto-updating alias, always pointing at whichever flash model is current-stable — specifically designed so integrations don't need a code change every time Google retires a version. Applied identically to the chat chain (here) and the vision provider list (Section 6.2). If Gemini ever fails outright again, this alias is the first thing to check, but it should absorb future churn automatically.*

All five: genuinely free-forever, no card, OpenAI-compatible `/chat/completions`, called via plain `fetch()` — no dedicated SDK for any of them (`groq-sdk` was removed from the codebase entirely).

**Deliberately excluded**, after checking actual terms rather than marketing copy: Together AI (its "free tier" is a one-time credit that expires — not free-forever), Cohere (non-OpenAI-schema API), Cloudflare Workers AI (needs an extra account-ID in the URL), Hugging Face (informally/inconsistently enforced free-tier limits — bad specifically for something meant to be a *reliable fallback*), DeepSeek (billed per token, not actually free).

### 5.2 Multi-key rotation — up to 10 per provider
Every provider supports **up to 10 rotating keys** via `PROVIDERNAME_API_KEY`, `_1` through `_10` (any combination; the plain unsuffixed name still works alone). `collectProviderKeys(baseEnvName)` handles this generically for every provider — search (Tavily), vision (Gemini/OpenRouter/Groq), and TTS (ElevenLabs) all reuse the exact same helper.

### 5.3 Per-provider cooldown — two tiers, not one
Originally, every single call started from the top of the chain regardless of whether that provider had just failed seconds earlier. Fixed: a provider that fails is put on cooldown and skipped in favor of the next one, cleared instantly on success. If *every* provider happens to be cooling down simultaneously, cooldowns are ignored and the whole chain is tried anyway rather than failing with zero attempts.

**Two different cooldown lengths, added since v2:**
- **60 seconds** (`PROVIDER_COOLDOWN_MS`) — the default, for transient failures (timeouts, rate limits, temporary outages) that are plausibly fixed on the next try.
- **30 minutes** (`PROVIDER_AUTH_FAILURE_COOLDOWN_MS`) — specifically for authentication failures (HTTP 401, or an error message matching `invalid.?api.?key|unauthorized`). **Confirmed rationale from production logs:** a genuinely bad/revoked API key isn't going to start working again in 60 seconds the way a timeout might. With only the standard cooldown, a permanently-invalid key got retried and re-failed on every request landing after its cooldown expired, forever, adding wasted latency each time. A key failing with an auth error now effectively sits out for 30 minutes, giving a human time to notice and fix `.env`, while every other error type keeps the original fast 60s retry.

### 5.4 Overall hard deadline (critical fix — bounds worst-case wait time)
Even with per-provider timeouts, trying all 5 providers sequentially could previously take up to ~100 seconds in a genuine worst case — which from the user's side looked exactly like "it typed for a while, then just stopped." Fixed: `callAIProvider()` enforces an **absolute 35-second deadline** across the *entire* call, independent of chain length or any individual provider's timeout setting. Once the deadline passes, remaining untried providers are skipped and the call fails cleanly.

### 5.5 Where AI is actually called
- **Vibe-check pass** (`evaluateMessageWithGroq` — name is a holdover, it actually walks the full chain, see Section 19.3) — runs only for unaddressed group messages as of v4 (Section 20.3); optionally produces an emoji reaction and/or a short ambient comment. Never deletes or warns.
- **Chat reply** (`generateAIChatReply`) — only when addressed; the real conversational response. Now includes explicit "task execution" instructions to stop the model from just announcing a task instead of doing it — see Section 18.15.
- **Summarize** (`summarizeQuotedText`) — only when replying to a message with "summarize"/"summarise"/"summary" as an actual word.
- **Movie Mode recap** (`maybeGenerateMovieRecap`) — once per group per day at most.
- **Daily Newspaper** (`maybeGenerateDailyNewspaper`) — once per group per day at most (Section 17.9).
- **Search-result synthesis** (`.search` command and auto-search) — feeds fresh web results into a chat-reply call.
- **Vision** (`analyzeImageWithGemini`) — separate function, separate provider list (Section 6.2).
- **Audio transcription** (`transcribeAudioWithGroq`) — separate function (Section 6.3).
- **Small "flavor" generations** — all genuinely AI-generated per explicit request that these NOT be canned/static: the confused-owner gag, the shut-up check-in/goodbye lines, unknown-command reactions, the natural-language-image-request "on it" acknowledgment, the Truth-or-Dare session-start acknowledgment, and the duplicate-spam nudge (Section 17.19) and unsupported-file decline line (Section 18.12).

---

## 6. Multimodal Capabilities (Search, Vision, Audio, Image Generation)

### 6.1 Web search — Tavily
`.search <query>` command, plus an **auto-trigger** inside normal chat replies (`shouldAutoSearch()`): fires on explicit search-intent phrasing ("search for", "latest", "current", "who is the current...") regardless of mood, and additionally for general knowledge-seeking phrasing ("what is", "explain", "history of") specifically when the active mood is `lecturer` or `professor` (both are meant to cite real sources). Deliberately **not** triggered on every addressed message — even with 10 rotating keys, the quota isn't infinite.

**Recency handling:** queries matching `NEWSY_QUERY_REGEX` ("today", "latest", "breaking", etc.) get `topic: "news"` + `time_range: "week"`; everything else gets `topic: "general"` + `time_range: "month"` — still recency-biased, just wider.

Search results are capped (500 chars/result × 4 results, plus a defensive 2500-char cap where injected into a prompt) before being handed to the LLM to summarize/ground its answer in.

### 6.2 Vision — image & sticker understanding
Triggered when the bot is addressed (or in a DM) and the incoming message — or the message being directly captioned — is an image or sticker. **Three providers tried in order**, all via the same `image_url` + base64 data-URI content-block format (standard OpenAI vision schema):

1. **Gemini** (`gemini-flash-latest`* — updated since v2, see Section 5.1's footnote for why) — original choice, smaller free vision-specific quota than its text quota (confirmed cause of "works once or twice then errors").
2. **OpenRouter** (`google/gemma-4-31b-it:free`) — verified genuinely free vision-capable model.
3. **Groq** (`meta-llama/llama-4-scout-17b-16e-instruct`) — reuses the *same* `GROQ_API_KEY` already configured for chat, no new env var. **⚠️ This specific Groq model carries an active deprecation notice from Groq (as of a document dated after June 17, 2026)** — kept as extra resilience today, but a future maintainer should check what Groq recommends as its vision replacement if this stops working.

**Fixed bugs specific to vision:** actual mimetype read from WhatsApp's own field instead of hardcoded; animated stickers detected and either converted to a static frame (if `sharp` is installed, Section 17.3) or declined gracefully; error logging captures and logs the real response body on failure, not just the HTTP status.

**Deliberately does NOT process every image/sticker in a group** — only when addressed (tagged, "Nayla" said, replying to the bot) or in a DM.

### 6.3 Audio transcription — Groq Whisper
Voice notes, when eligible (addressed or DM), are downloaded via Baileys' `downloadMediaMessage` straight into memory (never written to disk), then sent to `POST https://api.groq.com/openai/v1/audio/transcriptions` as `multipart/form-data` using Node's native `FormData`/`Blob` globals. Model: `whisper-large-v3-turbo`. Reuses the same Groq keys already configured for chat. The transcribed text is substituted directly for what the person "typed" and flows through the exact same pipeline as a normal text message from that point on.

### 6.4 Image generation — Pollinations.ai
`.imagine <prompt>` — plus natural language ("draw me a cat," Section 17.2). **No API key needed at all.** Constructs a URL and hands it to a validation step (`generateAndValidateImage()`) that fetches and checks the response itself (real content-type, non-trivial byte size, a hard `MAX_MEDIA_BYTES` cap) before handing the buffer to Baileys — this was a deliberate fix (a failed generation used to fail completely silently), traded off against the image now briefly passing through the bot's own RAM (a few hundred KB, released immediately after send) rather than never touching it at all.

### 6.5 "Hang tight" filler messages
Every multi-second-wait capability sends an immediate, randomized, italicized filler message (7 variants each — see `FILLER_MESSAGES`) the moment the task starts, before the real result arrives.

---

## 7. Reliability & Crash-Safety Architecture

Read this before adding any new external API call or any new long-running task.

### 7.1 The concurrency limiter (`runHeavyTask`)
Search, vision, audio, and image generation all go through a shared limiter: max **4 concurrent** heavy operations bot-wide, a bounded queue of **12** waiting beyond that. Once the queue itself is full, *new* requests fail fast instead of piling up forever. Normal chat replies deliberately do **NOT** go through this limiter — they have their own, separate timeout/deadline system (Section 5.4).

### 7.2 Timeouts — the actual root cause of the worst production incident
**Confirmed bug, now fixed:** `searchWeb`, `analyzeImageWithGemini`, and `transcribeAudioWithGroq` originally had **zero timeout** on their `fetch()` calls. If any single one hung, that `runHeavyTask` slot was held **forever**. With only 4 total slots, a couple of stuck requests could exhaust the entire system.

**The fix has two independent layers:** `fetchWithTimeout()` (real `AbortController`-based cancellation, used by every external call), plus a hard 25-second safety net inside `runHeavyTask` itself (`HEAVY_TASK_HARD_TIMEOUT_MS`) so *any future function* added to the heavy-task system can never hold a slot forever even if a developer forgets its own timeout.

**Rule for any future addition:** every new external network call must go through `fetchWithTimeout`, and every new long-running task must go through `runHeavyTask`.

### 7.3 The "zombie process" bug — the most important single fix in this project's history
**Confirmed root cause of "the bot appears alive but never actually sends anything."** The top-level crash handlers were catching *every* error, including fatal WhatsApp socket/encryption failures (`Unsupported state or unable to authenticate data`), and simply logging them before continuing — leaving the process technically alive, still passing Render's health check, while the actual WhatsApp connection underneath was dead.

**Fix:** `isFatalConnectionError(err)` detects this class of error (`"unsupported state"`, `"unable to authenticate data"`, `"bad mac"`) in both crash handlers, and when matched, deliberately calls `process.exit(1)` instead of swallowing it. Every *other* kind of error still gets the original "log and continue, never crash" treatment. **Note:** `"bad mac"` in this detector is exactly the failure class Section 7.11's periodic session sync is designed to prevent in the first place — the two fixes are complementary, not redundant: 7.11 reduces how often this happens, 7.3 makes sure the bot recovers cleanly on the rare occasion it still does.

### 7.4 `sock.sendMessage` itself had no timeout
Directly related to 7.3: `sock.sendMessage` calls inside `sendLikeAHuman` had no timeout of their own. Fixed via `sendMessageWithTimeout()` (15s).

### 7.5 The old moderation-queue's worker count
`MAX_CONCURRENT_AI_WORKERS` bumped from `1` to `3`, since the provider chain is now resilient with its own timeouts and doesn't need ultra-conservative single-threading.

### 7.6 Duplicate-message anti-spam was over-aggressive
Originally silenced *every* subsequent message during the 5-minute cooldown, even a completely different one. Fixed: a genuinely different message now ends the cooldown immediately. **Ordering relative to `.ignore`/`.mute` is now fixed too — see Section 20.1. One related edge case is still open: false positives on repeated media placeholders, Section 19.2.**

### 7.7 Error classification was over-broad
`describeAIError()` originally treated **any** HTTP 400 as "message too long," regardless of what the error actually said. Fixed: that message now only appears when the provider's actual error text mentions length/tokens.

### 7.8 Summary rule
**Don't infer a specific root cause from a generic signal** (a bare HTTP status code, a bare "it failed"). Read the actual response body/error text before presenting a confident explanation — either to the user or to yourself while debugging.

### 7.9 WhatsApp Web Protocol Version Drift (405 errors) — *new in v3*
`makeWASocket()` needs to declare which WhatsApp Web protocol version it's speaking. Left unspecified, Baileys falls back to whatever version was bundled with the package at install time — once that goes stale relative to what WhatsApp's servers actually require, every connection attempt gets rejected immediately with **405 Method Not Allowed**, even with perfectly valid saved credentials, no matter how current the credentials themselves are. **Fix:** `fetchLatestWaWebVersion({})` is called before every `makeWASocket()` invocation to fetch WhatsApp's current protocol version dynamically at boot, matching what `pair.js` already does. If a 405 shows up in the logs despite this, the troubleshooting message printed at that point points to `npm update @whiskeysockets/baileys` as the next step (Baileys itself may need updating, not just the version *number* fetched here — see Section 2.1).

### 7.10 Reconnection Backoff & Stability Confirmation — *new in v3*
The reconnect-attempt counter (`reconnectAttempts`) and its ceiling (`MAX_RECONNECT_ATTEMPTS = 8`) are hoisted to **module scope**, not local to `startBot()` — `startBot()` recurses on every reconnect, and a locally-scoped counter would reset to 0 on every single recursion, meaning every reconnect attempt used the identical backoff delay forever instead of actually escalating.

Backoff is exponential, `min(6000 × 2^attempts, 45000)` ms — attempt 1 waits 12s, attempt 2 waits 24s, attempt 3+ caps at 45s. After 8 consecutive failures, the bot gives up entirely (closes the Mongo connection, `process.exit(1)`) rather than hammering WhatsApp/Render forever — the assumption is a human needs to look at the logs at that point.

**The counter only resets after a connection proves itself stable**, not just on any successful open: a `stabilityTimer` is set for 30 seconds after `connection === "open"` fires; only if that timer completes without the connection closing again does `reconnectAttempts` reset to 0. A connection that opens and gets kicked seconds later (e.g. a 440 session-conflict) must **not** be able to reset the counter, or the 8-attempt safety net could never actually trigger and the bot would loop silently forever on a genuinely broken state. If a new `close` event fires while the stability timer is still pending, the timer is cleared and the failure count is preserved.

Specific status codes get targeted console troubleshooting hints: `401` → session revoked, clear the Mongo `sessions` collection and re-pair; `405` → see 7.9; `440` → another connection took over this exact session (check for a duplicate running instance or a duplicate linked device).

### 7.11 Session Staleness Between Restarts — the Periodic Full-Folder Sync ("Bad MAC" root fix) — *new in v3*
**🔑 Root fix for "Bad MAC" decryption errors, one of the most important fixes in this project.** The *only* thing that previously triggered a full session upload to MongoDB was the `creds.update` event — but that event fires only for the main identity blob. Baileys writes per-contact session/sender-key files directly to disk on **every message exchange**, completely independent of `creds.update`. That left MongoDB holding a **stale snapshot** of the Signal Protocol session state; restoring that stale snapshot after any restart desynced the double-ratchet from what senders actually used to encrypt — which is exactly what a Bad MAC error means.

**Fix:** a separate, module-scoped `setInterval` runs every **60 seconds**, independent of `creds.update`, and re-uploads the entire session auth folder (`./session_auth`) to MongoDB if it exists. This bounds the staleness window to at most 60 seconds instead of however long since the last `creds.update` (which, on a quiet bot, could be hours). This is a genuinely different, additional sync path — not a replacement for the `creds.update`-triggered one, which still exists and still fires immediately on credential changes.

### 7.12 Group-Config Persistence Retry & Periodic Reverification — *new in v3*
**Confirmed report addressed:** "a muted/ignored group reverts after a restart." `persistGroupConfig()` previously made exactly one write attempt and silently swallowed any failure (console-logged only) — a transient Mongo hiccup during `.mute`/`.ignore` meant the command told the user "done!" while the actual write never landed, and a restart before the next unrelated write re-persisted it would revert the setting.

**Fix, two layers:**
1. `persistGroupConfig()` now retries up to 2 additional times with a short backoff (`500ms × attempt`) and returns whether it ultimately succeeded. `.mute` and `.ignore` specifically (the safety/annoyance-critical commands) now append an honest warning to their confirmation message if persistence couldn't be confirmed after retries ("Heads up: I couldn't confirm this saved to the database after a few tries…") instead of always claiming unconditional success.
2. `reverifyMuteAndIgnorePersistence()` runs on the existing 10-minute scheduler tick, scanning every cached group config and re-persisting any group that currently has `muted: true` or a non-empty `ignoredUsers` list. In practice this is a cheap no-op scan for most groups (which have neither set) — it exists as a defense-in-depth safety net specifically for these two settings, on top of the retry logic above.

### 7.13 Raid Protection (Mass-Join Detection) & Group-Membership Cleanup — *new in v3, previously completely undocumented*
**This entire feature was absent from v2 of this document despite being fully implemented.** `sock.ev.on("group-participants.update", ...)` handles two things:

**Raid protection (`action === "add"`):** joins are tracked per-group in a rolling window; a single WhatsApp event can carry a whole `participants[]` array (a batch add), so joins are weighted by array length, not counted as 1 per event. If **5 or more joins land within 60 seconds** (`RAID_JOIN_THRESHOLD` / `RAID_WINDOW_MS`), `checkRaidProtection()` fires: if the bot is a group admin, it calls `groupSettingUpdate(jid, "announcement")` (WhatsApp's native admin-only-messaging mode) and persists `cfg.locked = true`, then announces the lockdown with instructions to `.unlock`. If the bot is *not* an admin, it only warns the group — it cannot lock anything without admin rights. The join-tracking window resets immediately on trigger so it can't re-fire repeatedly off the same join burst.

**Membership cleanup (`action === "remove"`):** checks whether the bot itself was the one removed (`isSelfJid`); if so, it proactively clears every in-memory Map keyed by that group's JID (`groupMessageBuffers`, `groupConfigCache`, `adminCache`, `recentRudenessFlag`, `lastReactionTime`, `lastAmbientTime`, `lastEasterEggTime`, `lastAIReplyTime`) rather than letting stale entries for a group the bot no longer has access to sit in memory indefinitely.

**Admin-cache invalidation:** on *any* participant change (add, remove, promote, demote), `adminCache.delete(event.id)` runs unconditionally — the bot's own admin status in that group may have just changed, and the normal 10-minute cache TTL would otherwise leave it stale.

A separate, much simpler listener, `sock.ev.on("groups.update", ...)`, just logs group renames (`update.subject`) — no side effects, since groups are keyed by JID everywhere, not by name.

### 7.14 Command Responses Now Feed Conversational Memory — *new in v3*
**Confirmed bug, fixed:** a natural follow-up like "what does this status mean" asked right after `.stats` had nothing to work with, because **neither** the `.stats` command invocation **nor** its response text ever reached `groupMessageBuffers` — `handleCommand()` returns `true` and the main pipeline `continue`s before the normal buffering call is ever reached.

**Fix:** `createResponseCapturingSock(sock, onTextSent)` wraps `sock` in a transparent `Proxy` for the duration of a single `handleCommand()` call. It intercepts only `sendMessage`, extracts whatever `text`/`caption` was actually sent, and forwards it to a callback — every other property/method on `sock` passes through completely untouched. This avoids manually adding a buffering call to all 25+ individual command branches by hand (and avoids them silently drifting out of sync as new commands get added). The main message loop now does:
```
const commandSentTexts = [];
const commandCapturingSock = createResponseCapturingSock(sock, (t) => commandSentTexts.push(t));
const wasCommand = await handleCommand(commandCapturingSock, ...);
if (wasCommand) {
  await bufferGroupMessage(jid, sender, text);                                  // the command itself
  for (const t of commandSentTexts) await bufferGroupMessage(jid, BOT_CONFIG.name, t); // its reply
  continue;
}
```
Buffering happens **only** inside this `wasCommand` branch, never unconditionally up front — this was a deliberate choice to avoid double-buffering against the pre-existing later buffer call that non-command messages already go through (and which correctly runs *after* audio transcription replaces `text`, something commands never need since they're always plain text).

---

## 8. Dependencies

```
@whiskeysockets/baileys   — WhatsApp multi-device Web API client (keep reasonably current — Section 2.1, 7.9)
mongoose                  — MongoDB object modeling
pino                      — logger (passed to Baileys internally)
dotenv                    — loads .env in local/dev use
fs, path, http, https, child_process — Node built-ins
FormData, Blob, fetch, AbortController — Node 18+ built-in globals, used directly, no extra packages
sharp                     — OPTIONAL. Powers animated-sticker frame extraction (Section 6.2) and .sticker
                             image→webp conversion (Section 17.6). Loaded lazily via a try/catch (getSharp())
                             — degrades gracefully if never installed. Run `npm install sharp` to enable.
ffmpeg-static              — OPTIONAL, new in v3. Bundles a prebuilt ffmpeg binary as a plain npm dependency
                             (same mechanism as sharp bundling libvips — no system-level install needed).
                             Powers real OGG/Opus transcoding for .tts voice notes — see Section 18.10.
                             Loaded lazily (getFfmpegPath()); degrades gracefully to a regular (non-voice-
                             note-styled but fully playable) audio attachment if not installed. Run
                             `npm install ffmpeg-static` to enable proper voice-note bubbles.
```
`groq-sdk` is no longer imported anywhere in `index.js` — safe to remove from `package.json`, harmless to leave.

---

## 9. Complete Environment Variable Reference

```env
# --- Required for persistent sessions & stored memory ---
MONGODB_URI=mongodb+srv://user:pass@cluster.mongodb.net/dbname?retryWrites=true&w=majority

# --- Chat AI providers (at least ONE recommended; all optional individually) ---
# Every provider below supports up to 10 rotating keys: PLAIN, then _1 through _10, any combination.
GROQ_API_KEY=gsk_...
GROQ_API_KEY_1=            # ... through GROQ_API_KEY_10, all optional
CEREBRAS_API_KEY=
CEREBRAS_API_KEY_1=        # ... through CEREBRAS_API_KEY_10
GEMINI_API_KEY=            # from aistudio.google.com — also reused for vision
GEMINI_API_KEY_1=          # ... through GEMINI_API_KEY_10
OPENROUTER_API_KEY=        # from openrouter.ai — also reused for vision fallback
OPENROUTER_API_KEY_1=      # ... through OPENROUTER_API_KEY_10
MISTRAL_API_KEY=
MISTRAL_API_KEY_1=         # ... through MISTRAL_API_KEY_10

# --- Web search ---
TAVILY_API_KEY=            # from tavily.com — permanent free tier, 1000 searches/month
TAVILY_API_KEY_1=          # ... through TAVILY_API_KEY_10

# --- Vision & audio: no new keys needed ---
# Vision reuses GEMINI_API_KEY*, OPENROUTER_API_KEY*, and GROQ_API_KEY* (in that order).
# Audio transcription reuses GROQ_API_KEY*.
# Image generation (Pollinations.ai) needs no key at all.

# --- Text-to-speech (.tts / "reply in a voice note") ---
# OPTIONAL. ElevenLabs has a real, documented free tier (~10k chars/month,
# no card) and is tried first while quota lasts. StreamElements (no key
# needed) is always available as a zero-config fallback, so .tts works even
# with ZERO ElevenLabs keys configured. See Section 18.9 for why the TTS
# provider landscape doesn't have as clean a "free forever" option as the
# text/vision/audio chain.
ELEVENLABS_API_KEY=        # from elevenlabs.io — optional
ELEVENLABS_API_KEY_1=      # ... through ELEVENLABS_API_KEY_10
ELEVENLABS_VOICE_ID=       # OPTIONAL PIN ONLY — changed since v2, see below.

# --- Daily Newspaper scheduling ---
NEWSPAPER_HOUR=20          # optional, 0-23, defaults to 20 (8 PM). This is SERVER-LOCAL time —
                            # Render defaults to UTC unless you also set TZ (e.g. TZ=Africa/Lagos)
                            # in Render's environment settings to shift server-local time to yours.

# --- Render infrastructure (Render sets RENDER_EXTERNAL_URL automatically) ---
PORT=10000
RENDER_EXTERNAL_URL=       # auto-set by Render, do not set manually
NODE_ENV=production
```

**⚠️ `ELEVENLABS_VOICE_ID` behavior changed since v2 — the old default value is now wrong.** v2 stated this defaults to `"21m00Tcm4TlvDq8ikWAM"` ("Rachel"). **That is no longer true and would actively break TTS if hardcoded again.** Confirmed in production: a free ElevenLabs account can only use voices it **owns** (custom-cloned or voice-designed in its own dashboard) via the API — never a shared "library"/premade voice like Rachel, even though library voices are freely usable in ElevenLabs' own web app. Hardcoding a library voice ID reliably fails with `402 payment_required` on a free plan. See Section 18.9 for the full fix — in short, if this env var is unset, the bot now resolves the account's own first available voice dynamically at runtime instead of assuming one exists.

If `MONGODB_URI` is missing: no persistent session, no stats/mood/facts/archive/activity/newspaper-date persistence — bot still runs.
If every chat-AI key is missing: bot still runs on local regex/canned-response logic only.
If `TAVILY_API_KEY` is missing: `.search` and auto-search gracefully say so; nothing else is affected.
If vision/audio keys are all missing: the bot honestly says it can't do that yet, rather than erroring.
If `ELEVENLABS_API_KEY` is missing: `.tts` still works via the free StreamElements fallback alone; if that also fails, it falls back to a plain text reply rather than nothing.

---

## 10. The Complete Message Pipeline (Step by Step, Current State)

Every incoming message goes through `sock.ev.on("messages.upsert", ...)`, `for (const msg of m.messages)`. **This ordering was re-verified against the current code for v4.** Steps 4–7 were reordered in v4 (see the note on step 4); nothing else in the sequence changed since v3.

1. **`m.type !== "notify"` → skip the whole batch.** Filters out offline/history-sync replays.
2. **Text extraction & unwrapping** (`extractTextFromMessage`) — recursively strips `ephemeralMessage`/`viewOnceMessage`/`deviceSentMessage` wrappers (see Section 13.1 and, for the `deviceSentMessage` addition specifically, **Section 20.6**). Media captions are read as real text; bare media gets an honest placeholder (`[image, no caption]`, `[sticker]`, etc.).
3. **Rate limiting** (`isRateLimited`) — 4 messages/8 seconds per sender, silent drop beyond that.
4. **Permanent per-user ignore check** (`.ignore`) — checked **before** command routing, using LID-aware JID matching (`isJidInList`).
5. **Temporary per-user ignore check** (from the shut-up two-strike system, Section 10.1) — same early position, same reasoning.
6. **Permanent group mute check** (`.mute`) — checked before command routing; while muted, **the only thing that still works is `.unmute` itself**, exact-matched.
7. **Duplicate-spam check** (`checkDuplicateSpam`, DM **and** group) — same message 3x in a row → 5-minute silence *toward that sender*, released early if they send something different. **✅ FIXED in v4 (Section 20.1):** this used to run *before* steps 4–6, meaning its nudge could reach someone who was supposed to be fully silenced — moved to run after all three silence checks instead, so mute/ignore are now genuinely airtight, no exceptions. (v3 listed this as open bug 19.1; it's resolved — see Section 20.1.)
8. **Gamification bookkeeping** — `messagesReceived++`, `bumpDailyStats()`, `bumpActivityHour()`. Runs **before** command routing (fixed since v2, unchanged in v4), so `.settings`/`.activity` count typed-command traffic too. `bumpUserStats` (XP) is deliberately **not** moved — it stays scoped to genuine non-command chat only, further down the pipeline, so rapid-firing commands can't be used to farm XP.
9. **Command router** (`handleCommand`, via `createResponseCapturingSock` — Section 7.14) — see Section 11 for the full list. A recognized command's own response text is captured and fed into `bufferGroupMessage` right alongside the command itself. `.kick`/`.promote`/`.demote` now carry the same self-target guard `.ignore` already had — **✅ FIXED in v4, Section 20.2** (v3 listed this as open bug 19.2).
10. **Unrecognized dot-command fallback** — AI-generated in-character reaction (`generateUnknownCommandReply`), not a canned array.
11. **Addressing computed** (`isBotAddressed`) — @mention, saying "Nayla", or replying to one of the bot's own messages, checked across **every** media type's `contextInfo` (Section 13.1). This check, and every quoted-content lookup below it, now correctly unwraps a reply to one of the **bot's own** prior messages — see Section 20.6, the single most impactful fix in v4.
12. **Audio transcription**, if eligible (addressed or DM) — replaces `text` with the transcription before anything downstream runs.
13. **Direct document/video decline**, if eligible — an honest, AI-generated decline for a document/video sent *directly* (not quoted), mirroring the quoted-media case (Section 18.12).
14. **Bare-media skip** — unaddressed, uncaptioned media in a group is skipped entirely (no AI cost, no buffering).
15. **Context buffering** (`bufferGroupMessage`) — identical for DMs and groups; 50-message cap, archived to `ConversationArchive` (30-day TTL) and reset on overflow. Bare video/document placeholders are excluded from the buffer entirely (Section 18.13).
16. **Hard length guard** (`MAX_AI_INPUT_CHARS = 4000`) before any AI call — applied uniformly across the vibe-check pass, the combined-media analyzer, and the normal reply path (Section 18.14). A separate, smaller cap (`MAX_QUOTED_CONTEXT_CHARS = 1200`) applies to quoted-reply context specifically.
17. **Local toxicity flag** — sets a 10-minute "recently rude" mood modifier, independent of any AI call.
18. **Vibe-check pass** — optional comment/reaction only, cooldown-gated, never enforcement (Section 12.6). **✅ FIXED in v4 (Section 20.3):** now only runs for unaddressed group messages (`isGroup && !addressed`) — its result was previously discarded for every DM and every addressed group message, burning a wasted AI-provider call each time. (v3 listed this as open bug 19.3; it's resolved.)
19. **Shut-up detection** (highest priority once addressed) — two-strike system, Section 10.1.
20. **Vision routing**, if the message is a direct image/sticker and eligible — animated stickers converted to a static frame (if `sharp` is available) or declined gracefully first.
21. **Owner-forget gag** — 10% roll on a genuine ownership question.
22. **Quoted-content gathering** (`gatherQuotedContext`, for any reply that carries text, an image/sticker, audio, a link, or a phone number) — feeds *both* the quoted content and the person's own new message into one AI call (this was always the design; it was blocked from working correctly until Section 20.6's fix). No longer leaks the internal bare-media placeholder (`"[image, no caption]"`, `"[sticker]"`, etc.) into the model's context as if it were real caption text, and a failed media *download* (as opposed to a failed vision analysis) now honestly says so instead of going silent — see Section 20.4. If quote-detection ever still comes up empty on a genuine reply, it now logs the raw structure instead of failing silently — Section 20.7.
23. **Summarize or normal reply** — search auto-injected first if `shouldAutoSearch()` matches; emoji-ratio policy applied to the final text (see Section 19.1, still open, for a subtle bug in this step); sent via `sendLikeAHuman` (typing indicator, rare typo/self-correct, all timeout-protected per Section 7.4). `.eli5` specifically no longer drifts to an unrelated generic explanation when the quoted content is terse or technical — Section 20.5.
24. **Not addressed, not in cooldown** → rare Group Soul reaction/comment (from step 18's already-run call) and a very rare easter egg.

### 10.1 The two-strike "shut up" system
First "shut up"/"leave me alone"/etc. from someone → genuinely AI-generated apology **and check-in** (asks what's wrong, does not go quiet yet). If the **same person** persists within 10 minutes → AI-generated goodbye, and that person specifically is silenced for 5 minutes via the temporary-ignore mechanism — everyone else keeps getting normal replies.

---

## 11. Every Command, Current State

| Command | Who | What it does |
|---|---|---|
| `.rank` / `.level` | Everyone | XP and title |
| `.stats` | Everyone | Bot-wide health snapshot |
| `.health` (or `.info` / `.bot`) | Everyone | Full diagnostics: AI provider chain, MongoDB connection *and storage used*, circuit breaker, RAM, heavy-task queue depth, search/vision/audio/TTS availability |
| `.settings` | Everyone (group only) | This group's status: mute state, mood, lock state, ignored-user count, session message/response counters |
| `.activity` | Everyone (group only) | 7-day ASCII activity heatmap by hour |
| `.mood` | Everyone (view) / group admin (change) | Bare = shows current; `.mood <name>` changes it |
| `.help` / `.menu` | Everyone | Full command list |
| `.about` | Everyone | What the bot is, in-character |
| `.owner` | Everyone | Creator (Jackie) |
| `.search <query>` | Everyone | Web search via Tavily, answer synthesized by AI |
| `.imagine <prompt>` | Everyone | Image generation via Pollinations.ai — also triggers on natural language ("draw me a cat") |
| `.sticker` (reply to image/sticker) | Everyone | Converts the replied-to image into a proper WhatsApp sticker via `sharp` |
| `.tts <question>` (optionally replying to image/vn/link/anything) | Everyone | Answers as a spoken voice note — now real OGG/Opus if `ffmpeg-static` is installed (Section 18.10) |
| `.truth` / `.dare` | Everyone | Fresh, AI-generated, randomly-difficulty-rolled truth/dare — also triggers on "let's play truth or dare" |
| `.quote` | Everyone | AI-generated deep/inspiring quote, real attribution only if genuinely confident |
| `.eli5 <topic>` | Everyone | Explains any topic like you're 5, with auto-search for current-events topics |
| `.ping` / `.flip` / `.roll [sides]` / `.8ball` | Everyone | Zero-AI-cost fun commands |
| `.lock` / `.unlock` | Group admin | WhatsApp's native admin-only-messaging toggle |
| `.moviemode on/off` | Group admin | Toggles the daily Movie Mode recap for this group |
| `.newsletter on/off` | Group admin | Toggles the Daily Newspaper for this group |
| `.kick` / `.promote` / `.demote` | Group admin (bot must be group admin) | Reply **or** @mention both work. Now carries the same self-target guard `.ignore` has — replying to the bot's own message with no other target is refused gracefully instead of acting on the bot itself (fixed in v4, Section 20.2). |
| `.tagall` / `.everyone` | Group admin **AND** bot must be group admin | Mentions everyone with real, visible, tappable tags |
| `.del` / `.delete` | Group admin (bot must be group admin) | Deletes the replied-to message — the **only** deletion capability anywhere in the bot |
| `.mute` / `.unmute` | Group admin | Whole-group silence; only `.unmute` works while muted. Now retries persistence and periodically reverifies it (Section 7.12) |
| `.ignore` (reply or @mention) | Group admin | Silences one person in this group entirely, including their own commands; refuses with a joke if you try to target the bot itself |
| `.ignorelist` | Group admin | Shows who's ignored |
| `.undoignore` (@user or `all`) | Group admin | Un-ignores |

**Not a command — automatic:** **Raid protection** (Section 7.13) runs continuously in the background against `group-participants.update` events; there's no command to trigger it manually, only `.unlock` to release a lockdown it (or `.lock`) put in place.

**Available moods:** `cool` (default, warm and humble), `gen_z`, `strict_mod`, `playful`, `sarcastic`, `flirty` (tasteful, reads the room), `motivational`, `empathic`, `inquisitive`, `chill`, `therapist`, `professor`, `lecturer`, `grandma`. Stored **per-group** in `GroupConfig.mood`; DMs use a global fallback.

---

## 12. Chronological History — v1 → v2

*(Preserved from v2 verbatim; picks up from the project's origin and the moderation-removal pivot. See Section 17 for the next batch of history, and Section 18 for the batch found in this v3 audit.)*

### 12.1 Multi-provider expansion & reliability
Expanded from 3 to 5 chat providers (added Gemini, OpenRouter), then extended key rotation from 3 to 10 per provider. Added the per-provider cooldown (Section 5.3) and the overall 35-second hard deadline (Section 5.4).

### 12.2 The `.kick`/`.promote`/`.demote` mention bug
Confirmed real: these commands used an *exact* string match (`cmd === ".kick"`), so `.kick @someone` silently fell through to normal chat instead of running the command. Fixed to match with trailing arguments too.

### 12.3 DM conversation memory
Confirmed real: `bufferGroupMessage`/`getRecentContext` were only ever wired up for groups, so every DM was context-free. Fixed: DMs now share the identical buffering system groups use; Movie Mode explicitly excludes non-group JIDs.

### 12.4 `.mute` and `.ignore` — built, then two real bugs fixed
Built `.mute`/`.unmute` and `.ignore`/`.ignorelist`/`.undoignore`. Two confirmed bugs found afterward: `.mute` didn't actually block commands (check ran after routing — fixed), and the bot could "ignore itself" via a reply-resolved target (now explicitly checked and refused with a joke). `.ignorelist` was also missing its admin gate — added.

### 12.5 The owner-forget gag, two-strike shut-up, emoji ratio, tone reinforcement
Built the 10%-chance owner-forget gag, the two-strike shut-up system, code-level emoji-ratio enforcement, and substantially expanded `BASELINE_TONE_RULES` after confirmed reports of the bot landing as mean rather than funny.

### 12.6 The moderation-removal pivot (still the most important standing decision)
The bot used to have full AI-driven `approve`/`warn`/`delete` moderation, removed permanently after a sustained pattern of false positives. **The only deletion capability anywhere in this bot is the manual, admin-invoked `.del` command.** Do not reintroduce automated moderation without revisiting this decision explicitly.

### 12.7 Multimodal capability build-out
Added web search, image generation, vision, and audio transcription in one large session (Section 6).

### 12.8 The privacy leak — facts leaking between a DM and unrelated groups
**Confirmed serious bug, fixed.** Per-user facts were keyed only by person, globally — something discussed in a DM could surface in an unrelated group. Fixed via `UserChatFacts`, keyed by person + specific chat. **This is a privacy-sensitive area — any future "memory" feature must be scoped per-chat by default.**

### 12.9 The media-reply detection bug
**Confirmed real, systemic bug affecting five separate functions.** A reply's `contextInfo` lives inside whichever message type the reply itself is, not always `extendedTextMessage`. Fixed with a shared `getContextInfo(content)` helper (Section 13.1).

### 12.10 The reliability incident — timeouts, the zombie process, everything in Section 7
The single most significant debugging arc in this project's history (as of v2) — see Section 7 in full.

### 12.11 Link commentary tone, and the "AI echoes its own example" bug
A literal example phrase in a system prompt was being reproduced verbatim. Fixed by describing tone in words instead of providing a copyable line (Section 13.3).

### 12.12 Error classification precision
Covered in Section 7.7.

### 12.13 Baileys version bump
Covered in Section 2.1.

---

## 13. Known Recurring Bug Patterns — Read This Before Touching Identity, Media, or Prompt Code

The **same category of bug reappeared multiple times** across this project's history. Check against this list before shipping any change in these areas.

### 13.1 Never use `Object.keys(content)[0]` (or any "assume the first key is the real one") to detect a WhatsApp message's type
Caused a real bug twice. **Always check each known message-type field explicitly.** `unwrapMessageContent()` and `getContextInfo()` are the canonical implementations — extend them, don't replace their approach.

### 13.2 WhatsApp identity is not one format — always check both classic and `@lid` JIDs
The **single most recurring bug class in this entire project** — bit mention detection, bot admin-status detection, reply-to-bot detection, sender admin-status detection, and `.ignore` matching independently. `isSelfJid()` and `isJidInList()` are the canonical implementations.

### 13.3 Never put a literal, copyable example phrase in an AI system prompt
When a prompt needs to convey tone or style, describe the tone in words rather than providing a concrete line the model can just copy.

### 13.4 Dot-commands that accept an argument must not use exact string equality
`cmd === ".kick"` only matches when there's nothing else in the message. Any command that can take a trailing argument must match with `cmd === base || cmd.startsWith(base + " ")`.

### 13.5 Reply-based target resolution can accidentally resolve to the bot itself
Confirmed bug in `.ignore`, fixed there via an explicit `isSelfJid()` check. **Audit note (v3, resolved in v4):** a v3 audit found this exact pattern UNFIXED in `.kick`/`.promote`/`.demote` (tracked as bug 19.2) — the principle stated here had been correctly identified but not applied to every command sharing the vulnerable `resolveCommandTarget()` pattern. **Fixed in v4** (Section 20.2): the same `isSelfJid()` guard now sits on all four commands that use `resolveCommandTarget()`. Keep treating this section as "the fix belongs on every command using `resolveCommandTarget()`," not just whichever one it was fixed on first — that's exactly the mistake this note now documents having actually happened once already.

### 13.6 Every external network call needs an explicit timeout — no exceptions, including ones that feel "quick"
Covered fully in Section 7.2.

### 13.7 Don't infer a specific root cause from a generic signal (like a bare HTTP status code)
Covered in Section 7.7/7.8.

### 13.8 Crash handlers that swallow *everything* can hide the worst bugs, not prevent them
Covered fully in Section 7.3.

### 13.9 A shared, global-flagged regex object used with `.test()` across multiple calls carries state between them — *new in v3*
`String.prototype.test()` on a regex with the `g` flag reads and mutates that regex object's `lastIndex` property; the next `.test()` call on the *same object* resumes searching from wherever the last one left off, not from the start of the new string. `.match()` and `.replace()` on a global regex are **not** affected the same way (both reset to index 0 internally per spec) — only shared `.test()`/`.exec()` calls are at risk. **Confirmed instance: `EMOJI_REGEX`, see Section 19.1 (still open as of v4).** Rule going forward: if a regex needs the `g` flag for one use (`.match()`/`.replace()`), don't also reuse that same object for a `.test()` boolean check elsewhere — construct a separate non-global version for that.

### 13.10 `unwrapMessageContent`'s wrapper-type list needs to know about every WhatsApp envelope, not just the ones already found — *new in v4*
Section 13.1 already established "check every known message-type field explicitly, never infer from key order" for *content* type detection. The same discipline applies one level up, to *wrapper/envelope* detection: `unwrapMessageContent()` only unwraps the specific envelope types listed in its `wrapperTypes` array (`ephemeralMessage`, `viewOnceMessage`, `viewOnceMessageV2`, `viewOnceMessageV2Extension`, and — as of v4 — `deviceSentMessage`). **Confirmed real gap, found via live user testing, not static review:** `deviceSentMessage` was missing entirely, and it's not an obscure edge case for this bot specifically — it's the envelope WhatsApp uses for a message sent from a companion/linked device (exactly what this bot's own session is) whenever that message is referenced elsewhere, e.g. quoted in a reply. That made it silently impossible to understand a reply to almost anything the bot itself had said — see **Section 20.6** for the full incident. **Rule going forward:** if a future WhatsApp/Baileys update introduces another envelope type (this has already happened multiple times across this protocol's history), the fix is always the same one-line addition to `wrapperTypes` — resist the urge to patch around it at individual call sites, since every quoted-content function in this file already funnels through this one shared helper specifically so a single fix here propagates everywhere at once.

### 13.11 Evaluate a pasted third-party AI diagnosis against the actual protocol/schema before applying it — don't follow it just because it sounds confident — *new in v4*
This has come up multiple times across this project's history (Section 12.9, Section 17.9, Section 15's rejected auto-fetch proposal) but is worth stating as its own explicit rule after the clearest example yet: during the same live-testing round that found Section 13.10's real bug, a separately-pasted third-party AI diagnosis proposed a *different* fix — checking `content.conversation?.contextInfo` — for what looked like the same symptom. That fix does nothing. `conversation` is a plain string field in WhatsApp's message schema (literally just the message text), not a nested message object, so it cannot structurally carry a `.contextInfo` property — and a reply never arrives as a bare `conversation` in the first place, since WhatsApp always promotes any message that needs to carry `contextInfo` (which every reply does) to `extendedTextMessage`. The diagnosis was fluent, used correct-sounding terminology, and correctly identified the *symptom pattern* (quote-detection failing) — it was simply wrong about the mechanism, in a way that would have looked like a real fix in a code review without protocol-level knowledge to check it against. **Rule going forward:** a plausible-sounding diagnosis is not evidence on its own — trace the claim against the actual protobuf/schema shape (or, if genuinely uncertain, add diagnostic logging and get real data — see Section 20.7) before treating it as the fix. Full incident write-up: Section 20.8.

---

## 14. Design Philosophy & Precautions

- **512MB is not the only storage constraint — MongoDB's free M0 tier (~512MB) is a separate limit.** `.health` reports actual MongoDB storage used.
- **Every "memory" feature must default to being scoped as narrowly as the person would expect** (Section 12.8).
- **Timeouts and hard deadlines are load-bearing, not optional robustness theater** (Section 7.2).
- **A handful of specific fatal errors are legitimate exceptions to "never crash"** (Section 7.3).
- **Session/connection staleness is a distinct failure class from message-handling bugs** (new in v3, Section 7.9–7.11) — a bot can be functioning perfectly at the application layer and still be silently disconnected or corrupting its own encryption state underneath. Don't assume "the logs look fine" means "the connection is fine."
- **A retry-and-warn-honestly pattern beats a single silent attempt** for anything safety/annoyance-critical (Section 7.12) — `.mute`/`.ignore` now tell the truth about whether they actually saved, rather than always claiming success.

---

## 15. What Was Explicitly NOT Built (Scope Decisions, Not Oversights)

- **PDF/document analysis** — needs a fundamentally different architecture and real disk-lifecycle risk; deliberately deferred. The bot *does* now honestly decline when someone sends or replies to a document/video and asks about it, both directly and quoted (Section 18.12) — that's a UX fix for the declined case, not a reversal of this scope decision.
- **Arbitrary link/URL content analysis (server-side fetching of a user-supplied URL's actual page content)** — real SSRF/memory-exhaustion surface, still not built. Domain-only extraction (Section 17.1) remains the sanctioned way this bot reasons about links. A later request to auto-fetch every posted link was explicitly declined for this exact reason (Section 17.16).
- **Video understanding** — explicitly excluded by request.
- **A giant hardcoded command menu** — `.help` only ever lists what's genuinely implemented.
- **"Fake Awards" and other pure-novelty features** — explicitly requested to be skipped.
- **A separate contextual-emotion-memory database** — judged already covered by the existing per-chat-scoped facts system.
- **Together AI, Cohere, Cloudflare Workers AI, Hugging Face, DeepSeek** as AI providers — each excluded for specific, documented reasons (Section 5.1).
- **A full-day-transcript Mongo collection for the Daily Newspaper** — rejected in favor of a lighter design (Section 17.9).
- **A separate `.bot`/`.info` command with its own parallel implementation** — aliased to `.health` instead (Section 17.13).
- ~~**Local ffmpeg-based audio transcoding for TTS**~~ — **⚠️ This bullet was accurate in v2 and is no longer true — corrected in v3.** This *was* built, as an optional dependency (`ffmpeg-static`), using the exact same lazy-load/graceful-degrade pattern already established for `sharp`. See Section 18.10 for the full story of why the earlier "not justified" reasoning was revisited, and Section 8 for the dependency entry. The underlying honest limitation this bullet described (WhatsApp voice notes need real OGG/Opus, which a plain mp3+`ptt:true` doesn't reliably provide) is *why* it ended up getting built after all — it wasn't a nice-to-have, it was a confirmed-broken user-facing bug (Section 18.10).

---

## 16. Quick-Start: Picking This Project Up Cold

1. **Read `index.js` top-to-bottom once.** Single file, no hidden modules, heavily commented at every non-obvious decision.
2. **Read Section 13 before changing anything related to message-type detection, WhatsApp identity comparison, AI prompts, or dot-commands with arguments.**
3. **Read Section 19 before starting new work in any area it touches.** These are confirmed, real bugs, still unfixed as of v4 — check whether your task overlaps with any of them before you start, so you don't build on top of a bug or accidentally mask it. **Read Section 20 too** — three previously-open bugs are now fixed there, plus the most impactful fix in the project's history (Section 20.6).
4. **Confirm `.env`** matches Section 9 — the MongoDB variable is `MONGODB_URI`, and note the `ELEVENLABS_VOICE_ID` behavior change.
5. **`.health` in any chat** gives an instant picture of what's configured and working.
6. **Never reintroduce automated deletion/warnings.** Revisit Section 12.6 first if asked to.
7. **Any new identity-comparison code must be LID-aware** (Section 13.2) — use `isSelfJid()`/`isJidInList()`.
8. **Any new "is this a reply" check must use `getContextInfo()`** (Section 13.1), and remember `unwrapMessageContent()` now also handles `deviceSentMessage` — don't reintroduce a raw, un-unwrapped read of quoted content anywhere (Section 20.6).
9. **Any new AI call must go through `callAIProvider()`** or explicitly add itself to the vision/audio/TTS provider lists, and must have its own timeout via `fetchWithTimeout` if it's a raw `fetch()` outside those systems.
10. **Any new long-running task must go through `runHeavyTask()`.**
11. **Any new prompt must include `BASELINE_TONE_RULES`**, and must never contain a literal example phrase the model could just copy (Section 13.3).
12. **Any new "memory" feature defaults to per-chat scope** (Section 12.8).
13. **Keep an eye on the Baileys version and the WhatsApp Web protocol version fetch over time** (Sections 2.1, 7.9) — genuinely recurring maintenance.
14. **Any new command that resolves a target from a reply must check `isSelfJid()`** (Section 13.5) — `.kick`/`.promote`/`.demote` now do too (Section 20.2); keep applying this to anything new built on `resolveCommandTarget()`.
15. **Read Section 17 before touching truth/dare, the Daily Newspaper, TTS, or the combined image+link reply analyzer**, **Section 18 before touching connection/reconnect logic, session sync, group-config persistence, or raid protection**, and **Section 20 before touching quoted-content extraction, `.eli5`, mute/ignore ordering, or the vibe-check pass.**
16. **Before applying a pasted third-party AI diagnosis, verify it against the actual WhatsApp/Baileys schema first** (Section 13.11) — one was wrong in a way that sounded confident and used correct-sounding jargon; the real bug was somewhere else entirely (Section 20.6/20.8).

---


## 17. Major Feature Expansion — Multimodal Analysis, Games, Newspaper, TTS, and a Real Bug Sweep

*(Preserved from v2. Continues chronologically from Section 12; Section 18 continues from here.)*

### 17.1 Combined reply analysis — image + write-up + links + phone numbers, one answer
`analyzeQuotedMediaAndText()` downloads the quoted image/sticker, runs vision on it, extracts any link **domains** from the quoted text (`extractDomains()` — pure string parsing, never fetches the URL itself), flags but never repeats back an apparent phone number, optionally web-searches the domain + surrounding text for grounding, and feeds all of it into ONE `generateAIChatReply()` call. **Trigger scope:** addressed + replying to an image/sticker + (`ANALYZE_INTENT_REGEX` matches, or the remaining text after stripping "Nayla" is ≤12 characters).

### 17.2 Natural-language image generation
`isImageGenerationIntent(text)` detects the request before it reaches the chat-reply prompt. Two verb tiers: STRONG (`draw`/`sketch`/`paint`/`illustrate`) fire on the verb + a direct object alone; WEAK/generic (`generate`/`create`/`make`/`design`/`render`) require an explicit image-noun nearby. An idiom-exclusion list stops "draw the line," "draw a crowd," "paint the town," etc. from misfiring.

### 17.3 Animated sticker support (optional, via `sharp`)
`extractStaticFrameFromAnimatedWebp()` decodes the animated webp and re-encodes just its first frame as a static PNG. Falls back to a graceful decline if `sharp` isn't installed or conversion fails.

### 17.4 Truth or Dare (`.truth` / `.dare`, natural language)
Fully AI-generated via `generateTruthOrDare()`. Difficulty randomly rolled (`rollTodDifficulty()`: 40% mild / 35% spicy / 20% wild / 5% insane), with hard safety rules baked into the prompt regardless of tier. Session-gated natural-language triggers (`todActiveSessions`, 15-minute window) so a bare "truth." in an unrelated reply never misfires as a game pick.

### 17.5 `.quote` (natural language: "gimme a quote")
`generateQuote()` never fabricates a quote and attributes it to a real named person unless genuinely confident — writes an original unattributed line instead if unsure. Per-chat recent-quote history and a randomly-rolled theme fight mode-collapse toward the same famous quote every time.

### 17.6 `.sticker` — Sticker Maker
Reply to an image/sticker → `sharp`-based 512×512 conversion with transparent padding. Same optional-dependency graceful-decline pattern as Section 17.3.

### 17.7 `.tts` — Text-to-Speech / "reply in a voice note"
Chain: **ElevenLabs** (real free tier, tried first) → **StreamElements** (no key, best-effort) → **plain text** if both fail. Reuses existing machinery (combined analyzer for quoted images, `transcribeAudioWithGroq` for quoted voice notes, `generateAIChatReply` with auto-search otherwise). **⚠️ The "honest limitation" originally described here — no guaranteed native OGG/Opus encoding — has been substantially addressed since v2. See Section 18.10: real OGG/Opus transcoding is now available via the optional `ffmpeg-static` dependency, with a graceful fallback to a regular (fully playable, just not voice-note-styled) audio attachment if it isn't installed.**

### 17.8 `.eli5 <topic>`
`generateEli5Explanation()`. Auto-searches only when the topic matches `NEWSY_QUERY_REGEX`.

### 17.9 Daily Newspaper (`.newsletter on/off`)
Real, incrementally-tallied stats (`bumpDailyStats()` — per-sender message counts, per-emoji usage), not AI-guessed. No new full-day transcript storage — reuses the existing rolling `groupMessageBuffers` for the "funniest moment" sample. One AI call per group per day (`maybeGenerateDailyNewspaper()`), asked only for the creative parts in structured JSON. Time-scheduled (`NEWSPAPER_HOUR`, default 20/8PM server-local), gated by `cfg.lastNewspaperDate`. Session-only daily tallies (not persisted), same trade-off as `GroupConfig`'s session counters.

### 17.10 `.activity` — Group Activity Heatmap
One small Mongo doc per group per day (`ActivityLog`, 24-length int array), TTL-expired after 8 days. In-memory buckets flush on the 10-minute scheduler. `.activity` merges the last 7 persisted days with today's live bucket and renders a zero-AI-cost ASCII bar chart.

### 17.11 `.moviemode on/off` and `.newsletter on/off`
Simple admin-gated boolean toggles on `GroupConfig`, both default `true` so existing groups keep their current always-on behavior.

### 17.12 Auto read receipts (DMs, by default)
`sock.readMessages([msg.key])`, fire-and-forget, DM-only.

### 17.13 `.info` / `.bot` — aliased, not duplicated
Aliased to `.health` to avoid two near-identical text blocks drifting out of sync.

### 17.14 `.tagall` actually tags people now
`mentions: allJids` alone doesn't render visible tags — WhatsApp only tags JIDs that also appear as a literal `"@<number>"` substring in the message text. Fixed by enumerating every participant into the text, same pattern `.kick`/`.promote`/`.demote` use. Bot-admin gate added as a deliberate access-control choice, not a WhatsApp protocol requirement.

### 17.15 Movie Mode ignoring `.mute`
**Confirmed bug, fixed:** `maybeGenerateMovieRecap()` runs on its own independent scheduler and never checked `cfg.muted`. One-line fix. The Daily Newspaper (17.9) was built with this check from day one, having learned from this exact bug — and see Section 18.11, where the same lesson generalizes to persistence, not just muting.

### 17.16 Rejected: automatic link-prefetch/summary for every posted link
Explicitly declined — see Section 15.

### 17.17 `.settings` showing "NaN" for message counts and session time
**Confirmed bug, root-caused precisely:** `loadGroupConfigsFromMongo()` bypassed `getGroupConfig()`'s own default-object logic, leaving three session-only fields `undefined`, which coerced to `NaN` on first increment. Fixed by explicitly initializing all three fields on load.

### 17.18 Uptime formatting
`formatUptime(seconds)` renders `"1 day, 4 hrs, 10 mins"` instead of raw decimal minutes.

### 17.19 Duplicate-message anti-spam extended to groups
Extended from DM-only to also cover groups, keyed by `"chatJid:senderJid"` together. The notice itself is AI-generated (`generateDuplicateSpamNudge()`). Two edge cases were found in a later audit: the ordering issue relative to `.ignore`/`.mute` is fixed (Section 20.1); the media-placeholder false-positive issue is still open (Section 19.2).

---

## 18. Connection Reliability, Session Persistence & Further Fixes (Latest Batch) — *entirely new in v3*

This section covers everything found in `index.js` that was **not reflected anywhere in v2**, discovered during a full line-by-line audit of the current code. As with Sections 12 and 17, this is written as history — what changed and why — with technical depth living in the cross-referenced sections above where one already exists.

### 18.1–18.6 Connection & session reliability
Fully covered in **Section 7.9 through 7.14** — WhatsApp Web protocol version drift (405s), reconnection backoff and stability confirmation, the periodic full-session-folder sync (the "Bad MAC" root fix), group-config persistence retry and periodic reverification, raid protection and group-membership cleanup, and command responses feeding conversational memory. These are collectively the largest undocumented-but-implemented body of work found in this audit, and all six were completely absent from v2 despite being fully built and, based on the code comments, clearly born from real production incidents ("confirmed in production," "confirmed report addressed") in the same way Section 7's original incidents were.

### 18.7 Raid protection specifically (pointer)
Covered in full in **Section 7.13**. Worth calling out separately here because it's a genuinely new *capability*, not just a reliability patch — the bot did not previously have any automated response to a mass-join event.

### 18.8 Gemini model — pinned version → auto-updating alias
Covered in full in **Section 5.1's footnote** and **Section 6.2**. `gemini-2.5-flash` → `gemini-flash-latest`, applied identically to the chat provider chain and the vision provider list, after confirmed production 404s ahead of Google's official retirement date.

### 18.9 ElevenLabs voice ID — from a hardcoded library voice to dynamic resolution
**Confirmed production bug:** ElevenLabs returned `"Free users cannot use library voices via the API. Please upgrade your subscription to use this voice."` — a free ElevenLabs account can only use voices it **owns** (custom-cloned or voice-designed) via the API, never a shared "library" voice like "Rachel," even though Rachel is freely usable in ElevenLabs' own web app.

**Fix:** `ELEVENLABS_VOICE_ID` is no longer hardcoded to a library voice. `resolveElevenLabsVoiceId(key)` resolves the voice to use at runtime: if `ELEVENLABS_VOICE_ID` is explicitly set, that always wins (lets you pin a specific voice once you've created one). Otherwise, it calls `GET /v1/voices` for that API key, caches the result per-key (`resolvedVoiceIdCache`) so it's not re-fetched on every TTS call, and prefers a genuinely-owned/custom voice over anything flagged `"premade"` in case both are somehow present. **If the account has zero voices**, `generateSpeechAudio()` throws an instructive error rather than a bare 402 — the console log explains exactly what to do: create a voice at elevenlabs.io via either Voice Cloning (upload/record a sample) or Voice Design (generate from a text description), both of which work on the free plan and produce a voice ID this function then picks up automatically with no code change.

### 18.10 Real OGG/Opus TTS transcoding via optional `ffmpeg-static`
**Confirmed production bug, reported as "WhatsApp says something is wrong with the Audio":** WhatsApp voice-note bubbles genuinely require real OGG/Opus-encoded audio. Sending an mp3 file with `ptt: true` does **not** reliably work, contrary to what v2 of this document assumed (v2's Section 15 explicitly said this wasn't built and that the bot "sends real, complete, always-playable audio with `ptt: true`... which most WhatsApp clients render as a voice-note-style bubble in practice" — multiple independent production reports have since confirmed WhatsApp either fails to play that combination or shows a corrupt-media error). **That assumption was wrong, and this document is corrected accordingly.**

**Fix:** `ffmpeg-static` (an optional dependency, same bundling pattern as `sharp` — a prebuilt binary shipped as a plain npm package, no system-level install) is loaded lazily via `getFfmpegPath()`, failing closed exactly like `sharp` does if not installed. `transcodeToOggOpus()` pipes the raw TTS audio buffer through `ffmpeg` entirely in memory (stdin/stdout, never touches disk) to produce real 48kHz mono OGG/Opus at 64kbps, with its own hard timeout (15s default) that force-kills a hung `ffmpeg` process via `SIGKILL`. `generateSpeechAudio()` now: gets raw audio from ElevenLabs/StreamElements as before → attempts the ffmpeg transcode → on success, sends with `ptt: true` and `isVoiceNote: true` for a proper voice-note bubble → on failure (including `ffmpeg-static` simply not being installed), falls back to sending the **untranscoded** audio as a **regular** (non-`ptt`) attachment, which WhatsApp plays completely fine — **never** the confirmed-broken mp3+`ptt:true` combination again. **`.tts` works with zero configuration change either way** — this is a pure quality upgrade when `ffmpeg-static` is present, not a new requirement. Run `npm install ffmpeg-static` to enable it.

### 18.11 Provider auth-failure cooldown
Covered in full in **Section 5.3**. A bad/revoked key now sits out for 30 minutes instead of the standard 60 seconds, since a permanently-invalid key isn't going to fix itself the way a transient timeout might.

### 18.12 Document/video honest decline extended to directly-sent files
The combined-quoted-media analyzer (Section 17.1-era) already declined honestly when someone *replied to* a document or video. That decline is now also triggered for a document/video sent **directly** to the bot (not as a reply) when the bot is addressed in a group, or in any DM — same `generateUnsupportedFileDeclineLine(vibe, fileType)` function, same honest, warm, AI-generated (never canned) "I can't read this yet" response, just triggered from a second call site so the direct-send case isn't left to fall through to a confusing generic reply.

### 18.13 Noise-placeholder messages excluded from the conversation buffer
`NOISE_PLACEHOLDER_REGEX` (`/^\[(video, no caption|file(: .+)?)\]$/`) is checked in `bufferGroupMessage()` — a bare, uncaptioned video or any document/file placeholder is now skipped entirely rather than stored, since this bot doesn't process document/video content at all and storing the placeholder is pure noise with zero value for context, summarization, or the Daily Newspaper. **Deliberately does not exclude** `[image, no caption]`, `[sticker]`, `[voice note]`, or `[audio file]` — those genuinely carry signal (a vision/transcription result may follow, or at minimum "someone shared something" is worth a Daily Newspaper mention).

### 18.14 Input-length truncation applied uniformly across every AI call site
Previously, the `MAX_AI_INPUT_CHARS` (4000-char) truncation only reliably applied inside the plain chat-reply branch. `boundedQuestion` is now computed once, before the reply-type decision is made, and used consistently across the combined-media-analysis path **and** the normal-reply path (the dedicated summarizer intentionally keeps using the full, untruncated `quotedTextRaw`, since it has its own separate, larger `MAX_SUMMARIZABLE_CHARS` = 12,000 cap suited to summarizing a big pasted block on purpose).

### 18.15 Task-execution prompt hardening
A new paragraph in `generateAIChatReply()`'s system prompt explicitly addresses a failure mode where the model would respond to a task request ("tell a story," "write something," "quiz me") with only an announcement or warm-up line ("Alright, let's dive in!") and no actual content — or would repeat that same announcement on a short follow-up like "go"/"continue"/"yes" instead of producing the next real chunk. The prompt now requires the **actual content** to be present in the reply itself, targets roughly 100–300 words for a genuine task response (vs. 1–4 sentences for casual chat), and explicitly distinguishes "one clear round of setup is fine; repeating it is the bug to avoid."

### 18.16 Minor personality-prompt additions
- **A rare (5%) "distracted" quirk**, prompt-only, zero stored state: for that one reply, the model is invited to briefly fixate on one random, non-essential word/noun in what the person said before still addressing their actual point — e.g. "Honeycrisp or Granny Smith? Also yeah, send the code."
- **An explicit-emoji-request override** (`/\bemojis?\b/i` match on the incoming message): when someone explicitly asks for emoji as content ("reply with emojis," "explain this in emoji"), the usual sparing-emoji default is set aside for that reply so the request isn't fought by the ratio policy.

---

## 19. Issues Found But Not Yet Fixed

Unlike Section 13 (patterns already fixed at least once, worth guarding against recurring) and Sections 18/20 (things that were fixed, some undocumented at the time, some fixed live during this document's own history), **everything in this section is a real, currently-live bug in the code as of this writing.** Recorded here in the same spirit as the rest of this document: so nobody — human or AI — has to rediscover these from scratch, and so a future fix can be verified against the exact mechanism described rather than a vague symptom report.

**Renumbered in v4:** three items that lived here in v3 (duplicate-spam vs. mute/ignore ordering, the `.kick`/`.promote`/`.demote` self-target guard, and the vibe-check economy fix) are now fixed — see Section 20.1–20.3. The three that remain are renumbered 19.1–19.3 below (previously 19.4–19.6) so this section has no gaps.

### 19.1 `EMOJI_REGEX` — stateful `lastIndex` on a shared global-flagged regex used with `.test()`
**Where:** `applyEmojiPolicy()` calls `EMOJI_REGEX.test(text)` and, later in the same function, `EMOJI_REGEX.test(finalText)` — both against the module-level `const EMOJI_REGEX = /\p{Extended_Pictographic}/gu`.

**Impact:** per spec (Section 13.9), `.test()` on a global-flagged regex reads and mutates that object's `lastIndex`. A match found late in one message leaves `lastIndex` pointing partway through that string; the *next* call — on a different, possibly shorter message — starts searching from that stale offset and can return `false` even when the new message genuinely contains an emoji near its start. (`bumpDailyStats()`'s use of the same object via `.match()` is unaffected — `.match()` always resets `lastIndex` to 0 first, per spec.) Practical severity is low (worst case: the emoji-ratio enforcement occasionally fails to strip emoji it should have), but it's a real, easily-fixed correctness bug.

**Suggested fix direction:** use a non-global regex literal (no `g` flag) for boolean presence checks, and reserve the global-flagged version for `.match()`/`.replace()` only.

### 19.2 Duplicate-spam detector can misfire on repeated bare-media placeholders
**Where:** `checkDuplicateSpam()` operates on whatever `text` currently holds, including the placeholder strings `extractTextFromMessage()` substitutes for bare media (`"[image, no caption]"`, `"[sticker]"`).

**Impact:** three uncaptioned photos or stickers sent in a row from the same person register as three identical "messages," and can trigger the same "stop sending the same message" nudge meant for genuine repeated text. A narrower, standalone issue from the mute/ignore-ordering bug fixed in Section 20.1 — worth fixing on its own regardless.

**Suggested fix direction:** exclude known media placeholders from the duplicate-spam text comparison, or key the check on `(text, mediaType)` rather than text alone.

### 19.3 Cosmetic: naming still reflects an earlier single-provider design
**Where:** `evaluateMessageWithGroq()`, `recordGeminiFailure()`, and log lines like `"Retrying Gemini AI connection"` / `"3 consecutive Gemini failures"`.

**Impact:** none functionally — these names are leftovers from before the provider chain was expanded to 5 providers (Groq is now first, not Gemini-only). Purely a readability hazard for anyone debugging from logs or reading the code cold, who might reasonably assume these are Gemini-specific when they're actually chain-wide.

**Suggested fix direction:** rename to something chain-neutral (`evaluateMessageWithAI`, `recordAIProviderFailure`) next time this area is touched — not urgent enough to warrant a standalone change.

---

## 20. v4 Fixes — Mute/Ignore Airtightness, the Self-Target Guard, Vibe-Check Economy, and the `deviceSentMessage` Root Cause

Everything in this section was fixed in v4. The first three resolve bugs 19.1–19.3 as they were numbered in v3 (see the note at the top of the current Section 19 for the renumbering). The rest were found live, through the person's own hands-on testing, not through static code review — recorded in full because 20.6 in particular is the most impactful single fix in this project's history.

### 20.1 Mute/ignore are now genuinely airtight (fixes v3's 19.1)
**The bug:** `checkDuplicateSpam()` — including its "just_triggered" branch, which actively sends an AI-generated nudge — ran *before* the permanent `.ignore` check, the temporary two-strike ignore check, and the `.mute` check in the main pipeline. Someone who was ignored, temporarily silenced, or in a muted group could still get the bot to send a message just by repeating text three times in a row, directly breaking `.ignore`'s "no replies, no reactions, nothing" guarantee and `.mute`'s "only `.unmute` works" guarantee.

**The fix:** the duplicate-spam check now runs *after* all three silence checks (see the renumbered Section 10, steps 4–7) — a message from someone who should be fully silenced is dropped before duplicate-spam logic ever sees it. No exceptions, mute means mute.

### 20.2 `.kick`/`.promote`/`.demote` now have the same self-target guard `.ignore` already had (fixes v3's 19.2)
**The bug:** covered in Section 13.5's audit note — `resolveCommandTarget()` is shared by `.ignore` and by `.kick`/`.promote`/`.demote`, but only `.ignore` had the `isSelfJid()` check. Replying to one of the bot's own messages and typing `.kick` with no other target would resolve to the bot's own JID and attempt to remove the bot from the group.

**The fix:** the identical `isSelfJid(sock, target)` check, with the same graceful, in-character refusal `.ignore` already uses, added right after target resolution in the shared `.kick`/`.promote`/`.demote` block.

### 20.3 Vibe-check now only runs when its result can actually be used (fixes v3's 19.3)
**The bug:** `evaluateMessage()` ran unconditionally for every non-oversized message — DM or group, addressed or not — but its output was only ever read in the unaddressed-group "Group Soul" branch, meaning every DM and every addressed group message paid for a full AI-provider round trip whose result was thrown away.

**The fix:** gated behind `!isOversized && isGroup && !addressed`. `addressed` was already computed earlier in the pipeline by this point, so this was a pure condition change, not a reordering. **Explicitly verified not to affect quoted-media/link/phone-number understanding** — that's the separate `gatherQuotedContext`/`analyzeQuotedMediaAndText` mechanism (Section 17.1), which only ever runs inside the addressed/`shouldChatReply` branch and was untouched by this change.

### 20.4 Quoted-media placeholder leak and silent download-failure gap (found via live testing)
**The bug, found from a real report** ("I sent an image, no caption, then replied 'Nayla what's this?' — the bot said it wasn't sure what 'this' referred to"): `gatherQuotedContext()` pushed whatever `getQuotedMessageText()` returned into the prompt as `Original message text/caption: "..."` unconditionally — including when that "text" was actually the internal bare-media placeholder (`"[image, no caption]"`, `"[sticker]"`, etc.), which reads to the model as literal, ambiguous filler text, not as a signal that an image was involved. Compounding this: if the quoted image's *download* failed (as opposed to the vision *analysis* failing), nothing flagged it at all — `visionFailed` was only ever set inside the `if (rawBuffer)` branch, so a failed download produced total silence in the model's context.

**The fix:** a new `MEDIA_PLACEHOLDER_TEXT_REGEX` filters the placeholder out before it's ever treated as real caption text — only a genuine caption gets pushed as `"Original message text/caption"` now. A failed download sets `visionFailed = true` just like a failed analysis does, surfacing the same honest `"(There was an image/sticker attached... but I couldn't retrieve or analyze it this time...)"` fallback line instead of silence.

### 20.5 `.eli5` drifting to an unrelated generic explanation instead of the actual quoted content (found via live testing)
**The bug, found from a real report:** replying to the bot's own `.stats`/`.menu` output with a bare `.eli5` produced a completely unrelated, generic "your body is like a car, food is the gasoline" explanation instead of explaining the actual quoted content. This function had a documented history of exactly this kind of drift (see the code comment already in `generateEli5Explanation()` from an earlier fix) — given terse or technical content and no strong instruction against it, the model would substitute a more familiar, easier-to-explain topic instead of engaging with what it was actually given.

**The fix:** the system prompt now explicitly forbids substituting a different, more familiar topic "just because it's an easier example," names the exact failure mode as a known anti-pattern to avoid, and instructs the model to translate technical content (a command, a status readout, jargon) term-by-term instead of talking around it. The never-supposed-to-be-reached final fallback (topic and quoted content both empty) no longer says a bare "Explain like I'm 5" — it now explicitly tells the model not to invent a topic and to ask honestly for one instead. **Note:** this made the symptom much less likely, but the true root cause turned out to be Section 20.6 below — `additionalContext` was arririving empty because quote-detection itself was silently failing for replies to the bot's own messages, not because the prompt was weak. Both fixes are worth keeping: 20.6 means this degenerate case should now be rare, and this fix means it's harmless if it's ever hit anyway.

### 20.6 THE root cause: `deviceSentMessage` — the most impactful fix in this project's history
**The bug, found from a real report, after two rounds of fixes that improved things without fully resolving them:** replying to *any* message the bot itself had sent — `.menu`'s output, `.stats`'s output, a normal chat reply, anything — silently failed to extract any quoted content at all. Not "extracted the wrong thing" — extracted **nothing**, as if there were no reply at all. This explains every symptom reported across this whole debugging arc: `.eli5` asking for a topic despite clearly being a reply; "Nayla, what's this?" and "analyse this image" getting confused, generic responses; and — the biggest tell — **DMs being broken far worse than groups**, because in a DM almost everything you reply to *is* something the bot itself just said.

**Root cause:** WhatsApp wraps a message in a `deviceSentMessage` envelope when it was sent from a companion/linked device — which is exactly what this bot's own WhatsApp session is (Section 1: "runs as a real linked device"). When that message is later quoted, the real content sits one level deeper than usual: `quotedMessage.deviceSentMessage.message`, not `quotedMessage` directly. `unwrapMessageContent()`'s wrapper-type list didn't include `deviceSentMessage` — see Section 13.10 for the general pattern this represents. Every quoted-content function in the file (`getQuotedMessageText`, `getQuotedMediaType`, `gatherQuotedContext`, `downloadQuotedMedia`) funnels through this one shared helper, so this single missing entry explained the entire debugging arc at once.

**The fix:** one line — `"deviceSentMessage"` added to `unwrapMessageContent()`'s `wrapperTypes` array (same file location as the `ephemeralMessage`/`viewOnceMessage` handling it already sits next to). Every downstream consumer benefits automatically, with zero changes needed at any individual call site — exactly the payoff of having funneled everything through one shared function in the first place (the Section 13.1 principle, paying off here for a completely different wrapper type than the one it was originally written for).

**Confirms and closes out the explicit asks from this debugging round:** `.eli5` not needing a topic when it's genuinely replying to something (already correctly designed — see the code's own `hasRealTopic`/`additionalContext` branching); feeding *both* the current message and the quoted content to the AI together (already correctly designed — see `generateAIChatReply`'s user-turn construction); understanding a reply from *any* sender in a group, not just recent context (already correctly designed — quoted-content extraction reads whatever WhatsApp attaches directly to the reply, regardless of who sent the original or how long ago). All three were blocked by this one bug, not missing features — no new MongoDB storage or message-history flushing needed, contrary to an earlier open question about whether that would be required.

### 20.7 Diagnostic logging added as a permanent safety net
**Added alongside 20.6, not a bug fix on its own:** `getQuotedMessageText()` now logs a warning — `⚠️ [QUOTE DETECTION] Found a quotedMessage but couldn't extract any text from it...` — specifically when a `quotedMessage` object genuinely exists (a real reply was detected) but neither text nor a recognized placeholder could be pulled out of it. This is deliberately low-noise: a text-only quote correctly producing no media type isn't logged (that's normal), and a real caption or a normal media placeholder isn't logged either (extraction succeeded). It only fires for a genuinely unrecognized content/wrapper shape — exactly the situation `deviceSentMessage` was silently causing before 20.6, and exactly what would be needed to diagnose the *next* one of these without another multi-round guessing process. **If this warning ever appears in the logs, treat it as the starting point** — it prints the raw top-level keys of both the wrapped and unwrapped quoted content, which is enough to identify the missing wrapper or field directly.

### 20.8 Debunked: a pasted third-party diagnosis proposing `content.conversation?.contextInfo`
**What was proposed:** during the same testing round that found Section 20.6's real bug, a separately-pasted AI diagnosis identified the same symptom pattern (quote-detection failing) and proposed adding `|| content.conversation?.contextInfo` to `getContextInfo()`, reasoning that WhatsApp sometimes sends a reply as a bare `conversation` object whose `contextInfo` the function wasn't checking.

**Why it's wrong:** `conversation` is a plain string field in WhatsApp's message schema — literally just the message's text content, not a nested message object — so it cannot structurally have a `.contextInfo` property at all; `"some string".contextInfo` is always `undefined`, silently, forever. This codebase's own `extractTextFromMessage()` already treats `content.conversation` as a plain string (`if (content.conversation) return content.conversation;`), consistent with the actual schema. More fundamentally, a reply can never arrive as a bare `conversation` in the first place: WhatsApp always promotes any outgoing message that needs to carry `contextInfo` — which every reply does, by definition — to `extendedTextMessage`, specifically because that's the type with somewhere for `contextInfo` to live. The proposed fix would have compiled, run without error, and done precisely nothing.

**What it got right, and why it's still worth crediting:** the diagnosis correctly recognized that all the reported symptoms shared one root cause (quote-detection failing generally, not three unrelated bugs), and its suggested verification step — add logging, print the raw `msg.message` structure, confirm against real data — was sound methodology, and is exactly what led to actually finding Section 20.6's bug and to permanently adding Section 20.7's diagnostic. The lesson isn't "ignore third-party diagnoses" — it's "verify the specific mechanism against the real schema before trusting it just because it's fluent and confident." Generalized as a standing rule in **Section 13.11**.

---

*End of document. Reflects the project's state as of the `index.js` fixed and audited through v4. When this document is next updated, preserve everything here — append and revise, don't delete history, the same way this version preserved and built on v3, v3 on v2, and v2 on v1.*
