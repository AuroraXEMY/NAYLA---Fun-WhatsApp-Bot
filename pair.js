/**
 * WhatsApp Bot Pairing Code Authorization Utility (Anti-Fail Resiliency Edition)
 * * SOLE PURPOSE: Securely authenticate with your WhatsApp account using a pairing code,
 * download and save session credentials, and sync them to your MongoDB Database.
 * Once completed, this script exits and you run 'npm start' to run the main bot!
 */

const { 
  default: makeWASocket, 
  DisconnectReason, 
  useMultiFileAuthState, 
  Browsers,
  delay,
  fetchLatestWaWebVersion
} = require("@whiskeysockets/baileys");
const mongoose = require("mongoose");
const pino = require("pino");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

// Trapping exceptions with detailed debugger
process.on("uncaughtException", (err) => {
  console.error("🔥 [DEBUGGER ERROR] Caught exception:", err.message);
  console.error(err.stack);
});

const MONGO_URI = process.env.MONGODB_URI;
const PHONE_NUMBER = process.env.PHONE_NUMBER;

// Model to store session keys in MongoDB (Cloud Sync)
const SessionSchema = new mongoose.Schema({
  sessionId: { type: String, required: true, unique: true },
  data: { type: String, required: true }
});
const Session = mongoose.models.Session || mongoose.model("Session", SessionSchema);

async function uploadSessionToMongo(authFolder) {
  if (!MONGO_URI) {
    console.log("⚠️ No MONGODB_URI set, skipping cloud upload. Session will only be saved locally.");
    return;
  }
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
    console.log("💾 Active session successfully uploaded to MongoDB Atlas Cluster! 🔒");
  } catch (err) {
    console.error("❌ Failed to sync session to MongoDB:", err.message);
  }
}

// Global state trackers to prevent loops and wipes during reconnects
let isFirstRun = true;
let codeRequested = false;
let connectionFailures = 0;

async function runPairing() {
  if (isFirstRun) {
    console.log("==================================================");
    console.log("⚡ VIBEGUARD WHATSAPP PAIR-CODE WIZARD INITIALIZING");
    console.log("==================================================");

    if (MONGO_URI) {
      try {
        console.log("🔌 Connecting to MongoDB Atlas Database...");
        await mongoose.connect(MONGO_URI, {
          serverSelectionTimeoutMS: 10000,
          connectTimeoutMS: 10000
        });
        console.log("✅ MongoDB Connection Successful.");
      } catch (dbErr) {
        console.error("❌ MongoDB connection failed. Running in local-only mode:", dbErr.message);
      }
    }
  }

  const authFolder = "./session_auth";
  
  // ONLY clear the folder on the very first start. Preserves data during reconnects!
  if (isFirstRun) {
    if (fs.existsSync(authFolder)) {
      console.log("🧹 Clearing old session data for a fresh pairing...");
      fs.rmSync(authFolder, { recursive: true, force: true });
    }
    fs.mkdirSync(authFolder, { recursive: true });
    isFirstRun = false;
  }

  const { state, saveCreds } = await useMultiFileAuthState(authFolder);

  if (!codeRequested) {
    console.log("Fetching latest WhatsApp Web version protocol headers...");
  }
  const { version } = await fetchLatestWaWebVersion({});

  const sock = makeWASocket({
    version, 
    auth: state,
    printQRInTerminal: false, 
    logger: pino({ level: "silent" }), // Silenced to prevent terminal spam while entering code
    browser: Browsers.windows("Chrome"),
    syncFullHistory: false,
    
    // 👇 60-SECOND TIMEOUTS ENFORCED 👇
    connectTimeoutMs: 60000, 
    defaultQueryTimeoutMs: 60000,
    keepAliveIntervalMs: 10000,
  });

  // 👇 PAIRING CODE LOGIC (Locked to one request) 👇
  if (!sock.authState.creds.registered && !codeRequested) {
    if (!PHONE_NUMBER) {
      console.error("\n❌ [FATAL] PHONE_NUMBER environment variable is missing!");
      process.exit(1);
    }

    console.log("⏳ Delaying pairing request to allow socket handshake...");
    setTimeout(async () => {
      try {
        const cleanNumber = PHONE_NUMBER.replace(/[^0-9]/g, "");
        const code = await sock.requestPairingCode(cleanNumber);
        codeRequested = true; // Lock activated
        
        console.log("\n==================================================");
        console.log(`🔑 YOUR PAIRING CODE: ${code}`);
        console.log("==================================================");
        console.log("👉 Go to: WhatsApp > Linked Devices > Link a Device > Link with phone number.");
        console.log("👉 You have 60 seconds to enter this code.");
        console.log("==================================================\n");
      } catch (err) {
        console.error("❌ Failed to request pairing code:", err.message);
      }
    }, 3000); 
  }

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === "close") {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      
      connectionFailures++;
      if (connectionFailures >= 5) { // Increased tolerance to 5 for unstable connections
        console.error("\n❌ [LINKING FAILED] Connection dropped too many times. Terminating...");
        try { await mongoose.connection.close(); } catch (e) {}
        process.exit(1);
      }

      if (shouldReconnect) {
        // Silently reconnect without wiping the folder or generating a new code
        await delay(5000);
        runPairing(); 
      } else {
        console.error("❌ WhatsApp permanently rejected this pairing attempt. Please clear auth files and try again.");
        try { await mongoose.connection.close(); } catch (e) {}
        process.exit(1);
      }
    } 
    
    else if (connection === "open") {
      console.log("\n==================================================");
      console.log("🎉 SUCCESS: WHATSAPP ACCOUNT LINKED & AUTHENTICATED!");
      console.log("==================================================");
      console.log("💾 Syncing local credentials files to MongoDB Atlas...");
      
      await saveCreds();
      await uploadSessionToMongo(authFolder);
      
      console.log("\n✅ BOT IS FULLY LOGGED IN AND READY! 🚀");
      console.log("👉 Step 3: Run 'npm start' to boot up your persistent moderator bot!");
      console.log("==================================================\n");
      
      try {
        await mongoose.connection.close();
      } catch (e) {}
      process.exit(0);
    }
  });
}

runPairing();