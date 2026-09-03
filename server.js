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

app.get("/healthz", (req, res) => {
  res.json({ ok: true });
});

app.post("/api/chat", async (req, res) => {
  try {
    const { message, chatId } = req.body;

    if (!message || !message.trim()) {
      return res.status(400).json({
        error: "Message is required."
      });
    }

    let activeChatId = chatId;

    if (!activeChatId) {
      const chat = await chatSDK.createChat("Negotiations Agent Chat");
      activeChatId = chat.chat_id || chat.id;
    }

    const response = await chatSDK.sendMessage(message, {
      chatId: activeChatId,
      agentType: "chat_agent",
      agentId: process.env.CHATBOT_AGENT_ID,
      useKnowledgebase: true,
      skipStream: true
    });

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

    res.json({
      chatId: activeChatId,
      reply
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
