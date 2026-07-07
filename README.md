# VibeGuard AI Moderator Bot (v2.4.0) 😎🤖

Professional, enterprise-resilient WhatsApp group moderator bot designed to run 24/7 on resource-constrained hosting services like **Render (Free Tier - 512MB RAM)** or **Termux**. 

Designed with an **Isolated Two-Stage Architecture** to eliminate pairing timeouts and 405/428 connection loops entirely!

---

## ⚡ 12-Tier Crash and Resiliency Protections
This bot incorporates top-tier corporate developer patterns to operate seamlessly within Render's strict **512MB RAM free limit**:
1. **Isolated Pairing Protocol**: Authenticating is moved into a dedicated `pair.js` file, separating it from the main bot startup loop and completely avoiding 405/428 crash states!
2. **Uncaught Crash Traps**: Global listeners catch uncaught exceptions, preventing random network/WS errors from killing the bot process.
3. **Serial API Request Queue**: Moderation requests are throttled and handled through a single sequential queue, stopping parallel AI tasks from bloating Node's RAM.
4. **Leaky-Bucket Rate Limiter**: Spammers spamming dozens of messages are instantly rate-limited per chat/user, bypassing Gemini to conserve limits.
5. **Memory Heap Monitor**: Automatically tracks RAM allocation. If memory gets close to limits (>380MB), it flushes rate-limiter maps preventatively.
6. **Circuit Breaker Outage Handler**: If the Gemini API suffers an outage, the bot automatically switches off Gemini and activates local engines.
7. **Zero-Latency Fallback Engine**: Fully functional offline local moderator evaluates links, flood lengths, and custom triggers with lightning-fast regex patterns.
8. **Keep-Alive Server**: A zero-weight keep-alive server (`server.js`) keeps the Render container awake 24/7 and passes port checks instantly!
9. **Exponential Backoff Reconnector**: Dynamically calculates connection retry pauses up to 45s to avoid IP bans.
10. **Group Admin Caching**: Caches group admin rules for 10 minutes to avoid querying heavy WhatsApp metadata on every single message.
11. **Safe Send Wrapper**: All sendMessage and deleteMessage requests are safe-wrapped to prevent missing admin permissions from throwing uncaught thread errors.
12. **Database Timeout Guard**: MongoDB connections have a strict 10s timeout, falling back automatically to local file sessions if Atlas experiences temporary hiccups.

---

## 🔑 Step 1: Link/Pair Your Device (Run Once)
Pairing with a phone number is the easiest way to log in. No terminal QR scanning required!

1. Open your code's `.env` file (locally or on Render's Environment variables screen).
2. Set the following variables:
   - `PHONE_NUMBER` = *(Your phone number with country code, e.g., `2348012345678`, no spaces or +)*
   - `MONGODB_URI` = *(Your MongoDB Atlas Connection string)*
   - `GEMINI_API_KEY` = *(Your official Google Gemini API Key)*
3. Run the secure pairing wizard:
   ```bash
   npm run pair
   ```
4. Watch the console logs! A secure hyphenated **Pairing Code** will print (e.g., `A1B2-C3D4`).
5. Open **WhatsApp on your phone > Settings > Linked Devices > Link a Device > Link with phone number instead**.
6. Type the Pairing Code printed in your logs! Once linked, the wizard automatically uploads your session to MongoDB Atlas and exits safely.

---

## 🚀 Step 2: Start the Main Bot (Run 24/7)
Once paired, your session credentials are saved safely in MongoDB Atlas. You can now boot your bot and keep-alive server:
```bash
npm start
```
The bot will download your session from MongoDB, connect instantly, run 24/7, and automatically stay awake via the HTTP keep-alive server!

---

## ☁️ Render.com Cloud Deployment Guide (Full Tutorial)

### 1. Set Up MongoDB Atlas (Free State Storage)
1. Go to [MongoDB Atlas](https://www.mongodb.com/cloud/atlas) and register a free account.
2. Create a Free Cluster (Shared M0 Tier).
3. Under **Database Access**, create a user and copy down the username and password.
4. Under **Network Access**, click **Add IP Address** and set it to `0.0.0.0/0` (this is critical so Render's changing IPs can connect).
5. On your Cluster page, click **Connect > Drivers**, and copy your **connection string**. Replace `<password>` with your database user password.

### 2. Set Up Your Private GitHub Repository
1. Create a free account on [GitHub.com](https://github.com).
2. Go to your GitHub profile settings and create a Personal Access Token (PAT). (Use this PAT as your password when pushing code!).
3. Create a new **Private** repository named `whatsapp-vibe-bot`.
4. On your local machine or Termux, push your code files:
   ```bash
   git init
   echo "node_modules/" >> .gitignore
   echo "session_auth/" >> .gitignore
   echo ".env" >> .gitignore
   git add .
   git commit -m "deploying robust VibeGuard bot v2.4.0"
   git branch -M main
   git remote add origin https://github.com/YOUR_GITHUB_USERNAME/whatsapp-vibe-bot.git
   git push -u origin main
   ```

### 3. Deploy 24/7 on Render (Free Tier)
1. Sign up on [Render.com](https://render.com) using your GitHub login.
2. Click **New +** at the top right and select **Web Service**.
3. Find your `whatsapp-vibe-bot` repository in the list and click **Connect**.
4. Set the following configuration:
   - **Runtime**: `Node`
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
5. Scroll down to **Environment Variables** and click **Add Environment Variable**:
   - `GEMINI_API_KEY` = *(Your official Google Gemini API Key)*
   - `MONGODB_URI` = *(Your MongoDB Atlas Connection string)*
   - `PHONE_NUMBER` = *(The bot's phone number with country code, e.g. 2348012345678)*
6. Click **Deploy Web Service**!
7. 
