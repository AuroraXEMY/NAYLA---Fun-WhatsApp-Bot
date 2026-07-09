/**
 * WhatsApp Moderation & Chat Bot (Gemini-Powered)
 * 
 * DESIGNED FOR RESILIENCY & RESOURCE-CONSTRAINED ENVIRONMENTS (RENDER 512MB RAM)
 * 
 * Features:
 * - Multi-device WhatsApp connection using @whiskeysockets/baileys (No Chromium required!)
 * - Server-side AI integration using the Groq API (free tier, OpenAI-compatible)
 * - MongoDB integration via Mongoose to persist credentials (no constant re-logging!)
 * - Configured Vibe: "cool"
 * - Real-time spam, link, toxicity and keyword moderation
 * - ZERO-PAIRING startup flow: Loads authenticated session from MongoDB Atlas securely!
 * - 50+ Advanced Anti-Crash, Memory leak, Flood, and API Failure protection systems
 */

const { 
  default: makeWASocket, 
  DisconnectReason, 
  useMultiFileAuthState, 
  fetchLatestWaWebVersion,
  delay 
} = require("@whiskeysockets/baileys");
const Groq = require("groq-sdk");
const mongoose = require("mongoose");
const pino = require("pino");
const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");
require("dotenv").config();

// ==========================================
// 🌐 KEEP-ALIVE / HEALTH-CHECK SERVER
// ==========================================
// Render's free-tier Web Services require a bound HTTP port within ~90s of deploy,
// even though this bot is a WhatsApp socket + Mongo worker with no real web traffic.
// Without this, Render's port scanner times out and recycles the ENTIRE container
// on a loop — which is what was tearing down the WhatsApp socket every 20-45s and
// showing up as repeated 440 (connectionReplaced) disconnects in the logs.
// This MUST live at module scope (not inside startBot()) — startBot() recurses on
// every reconnect, and calling .listen() on the same port twice crashes with EADDRINUSE.
const PORT = process.env.PORT || 10000;
http.createServer((req, res) => {
  if (req.url === "/ping" || req.url === "/") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("PONG - Nayla Keep-Alive is Active! 🌴😎\n");
  } else {
    res.writeHead(404);
    res.end();
  }
}).listen(PORT, "0.0.0.0", () => {
  console.log(`🌐 Keep-alive server listening on port ${PORT} (Render health check)`);
});

// --- Self-ping loop so Render's free tier doesn't spin this service down ---
// Render only counts INBOUND traffic to this service toward the 15-min idle
// clock — the bot's outbound WhatsApp socket doesn't count. This pings our
// own public URL every 10 minutes to keep that clock from ever expiring.
// (Folded in from the separate server.js — running that as a second process
// would either crash on the same PORT, or never actually boot the bot at all.)
const SELF_URL = process.env.RENDER_EXTERNAL_URL;
if (SELF_URL) {
  console.log(`⏱️ [KEEP-ALIVE] Self-ping loop active. Target: ${SELF_URL}`);
  // FIX: RENDER_EXTERNAL_URL is always https:// in production, but the old
  // code always used the http module, which throws ERR_INVALID_PROTOCOL on
  // any https:// URL. This was crashing every 10 minutes (caught by the
  // uncaughtException trap, so the process survived) — meaning the self-ping
  // itself has never once actually succeeded since deployment.
  const client = SELF_URL.startsWith("https") ? https : http;
  setInterval(() => {
    client.get(SELF_URL, (res) => {
      console.log(`💓 [KEEP-ALIVE] Self-ping successful: Status ${res.statusCode}`);
    }).on("error", (err) => {
      console.error("⚠️ [KEEP-ALIVE] Self-ping failed:", err.message);
    });
  }, 10 * 60 * 1000); // 10 minutes — safely under Render's 15-min spin-down window
} else {
  console.warn("⚠️ [KEEP-ALIVE] RENDER_EXTERNAL_URL not set — self-ping loop disabled. Free tier may still spin down after 15 idle minutes.");
}

// ==========================================
// 🛡️ 50+ ADVANCED ANTI-CRASH & PROTECTION SUITE
// ==========================================

// --- PROTECTION TIER 1: GLOBAL UNCAUGHT CRASH TRAPS ---
process.on("uncaughtException", (err) => {
  console.error("🔥 [ANTI-CRASH] Uncaught Exception trapped successfully:", err.message);
  console.error(err.stack);
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("🔥 [ANTI-CRASH] Unhandled Promise Rejection trapped successfully:", reason);
});

// --- PROTECTION TIER 2: LOCAL HIGH-SPEED REGEX FALLBACK ENGINE (ZERO-LATENCY / NO COSTS) ---
const LOCAL_BAD_WORDS = [
  "scam", "crypto double", "giveaway free", "make money quick", "fuck", "bitch", "asshole", 
  "retard", "idiot", "motherfucker", "bastard", "dickhead", "pussy"
];

function fallbackLocalModerate(text) {
  const textLower = text.toLowerCase();
  
  // 1. Banned Link Regex Rule
  if (BOT_CONFIG.rules.blockLinks) {
    const linkRegex = /(https?:\/\/)?(www\.)?[-a-zA-Z0-9@:%._\+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b([-a-zA-Z0-9()@:%_\+.~#?&//=]*)/gi;
    if (linkRegex.test(textLower)) {
      return {
        action: "delete",
        replyMessage: "🚫 Link spam is strictly prohibited in this group chat.",
        reason: "Matched local blockLinks regex pattern."
      };
    }
  }

  // 2. Anti-Spam Flood Regex Rule
  if (BOT_CONFIG.rules.blockSpam) {
    const repeatingCharRegex = /(.)\1{15,}/i;
    if (text.length > 800 || repeatingCharRegex.test(textLower)) {
      return {
        action: "delete",
        replyMessage: "⚠️ Spam flood detected and discarded instantly.",
        reason: "Matched spam-length or character flood regex."
      };
    }

    // ALL-CAPS shouting: only checked on messages with real letters and
    // enough length to be meaningful (avoids false-flagging short "OK"/"LOL").
    const letters = text.replace(/[^a-zA-Z]/g, "");
    if (letters.length >= 12 && letters === letters.toUpperCase()) {
      return {
        action: "warn",
        replyMessage: "🔊 Whoa, all caps! Mind dialing it down a notch? 😅",
        reason: "Matched all-caps shouting heuristic."
      };
    }

    // Emoji flood: a wall of 10+ emoji in one message.
    const emojiMatches = text.match(/\p{Extended_Pictographic}/gu) || [];
    if (emojiMatches.length >= 10) {
      return {
        action: "warn",
        replyMessage: "🎉 Love the enthusiasm, but that's a lot of emoji! 😅",
        reason: "Matched emoji-flood heuristic."
      };
    }
  }

  // 3. Toxicity Fallback
  for (const badWord of LOCAL_BAD_WORDS) {
    if (textLower.includes(badWord)) {
      return {
        action: "warn",
        replyMessage: "⚠️ Please keep the conversation respectful and avoid offensive language.",
        reason: "Matched local list blacklist term."
      };
    }
  }

  return { action: "approve", replyMessage: "", reason: "Approved via fallback local checks." };
}

// --- PROTECTION TIER 3: CIRCUIT BREAKER (HANDLES AI SERVICE DOWN/OUTAGES) ---
let aiFailStreak = 0;
let circuitBreakerOpen = false;
let circuitBreakerResetTime = 0;

function checkCircuitBreaker() {
  if (circuitBreakerOpen) {
    if (Date.now() > circuitBreakerResetTime) {
      console.log("⚡ [CIRCUIT BREAKER] Retrying Gemini AI connection (Cool-down expired)...");
      circuitBreakerOpen = false;
      aiFailStreak = 0;
    } else {
      return true; // Circuit is open, use local fallback
    }
  }
  return false;
}

function recordGeminiFailure() {
  aiFailStreak++;
  if (aiFailStreak >= 3) {
    circuitBreakerOpen = true;
    circuitBreakerResetTime = Date.now() + 60000; // Open for 60 seconds
    console.error("⚡ [CIRCUIT BREAKER ALERT] 3 consecutive Gemini failures. Switched to LOCAL REGEX ENGINE for 60 seconds!");
  }
}

// --- PROTECTION TIER 4: GLOBAL IN-MEMORY SEQUENTIAL QUEUE (CONSERVES MEMORY, PREVENTS RENDER OOM) ---
const apiRequestQueue = [];
let activeWorkers = 0;
const MAX_CONCURRENT_AI_WORKERS = 1; // Strict serial handling to fit 512MB limit perfectly
const MAX_QUEUE_SIZE = 40; // Hard load shedding limit under severe flood

async function enqueueModerationRequest(sender, text, vibe) {
  if (apiRequestQueue.length >= MAX_QUEUE_SIZE) {
    console.warn("🚨 [LOAD SHEDDING] Queue size limit reached! Processing message instantly using local regex fallback to prevent memory overflow...");
    return fallbackLocalModerate(text);
  }

  return new Promise((resolve) => {
    apiRequestQueue.push({ sender, text, vibe, resolve });
    processNextQueueItem();
  });
}

async function processNextQueueItem() {
  if (activeWorkers >= MAX_CONCURRENT_AI_WORKERS || apiRequestQueue.length === 0) {
    return;
  }

  activeWorkers++;
  const { sender, text, vibe, resolve } = apiRequestQueue.shift();

  try {
    const result = await evaluateMessageWithGroq(sender, text, vibe);
    resolve(result);
  } catch (err) {
    console.error("❌ Queue job execution error:", err.message);
    resolve(fallbackLocalModerate(text));
  } finally {
    activeWorkers--;
    setTimeout(processNextQueueItem, 100);
  }
}

// --- PROTECTION TIER 5: ROLLING FLOOD RATE-LIMITER PER CHAT/USER ---
const chatRateLimits = new Map();
const RATE_LIMIT_WINDOW_MS = 8000; // 8 seconds
const MAX_MESSAGES_IN_WINDOW = 4; // Max 4 messages per user/chat within 8 seconds

function isRateLimited(senderId) {
  const now = Date.now();
  if (!chatRateLimits.has(senderId)) {
    chatRateLimits.set(senderId, [now]);
    return false;
  }

  const timestamps = chatRateLimits.get(senderId).filter(ts => now - ts < RATE_LIMIT_WINDOW_MS);
  timestamps.push(now);
  chatRateLimits.set(senderId, timestamps);

  if (timestamps.length > MAX_MESSAGES_IN_WINDOW) {
    return true; // FLOODING! Silent ignore.
  }
  return false;
}

// --- PROTECTION TIER 6: MEMORY HEAP LEAK MONITOR & TRASH DISPOSAL ---
setInterval(() => {
  const mem = process.memoryUsage();
  const heapUsedMB = mem.heapUsed / 1024 / 1024;
  console.log(`📊 [MEMORY STATUS] Heap Used: ${heapUsedMB.toFixed(1)} MB / 512 MB (Max Allocation Limit)`);
  
  if (heapUsedMB > 380) {
    console.warn("🚨 [CRITICAL MEMORY PREVENTATIVE FLUSH] Heap exceeds 380MB! Purging cached rate limiters and queues to protect server container...");
    chatRateLimits.clear();
    apiRequestQueue.length = 0;
    lastAIReplyTime.clear();
    recentJoins.clear();
    if (global.gc) {
      try {
        global.gc();
        console.log("🧹 [MEM MONITOR] Succeeded forcing Garbage Collection!");
      } catch (e) {}
    }
  }
}, 45000); // Check every 45 seconds

// --- PROTECTION TIER 7: CACHED GROUP ADMIN STATUS (MINIMIZES BAILEYS IN-MEMORY METADATA LOOKUPS) ---
const adminCache = new Map();
const ADMIN_CACHE_TTL = 10 * 60 * 1000; // 10 minutes cache TTL

async function checkIfBotIsAdminInGroup(sock, jid) {
  const cached = adminCache.get(jid);
  if (cached && Date.now() - cached.timestamp < ADMIN_CACHE_TTL) {
    return cached.isAdmin;
  }

  try {
    const groupMetadata = await sock.groupMetadata(jid);
    // FIX: same LID root cause as isBotMentioned — the old code only ever
    // constructed the phone-JID form (...@s.whatsapp.net). In any group
    // where WhatsApp represents the bot's OWN participant entry via its LID
    // instead, that never matched, so the bot always looked like a non-admin
    // even when it genuinely was one.
    const selfNumbers = [sock.user?.id, sock.user?.lid]
      .filter(Boolean)
      .map(j => j.split(":")[0].split("@")[0]);

    const botParticipant = groupMetadata.participants.find(p => {
      const num = p.id.split(":")[0].split("@")[0];
      return selfNumbers.includes(num);
    });
    const isAdmin = !!(botParticipant && (botParticipant.admin === "admin" || botParticipant.admin === "superadmin"));
    
    adminCache.set(jid, { timestamp: Date.now(), isAdmin });
    return isAdmin;
  } catch (err) {
    console.warn("⚠️ Failed fetching group metadata for admin validation:", err.message);
    return false;
  }
}

// ==========================================
// 🎉 TIER 8: GAMIFICATION & FUN-FEATURE STATE
// ==========================================
// Everything here is capped/bounded and flushed to Mongo periodically rather
// than on every message, keeping both RAM and Mongo write-load negligible on
// a personal-scale bot. None of this adds extra Groq requests except Movie
// Mode, which is capped to one call per group per day.
const userStatsCache = new Map();      // jid -> { displayName, xp, messageCount, facts, lastActive, dirty }
const groupMessageBuffers = new Map(); // groupJid -> [{sender, text, ts}], capped to ACTIVE_CONTEXT_CAP
const groupConfigCache = new Map();    // groupJid -> { locked, lastRecapDate, dirty }
const lastAIReplyTime = new Map();     // chatJid -> timestamp, for the reply cooldown
const recentJoins = new Map();         // groupJid -> [{ts, count}], for raid detection
let currentSock = null;                // set once startBot() creates a socket; read by top-level intervals
let statsLoadedOnce = false;

const ACTIVE_CONTEXT_CAP = 50;      // per your spec: ~50 messages of active memory, then archive+reset
const AI_REPLY_COOLDOWN_MS = 4000;  // stops rapid re-tags from burning Groq's free-tier quota
const RAID_JOIN_THRESHOLD = 5;      // N joins...
const RAID_WINDOW_MS = 60000;       // ...within this many ms triggers an auto-lockdown

const LEVEL_TITLES = [
  { level: 0, title: "Newcomer" },
  { level: 3, title: "Regular" },
  { level: 6, title: "Certified Menace" },
  { level: 10, title: "Village Elder" },
  { level: 15, title: "Professor" },
  { level: 20, title: "Chaos God" }
];

function xpToLevel(xp) {
  return Math.floor(Math.sqrt(xp / 10));
}

function levelTitle(level) {
  let title = LEVEL_TITLES[0].title;
  for (const t of LEVEL_TITLES) {
    if (level >= t.level) title = t.title;
  }
  return title;
}

function getUserStats(jid) {
  if (!userStatsCache.has(jid)) {
    userStatsCache.set(jid, { displayName: "Anonymous", xp: 0, messageCount: 0, facts: [], lastActive: new Date(), dirty: true });
  }
  return userStatsCache.get(jid);
}

function bumpUserStats(jid, displayName) {
  const stats = getUserStats(jid);
  stats.displayName = displayName || stats.displayName;
  stats.xp += 1 + Math.floor(Math.random() * 3); // +1 to +3 XP per message
  stats.messageCount += 1;
  stats.lastActive = new Date();
  stats.dirty = true;
  return stats;
}

function addUserFact(jid, fact) {
  if (!fact || !fact.trim()) return;
  const stats = getUserStats(jid);
  const clean = fact.trim().slice(0, 120);
  if (stats.facts.includes(clean)) return;
  stats.facts.push(clean);
  if (stats.facts.length > 5) stats.facts.shift(); // cap to last 5 — bounds both memory and prompt size
  stats.dirty = true;
}

// Batch-flush ONLY changed user stats to Mongo periodically — avoids a write
// on every single message, which would hammer the free Mongo tier for data
// this low-stakes (XP/facts, not moderation state).
async function flushUserStatsToMongo() {
  if (!MONGO_URI) return;
  const dirtyEntries = [...userStatsCache.entries()].filter(([, s]) => s.dirty);
  if (dirtyEntries.length === 0) return;

  for (const [jid, stats] of dirtyEntries) {
    try {
      await UserStat.findOneAndUpdate(
        { jid },
        { displayName: stats.displayName, xp: stats.xp, messageCount: stats.messageCount, facts: stats.facts, lastActive: stats.lastActive },
        { upsert: true }
      );
      stats.dirty = false;
    } catch (err) {
      console.error(`❌ Failed flushing stats for ${jid}:`, err.message);
    }
  }
  console.log(`💾 [STATS] Flushed ${dirtyEntries.length} updated user profile(s) to MongoDB.`);
}

async function loadUserStatsFromMongo() {
  if (!MONGO_URI) return;
  try {
    const all = await UserStat.find({}).limit(2000); // hard cap — plenty for a personal-scale bot
    for (const doc of all) {
      userStatsCache.set(doc.jid, {
        displayName: doc.displayName || "Anonymous",
        xp: doc.xp || 0,
        messageCount: doc.messageCount || 0,
        facts: doc.facts || [],
        lastActive: doc.lastActive || new Date(),
        dirty: false
      });
    }
    console.log(`📥 [STATS] Loaded ${all.length} existing user profile(s) from MongoDB.`);
  } catch (err) {
    console.error("❌ Failed loading user stats from MongoDB:", err.message);
  }
}

function getGroupConfig(jid) {
  if (!groupConfigCache.has(jid)) {
    groupConfigCache.set(jid, { locked: false, lastRecapDate: null, mood: "cool", dirty: false });
  }
  return groupConfigCache.get(jid);
}

async function persistGroupConfig(jid) {
  if (!MONGO_URI) return;
  const cfg = getGroupConfig(jid);
  try {
    await GroupConfig.findOneAndUpdate(
      { jid },
      { locked: cfg.locked, lastRecapDate: cfg.lastRecapDate, mood: cfg.mood },
      { upsert: true }
    );
  } catch (err) {
    console.error(`❌ Failed persisting group config for ${jid}:`, err.message);
  }
}

async function loadGroupConfigsFromMongo() {
  if (!MONGO_URI) return;
  try {
    const all = await GroupConfig.find({}).limit(500);
    for (const doc of all) {
      groupConfigCache.set(doc.jid, { locked: !!doc.locked, lastRecapDate: doc.lastRecapDate || null, mood: doc.mood || "cool", dirty: false });
    }
    console.log(`📥 [CONFIG] Loaded ${all.length} existing group config(s) from MongoDB.`);
  } catch (err) {
    console.error("❌ Failed loading group configs from MongoDB:", err.message);
  }
}

// Active conversational memory: holds the last ACTIVE_CONTEXT_CAP text
// messages per group. Feeds AI chat replies with real context AND doubles as
// Movie Mode's source. Once it hits the cap, the whole buffer is archived to
// MongoDB (a durable "dump") and reset — bounded memory, nothing silently
// lost, and the AI always has a fresh, relevant window instead of stale
// months-old context.
async function bufferGroupMessage(jid, sender, text) {
  if (!groupMessageBuffers.has(jid)) groupMessageBuffers.set(jid, []);
  const buf = groupMessageBuffers.get(jid);
  buf.push({ sender, text: text.slice(0, 200), ts: Date.now() }); // truncate per-message to bound memory

  if (buf.length >= ACTIVE_CONTEXT_CAP) {
    if (MONGO_URI) {
      try {
        await ConversationArchive.create({
          jid,
          transcript: buf.map(m => `${m.sender}: ${m.text}`),
          archivedAt: new Date()
        });
        console.log(`🗄️ [MEMORY] Archived ${buf.length} messages for ${jid} to MongoDB — active context reset.`);
      } catch (err) {
        console.error(`❌ Failed archiving conversation for ${jid}:`, err.message);
        // Fall through and reset anyway — bounding memory matters more than
        // this one archive succeeding.
      }
    }
    groupMessageBuffers.set(jid, []); // reset for a fresh window regardless of archive success
  }
}

// Returns the last `limit` buffered messages as a mini-transcript, capped
// hard regardless of how much is stored, to keep every AI prompt small and
// fast rather than growing with group activity.
function getRecentContext(jid, limit = 15) {
  const buf = groupMessageBuffers.get(jid) || [];
  if (buf.length === 0) return "";
  return buf.slice(-limit).map(m => `${m.sender}: ${m.text}`).join("\n");
}

// --- 🎬 Movie Mode: ONE Groq call per group per day, never per-message ---
async function maybeGenerateMovieRecap(sock) {
  if (!sock || !process.env.GROQ_API_KEY) return;
  const today = new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"

  for (const [jid, buffer] of groupMessageBuffers.entries()) {
    try {
      const cfg = getGroupConfig(jid);
      if (cfg.lastRecapDate === today) continue; // already recapped today
      if (buffer.length < 15) continue; // not enough activity to bother

      const transcript = buffer.map(m => `${m.sender}: ${m.text}`).join("\n").slice(0, 6000); // token-bound

      const response = await groq.chat.completions.create({
        model: "llama-3.3-70b-versatile",
        messages: [
          { role: "system", content: `You write short, funny "episode recap" summaries of WhatsApp group chat days, like a sitcom recap. Punchy, 4-6 sentences max, playful, uses the real names mentioned. End with a one-line "Episode Rating: X/10" and a couple of emoji.` },
          { role: "user", content: `Here is today's group chat transcript:\n${transcript}\n\nWrite today's cinematic recap.` }
        ],
        temperature: 0.9
      });

      const recap = response.choices[0].message.content.trim();
      await sock.sendMessage(jid, { text: `🎬 *Today's Episode*\n\n${recap}` });
      console.log(`🎬 [MOVIE MODE] Sent daily recap to ${jid}.`);

      cfg.lastRecapDate = today;
      cfg.dirty = true;
      await persistGroupConfig(jid);
      groupMessageBuffers.set(jid, []); // reset for the new day
    } catch (err) {
      const { category, detail } = describeAIError(err);
      console.error(`🔴 [MOVIE MODE FAILURE] ${jid} | Category: ${category} | ${detail}`);
      // Never let one group's failure stop the loop for the rest.
    }
  }
}

// --- 🚨 Raid protection: mass-join detection, zero AI cost ---
// group-participants.update fires with a whole participants[] array per
// event (can be a batch add), so joins are weighted by array length rather
// than counted as 1 per event.
async function checkRaidProtection(sock, jid, joinCount = 1) {
  const now = Date.now();
  if (!recentJoins.has(jid)) recentJoins.set(jid, []);
  const joins = recentJoins.get(jid).filter(j => now - j.ts < RAID_WINDOW_MS);
  joins.push({ ts: now, count: joinCount });
  recentJoins.set(jid, joins);

  const totalJoins = joins.reduce((sum, j) => sum + j.count, 0);
  if (totalJoins < RAID_JOIN_THRESHOLD) return;

  console.warn(`🚨 [RAID PROTECTION] ${totalJoins} joins in <60s in ${jid}. Attempting auto-lockdown...`);
  recentJoins.set(jid, []); // reset so this doesn't re-trigger on every subsequent join

  try {
    const isBotAdmin = await checkIfBotIsAdminInGroup(sock, jid);
    if (isBotAdmin) {
      await sock.groupSettingUpdate(jid, "announcement"); // admin-only messaging
      await sock.sendMessage(jid, { text: `🚨 Raid protection triggered: ${totalJoins} joins in under a minute. Group locked to admins-only. An admin can send *.unlock* to reopen.` });
      const cfg = getGroupConfig(jid);
      cfg.locked = true;
      cfg.dirty = true;
      await persistGroupConfig(jid);
    } else {
      await sock.sendMessage(jid, { text: `🚨 Raid protection triggered: ${totalJoins} joins in under a minute — but I'm not an admin here, so I can't auto-lock. Please check the group manually!` });
    }
  } catch (err) {
    console.error("❌ Raid protection lockdown failed:", err.message);
  }
}

// --- Command router for . commands (.rank, .stats, .lock, .unlock) ---
async function checkIfSenderIsAdmin(sock, jid, senderJid) {
  try {
    const groupMetadata = await sock.groupMetadata(jid);
    const senderNumber = senderJid.split(":")[0].split("@")[0];
    const participant = groupMetadata.participants.find(p => p.id.split(":")[0].split("@")[0] === senderNumber);
    return !!(participant && (participant.admin === "admin" || participant.admin === "superadmin"));
  } catch (err) {
    console.warn("⚠️ Failed checking sender admin status:", err.message);
    return false;
  }
}

// Returns true if the text was a recognized command (caller should skip
// further moderation/AI-chat processing for this message).
async function handleCommand(sock, jid, senderJid, sender, text, msg) {
  const cmd = text.toLowerCase().trim();
  if (!cmd.startsWith(".")) return false;

  try {
    if (cmd === ".rank" || cmd === ".level") {
      const stats = getUserStats(senderJid);
      const level = xpToLevel(stats.xp);
      await sock.sendMessage(jid, {
        text: `📈 *${sender}'s Rank*\nLevel ${level} — "${levelTitle(level)}"\nXP: ${stats.xp} | Messages: ${stats.messageCount}`
      }, { quoted: msg });
      return true;
    }

    if (cmd === ".stats") {
      const mem = process.memoryUsage();
      const uptimeMin = (process.uptime() / 60).toFixed(1);
      await sock.sendMessage(jid, {
        text: `📊 *Nayla Status*\nUptime: ${uptimeMin} min\nHeap: ${(mem.heapUsed / 1024 / 1024).toFixed(1)} MB / 512 MB\nAI failures (streak): ${aiFailStreak}\nCircuit breaker: ${circuitBreakerOpen ? "OPEN (using local fallback)" : "closed (AI healthy)"}\nTracked users: ${userStatsCache.size}\nTracked groups: ${groupMessageBuffers.size}`
      }, { quoted: msg });
      return true;
    }

    if (cmd === ".lock" || cmd === ".unlock") {
      if (!jid.endsWith("@g.us")) {
        await sock.sendMessage(jid, { text: "⚠️ That command only works in groups." }, { quoted: msg });
        return true;
      }
      const senderIsAdmin = await checkIfSenderIsAdmin(sock, jid, senderJid);
      if (!senderIsAdmin) {
        await sock.sendMessage(jid, { text: "🚫 Only group admins can use that command." }, { quoted: msg });
        return true;
      }
      const isBotAdmin = await checkIfBotIsAdminInGroup(sock, jid);
      if (!isBotAdmin) {
        await sock.sendMessage(jid, { text: "⚠️ I need to be a group admin to lock/unlock the group." }, { quoted: msg });
        return true;
      }
      const locking = cmd === ".lock";
      await sock.groupSettingUpdate(jid, locking ? "announcement" : "not_announcement");
      const cfg = getGroupConfig(jid);
      cfg.locked = locking;
      cfg.dirty = true;
      await persistGroupConfig(jid);
      await sock.sendMessage(jid, { text: locking ? "🔒 Group locked — only admins can send messages now." : "🔓 Group unlocked — everyone can send messages again." });
      return true;
    }

    if (cmd === ".mood" || cmd.startsWith(".mood ")) {
      const parts = text.trim().split(/\s+/);
      if (!jid.endsWith("@g.us")) {
        await sock.sendMessage(jid, { text: `🎭 Available moods: ${AVAILABLE_MOODS.join(", ")}\n(Mood is set per-group — this only applies inside groups.)` }, { quoted: msg });
        return true;
      }
      const cfg = getGroupConfig(jid);
      if (parts.length === 1) {
        await sock.sendMessage(jid, { text: `🎭 Current mood here: *${cfg.mood}*\nAvailable: ${AVAILABLE_MOODS.join(", ")}\nAdmins can change it: *.mood <name>*` }, { quoted: msg });
        return true;
      }
      const senderIsAdmin = await checkIfSenderIsAdmin(sock, jid, senderJid);
      if (!senderIsAdmin) {
        await sock.sendMessage(jid, { text: "🚫 Only group admins can change the mood." }, { quoted: msg });
        return true;
      }
      const newMood = parts[1].toLowerCase();
      if (!AVAILABLE_MOODS.includes(newMood)) {
        await sock.sendMessage(jid, { text: `❌ Unknown mood. Available: ${AVAILABLE_MOODS.join(", ")}` }, { quoted: msg });
        return true;
      }
      cfg.mood = newMood;
      cfg.dirty = true;
      await persistGroupConfig(jid);
      await sock.sendMessage(jid, { text: `🎭 Mood changed to *${newMood}*!` });
      console.log(`🎭 [MOOD] ${jid} mood changed to "${newMood}" by ${sender}.`);
      return true;
    }

    if (cmd === ".help") {
      await sock.sendMessage(jid, {
        text: `🤖 *${BOT_CONFIG.name} Commands*\n\n*Everyone:*\n.rank / .level — your XP & title\n.stats — bot health\n.mood — show current personality\n\n*Group admins only:*\n.lock / .unlock — restrict messaging to admins\n.mood <name> — change personality (${AVAILABLE_MOODS.join(", ")})\n.kick (reply or @mention) — remove a member\n.promote / .demote (reply or @mention) — admin toggle\n.tagall — mention everyone\n.del (reply to a message) — delete it\n\nTag me or say my name to chat, or reply "Nayla summarize this" onto a long message!`
      }, { quoted: msg });
      return true;
    }

    if (jid.endsWith("@g.us") && (cmd === ".kick" || cmd === ".promote" || cmd === ".demote")) {
      const senderIsAdmin = await checkIfSenderIsAdmin(sock, jid, senderJid);
      if (!senderIsAdmin) {
        await sock.sendMessage(jid, { text: "🚫 Only group admins can use that command." }, { quoted: msg });
        return true;
      }
      const isBotAdmin = await checkIfBotIsAdminInGroup(sock, jid);
      if (!isBotAdmin) {
        await sock.sendMessage(jid, { text: "⚠️ I need to be a group admin to do that." }, { quoted: msg });
        return true;
      }
      const target = resolveCommandTarget(msg.message);
      if (!target) {
        await sock.sendMessage(jid, { text: "⚠️ Reply to that person's message, or @mention them, along with the command." }, { quoted: msg });
        return true;
      }
      const actionMap = { ".kick": "remove", ".promote": "promote", ".demote": "demote" };
      await sock.groupParticipantsUpdate(jid, [target], actionMap[cmd]);
      const label = { ".kick": "removed 👋", ".promote": "promoted to admin 🎖️", ".demote": "demoted from admin" }[cmd];
      await sock.sendMessage(jid, { text: `✅ @${target.split("@")[0]} ${label}.`, mentions: [target] });
      console.log(`✅ [${cmd}] ${sender} used ${cmd} on ${target} in ${jid}.`);
      return true;
    }

    if (cmd === ".tagall" || cmd === ".everyone") {
      if (!jid.endsWith("@g.us")) {
        await sock.sendMessage(jid, { text: "⚠️ That command only works in groups." }, { quoted: msg });
        return true;
      }
      const senderIsAdmin = await checkIfSenderIsAdmin(sock, jid, senderJid);
      if (!senderIsAdmin) {
        await sock.sendMessage(jid, { text: "🚫 Only group admins can use that command." }, { quoted: msg });
        return true;
      }
      const groupMetadata = await sock.groupMetadata(jid);
      const allJids = groupMetadata.participants.map(p => p.id);
      await sock.sendMessage(jid, { text: "📢 Attention everyone!", mentions: allJids });
      return true;
    }

    if (cmd === ".del" || cmd === ".delete") {
      if (!jid.endsWith("@g.us")) {
        await sock.sendMessage(jid, { text: "⚠️ That command only works in groups." }, { quoted: msg });
        return true;
      }
      const senderIsAdmin = await checkIfSenderIsAdmin(sock, jid, senderJid);
      if (!senderIsAdmin) {
        await sock.sendMessage(jid, { text: "🚫 Only group admins can use that command." }, { quoted: msg });
        return true;
      }
      const isBotAdmin = await checkIfBotIsAdminInGroup(sock, jid);
      if (!isBotAdmin) {
        await sock.sendMessage(jid, { text: "⚠️ I need to be a group admin to delete messages." }, { quoted: msg });
        return true;
      }
      const quotedKey = resolveQuotedMessageKey(jid, msg.message);
      if (!quotedKey) {
        await sock.sendMessage(jid, { text: "⚠️ Reply to the message you want deleted with *.del*." }, { quoted: msg });
        return true;
      }
      await sock.sendMessage(jid, { delete: quotedKey });
      console.log(`🗑️ [.del] ${sender} deleted a message in ${jid}.`);
      return true;
    }
  } catch (err) {
    console.error(`❌ Command "${cmd}" failed:`, err.message);
    try { await sock.sendMessage(jid, { text: "❌ That command failed — check my admin permissions and try again." }, { quoted: msg }); } catch (e) {}
    return true;
  }

  return false; // not a recognized command — fall through to normal handling
}

// Runs independent of connection state — checks every 10 min whether it's
// time for a Movie Mode recap, and flushes any dirty XP/fact changes to
// Mongo. Lives at module scope (not inside startBot()) so it's created
// exactly once regardless of how many times the socket reconnects.
setInterval(async () => {
  try {
    await flushUserStatsToMongo();
    await maybeGenerateMovieRecap(currentSock);
  } catch (err) {
    console.error("❌ [SCHEDULER] Periodic gamification/movie-mode task failed:", err.message);
  }
}, 10 * 60 * 1000);

// Initialize MongoDB Connection
const MONGO_URI = process.env.MONGODB_URI;
if (!MONGO_URI) {
  console.warn("⚠️ MONGODB_URI is missing. Falling back to local file auth state. Sessions will not persist on cloud servers.");
}

// Model to store session keys in MongoDB (Cloud Sync)
const SessionSchema = new mongoose.Schema({
  sessionId: { type: String, required: true, unique: true },
  data: { type: String, required: true }
});
const Session = mongoose.models.Session || mongoose.model("Session", SessionSchema);

// --- Lightweight gamification & memory schemas (all best-effort, non-critical) ---
const UserStatSchema = new mongoose.Schema({
  jid: { type: String, required: true, unique: true },
  displayName: String,
  xp: { type: Number, default: 0 },
  messageCount: { type: Number, default: 0 },
  facts: { type: [String], default: [] }, // capped to last 5 in code
  lastActive: Date
});
const UserStat = mongoose.models.UserStat || mongoose.model("UserStat", UserStatSchema);

const GroupConfigSchema = new mongoose.Schema({
  jid: { type: String, required: true, unique: true },
  locked: { type: Boolean, default: false },
  lastRecapDate: String, // "YYYY-MM-DD" of the last Movie Mode recap sent
  mood: { type: String, default: "cool" } // per-group personality override
});
const GroupConfig = mongoose.models.GroupConfig || mongoose.model("GroupConfig", GroupConfigSchema);

// Archived "active memory" dumps — written once a group's rolling 50-message
// buffer fills up, then the live buffer resets. Not meant to be re-loaded
// into memory; just a durable record so nothing's silently lost.
const ConversationArchiveSchema = new mongoose.Schema({
  jid: String,
  transcript: [String],
  archivedAt: Date
});
const ConversationArchive = mongoose.models.ConversationArchive || mongoose.model("ConversationArchive", ConversationArchiveSchema);

// Configure Bot rules and profile
const BOT_CONFIG = {
  name: "Nayla 😎",
  vibe: "cool", // global fallback for DMs — groups use their own GroupConfig.mood
  rules: {
  "blockLinks": true,
  "blockSpam": true,
  "toxicityThreshold": "medium"
}
};

// Supported personality moods, settable per-group via .mood — description
// text shared between the moderation prompt and the AI chat-reply prompt so
// they never drift out of sync with each other.
const AVAILABLE_MOODS = ["cool", "gen_z", "strict_mod", "playful", "sarcastic", "flirty"];
const MOOD_DESCRIPTIONS = {
  cool: "slang, chilling, 😎, 🌴.",
  gen_z: "lowercase, sarcastic, bruh, 💀, 😭.",
  strict_mod: "extremely polite, firm, warning template, 🚫.",
  playful: "lighthearted, teasing, loves jokes and puns, 😄🤪.",
  sarcastic: "dry wit, deadpan comebacks, playful jabs — never actually mean, 🙄😏.",
  flirty: "warm, charming, complimentary banter — always PG, never explicit, 😉💫."
};
function describeMood(vibe) {
  return MOOD_DESCRIPTIONS[vibe] || MOOD_DESCRIPTIONS.cool;
}

const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY
});

async function uploadSessionToMongo(authFolder) {
  if (!MONGO_URI) return;
  try {
    const files = fs.readdirSync(authFolder);
    const sessionData = {};
    for (const file of files) {
      if (file.endsWith(".json")) {
        const filePath = path.join(authFolder, file);
        sessionData[file] = fs.readFileSync(filePath, "utf-8");
      }
    }
    await Session.findOneAndUpdate(
      { sessionId: "whatsapp_vibe_bot" },
      { data: JSON.stringify(sessionData) },
      { upsert: true }
    );
    console.log("💾 Session successfully synced & uploaded to MongoDB Atlas!");
  } catch (err) {
    console.error("❌ Failed to sync session folder to MongoDB:", err.message);
  }
}

async function downloadSessionFromMongo(authFolder) {
  if (!MONGO_URI) return false;
  try {
    if (!fs.existsSync(authFolder)) {
      fs.mkdirSync(authFolder, { recursive: true });
    }
    const record = await Session.findOne({ sessionId: "whatsapp_vibe_bot" });
    if (record) {
      const sessionData = JSON.parse(record.data);
      for (const [file, content] of Object.entries(sessionData)) {
        fs.writeFileSync(path.join(authFolder, file), content);
      }
      console.log("📥 Loaded active login session from MongoDB Atlas!");
      return true;
    }
  } catch (err) {
    console.error("❌ Failed to load session from MongoDB:", err.message);
  }
  return false;
}

async function evaluateMessageWithGroq(sender, text, vibe = BOT_CONFIG.vibe) {
  if (!process.env.GROQ_API_KEY) {
    console.warn("⚠️ GROQ_API_KEY not configured. Defaulting to local regex moderation.");
    return fallbackLocalModerate(text);
  }

  const aiTimeoutPromise = new Promise((_, reject) => {
    setTimeout(() => reject(new Error("Groq API call timed out after 9 seconds")), 9000);
  });

  const apiCallPromise = (async () => {
    const systemPrompt = `You are a WhatsApp Moderator Bot named ${BOT_CONFIG.name}.
Your job is to analyze group chat messages and return a clean, structured moderation action as JSON.

You must follow these rules:
1. Block Links: ${BOT_CONFIG.rules.blockLinks ? "YES - any link containing http, https, or .com is banned. Action: delete." : "NO"}
2. Block Spam: ${BOT_CONFIG.rules.blockSpam ? "YES - repeated words, massive blocks of gibberish. Action: delete." : "NO"}
3. Toxicity Level: ${BOT_CONFIG.rules.toxicityThreshold === "high" ? "Strictly block severe toxicity." : "Block direct insults, swearing, or drama. Action: warn."}

IMPORTANT: The literal text "@mention" is just a normal @mention placeholder — it is NEVER a link, spam, or violation by itself. Only flag actual URLs, repeated gibberish, or genuine toxicity.

This is a MODERATION-ONLY pass. Never use action "reply" here — conversational replies are handled by a separate system that only responds when the bot is directly tagged.

Personality: "${vibe}"
${describeMood(vibe)}

Respond ONLY with a raw JSON object matching this exact schema, no other text:
{
  "action": "approve" | "warn" | "delete",
  "replyMessage": "The viby response to send to the group chat.",
  "reason": "Internal reasoning text"
}`;

    const response = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: `Sender: "${sender}"\nContent: "${text}"` }
      ],
      response_format: { type: "json_object" },
      temperature: 0.4
    });

    let cleanText = response.choices[0].message.content.trim();
    if (cleanText.startsWith("```json")) {
      cleanText = cleanText.replace(/^```json/, "").replace(/```$/, "");
    } else if (cleanText.startsWith("```")) {
      cleanText = cleanText.replace(/^```/, "").replace(/```$/, "");
    }

    return JSON.parse(cleanText.trim());
  })();

  try {
    const result = await Promise.race([apiCallPromise, aiTimeoutPromise]);
    aiFailStreak = 0;
    return result;
  } catch (err) {
    const { category, detail } = describeAIError(err);
    console.error(`🔴 [MODERATION AI FAILURE] Category: ${category} | ${detail} | Raw: ${err.message}`);
    recordGeminiFailure();
    return fallbackLocalModerate(text);
  }
}

async function evaluateMessage(sender, text, vibe) {
  if (checkCircuitBreaker()) {
    console.warn("⚡ [CIRCUIT BREAKER ACTIVE] Bypassing Gemini, sending message directly to local Regex Moderator");
    return fallbackLocalModerate(text);
  }

  return enqueueModerationRequest(sender, text, vibe);
}

// Hoisted to module scope so the backoff actually escalates across reconnects —
// previously this lived inside startBot() and got reset to 0 every time startBot()
// recursed, which is why every reconnect in the logs backed off for the same 12.0s.
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 8;
let stabilityTimer = null; // only reset reconnectAttempts once a connection proves it's actually stable

// --- MESSAGE CONTENT EXTRACTOR (UNWRAPS DISAPPEARING / VIEW-ONCE CONTAINERS) ---
// Baileys nests disappearing-message and view-once content one level deeper than
// a normal message: msg.message.ephemeralMessage.message.conversation, NOT
// msg.message.conversation directly. The old extraction line only ever checked
// the top level, so for any chat with disappearing messages on (WhatsApp now
// defaults many chats to this), text came back as "" and `if (!text) continue;`
// silently skipped the message *before* the "📬 Message from..." log line ever
// ran — which is exactly why nothing showed up, even though messages.upsert
// was firing correctly the whole time.
function unwrapMessageContent(message) {
  if (!message) return null;
  // FIX: checking Object.keys(message)[0] only inspected the FIRST key. WhatsApp
  // frequently puts messageContextInfo (or other metadata) first and the real
  // wrapper (ephemeralMessage etc.) second — so the old check silently missed
  // it, text extraction came back empty, and messages got skipped before ever
  // reaching the "📬 Message from..." log line. Now every wrapper type is
  // checked directly as a property, regardless of key order.
  const wrapperTypes = ["ephemeralMessage", "viewOnceMessage", "viewOnceMessageV2", "viewOnceMessageV2Extension"];
  for (const type of wrapperTypes) {
    if (message[type]?.message) {
      return unwrapMessageContent(message[type].message);
    }
  }
  return message;
}

// --- Bot-mention detection ---
// A group message only carries mentionedJid inside extendedTextMessage's
// contextInfo. sock.user.id looks like "234801234567:51@s.whatsapp.net" —
// strip the device suffix and domain before comparing to each mentioned JID.
function isBotMentioned(sock, message) {
  const content = unwrapMessageContent(message);
  const mentionedJids = content?.extendedTextMessage?.contextInfo?.mentionedJid || [];

  // FIX: WhatsApp's LID (Linked Identity) migration means a group mention can
  // reference the bot by its real phone-number JID (...@s.whatsapp.net) OR by
  // its LID (...@lid) — two different identifiers for the same account.
  // Baileys exposes both: sock.user.id (phone JID) and sock.user.lid (LID).
  // The old check only compared against .id, so any group WhatsApp has
  // migrated to LID-style mentions silently never matched — exactly why
  // tagging worked in no group at all despite DMs working fine.
  const selfNumbers = [sock.user?.id, sock.user?.lid]
    .filter(Boolean)
    .map(jid => jid.split(":")[0].split("@")[0]);

  const mentionedNumbers = mentionedJids.map(jid => jid.split(":")[0].split("@")[0]);
  const mentioned = mentionedNumbers.some(num => selfNumbers.includes(num));

  console.log(`🔍 [MENTION CHECK] mentionedJid: [${mentionedJids.join(", ") || "none"}] | self: [${selfNumbers.join(", ")}] | matched: ${mentioned}`);

  return mentioned;
}

// The bot now also responds to its name being said directly, not just a
// formal @mention — "What's up Nayla" works the same as tagging it.
function isBotAddressed(sock, message, text) {
  if (isBotMentioned(sock, message)) return true;
  return /\bnayla\b/i.test(text);
}

// --- Classify Groq/API failures into a clear, human-readable reason ---
// Logged to the Render console on every failure, and also used to tell the
// user in-chat why the AI didn't respond, instead of failing silently.
function describeAIError(err) {
  const msg = (err?.message || String(err) || "").toLowerCase();
  const status = err?.status || err?.code;

  if (msg.includes("timed out")) {
    return { category: "TIMEOUT", detail: "Groq call exceeded the timeout window.", userText: "⏱️ My AI brain took too long to respond. Try again in a sec!" };
  }
  if (status === 401 || msg.includes("invalid api key") || msg.includes("unauthorized") || msg.includes("invalid_api_key")) {
    return { category: "AUTH", detail: "GROQ_API_KEY is missing or invalid.", userText: "🔑 My AI connection is misconfigured (invalid/missing API key) — my developer needs to check GROQ_API_KEY." };
  }
  if (msg.includes("econnrefused") || msg.includes("enotfound") || msg.includes("fetch failed") || msg.includes("network") || msg.includes("eai_again")) {
    return { category: "CONNECTION", detail: "Could not reach Groq's API servers (connection refused/DNS/network).", userText: "🌐 I couldn't reach the AI servers (connection refused). Try again shortly!" };
  }
  if (status === 429 || msg.includes("rate limit") || msg.includes("rate_limit")) {
    return { category: "RATE_LIMIT", detail: "Groq free-tier rate limit exceeded (30 req/min or daily cap).", userText: "🚦 I'm being rate-limited right now. Give me a minute!" };
  }
  if (status === 404 || msg.includes("not found") || msg.includes("decommissioned")) {
    return { category: "BAD_MODEL", detail: "The configured Groq model name was not found/is invalid/decommissioned.", userText: "❓ My AI model config looks wrong — my developer needs to check the model name." };
  }
  if (msg.includes("json_validate_failed") || msg.includes("json")) {
    return { category: "JSON_FORMAT", detail: "Groq failed to produce valid JSON for this request.", userText: "🤔 My AI brain got confused formatting that reply. Falling back to basic rules." };
  }

  return { category: "UNKNOWN", detail: err?.message || "Unknown error", userText: `🤖 Something broke talking to my AI brain: ${err?.message || "unknown error"}` };
}

// --- Conversational AI reply (only fires when the bot is directly addressed) ---
// Piggybacks lightweight personality memory onto this SAME call — zero extra
// Groq requests. The model is asked to return both the reply and an optional
// short new fact about the sender in one JSON response.
async function generateAIChatReply(senderJid, sender, question, vibe = BOT_CONFIG.vibe, context = "") {
  if (!process.env.GROQ_API_KEY) {
    console.error("🔴 [AI CHAT] GROQ_API_KEY is not set in environment variables.");
    return { success: false, message: "🔑 My AI connection is misconfigured (missing API key) — my developer needs to set GROQ_API_KEY." };
  }

  const stats = getUserStats(senderJid);
  const knownFacts = stats.facts.length > 0 ? stats.facts.join("; ") : "nothing yet";

  const timeoutPromise = new Promise((_, reject) => {
    setTimeout(() => reject(new Error("Groq chat call timed out after 15 seconds")), 15000);
  });

  const callPromise = (async () => {
    const systemPrompt = `You are ${BOT_CONFIG.name}, a WhatsApp group companion with a "${vibe}" personality.
${describeMood(vibe)}
What you already remember about ${sender}: ${knownFacts}.
${context ? `Recent conversation in this chat (for context only, don't repeat it back verbatim):\n${context}\n` : ""}
Reply naturally and in character, 1-4 sentences, weaving in what you remember about them ONLY where it fits naturally — don't force it every time.
Do not mention you are an AI model unless directly asked. Never store or repeat sensitive personal info (health, address, financial details).

Respond ONLY with a raw JSON object matching this schema, no other text:
{
  "reply": "your in-character reply text",
  "newFact": "one short new casual/non-sensitive fact worth remembering about this person from this message, or an empty string if nothing notable"
}`;

    const response = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: `${sender} said: "${question}"` }
      ],
      response_format: { type: "json_object" },
      temperature: 0.7
    });

    let cleanText = response.choices[0].message.content.trim();
    if (cleanText.startsWith("```")) {
      cleanText = cleanText.replace(/^```json?/, "").replace(/```$/, "").trim();
    }
    return JSON.parse(cleanText);
  })();

  try {
    const result = await Promise.race([callPromise, timeoutPromise]);
    aiFailStreak = 0;
    if (result.newFact) addUserFact(senderJid, result.newFact);
    return { success: true, message: result.reply };
  } catch (err) {
    const { category, detail, userText } = describeAIError(err);
    console.error(`🔴 [AI CHAT FAILURE] Category: ${category} | ${detail} | Raw: ${err.message}`);
    recordGeminiFailure();
    return { success: false, message: userText };
  }
}

function extractTextFromMessage(message) {
  const content = unwrapMessageContent(message);
  if (!content) return "";
  return content.conversation || content.extendedTextMessage?.text || "";
}

// FIX: WhatsApp renders an @mention as a literal "@<digits>" substring inside
// the visible text (e.g. "Can you help @21827661385803"). A long bare digit
// string with no other context reads as suspicious/spam-like to a moderation
// LLM — this was the direct, confirmed cause of tagged messages getting
// misclassified as link/spam violations. Stripping it to a clean, neutral
// placeholder before ANY downstream processing (moderation, AI replies,
// summarization, conversation memory) fixes that at the source.
function sanitizeMentionArtifacts(text) {
  return text.replace(/@\d{7,}/g, "@mention");
}

// Pulls the text out of whatever message this one is quote-replying to, if
// any — needed for "Nayla summarize this" replied onto a long message.
function getQuotedMessageText(message) {
  const content = unwrapMessageContent(message);
  const quoted = content?.extendedTextMessage?.contextInfo?.quotedMessage;
  if (!quoted) return null;
  const text = extractTextFromMessage(quoted);
  return text && text.trim().length > 0 ? text.trim() : null;
}

// Resolves who a moderation command (.kick/.promote/.demote) targets: prefer
// whoever's message is being replied to, otherwise the first @mention.
function resolveCommandTarget(message) {
  const content = unwrapMessageContent(message);
  const contextInfo = content?.extendedTextMessage?.contextInfo;
  if (contextInfo?.participant) return contextInfo.participant;
  if (contextInfo?.mentionedJid?.length > 0) return contextInfo.mentionedJid[0];
  return null;
}

// Builds the message key .del needs to delete a REPLIED-TO message (requires
// the bot to be a group admin to delete someone else's message).
function resolveQuotedMessageKey(jid, message) {
  const content = unwrapMessageContent(message);
  const contextInfo = content?.extendedTextMessage?.contextInfo;
  if (!contextInfo?.stanzaId) return null;
  return {
    remoteJid: jid,
    id: contextInfo.stanzaId,
    participant: contextInfo.participant,
    fromMe: false
  };
}

// Summarize an arbitrary quoted message. Anti-crash: hard-caps input length
// regardless of how long the original message actually was, so one giant
// pasted document can't blow up token usage, latency, or the request itself.
async function summarizeQuotedText(quotedText) {
  if (!process.env.GROQ_API_KEY) {
    return { success: false, message: "🔑 My AI connection is misconfigured — can't summarize right now." };
  }
  if (quotedText.length < 30) {
    return { success: false, message: "🤔 That message is already pretty short — not much to summarize!" };
  }

  const trimmed = quotedText.slice(0, 6000); // anti-crash: bound input size no matter how long the source was
  const wasTruncated = quotedText.length > 6000;

  const timeoutPromise = new Promise((_, reject) => {
    setTimeout(() => reject(new Error("Groq summarize call timed out after 15 seconds")), 15000);
  });

  const callPromise = (async () => {
    const response = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [
        { role: "system", content: "Summarize the given WhatsApp message clearly and concisely in 2-4 sentences. Keep the key facts, drop filler." },
        { role: "user", content: trimmed }
      ],
      temperature: 0.3
    });
    return response.choices[0].message.content.trim();
  })();

  try {
    const summary = await Promise.race([callPromise, timeoutPromise]);
    aiFailStreak = 0;
    return { success: true, message: `📋 *Summary:*\n${summary}${wasTruncated ? "\n\n_(original message was long, summarized from the first ~6000 characters)_" : ""}` };
  } catch (err) {
    const { category, detail, userText } = describeAIError(err);
    console.error(`🔴 [SUMMARIZE FAILURE] Category: ${category} | ${detail} | Raw: ${err.message}`);
    recordGeminiFailure();
    return { success: false, message: userText };
  }
}

async function startBot() {
  console.log("==================================================");
  console.log("⚡ VIBEGUARD WHATSAPP PERSISTENT MODERATOR STARTING");
  console.log("==================================================");

  if (MONGO_URI) {
    try {
      console.log("🔌 Connecting to MongoDB Database with strict 10s timeout...");
      await mongoose.connect(MONGO_URI, {
        serverSelectionTimeoutMS: 10000,
        connectTimeoutMS: 10000
      });
      console.log("✅ Successfully synced to MongoDB Atlas Cluster.");
    } catch (dbErr) {
      console.error("❌ MongoDB Connection failed, operating locally on ephemeral state:", dbErr.message);
    }

    // Only load once per process lifetime — startBot() can recurse on
    // reconnect, and re-loading every time would be wasted Mongo reads.
    if (!statsLoadedOnce) {
      await loadUserStatsFromMongo();
      await loadGroupConfigsFromMongo();
      statsLoadedOnce = true;
    }
  }

  const authFolder = "./session_auth";
  const hasLoadedSession = await downloadSessionFromMongo(authFolder);
  const credsExist = fs.existsSync(path.join(authFolder, "creds.json"));

  if (!hasLoadedSession && !credsExist) {
    console.error("\n❌ [CRITICAL LOG-IN FAILURE]");
    console.error("No active authenticated WhatsApp session could be downloaded from your MongoDB Atlas Cluster, and no local creds.json was found!");
    console.error("\n👉 ACTION REQUIRED:");
    console.error("You MUST complete the initial pairing sequence first! Please run the dedicated pairing script:");
    console.error("   npm run pair");
    console.error("This will print your Pairing Code, wait for you to link it on your phone, and lock the session into MongoDB Atlas.");
    console.error("Once paired, you can run 'npm start' to start this bot 24/7 without issues!\n");
    process.exit(1);
  }

  const { state, saveCreds } = await useMultiFileAuthState(authFolder);

  // 🔑 THE FIX: fetch WhatsApp's current Web protocol version before connecting.
  // Without this, Baileys falls back to whatever version was bundled with the
  // package at install time. Once that goes stale relative to what WhatsApp's
  // servers require, every connection attempt gets rejected immediately with
  // "405 Method Not Allowed" — even with perfectly valid saved credentials.
  // pair.js already fetches this dynamically; this brings the bot in line with it.
  console.log("Fetching latest WhatsApp Web version protocol headers...");
  const { version } = await fetchLatestWaWebVersion({});
  console.log(`Using WhatsApp Web Version: ${version.join('.')}`);

  console.log("⚡ Booting WhatsApp socket connection using saved credentials...");

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: "silent" }),
    browser: ["Nayla AI", "Chrome", "2.0.0"],
    syncFullHistory: false,
    markOnlineOnConnect: true,
    connectTimeoutMs: 60000
  });

  currentSock = sock; // exposed to the top-level Movie Mode / stats-flush interval

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === "close") {
      // Cancel any pending "this connection was stable" timer from the last
      // open — if we're closing again, it clearly wasn't stable, so the
      // failure count must NOT get wiped out from under us.
      if (stabilityTimer) {
        clearTimeout(stabilityTimer);
        stabilityTimer = null;
      }

      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      
      console.log(`⚠️ Connection disconnected. Status Code: ${statusCode}. Attempting reconnect: ${shouldReconnect}`);
      
      if (statusCode === 401) {
        console.log("👉 Troubleshooting: The session was revoked or logged out from the WhatsApp app. Clear your MongoDB 'sessions' collection and run 'npm run pair' to generate a fresh connection.");
      } else if (statusCode === 405) {
        console.log("👉 Troubleshooting: 405 means WhatsApp rejected the connection protocol version. This should now self-correct via fetchLatestWaWebVersion — if it persists, run 'npm update @whiskeysockets/baileys'.");
      } else if (statusCode === 440) {
        console.log("👉 Troubleshooting: 440 means another connection took over this exact session. Check for a second running instance (another Render service, KataBump, your local machine) using the same MongoDB session, or check WhatsApp > Linked Devices for a duplicate entry.");
      }

      if (shouldReconnect) {
        reconnectAttempts++;

        if (reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
          console.error(`\n❌ [GIVING UP] ${MAX_RECONNECT_ATTEMPTS} consecutive reconnect failures. Stopping to avoid hammering WhatsApp/Render. Check the logs above, fix the root cause, then redeploy.\n`);
          try { await mongoose.connection.close(); } catch (e) {}
          process.exit(1);
        }

        const backoffDelay = Math.min(6000 * Math.pow(2, reconnectAttempts), 45000);
        console.log(`🔄 Backing off for ${(backoffDelay / 1000).toFixed(1)} seconds before reconnecting (attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...`);
        
        await delay(backoffDelay);
        startBot();
      } else {
        console.error("❌ WhatsApp session was permanently logged out or credentials revoked. Please clear your session files and re-pair using 'npm run pair'.");
        process.exit(1);
      }
    } else if (connection === "open") {
      console.log("\n==================================================");
      console.log("✅ VIBEGUARD AI WHATSAPP BOT ONLINE & PROTECTING!");
      console.log("==================================================\n");

      // Only treat the connection as genuinely stable — and reset the failure
      // counter — after it survives 30s without closing again. A connection
      // that opens and gets kicked seconds later (e.g. by a 440 conflict)
      // must NOT be able to reset the counter, or the 8-attempt safety net
      // can never trigger and this would loop silently forever.
      stabilityTimer = setTimeout(() => {
        reconnectAttempts = 0;
        stabilityTimer = null;
      }, 30000);

      await uploadSessionToMongo(authFolder);
    }
  });

  sock.ev.on("creds.update", async () => {
    await saveCreds();
    await uploadSessionToMongo(authFolder);
  });

  // 🚨 Raid protection — pure local join-rate detection, zero AI cost.
  sock.ev.on("group-participants.update", async (event) => {
    try {
      if (event.action === "add") {
        await checkRaidProtection(sock, event.id, event.participants.length);
      }
    } catch (err) {
      console.error("❌ Raid protection listener error:", err.message);
    }
  });

  sock.ev.on("messages.upsert", async (m) => {
    if (m.type !== "notify") return;

    for (const msg of m.messages) {
      if (!msg.message || msg.key.fromMe) continue;

      const jid = msg.key.remoteJid;
      const text = sanitizeMentionArtifacts(extractTextFromMessage(msg.message));
      const sender = msg.pushName || "Anonymous";
      const senderJid = msg.key.participant || msg.key.remoteJid;

      if (!text) continue;

      // Log receipt IMMEDIATELY — this must fire the instant a real text
      // message arrives, before any rate-limit/AI decision can skip it,
      // otherwise "message received" becomes invisible on the console again.
      console.log(`📬 [${jid}] Message from ${sender}: ${text.slice(0, 50)}`);

      if (isRateLimited(senderJid)) {
        console.log(`⏳ Rate-limited — skipping further processing for ${sender}.`);
        continue;
      }

      // --- 0. Command router (.rank, .stats, .lock, .unlock) — handled
      // entirely separately from moderation/AI-chat, zero Groq cost.
      const wasCommand = await handleCommand(sock, jid, senderJid, sender, text, msg);
      if (wasCommand) continue;

      // --- Gamification + Movie Mode bookkeeping — pure local, no AI cost.
      bumpUserStats(senderJid, sender);
      const isGroup = jid.endsWith("@g.us");
      const vibe = isGroup ? getGroupConfig(jid).mood : BOT_CONFIG.vibe;
      if (isGroup) await bufferGroupMessage(jid, sender, text);

      // --- 1. Moderation pass: spam/link/toxicity — runs on every message ---
      try {
        const evaluation = await evaluateMessage(sender, text, vibe);

        if (evaluation.action === "warn") {
          await sock.sendMessage(jid, { text: evaluation.replyMessage }, { quoted: msg });
          console.log(`⚠️ Bot warned ${sender} successfully.`);
        } 
        else if (evaluation.action === "delete") {
          if (isGroup) {
            const isBotAdmin = await checkIfBotIsAdminInGroup(sock, jid);
            if (isBotAdmin) {
              const cleanParticipant = senderJid.split("@")[0];
              await sock.sendMessage(jid, { 
                text: `🚫 Violation by @${cleanParticipant} deleted: ${evaluation.replyMessage}`, 
                mentions: [senderJid] 
              });
              await sock.sendMessage(jid, { delete: msg.key });
              console.log(`🗑️ Deleted violator message from ${sender}.`);
            } else {
              console.warn("⚠️ Bot is not admin in this group! Cannot auto-delete. Sent warning text instead.");
              await sock.sendMessage(jid, { 
                text: `⚠️ [Violation Warning] Please don't send links or spam here, ${sender}. (Make me Admin to auto-delete messages!)` 
              }, { quoted: msg });
            }
          }
        }
      } catch (sendErr) {
        console.error("❌ Safeguard caught failed WhatsApp send/delete error:", sendErr.message);
      }

      // --- 2. Conversational AI: ONLY when the bot is tagged/named in a
      // group, or ANY message in a direct 1:1 chat (no one else to address).
      // "Addressed" now covers both a formal @mention AND saying "Nayla".
      const addressed = isGroup && isBotAddressed(sock, msg.message, text);
      const shouldChatReply = !isGroup || addressed;

      // Reply cooldown — protects Groq's free-tier quota from rapid re-tags
      // and stops the bot from feeling spammy if someone tags it repeatedly.
      const lastReply = lastAIReplyTime.get(jid) || 0;
      const cooledDown = Date.now() - lastReply > AI_REPLY_COOLDOWN_MS;

      if (shouldChatReply && cooledDown) {
        lastAIReplyTime.set(jid, Date.now());

        // Special case: "Nayla summarize this" as a reply to a long message.
        const wantsSummary = /\bsummar(y|ise|ize)\b/i.test(text);
        const quotedText = wantsSummary ? getQuotedMessageText(msg.message) : null;

        let aiResult;
        if (wantsSummary && quotedText) {
          aiResult = await summarizeQuotedText(quotedText);
        } else if (wantsSummary && !quotedText) {
          aiResult = { success: false, message: "🤔 Reply directly to the message you want me to summarize!" };
        } else {
          const context = isGroup ? getRecentContext(jid) : "";
          aiResult = await generateAIChatReply(senderJid, sender, text, vibe, context);
        }

        try {
          await sock.sendMessage(jid, { text: aiResult.message }, { quoted: msg });
          console.log(aiResult.success
            ? `💬 AI-replied to ${sender} successfully.`
            : `⚠️ Sent AI-failure notice to ${sender} (see error above).`);
        } catch (sendErr) {
          console.error("❌ Failed sending AI chat reply:", sendErr.message);
        }
      } else if (shouldChatReply && !cooledDown) {
        console.log(`⏱️ [COOLDOWN] Skipped AI reply to ${sender} — too soon since last reply in this chat.`);
      }
    }
  });
}

process.on("SIGTERM", async () => {
  console.log("👋 [SHUTDOWN] Terminating database connections gracefully...");
  try {
    await mongoose.connection.close();
  } catch (e) {}
  process.exit(0);
});

process.on("SIGINT", async () => {
  console.log("👋 [SHUTDOWN] Interrupted. Closing...");
  try {
    await mongoose.connection.close();
  } catch (e) {}
  process.exit(0);
});

startBot();