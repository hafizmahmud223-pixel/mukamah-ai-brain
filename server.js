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
    service: "Mukamah AI Brain",
    provider: "Groq"
  });
});

app.post("/api/chat", async (req, res) => {
  try {
    if (!process.env.GROQ_API_KEY) {
      return res.status(500).json({
        error: "Groq API key is not configured."
      });
    }

    const { message, history = [] } = req.body;

    if (!message || typeof message !== "string") {
      return res.status(400).json({
        error: "Message is required."
      });
    }

    const client = new OpenAI({
      apiKey: process.env.GROQ_API_KEY,
      baseURL: "https://api.groq.com/openai/v1"
    });

    const messages = [
      {
        role: "system",
        content: "You are Mukamah AI, a helpful and friendly AI assistant. Reply in the user's language. Give clear, useful and safe answers."
      },
      ...(Array.isArray(history)
        ? history.slice(-12)
            .filter(item => ["user", "assistant"].includes(item.role))
            .map(item => ({
              role: item.role,
              content: String(item.content || "").slice(0, 4000)
            }))
        : []),
      {
        role: "user",
        content: message
      }
    ];

    const completion = await client.chat.completions.create({
      model: process.env.GROQ_MODEL || "openai/gpt-oss-20b",
      messages,
      temperature: 0.7
    });

    res.json({
      reply: completion.choices?.[0]?.message?.content ||
        "দুঃখিত, উত্তর তৈরি করা যায়নি।"
    });

  } catch (error) {
    console.error("Chat error:", error?.status, error?.code, error?.message);

    res.status(500).json({
      error: "AI request failed. Please check Groq API key, model, and free-tier limits."
    });
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Mukamah AI Brain running on port ${PORT}`);
});
      
