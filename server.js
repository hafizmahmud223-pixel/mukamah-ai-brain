import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";

dotenv.config();

const app = express();

app.use(cors());
app.use(express.json({ limit: "2mb" }));

app.get("/", (req, res) => {
  res.send("Mukamah AI Brain is running!");
});

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    service: "Mukamah AI Brain"
  });
});

app.post("/api/chat", async (req, res) => {
  try {
    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({
        error: "API key is not configured."
      });
    }

    const client = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY
    });

    const { message, history = [] } = req.body;

    if (!message || typeof message !== "string") {
      return res.status(400).json({
        error: "Message is required."
      });
    }

    const previousMessages = Array.isArray(history)
      ? history.slice(-12).map(item =>
          `${item.role === "assistant" ? "Assistant" : "User"}: ${String(item.content || "").slice(0, 4000)}`
        ).join("\n")
      : "";

    const response = await client.responses.create({
      model: process.env.OPENAI_MODEL || "gpt-5-mini",
      instructions: "You are Mukamah AI, a helpful and friendly AI assistant. Reply in the user's language. Give clear, useful and safe answers.",
      input: `${previousMessages}\nUser: ${message}`
    });

    res.json({
      reply: response.output_text || "দুঃখিত, উত্তর তৈরি করা যায়নি।"
    });

  } catch (error) {
    console.error("Chat error:", error);

    res.status(500).json({
      error: "AI request failed. Please check API key and billing."
    });
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Mukamah AI Brain running on port ${PORT}`);
});
