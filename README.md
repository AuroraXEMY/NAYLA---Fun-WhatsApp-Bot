<div align="center">

# 🌴 Nayla

### A self-hosted, AI-powered WhatsApp companion bot

*Chats, vibes, remembers, sees, listens, and speaks — running on a free-tier budget.*

![Node.js](https://img.shields.io/badge/node-%3E%3D18-339933?logo=node.js&logoColor=white)
![WhatsApp](https://img.shields.io/badge/WhatsApp-Baileys-25D366?logo=whatsapp&logoColor=white)
![Database](https://img.shields.io/badge/database-MongoDB%20Atlas-47A248?logo=mongodb&logoColor=white)
![Platform](https://img.shields.io/badge/hosting-Render-46E3B7?logo=render&logoColor=white)
![Architecture](https://img.shields.io/badge/architecture-single--file-blueviolet)
![License](https://img.shields.io/badge/license-unspecified-lightgrey)

[Highlights](#-highlights) · [Architecture](#-architecture) · [Installation](#-installation) · [Commands](#-commands) · [Deployment](#-deployment-render) · [Troubleshooting](#-troubleshooting) · [FAQ](#-faq)

</div>

<br/>

> **What is this?** Nayla is a WhatsApp companion bot that runs as a real linked device on its owner's WhatsApp account. It's a *vibe bot*, not a moderator — it chats when addressed, remembers small per-conversation details, searches the web, looks at photos and stickers, listens to voice notes, generates images, and occasionally comments on notable moments in a group. It never deletes messages or issues warnings — that capability was deliberately and permanently removed early in the project's life.
>
> **A note on architecture, read this first:** Nayla connects to WhatsApp as a *companion/linked device* on a real account (the same mechanism as WhatsApp Web or Desktop), not through an official WhatsApp Business API. This is sometimes called a "self-bot" pattern. It is not an officially sanctioned integration method, and automating a personal WhatsApp account may be inconsistent with WhatsApp's Terms of Service. Use at your own risk, on an account you're comfortable with — see [Security](#-security).

---

## 📖 Table of Contents

1. [Highlights](#-highlights)
2. [Architecture](#-architecture)
3. [Project Structure](#-project-structure)
4. [Requirements](#-requirements)
5. [Environment Variables](#-environment-variables)
6. [Installation](#-installation)
7. [Deployment (Render)](#-deployment-render)
8. [Pairing Your WhatsApp Account](#-pairing-your-whatsapp-account)
9. [Commands](#-commands)
10. [AI Provider System](#-ai-provider-system)
11. [Database](#-database)
12. [Configuration Guide](#-configuration-guide)
13. [Performance & Reliability](#-performance--reliability)
14. [Troubleshooting](#-troubleshooting)
15. [Updating & Maintenance](#-updating--maintenance)
16. [FAQ](#-faq)
17. [Security](#-security)
18. [Development Guide](#-development-guide)
19. [Credits](#-credits)
20. [License](#-license)

---

## ✨ Highlights

<table>
<tr>
<td width="50%" valign="top">

**🧠 AI & Conversation**
- 5-provider AI failover chain (Groq → Cerebras → Gemini → OpenRouter → Mistral), never called in parallel
- Up to 10 rotating API keys per provider
- Per-provider cooldowns — 60s for transient failures, 30 min for a bad/revoked key
- Absolute 35-second deadline across the whole call, no matter how many providers are tried
- 14 selectable personalities (moods), per-group in group chats, global fallback in DMs
- Per-chat rolling conversation memory (50 messages), archived to MongoDB on overflow
- Per-chat, per-person "facts" memory — scoped so a DM never leaks into a group or vice versa

**👁️ Multimodal**
- **Vision** — understands photos and stickers (3-provider fallback chain), including animated stickers (via optional `sharp`)
- **Voice transcription** — Groq Whisper, in memory, never written to disk
- **Image generation** — Pollinations.ai, no API key required, triggered by `.imagine` or natural language ("draw me a cat")
- **Text-to-speech** — ElevenLabs → StreamElements → plain-text fallback, with real OGG/Opus voice-note encoding via optional `ffmpeg-static`
- **Combined reply analysis** — reply to *any* message (yours, someone else's, or the bot's own) containing an image, sticker, voice note, link, or phone number, and ask about it in one shot

**🔎 Search & Awareness**
- Web search via Tavily, explicit (`.search`) or auto-triggered on search-intent phrasing
- Domain-only link awareness (never fetches arbitrary URLs — no SSRF surface)
- Phone-number detection (flagged, never repeated back)

</td>
<td width="50%" valign="top">

**🎮 Gamification & Group Utilities**
- XP/leveling system with titles (`.rank`)
- Truth or Dare with 4 randomly-rolled difficulty tiers
- AI-generated quotes with anti-repetition and anti-fabrication guardrails
- Daily "Newspaper" — real computed stats (top chatter, top emoji) + AI-written commentary
- Daily "Movie Mode" episode recap
- 7-day activity heatmap
- Raid protection — auto-lockdown on a mass-join burst
- Full moderation-adjacent toolkit (`.kick` / `.promote` / `.demote` / `.mute` / `.ignore` / `.tagall` / `.del`) — but **zero automated enforcement**, ever

**🛡️ Reliability & Crash Protection**
- Timeouts on every external call, plus a hard safety-net timeout on every heavy task
- Circuit breaker for the ambient "vibe-check" pass
- Exponential reconnect backoff with stability confirmation
- Fatal-error detection that intentionally restarts a corrupted WhatsApp session instead of running as a silent zombie
- Global concurrency limiter (4 concurrent heavy tasks, bounded queue) so a burst of images/voice-notes can't starve the bot

**⚙️ Resource Optimization (Render 512MB target)**
- Bounded, self-expiring in-memory caches everywhere, with a heap-pressure flush valve
- MongoDB writes are batched/dirty-flagged, never per-message
- Every collection has a deliberate TTL (or a deliberate lack of one)
- HTTP keep-alive server + self-ping loop to survive Render's free-tier sleep policy

</td>
</tr>
</table>

> 📚 **This README covers usage, deployment, and reference material only.** For the full history of every bug found, every architectural decision, and *why* things work the way they do, see [`NAYLA_PROJECT_DOCUMENTATION.md`](./NAYLA_PROJECT_DOCUMENTATION.md) — required reading before making non-trivial changes.

---

## 🏗 Architecture

Nayla is a **single Node.js process**, single file (`index.js`), no framework, no database ORM layer beyond Mongoose. It holds one persistent WhatsApp socket connection and a handful of `setInterval` background jobs, and serves one tiny HTTP endpoint purely to satisfy Render's health check.

```mermaid
flowchart TB
    subgraph WhatsAppNetwork["WhatsApp Network"]
        Phone(["📱 Owner's Phone<br/>Primary Device"])
        Others(["👥 Everyone Else<br/>DMs &amp; Groups"])
    end

    subgraph NaylaProcess["Nayla — index.js (single Node.js process)"]
        direction TB
        Baileys["Baileys Socket<br/>(Multi-Device / Companion Session)"]
        Pipeline["Message Pipeline<br/>rate-limit → ignore/mute → commands →<br/>addressing → media → AI reply"]
        HealthSrv["HTTP Keep-Alive Server<br/>GET / and /ping"]
        SelfPing["Self-Ping Loop<br/>every 10 min"]
        Scheduler["10-min Scheduler<br/>stats flush · Movie Mode ·<br/>Daily Newspaper · session sync"]
    end

    subgraph AIChain["AI Provider Chain (sequential failover)"]
        direction LR
        Groq --> Cerebras --> Gemini --> OpenRouter --> Mistral
    end

    subgraph Services["External Services"]
        Tavily[["🔎 Tavily<br/>Web Search"]]
        Pollinations[["🎨 Pollinations.ai<br/>Image Generation"]]
        TTS[["🎙️ ElevenLabs /<br/>StreamElements<br/>Text-to-Speech"]]
    end

    Mongo[("🍃 MongoDB Atlas<br/>Session · Stats · Facts ·<br/>GroupConfig · Archives")]

    Render{{"☁️ Render.com<br/>Free Web Service"}}

    Phone <-->|"linked device"| Baileys
    Others <--> Baileys
    Baileys <--> Pipeline
    Pipeline -->|"chat / vision / vibe-check"| AIChain
    Pipeline --> Tavily
    Pipeline --> Pollinations
    Pipeline --> TTS
    Pipeline <--> Mongo
    Baileys -.->|"session credentials"| Mongo
    Scheduler <--> Mongo
    Render -->|hosts| NaylaProcess
    Render -.->|"pings /ping every ≤15 min"| SelfPing
    SelfPing -.->|"keeps container awake"| Render
```

### Design principles that shaped this architecture

| Principle | Why |
|---|---|
| **Single file, no splitting** | Deliberate, permanent decision — the project is maintained by one person iterating via chat with AI assistants across sessions; one file with heavy inline commenting is more tractable than a module graph for that workflow. |
| **Degrade, never crash, on missing config** | Every feature checks for its own required env vars and disables itself gracefully (with an honest in-chat message) rather than throwing. |
| **Sequential provider fallback, never parallel** | Never hammer every AI/search provider at once just because one is struggling — always try one at a time, in priority order. |
| **Zero automated enforcement** | The bot used to auto-moderate (approve/warn/delete). This was removed permanently after a pattern of false positives. The *only* deletion path anywhere in the bot is the manual, admin-invoked `.del` command. |
| **LID-awareness everywhere identity is compared** | WhatsApp's multi-device identity system means the same account can appear as a classic JID or an `@lid` JID in different contexts — every identity comparison in this codebase normalizes both before comparing. |

---

## 📁 Project Structure

```
.
├── index.js                          # The entire bot. ~4,900 lines, single file, everything lives here.
├── pair.js                           # One-time, run-locally pairing script (not part of the deployed bot).
├── package.json                      # Dependencies (see below).
├── .env                              # Local environment variables (never commit this).
├── README.md                         # You are here.
└── NAYLA_PROJECT_DOCUMENTATION.md    # Full history: every bug found, every decision made, and why.
```

<details>
<summary><strong>What each file is responsible for</strong></summary>

<br/>

| File | Responsibility |
|---|---|
| **`index.js`** | Everything: the WhatsApp socket, the HTTP keep-alive server, the full message pipeline, every command, the AI provider chain, MongoDB schemas and persistence, vision/audio/TTS/image-generation integrations, gamification, and every background scheduler job. |
| **`pair.js`** | A **separate, one-time-use script** you run manually and locally (not on Render). It opens its own Baileys connection, walks you through linking a device to your WhatsApp account (QR code or pairing code, depending on how it's invoked), and uploads the resulting session credentials to the same MongoDB collection `index.js` reads from on startup. Never run this as part of your production deployment — see [Pairing](#-pairing-your-whatsapp-account). |
| **`package.json`** | Standard npm manifest. See [Requirements](#-requirements) for the dependency list `index.js` actually imports. |
| **`NAYLA_PROJECT_DOCUMENTATION.md`** | The living record of *why* — architectural decisions, every confirmed bug and its root cause, recurring bug patterns to avoid reintroducing, and the reasoning behind every non-obvious constant in the code. Read this before making any change that touches identity comparison, message-type detection, AI prompts, or the message pipeline's ordering. |

</details>

---

## 🧰 Requirements

| Requirement | Version / Tier | Notes |
|---|---|---|
| **Node.js** | **18 or later** | The code uses native `fetch`, `AbortController`, `FormData`, and `Blob` directly with no polyfills — these are Node 18+ globals. |
| **MongoDB Atlas** | Free **M0** tier is sufficient | ~512MB storage. Used for session persistence and all long-term memory. The bot runs without it, but loses all persistence across restarts. |
| **Hosting** | [Render.com](https://render.com) free or paid Web Service | The keep-alive server, self-ping loop, and health-check design are all built specifically around Render's free-tier constraints (port-binding requirement, 15-minute idle sleep). Any host that can run a long-lived Node process and expose one HTTP port will work, but Render is the tested target. |
| **RAM** | ~512MB target | Every in-memory cache in the codebase is bounded and self-expiring specifically to fit this budget, with a heap-pressure flush valve at 380MB. |
| **OS** | Any (Linux, macOS, Windows via WSL) for local pairing; Linux container for deployment | No OS-specific code paths. |

### API keys

<table>
<tr><th>Required</th><th>Optional (feature-gated)</th></tr>
<tr valign="top">
<td>

- **`MONGODB_URI`** — without it, no persistence at all across restarts
- **At least one chat AI provider key** — without any, the bot runs on local regex fallbacks only, with no real conversation

</td>
<td>

- One or more of: Groq, Cerebras, Google Gemini, OpenRouter, Mistral (chat + vision + audio, several are shared)
- Tavily (`.search`, auto-search)
- ElevenLabs (`.tts` — falls back to a keyless provider without it)

</td>
</tr>
</table>

Every provider above is genuinely free-tier / free-forever as of this writing (no card required) — see [AI Provider System](#-ai-provider-system) for why each one was chosen.

### npm dependencies

| Package | Required? | Purpose |
|---|---|---|
| `@whiskeysockets/baileys` | ✅ Required | WhatsApp multi-device Web API client |
| `mongoose` | ✅ Required | MongoDB object modeling |
| `pino` | ✅ Required | Logger (used internally by Baileys) |
| `dotenv` | ✅ Required (local dev) | Loads `.env` — not needed on Render, which injects env vars directly |
| `sharp` | ⭕ Optional | Animated-sticker frame extraction and `.sticker` image conversion. Both features degrade gracefully (with an honest in-chat message) if this isn't installed. |
| `ffmpeg-static` | ⭕ Optional | Real OGG/Opus voice-note encoding for `.tts`. Without it, `.tts` still works but sends a regular (non-voice-note-styled) audio attachment instead. |

Everything else (`fs`, `path`, `http`, `https`, `child_process`, `fetch`, `FormData`, `Blob`, `AbortController`) is a Node.js built-in — no additional package needed.

```bash
npm install @whiskeysockets/baileys mongoose pino dotenv
npm install sharp ffmpeg-static   # optional, but recommended
```

---

## 🔑 Environment Variables

<details open>
<summary><strong>Quick reference — the essentials</strong></summary>

<br/>

| Variable | Required? | Description |
|---|:---:|---|
| `MONGODB_URI` | **Yes**\* | MongoDB Atlas connection string. \*Not strictly required to boot, but the bot loses all persistence without it. |
| `GROQ_API_KEY` | Recommended | Primary chat provider, also powers vision fallback and audio transcription. Free tier. |
| `PORT` | No | HTTP port for the keep-alive server. Render sets this automatically — don't set it manually. |
| `RENDER_EXTERNAL_URL` | No | Auto-set by Render. Used by the self-ping loop. Don't set manually. |

</details>

<details>
<summary><strong>📋 Complete environment variable reference (click to expand)</strong></summary>

<br/>

#### Database

| Variable | Required? | Description | Default |
|---|:---:|---|---|
| `MONGODB_URI` | Recommended | Full MongoDB Atlas connection string | *(none — bot degrades to ephemeral-only mode)* |

#### Chat AI providers

Every provider below supports **up to 10 rotating keys**: the plain variable name, then `_1` through `_10`, any combination. At least one key across *any* provider is recommended.

| Variable | Required? | Description | Model used |
|---|:---:|---|---|
| `GROQ_API_KEY` (`_1`–`_10`) | Recommended | Priority 1 chat provider; also vision & audio transcription | `llama-3.3-70b-versatile` |
| `CEREBRAS_API_KEY` (`_1`–`_10`) | Optional | Priority 2 chat provider | `llama-3.3-70b` |
| `GEMINI_API_KEY` (`_1`–`_10`) | Optional | Priority 3 chat provider; also vision | `gemini-flash-latest` (auto-updating alias) |
| `OPENROUTER_API_KEY` (`_1`–`_10`) | Optional | Priority 4 chat provider; also vision fallback | `meta-llama/llama-3.3-70b-instruct:free` |
| `MISTRAL_API_KEY` (`_1`–`_10`) | Optional | Priority 5 chat provider | `mistral-small-latest` |

#### Web search

| Variable | Required? | Description | Default |
|---|:---:|---|---|
| `TAVILY_API_KEY` (`_1`–`_10`) | Optional | Powers `.search` and auto-search grounding | *(disabled — bot says so honestly)* |

#### Text-to-speech

| Variable | Required? | Description | Default |
|---|:---:|---|---|
| `ELEVENLABS_API_KEY` (`_1`–`_10`) | Optional | Primary TTS provider, real free tier (~10k chars/month) | *(falls back to StreamElements, no key needed)* |
| `ELEVENLABS_VOICE_ID` | Optional | Pins a specific ElevenLabs voice | *(auto-resolves the account's own first available voice)* |

> ⚠️ Free ElevenLabs accounts can only use voices they **own** (cloned or designed in the ElevenLabs dashboard) via the API — never shared "library" voices. If you set `ELEVENLABS_API_KEY` but the account has zero custom voices yet, TTS will fall back to StreamElements until you create one at elevenlabs.io.

#### Scheduling

| Variable | Required? | Description | Default |
|---|:---:|---|---|
| `NEWSPAPER_HOUR` | Optional | Hour (0–23, **server-local time**) the Daily Newspaper sends | `20` (8 PM) |
| `TZ` | Optional | Standard Node.js/OS timezone variable — shifts what "server-local" means for `NEWSPAPER_HOUR` | UTC (Render's default) |

#### Render infrastructure

| Variable | Required? | Description |
|---|:---:|---|
| `PORT` | No — set automatically by Render | HTTP port for the keep-alive server |
| `RENDER_EXTERNAL_URL` | No — set automatically by Render | Used by the self-ping loop to keep the free tier awake |

</details>

### Example `.env`

```env
MONGODB_URI=mongodb+srv://user:pass@cluster.mongodb.net/dbname?retryWrites=true&w=majority

GROQ_API_KEY=gsk_xxxxxxxxxxxxxxxxxxxxxxxx
CEREBRAS_API_KEY=
GEMINI_API_KEY=
OPENROUTER_API_KEY=
MISTRAL_API_KEY=

TAVILY_API_KEY=

ELEVENLABS_API_KEY=
ELEVENLABS_VOICE_ID=

NEWSPAPER_HOUR=20
TZ=Africa/Lagos
```

---

## 🚀 Installation

```bash
# 1. Clone the repository
git clone <your-repo-url>
cd nayla

# 2. Install dependencies
npm install
npm install sharp ffmpeg-static   # optional, recommended for full feature parity

# 3. Configure environment variables
cp .env.example .env   # or create .env manually
# then fill in .env with your MongoDB URI and at least one AI provider key
```

**4. Provision MongoDB Atlas**
Create a free M0 cluster at [mongodb.com/atlas](https://www.mongodb.com/atlas), create a database user, allow network access from anywhere (`0.0.0.0/0`) if deploying to Render (or restrict to Render's static IPs on a paid plan), and copy the connection string into `MONGODB_URI`.

**5. Pair your WhatsApp account (local machine, one time only)**
```bash
npm run pair
```
Follow the prompts, scan the QR code (or enter the pairing code) with the WhatsApp account you want the bot to run as. This uploads a working session to MongoDB. See [Pairing](#-pairing-your-whatsapp-account) for details.

**6. Run the bot**
```bash
npm start
# or directly:
node index.js
```

**7. Verify**
Message the account you paired (or a group it's in) with:
```
.health
```
You should get back a full diagnostics report — AI provider chain, MongoDB connection status, search/vision/audio/TTS availability, and current resource usage.

---

## ☁️ Deployment (Render)

Nayla is purpose-built for Render's free tier — the keep-alive server and self-ping loop exist specifically to work around its constraints.

### Service settings

| Setting | Value |
|---|---|
| **Environment** | Node |
| **Build Command** | `npm install` |
| **Start Command** | `node index.js` |
| **Health Check Path** | `/` or `/ping` (both return `200 OK`) |
| **Instance Type** | Free (or any paid tier — everything here also works fine, it's just not required) |

### Why the keep-alive server exists

Render's free-tier **Web Services** require a bound HTTP port within roughly 90 seconds of deploy, even though this bot's real job (a WhatsApp socket + MongoDB worker) has no actual web traffic. Without it, Render's port scanner times out and **recycles the entire container on a loop** — which looks like a WhatsApp connection dying every 20–45 seconds for no obvious reason. The tiny `http` server (`GET /` and `GET /ping`, both returning `200 OK`) exists purely to satisfy this requirement.

### Why the self-ping loop exists

Render's free tier additionally **sleeps the container after ~15 minutes of inbound-traffic inactivity**. The bot's own WhatsApp socket traffic is *outbound* and doesn't count toward that clock. `RENDER_EXTERNAL_URL` (auto-set by Render) is pinged every 10 minutes to keep the inbound-traffic clock from ever expiring.

### Persistent sessions across restarts/redeploys

Render's disk is **ephemeral** — anything written to disk is wiped on every restart or redeploy. Baileys normally saves WhatsApp session credentials as local files, which would mean re-pairing on every single deploy. Nayla instead:
1. Uploads the entire session folder to MongoDB on every credential update, **and**
2. Re-uploads it again on a standalone 60-second interval (independent of credential-update events, closing a gap that otherwise causes "Bad MAC" decryption errors after a restart — see [Troubleshooting](#-troubleshooting)), **and**
3. Downloads it back from MongoDB to local disk *before* Baileys reads it, on every boot.

As long as `MONGODB_URI` points at the same database `pair.js` uploaded to, **you never need to re-pair after the first successful pairing** — restarts and redeploys just work.

### Common deployment mistakes

| Mistake | Symptom | Fix |
|---|---|---|
| Setting `PORT` manually in Render's dashboard | Usually harmless, but unnecessary — Render injects it automatically | Leave `PORT` unset in your environment variables |
| Using a `.env` file on Render | Render doesn't read `.env` files from your repo | Add every variable in Render's **Environment** dashboard tab instead |
| Deploying without ever running `npm run pair` locally first | Bot exits immediately with a "no active session" error | Pair locally once, confirm the session uploaded to MongoDB, *then* deploy |
| Forgetting to allowlist `0.0.0.0/0` (or Render's IPs) in Atlas Network Access | `MongoServerSelectionError`, connection timeout | Update Atlas Network Access rules |
| Running `pair.js` *on* Render itself | No way to interactively scan a QR/enter a pairing code in a headless deploy | Always pair from a local machine, never in the deployed environment |

---

## 🔗 Pairing Your WhatsApp Account

`pair.js` is a **separate, local, one-time-use script** — it is never run as part of the deployed bot.

**What it does:** opens its own short-lived Baileys connection, walks you through linking a device to the target WhatsApp account (the same mechanism as adding WhatsApp Web/Desktop as a linked device), and on success, uploads the resulting session credentials to the `Session` collection in your MongoDB database.

**When you need to run it:**
- The very first time you set up the bot
- If you see `❌ [CRITICAL LOG-IN FAILURE]` in the logs (no session found in MongoDB and no local session either)
- If WhatsApp logs the session out (status code `401` in the logs) — clear the `sessions` collection in MongoDB first, then re-pair
- If you intentionally want to switch which WhatsApp account the bot runs as

**When you *don't* need to run it:**
- Normal restarts or redeploys — the session is restored from MongoDB automatically
- After a `440` (session-conflict) disconnect — that means *another* device took over the same session; check for a duplicate running instance rather than re-pairing
- After a `405` (protocol version) disconnect — this self-corrects automatically on reconnect; re-pairing won't help

> ⚠️ `pair.js` and `index.js` must point at the **exact same** `MONGODB_URI` database. If pairing "doesn't take effect" on your deployed bot, this mismatch is the first thing to check.

---

## 💬 Commands

All commands are case-insensitive and prefixed with `.`. Nayla also responds without any command at all when @mentioned, when "Nayla" is said in a message, or when you reply directly to one of her own messages.

### Everyone

<details open>
<summary><strong>Show all 15 general commands</strong></summary>

<br/>

| Command | Description | Example |
|---|---|---|
| `.rank` / `.level` | Shows your XP and title | `.rank` |
| `.stats` | Quick bot health snapshot | `.stats` |
| `.health` / `.info` / `.bot` | Full system diagnostics — AI chain, MongoDB, search/vision/audio/TTS availability, resource usage | `.health` |
| `.mood` | Shows the current personality for this chat | `.mood` |
| `.about` | What the bot is, in-character | `.about` |
| `.owner` | Who made the bot | `.owner` |
| `.search <query>` | Web search via Tavily, answer synthesized by AI | `.search latest Node.js LTS version` |
| `.imagine <prompt>` | Generates an image (no API key needed) — also triggers on natural language | `.imagine a cat astronaut` |
| `.sticker` | Reply to an image/sticker — converts it into a proper WhatsApp sticker | *(reply to a photo)* `.sticker` |
| `.tts <question>` | Answers as a spoken voice note instead of text — can reply to an image/voice-note/link too | `.tts explain quantum tunneling` |
| `.truth` / `.dare` | A fresh, AI-generated truth or dare — also triggers on "let's play truth or dare" | `.dare` |
| `.quote` | An AI-generated quote — never a fabricated attribution | `.quote` |
| `.eli5 <topic>` | Explains a topic like you're 5 — topic is optional if you're replying to a message | `.eli5 black holes` |
| `.ping` | Latency check | `.ping` |
| `.flip` / `.roll [sides]` / `.8ball` | Zero-cost fun commands | `.roll 20` |

</details>

<sup>`.sticker` also accepts the common typo `.stiker` as an exact alias.</sup>

### Group Admins Only

<details open>
<summary><strong>Show all 16 group-admin commands</strong></summary>

<br/>

| Command | Description | Bot must be group admin? | Example |
|---|---|:---:|---|
| `.settings` | This group's status — mute state, mood, lock state, ignored-user count, session counters | — | `.settings` |
| `.activity` | 7-day activity heatmap by hour | — | `.activity` |
| `.lock` / `.unlock` | Restrict messaging to admins only | ✅ | `.lock` |
| `.mood <name>` | Changes the group's personality | — | `.mood professor` |
| `.moviemode on` / `off` | Toggles the daily Movie Mode recap | — | `.moviemode off` |
| `.newsletter on` / `off` | Toggles the Daily Newspaper | — | `.newsletter on` |
| `.kick` | Removes a member — reply to their message or @mention them | ✅ | *(reply)* `.kick` |
| `.promote` / `.demote` | Toggles group-admin status — reply or @mention | ✅ | `.promote @user` |
| `.tagall` / `.everyone` | Mentions every member with real, tappable tags | ✅ | `.tagall` |
| `.del` / `.delete` | Reply to a message — deletes it (the **only** deletion path in the bot) | ✅ | *(reply)* `.del` |
| `.mute` / `.unmute` | Total silence in this group until `.unmute` — no exceptions, not even other commands | — | `.mute` |
| `.ignore` | Silences one person in this group entirely — reply or @mention | — | *(reply)* `.ignore` |
| `.ignorelist` | Shows who's currently ignored | — | `.ignorelist` |
| `.undoignore <@user\|all>` | Un-ignores one person or everyone | — | `.undoignore all` |

</details>

**Available moods:** `cool` (default) · `gen_z` · `strict_mod` · `playful` · `sarcastic` · `flirty` · `motivational` · `empathic` · `inquisitive` · `chill` · `therapist` · `professor` · `lecturer` · `grandma`

**Natural-language triggers (no command needed):** "draw me a cat" → `.imagine` · "let's play truth or dare" → Truth/Dare session · "gimme a quote" → `.quote` · "explain this in a voice note" → `.tts`-style reply · replying to media + "what's this?"/"explain"/"analyze" → combined analysis

---

## 🔀 AI Provider System

Nayla never depends on a single AI vendor. Every AI call — chat, vision, audio, or TTS — walks a **prioritized, sequential** chain of providers, never in parallel.

### The chat chain

```
Groq → Cerebras → Gemini → OpenRouter → Mistral
```

All five are genuinely free-forever with no card required, and all speak the same OpenAI-compatible `/chat/completions` schema, called via plain `fetch()` — no vendor SDK required for any of them.

| Order | Provider | Model | Also used for |
|:---:|---|---|---|
| 1 | Groq | `llama-3.3-70b-versatile` | Vision (fallback), audio transcription |
| 2 | Cerebras | `llama-3.3-70b` | — |
| 3 | Google Gemini | `gemini-flash-latest` *(auto-updating alias)* | Vision (primary) |
| 4 | OpenRouter | `meta-llama/llama-3.3-70b-instruct:free` | Vision (fallback) |
| 5 | Mistral | `mistral-small-latest` | — |

> **Why `gemini-flash-latest` and not a pinned version?** Pinned Gemini model versions have been observed returning hard 404s well ahead of their official retirement dates. The `-latest` alias is Google's own auto-updating pointer, specifically designed so integrations don't need a code change every time a version is retired.

### Failover behavior

- **Sequential, never parallel** — a provider only gets tried if every higher-priority one already failed for this specific call.
- **Per-provider cooldown** — a provider that fails is skipped on subsequent calls for a while, rather than being retried immediately on every message:
  - **60 seconds** for a transient failure (timeout, rate limit, temporary outage)
  - **30 minutes** for an authentication failure (bad/revoked key) — a broken key isn't going to fix itself in 60 seconds, so this avoids wasting a retry on every message until a human fixes `.env`
  - If *every* provider is cooling down simultaneously, cooldowns are ignored rather than failing with zero attempts
- **Absolute 35-second deadline** across the *entire* call, independent of chain length — bounds worst-case wait time regardless of how many providers get tried.
- **Up to 10 rotating keys per provider** — `GROQ_API_KEY`, `GROQ_API_KEY_1` … `GROQ_API_KEY_10`, any combination, same pattern for every provider.

### Vision and TTS have their own, separate chains

Vision: **Gemini → OpenRouter → Groq** (a smaller, vision-capable subset, since not every provider above supports image input).
TTS: **ElevenLabs → StreamElements → plain text** — no equally clean "free forever" option exists for TTS as of this writing, so this chain is deliberately structured differently from the others (see [`NAYLA_PROJECT_DOCUMENTATION.md`](./NAYLA_PROJECT_DOCUMENTATION.md) §17.7/§18.9 for the full reasoning).

---

## 🍃 Database

MongoDB Atlas is used for two distinct purposes: **session persistence** (so the bot doesn't need re-pairing on every restart) and **long-term memory** (stats, facts, group configuration, archives). If `MONGODB_URI` is unset, the bot still runs — it just loses all of this across restarts.

| Collection | Purpose | TTL | Written how often |
|---|---|:---:|---|
| **`Session`** | Live WhatsApp login credentials | None *(deliberate — expiring this logs the bot out)* | On every credential change, plus a standalone 60-second interval |
| **`UserStat`** | XP, message count, per-person, global | **1 year** of inactivity | Batched, dirty-flagged (never per-message) |
| **`UserChatFacts`** | Small remembered facts about a person, scoped to **one specific chat** — a DM and every group are separate memory spaces for the same person | **30 days** of inactivity | Batched, dirty-flagged |
| **`GroupConfig`** | Active configuration: mood, mute state, ignore list, lock state, Movie Mode/Newsletter toggles | None *(deliberate — active config, not accumulating junk)* | On change, with automatic retry + periodic reverification for mute/ignore specifically |
| **`ConversationArchive`** | Write-only dump of a group's rolling 50-message buffer once it fills up | **30 days** | Once per 50-message cycle |
| **`ActivityLog`** | One small 24-hour bucket array per group per day, for `.activity` | **8 days** *(`.activity` only ever looks at the last 7)* | Batched on the 10-minute scheduler |

> **Why per-chat-scoped facts matter:** an earlier version of this bot kept facts globally per-person, which meant something discussed in a private DM could resurface in an unrelated group. This was treated as a confirmed privacy bug and fixed by scoping facts to `(person, specific chat)` pairs. Any new "memory" feature should default to this same narrow scope.

---

## ⚙️ Configuration Guide

### ✅ Safe to change

| What | Where | Notes |
|---|---|---|
| `NEWSPAPER_HOUR`, `TZ` | Environment variables | Purely scheduling, no downstream effects |
| `ELEVENLABS_VOICE_ID` | Environment variable | Pins a specific voice once you've created one |
| Which AI provider keys are set | Environment variables | The chain adapts automatically to whichever keys are present |
| `AVAILABLE_MOODS` / `MOOD_DESCRIPTIONS` | `index.js` | Add a new personality by adding one entry to each and (optionally) referencing it in `BASELINE_TONE_RULES` |
| `BOT_CONFIG.name` / `.creator` | `index.js` | Rebranding — just make sure `creatorPronouns` stays accurate, it's fed directly into AI prompts |

### ⚠️ Change with caution — read the reasoning first

| Constant | Current value | Why it's set this way |
|---|---|---|
| `MAX_AI_INPUT_CHARS` | `4000` | A deliberately huge paste was confirmed to trip a real provider-side rate limit for 50+ minutes in production. This cap exists to prevent that class of incident, not as an arbitrary limit. |
| `MAX_CONCURRENT_HEAVY_TASKS` / `MAX_HEAVY_QUEUE_DEPTH` | `4` / `12` | Tuned for a 512MB container. Raising these on a memory-constrained host risks OOM under a burst of image/vision/TTS requests. |
| `HEAVY_TASK_HARD_TIMEOUT_MS` | `25000` | A safety net that force-releases a concurrency slot no matter what — lowering it risks killing genuinely slow-but-working requests; removing it entirely risks a stuck slot hanging forever. |
| `PROVIDER_COOLDOWN_MS` / `PROVIDER_AUTH_FAILURE_COOLDOWN_MS` | `60000` / `1800000` | Lowering the auth-failure cooldown reintroduces wasted retries against a key that's known to be dead until a human fixes it. |
| `RAID_JOIN_THRESHOLD` / `RAID_WINDOW_MS` | `5` / `60000` | Tune carefully for your group sizes — too low and normal group-invite bursts will trigger false lockdowns. |
| `DUPLICATE_SPAM_THRESHOLD` / `_COOLDOWN_MS` | `3` / `5 min` | Below 3, ordinary repeated confirmations ("ok", "ok") start getting flagged as spam. |

### 🚫 Don't do this

- **Don't reintroduce automated message deletion or warnings.** This was a deliberate, permanent architectural decision after a sustained pattern of false positives — see the documentation's history before ever revisiting it.
- **Don't add a raw string/JID comparison anywhere.** Always use `isSelfJid()` / `isJidInList()` — WhatsApp's `@lid` identity system has caused this exact class of bug independently in at least five different functions across this project's history.
- **Don't put a literal, copyable example phrase inside an AI system prompt.** Models will reproduce it verbatim as if it were the desired output — describe tone in words instead.
- **Don't add a new external `fetch()` call without `fetchWithTimeout()`, or a new long-running task without `runHeavyTask()`.** The worst production incident in this project's history came from exactly this omission.

---

## ⚡ Performance & Reliability

<table>
<tr><td width="50%" valign="top">

**Timeouts & Circuit Breaking**
- Every external `fetch()` call is wrapped in a real `AbortController`-based timeout — not just a `Promise.race`, which leaves the underlying request running
- A hard 25-second safety net on every heavy task, independent of any per-call timeout
- A 3-strikes circuit breaker on the ambient vibe-check pass, with a 60-second cooldown before retrying
- An absolute 35-second ceiling on the entire AI-provider chain walk, regardless of chain length

**Concurrency Control**
- Global limiter: 4 concurrent heavy tasks (search / vision / audio / image-gen), bounded 12-deep queue beyond that
- New requests past the queue limit fail fast with a clear message rather than piling up forever
- Normal chat replies deliberately bypass this limiter — they have their own timeout system, so a busy media queue can never block ordinary conversation

</td><td width="50%" valign="top">

**Connection Resilience**
- WhatsApp Web protocol version fetched fresh at every boot (prevents stale-protocol `405` rejections)
- Exponential reconnect backoff (12s → 24s → up to 45s cap), giving up after 8 consecutive failures
- The failure counter only resets after a connection proves itself stable for 30 seconds — a connection that opens and immediately gets kicked can't silently reset the safety net
- A dedicated fatal-error detector intentionally **restarts** the process on a corrupted WhatsApp encryption state, rather than continuing to run as an unresponsive "zombie" that looks alive in the logs

**Memory Management**
- Every in-memory cache (rate limits, cooldowns, sessions, buffers) is bounded and self-expiring
- A heap-pressure monitor flushes every non-essential cache if usage crosses 380MB
- MongoDB writes are dirty-flag batched on a 10-minute cycle, never per-message

</td></tr>
</table>

---

## 🩺 Troubleshooting

<details open>
<summary><strong>Common issues and fixes</strong></summary>

<br/>

| Problem | Likely Cause | Solution |
|---|---|---|
| Bot disconnects every 20–45 seconds on Render | Health-check port not bound in time | Confirm the keep-alive HTTP server is running (check for `🌐 Keep-alive server listening on port...` in logs); confirm Start Command is `node index.js` |
| Repeated **"Bad MAC" / "Unsupported state"** errors after a restart | Stale session state restored from MongoDB — the Signal Protocol double-ratchet desynced from what senders actually used | The bot now self-heals: this triggers an intentional restart with a fresh connection attempt. If it persists, clear the `sessions` collection in MongoDB and re-pair. |
| Connection closes with status `405` | Stale bundled WhatsApp Web protocol version | Should self-correct automatically (the version is fetched fresh at every boot). If it persists, run `npm update @whiskeysockets/baileys`. |
| Connection closes with status `401` | Session was logged out / revoked from the WhatsApp app itself | Clear the `sessions` collection in MongoDB, run `npm run pair` again |
| Connection closes with status `440` | Another device/instance took over the exact same session | Check for a duplicate running instance (a second Render service, a local `npm start`, another host) or a duplicate entry under WhatsApp → Linked Devices |
| No AI response at all, or `🔑 My whole brain is unplugged` | No AI provider keys configured | Set at least one of `GROQ_API_KEY` / `CEREBRAS_API_KEY` / `GEMINI_API_KEY` / `OPENROUTER_API_KEY` / `MISTRAL_API_KEY` |
| Slow AI responses, or "brain lag" messages | Primary provider(s) cooling down after a failure | Check `.health` for provider chain status; add a second provider's key for redundancy |
| MongoDB not saving anything | `MONGODB_URI` unset, wrong, or Atlas Network Access blocking the connection | Verify the connection string; ensure `0.0.0.0/0` (or your host's IP) is allowlisted in Atlas |
| `.mute`/`.ignore` "reverts" after a restart | A transient write failure at the moment the command ran | As of the current version, these retry automatically and warn honestly if they couldn't confirm the save — check for that warning in the bot's own reply |
| Bot ignores a reply to an image / says "I don't see anything" | The quoted message wasn't a real reply, or (historically) an unrecognized WhatsApp message envelope | Make sure you're using an actual swipe-reply, not just typing near the image. If it persists, check the console for a `⚠️ [QUOTE DETECTION]` warning — it prints exactly what structure wasn't recognized |
| `.tts` says "WhatsApp says something is wrong with the Audio" | `ffmpeg-static` not installed, sending non-OGG audio with `ptt: true` | Run `npm install ffmpeg-static`; without it, `.tts` falls back to a regular (non-voice-note) audio attachment instead, which always plays fine |
| ElevenLabs TTS returns a 402 / "upgrade your subscription" error | Free ElevenLabs accounts can't use shared "library" voices via the API | Create a custom voice (Voice Cloning or Voice Design, both free-tier) at elevenlabs.io — the bot auto-resolves it, no code change needed |
| `.imagine` silently does nothing | Pollinations.ai returned an error page or an oversized/undersized response | Check console logs for the specific HTTP status; this is validated and logged explicitly rather than failing silently |
| `.search` says web search isn't set up | `TAVILY_API_KEY` unset | Set `TAVILY_API_KEY` |
| Bot responds twice, or seems to "remember" the wrong thing | Rare — usually a sign the AI response was regenerated after a timeout race | Check for duplicate `messages.upsert` handling in logs; this shouldn't happen under normal operation, please report it |
| High Render memory usage / crash | A burst of concurrent heavy tasks (images/voice notes) on a very active bot | This is bounded by design (`MAX_CONCURRENT_HEAVY_TASKS`), but consider Render's paid tier for consistently high-traffic deployments |

</details>

---

## 🔄 Updating & Maintenance

- **Updating Baileys:** `npm update @whiskeysockets/baileys`. WhatsApp's multi-device protocol changes periodically; an outdated Baileys version is the most common cause of a bot that suddenly can't connect at all. Treat this as recurring maintenance, not a one-time fix.
- **Rotating AI provider keys:** just set/replace the relevant `_N` suffixed variable and restart — no code change needed, and old keys can be removed at any time.
- **Adding a new AI provider:** add one entry to `PROVIDER_DEFS` (name, env var base, base URL, model) — as long as it speaks the OpenAI-compatible `/chat/completions` schema, everything else (key rotation, cooldowns, failover) works automatically.
- **MongoDB schema changes:** this project doesn't use formal migrations — Mongoose schemas use optional fields with sensible defaults specifically so old documents remain valid after a schema addition (see how `movieModeEnabled`/`newsletterEnabled` default to `true` for pre-existing groups as the pattern to follow).
- **Dependency updates generally:** `sharp` and `ffmpeg-static` are optional and fail closed — safe to update independently or skip entirely.

---

## ❓ FAQ

<details>
<summary><strong>Click to expand the full FAQ (22 questions)</strong></summary>

<br/>

**Q: Does this use the official WhatsApp Business API?**
No. It connects as a linked/companion device on a real personal or business WhatsApp account, the same way WhatsApp Web does. See the disclaimer at the top of this README.

**Q: Can I run this on my main personal WhatsApp number?**
Technically yes, but consider a secondary number — automating a WhatsApp account carries inherent risk of the account being flagged, and a bot account is easier to reason about than your daily-driver number.

**Q: Does the bot ever delete messages or issue warnings automatically?**
No, never. This is a permanent, deliberate design decision. The only deletion capability anywhere in the bot is the manual, admin-invoked `.del` command.

**Q: What happens if I don't set any AI provider key?**
The bot still runs. It falls back to local regex-based detection for the ambient vibe-check pass (with canned, non-AI commentary), but real conversational replies won't work — you'll get an honest "my whole brain is unplugged" message instead of a crash.

**Q: What happens if MongoDB isn't configured?**
The bot still runs, with a console warning. You lose session persistence (re-pairing needed every restart) and all long-term memory (stats, facts, group settings, archives).

**Q: Why does the bot need to be a "group admin" for some commands but not others?**
`.kick`/`.promote`/`.demote`/`.del` genuinely require WhatsApp admin permissions at the protocol level. `.tagall` doesn't technically require it, but is deliberately gated behind the same bar as a security/access-control choice, not a protocol requirement.

**Q: Can I change the bot's name/personality?**
Yes — `BOT_CONFIG.name`, and the `AVAILABLE_MOODS`/`MOOD_DESCRIPTIONS` list for personalities. See [Configuration Guide](#-configuration-guide).

**Q: Why 5 different AI providers instead of just one reliable one?**
Free-tier AI APIs individually have real, sometimes tight rate limits. A 5-provider sequential failover chain means a single provider having a bad day doesn't take the whole bot down.

**Q: Does the bot read every message in a group?**
Every message is briefly seen (for rate-limiting, bookkeeping, and the optional ambient "vibe-check" pass), but a real AI conversational reply only happens when the bot is directly addressed — @mentioned, called by name, or replied to — or in a 1:1 DM, where every message gets a reply since there's no one else to address.

**Q: Does replying to an old message work, or only the most recent one?**
Any message, from anyone, at any point — WhatsApp attaches the quoted content directly to the reply itself, so the bot doesn't need to have "remembered" it from earlier in a buffer.

**Q: Why does DM behavior differ from group behavior in places?**
DMs always get a reply (no one else to address), don't get the ambient vibe-check pass, and don't participate in Movie Mode/Daily Newspaper (both explicitly group-only features).

**Q: Is there a cost to running this?**
Render's free tier and MongoDB Atlas's free M0 tier are both genuinely free. Every AI/search/TTS provider integrated is free-tier-first. The only realistic cost is if you exceed a free tier's limits at high traffic and choose to upgrade.

**Q: Can multiple people share ownership/admin of the bot?**
The bot has one designated "owner" for branding/`.owner` purposes, but any WhatsApp group admin can use the group-admin commands in their own group — there's no separate bot-level permission tier beyond WhatsApp's own admin status.

**Q: How is user data stored — is it encrypted?**
MongoDB Atlas encrypts data at rest by default. The WhatsApp session itself represents a live login and should be treated with the same sensitivity as a password — see [Security](#-security).

**Q: Can the bot understand images sent by other people, not just the owner?**
Yes — vision works on any image/sticker sent or quoted by anyone, subject to the same addressing rules as text (must be addressed in a group, always eligible in a DM).

**Q: Why does `.tts` sometimes send a normal audio file instead of a voice-note bubble?**
`ffmpeg-static` (which produces the real OGG/Opus encoding WhatsApp voice notes require) is an optional dependency. Without it installed, `.tts` still works, just as a regular playable audio attachment instead of a voice-note-styled bubble.

**Q: Can I add new commands?**
Yes — see [Development Guide](#-development-guide). Follow the existing pattern in `handleCommand()`, and remember dot-commands with arguments need `cmd === base || cmd.startsWith(base + " ")`, never exact equality.

**Q: Does the bot store message content long-term?**
Only a rolling 50-message-per-chat buffer, archived to MongoDB with a 30-day TTL once it overflows. Per-person "facts" are much smaller and scoped to the specific chat they were learned in, with their own 30-day TTL.

**Q: What's the difference between `.mute` and `.ignore`?**
`.mute` silences the bot for an **entire group** — nothing works except `.unmute`. `.ignore` silences the bot toward **one specific person** in that group — everyone else still gets normal replies.

**Q: Why does raid protection sometimes not actually lock the group?**
Locking a group requires the bot to already be a group admin. If it isn't, raid protection still detects and warns about the join burst, but can't enforce a lockdown without admin rights.

**Q: Is there a web dashboard?**
No — `.health` and `.stats` (in-chat commands) are the entire observability surface. This is a deliberate scope decision for a single-owner, single-file project.

**Q: Where do I report a bug or read about one that's already been found?**
See [`NAYLA_PROJECT_DOCUMENTATION.md`](./NAYLA_PROJECT_DOCUMENTATION.md) — it contains a full, continuously-updated history of every confirmed bug, including ones still open, before you file a new one.

</details>

---

## 🔐 Security

- **Never commit `.env`, `MONGODB_URI`, or any API key to version control.** Add `.env` to `.gitignore` before your first commit.
- **The MongoDB `Session` collection is as sensitive as a password.** Anyone with read access to it can restore your WhatsApp session and act as that account. Restrict Atlas database-user permissions and network access accordingly.
- **API keys should be scoped to what they need.** None of the providers integrated here require more than a basic inference/API-access scope — don't grant broader account permissions than necessary.
- **This bot operates as a self-bot / companion device**, not through WhatsApp's official Business API. Automating a personal account this way is not an officially sanctioned integration path and may carry account-level risk under WhatsApp's Terms of Service. Consider using a dedicated, non-primary number.
- **No automated moderation, ever.** There is no code path anywhere in this bot that can delete a message or take punitive action without a human admin explicitly invoking `.del`/`.kick`/etc. in the moment.
- **The bot never fetches arbitrary user-supplied URLs.** Link "awareness" is domain-name-only string parsing — there is no server-side page-fetching capability, deliberately, to avoid SSRF and memory-exhaustion risk on a resource-constrained host.

---

## 🛠 Development Guide

<details>
<summary><strong>Coding philosophy and patterns to follow</strong></summary>

<br/>

- **Extend the canonical helper, don't build a parallel one.** `unwrapMessageContent()`, `getContextInfo()`, `isSelfJid()`, `isJidInList()`, `callAIProvider()`, `runHeavyTask()`, and `fetchWithTimeout()` each exist so every call site behaves identically. A new feature that needs any of these capabilities should call the existing function, not reimplement a piece of it inline.
- **Every identity comparison must be LID-aware.** WhatsApp's `@lid` identity system means the same account can appear in two different-looking JID formats depending on context. Always normalize through `isSelfJid()`/`isJidInList()`.
- **Every "is this a reply" check must go through `getContextInfo()`.** Never hardcode `extendedTextMessage.contextInfo` — a reply made with media (image/sticker/voice-note) carries its context under that media type's own field instead.
- **Every external `fetch()` needs `fetchWithTimeout()`, no exceptions** — including ones that feel "too quick to need one." The worst production incident in this project's history came from exactly that assumption.
- **Every long-running task goes through `runHeavyTask()`** — it has its own hard safety-net timeout, but a per-call timeout is still the first line of defense.
- **Every AI prompt includes `BASELINE_TONE_RULES`**, and never contains a literal, copyable example phrase — models will reproduce it verbatim as if it were the desired output.
- **New "memory" features default to per-chat scope**, not global-per-person, unless there's a specific, deliberate reason otherwise.
- **Dot-commands that accept an argument must match with `cmd === base || cmd.startsWith(base + " ")`**, never exact equality — `cmd === ".kick"` alone silently fails to match `.kick @user`.
- **Any command resolving a target from a reply (`resolveCommandTarget()`) must check `isSelfJid()` against the result** before acting on it.
- **Graceful degradation over crashing, with a small set of deliberate exceptions.** Missing config should disable a feature with an honest in-chat message, not throw. The only exception is a small, explicitly-named set of genuinely fatal connection/encryption errors, which intentionally trigger a restart rather than running on as a silent zombie.
- **Verify a pasted or AI-generated diagnosis against the real protocol/schema before trusting it.** A plausible-sounding explanation is not evidence on its own.

**Before opening a change that touches:** identity comparison, message-type/media detection, the message pipeline's ordering, or AI prompt construction — read `NAYLA_PROJECT_DOCUMENTATION.md`'s "Known Recurring Bug Patterns" section first. Several bug classes have already been reintroduced once by not doing this.

</details>

---

## 🙏 Credits

| Service / Library | Role |
|---|---|
| [Baileys](https://github.com/WhiskeySockets/Baileys) | WhatsApp multi-device Web API client |
| [MongoDB Atlas](https://www.mongodb.com/atlas) | Session persistence and long-term memory |
| [Render](https://render.com) | Hosting |
| [Groq](https://groq.com) | Primary chat AI, vision fallback, audio transcription (Whisper) |
| [Cerebras](https://cerebras.ai) | Chat AI |
| [Google Gemini](https://ai.google.dev) | Chat AI, vision |
| [OpenRouter](https://openrouter.ai) | Chat AI, vision fallback |
| [Mistral](https://mistral.ai) | Chat AI |
| [Tavily](https://tavily.com) | Web search |
| [Pollinations.ai](https://pollinations.ai) | Image generation |
| [ElevenLabs](https://elevenlabs.io) | Primary text-to-speech |
| StreamElements | Fallback text-to-speech |
| [sharp](https://sharp.pixelplumbing.com) | Image processing (optional) |
| [ffmpeg](https://ffmpeg.org) via `ffmpeg-static` | Audio transcoding (optional) |

---

## 📄 License

No license has been chosen for this project yet. Until a `LICENSE` file is added, all rights are reserved by the project owner under default copyright — treat this as a private/personal project rather than an openly-licensed one.

<div align="center">

*If you're picking this project up cold, read [`NAYLA_PROJECT_DOCUMENTATION.md`](./NAYLA_PROJECT_DOCUMENTATION.md) next.*

</div>
## FOR EASE, YOU CAN JUST DOWNLOAD THE CODE, RUN PAIR.JS ON KATABUMP(CREATE ACCOUNT )STOP, RUN THE MAIN INDEX.JS AFTER, (YOU CAN CREATE A .ENV FILE WITH ALL NECESSARY VARIABLES AND UPLOAD TO KATABUMP TOO, BECAUSE RENDER'S FREE TIER CAPS AT 5GB BANDWIDTH 
