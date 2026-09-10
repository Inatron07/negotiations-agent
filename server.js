import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import Redis from "ioredis";
import { ChatSDK } from "@odin-ai-staging/sdk/dist/index.esm.js";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const allowedOrigin = process.env.ALLOWED_ORIGIN || "*";
app.use(cors({ origin: allowedOrigin === "*" ? true : allowedOrigin.split(",").map((s) => s.trim()) }));
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const chatSDK = new ChatSDK({
  baseUrl: process.env.CHATBOT_BASE_URL,
  projectId: process.env.CHATBOT_PROJECT_ID,
  apiKey: process.env.CHATBOT_API_KEY,
  apiSecret: process.env.CHATBOT_API_SECRET
});

// ---------- Credit usage tracking (scoped to this demo/site only) ----------
// This is a separate, self-imposed budget for the public demo — it has no
// relationship to the real EKB account's actual plan/usage. It approximates
// the documented EKB credit model (platform action credits + LLM token
// credits at Claude Sonnet 5 rates) since the SDK response doesn't expose
// real token counts.
const PLANNED_CREDITS = 5000;
const SONNET_5_RATE = { inputPer1M: 2000, outputPer1M: 10000 }; // credits per 1M tokens
// Seeded at 0.678 (matching the "0.678k" figure shown on the real EKB account at the
// time this demo budget was carved out) so Remaining starts at 5000 - 0.678 = 4999.32.
const SEED_USED_CREDITS = 0.678;
const CREDIT_KEY = "negotiations_agent:used_credits";

// IMPORTANT: this counter used to live in a plain JS variable. On Render's
// free plan the web service spins down after ~15 minutes of no traffic and
// loses all in-memory state (and the local filesystem) on every spin-up —
// so the counter silently reset to the seed value over and over, letting
// total usage blow past PLANNED_CREDITS across a day of intermittent
// traffic (this is what let a 1,000-credit cap pass 2,000+ actual credits
// used). The counter now lives in a separate, always-on Render Key Value
// (Redis) instance shared by every service/instance running this code, so
// the cap survives web service restarts and applies across duplicate
// deployments of the same app.
const CREDIT_STORE_URL = process.env.CREDIT_STORE_URL || process.env.REDIS_URL || "";

let redis = null;
let usingInMemoryFallback = false;
let inMemoryUsedCredits = SEED_USED_CREDITS;

if (CREDIT_STORE_URL) {
  redis = new Redis(CREDIT_STORE_URL, {
    maxRetriesPerRequest: 2,
    lazyConnect: false
  });
  redis.on("error", (err) => {
    console.error("Credit store (Redis) connection error:", err?.message || err);
  });
  // Seed the counter once, the first time this key is ever created. NX means
  // this is a no-op if some instance already seeded it.
  redis.set(CREDIT_KEY, String(SEED_USED_CREDITS), "NX").catch((err) => {
    console.error("Failed to seed credit counter:", err?.message || err);
  });
} else {
  // No persistent store configured (e.g. local dev without CREDIT_STORE_URL
  // set) — fall back to an in-memory counter so `npm start` still works,
  // but this fallback is NOT safe for production: it resets on every
  // restart and is not shared across instances.
  usingInMemoryFallback = true;
  console.warn(
    "CREDIT_STORE_URL is not set — falling back to an in-memory credit counter. " +
      "This is fine for local development, but on Render this MUST be set to a " +
      "Key Value (Redis) connection string, or the credit cap will not reliably hold " +
      "across service restarts/spin-downs."
  );
}

function estimateTokens(text) {
  // Rough heuristic: ~4 characters per token.
  return Math.ceil((text || "").length / 4);
}

function estimateTurnCost(inputText, outputText) {
  const inputTokens = estimateTokens(inputText);
  const outputTokens = estimateTokens(outputText);
  const platformCredits = 1 /* message */ + 1 /* knowledgebase tool call */;
  const tokenCredits =
    (inputTokens / 1_000_000) * SONNET_5_RATE.inputPer1M +
    (outputTokens / 1_000_000) * SONNET_5_RATE.outputPer1M;
  return platformCredits + tokenCredits;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

// Reads the current used-credits total from the shared store (or the
// in-memory fallback). Always reads fresh — never trusts a cached value —
// so the hard cap holds even with multiple instances/processes running.
async function getUsedCredits() {
  if (usingInMemoryFallback) return inMemoryUsedCredits;

  const raw = await redis.get(CREDIT_KEY);
  if (raw === null) {
    // Key missing (e.g. store was wiped) — reseed rather than silently
    // treating usage as 0, and fail closed if that fails too.
    await redis.set(CREDIT_KEY, String(SEED_USED_CREDITS), "NX");
    return SEED_USED_CREDITS;
  }
  const parsed = parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : SEED_USED_CREDITS;
}

// Atomically adds `delta` to the shared counter and returns the new total.
async function addUsedCredits(delta) {
  if (usingInMemoryFallback) {
    inMemoryUsedCredits += delta;
    return inMemoryUsedCredits;
  }
  const newValue = await redis.incrbyfloat(CREDIT_KEY, delta);
  return parseFloat(newValue);
}

function usageSnapshot(usedCreditsRaw) {
  const used = Math.min(round2(usedCreditsRaw), PLANNED_CREDITS);
  const remaining = Math.max(round2(PLANNED_CREDITS - used), 0);
  const percent = Math.min(Math.round((used / PLANNED_CREDITS) * 100), 100);
  return { used, planned: PLANNED_CREDITS, remaining, percent };
}

app.get("/healthz", (req, res) => {
  res.json({ ok: true });
});

app.get("/api/usage", async (req, res) => {
  try {
    const used = await getUsedCredits();
    res.json(usageSnapshot(used));
  } catch (error) {
    console.error("Failed to read credit usage:", error);
    res.status(503).json({ error: "Unable to read credit usage right now." });
  }
});

app.post("/api/chat", async (req, res) => {
  try {
    const { message, chatId } = req.body;

    if (!message || !message.trim()) {
      return res.status(400).json({
        error: "Message is required."
      });
    }

    let usedCredits;
    try {
      usedCredits = await getUsedCredits();
    } catch (error) {
      // Fail CLOSED: if we can't reliably read the credit counter, refuse
      // the request rather than risk letting usage run over the cap again.
      console.error("Credit store unavailable, refusing request:", error);
      return res.status(503).json({
        error: "Credit tracking is temporarily unavailable.",
        details: "Please try again in a moment. This demo won't process requests it can't meter."
      });
    }

    if (usedCredits >= PLANNED_CREDITS) {
      return res.status(402).json({
        error: "Credit limit reached.",
        details:
          "This demo has used its full 5,000-credit allowance. Please contact the Dev team for more credits.",
        limitReached: true,
        usage: usageSnapshot(usedCredits)
      });
    }

    let activeChatId = chatId;

    if (!activeChatId) {
      const chat = await chatSDK.createChat("Negotiations Agent Chat");

      if (typeof chat === "string") {
        throw new Error(
          "The chatbot API returned a web page instead of data. CHATBOT_BASE_URL is probably pointed at the app's front-end host instead of its API host — double-check it against the API docs/console."
        );
      }

      activeChatId = chat.chat_id || chat.id;
    }

    const response = await chatSDK.sendMessage(message, {
      chatId: activeChatId,
      agentType: "chat_agent",
      agentId: process.env.CHATBOT_AGENT_ID,
      useKnowledgebase: true,
      skipStream: true
    });

    if (typeof response === "string") {
      throw new Error(
        "The chatbot API returned a web page instead of data. CHATBOT_BASE_URL is probably pointed at the app's front-end host instead of its API host — double-check it against the API docs/console."
      );
    }

    console.log("Full chatbot response:", JSON.stringify(response, null, 2));

    const reply =
      response?.message?.final_response ||
      response?.message?.response ||
      response?.message?.content ||
      response?.message?.text ||
      response?.content ||
      response?.data?.message?.final_response ||
      response?.data?.message?.response ||
      response?.data?.message?.content ||
      response?.data?.message?.text ||
      response?.data?.content ||
      response?.response?.content ||
      response?.response?.text ||
      response?.response ||
      response?.answer ||
      response?.text ||
      JSON.stringify(response, null, 2);

    let newUsedCredits;
    try {
      newUsedCredits = await addUsedCredits(estimateTurnCost(message, reply));
    } catch (error) {
      // The chat reply already succeeded (and the underlying account was
      // already billed for it upstream) — we still return the reply, but
      // log loudly since the counter failed to record this turn's cost.
      console.error("Failed to record credit usage for this turn:", error);
      newUsedCredits = usedCredits;
    }

    res.json({
      chatId: activeChatId,
      reply,
      usage: usageSnapshot(newUsedCredits)
    });

  } catch (error) {
    console.error("Chatbot Error:", error);

    res.status(500).json({
      error: "Unable to process chat request.",
      details: error?.message || "Unknown error"
    });
  }
});

app.listen(PORT, () => {
  console.log(`Negotiations agent chatbot running at http://localhost:${PORT}`);
});
