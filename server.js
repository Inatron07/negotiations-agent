import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
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
const PLANNED_CREDITS = 1000;
const SONNET_5_RATE = { inputPer1M: 2000, outputPer1M: 10000 }; // credits per 1M tokens
// Seeded from the account's actual usage at the time this demo budget was carved out
// (0.678k credits already used on the real EKB account) so the counter starts where
// the account really stands, then accrues independently from there.
let usedCredits = 678;

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

function usageSnapshot() {
  const used = Math.min(Math.round(usedCredits), PLANNED_CREDITS);
  const remaining = Math.max(PLANNED_CREDITS - used, 0);
  const percent = Math.min(Math.round((used / PLANNED_CREDITS) * 100), 100);
  return { used, planned: PLANNED_CREDITS, remaining, percent };
}

app.get("/healthz", (req, res) => {
  res.json({ ok: true });
});

app.get("/api/usage", (req, res) => {
  res.json(usageSnapshot());
});

app.post("/api/chat", async (req, res) => {
  try {
    const { message, chatId } = req.body;

    if (!message || !message.trim()) {
      return res.status(400).json({
        error: "Message is required."
      });
    }

    if (usedCredits >= PLANNED_CREDITS) {
      return res.status(402).json({
        error: "Credit limit reached.",
        details:
          "This demo has used its full 1,000-credit allowance. Please contact the Dev team for more credits.",
        limitReached: true,
        usage: usageSnapshot()
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

    usedCredits += estimateTurnCost(message, reply);

    res.json({
      chatId: activeChatId,
      reply,
      usage: usageSnapshot()
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
