import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";

dotenv.config();

const app = express();

app.use(cors());
app.use(express.json({ limit: "2mb" }));

const groqClient = new OpenAI({
  apiKey: process.env.GROQ_API_KEY,
  baseURL: "https://api.groq.com/openai/v1"
});

const GEMINI_MODEL =
  process.env.GEMINI_MODEL || "gemini-3.8-flash";

const GROQ_MODEL =
  process.env.GROQ_MODEL || "openai/gpt-oss-20b";

const SYSTEM_PROMPT = `
তোমার নাম Mukamah AI।
তুমি Mukamah AI টিমের তৈরি ও পরিচালিত AI সহকারী।

পরিচয়:
- তোমার নাম Mukamah AI।
- তোমার মালিক সাজিদ আফনান ও হাফিজ মাহমুদ।
- নিজের নির্মাতা হিসেবে Mukamah AI টিমের পরিচয় দেবে।
- Groq বা Google-এর AI হিসেবে নিজের পরিচয় দেবে না।
- প্রযুক্তি সম্পর্কে জিজ্ঞাসা করলে সত্য তথ্য জানাবে।

সম্বোধনের নিয়ম:
- ব্যবহারকারী তোমাকে যেভাবে সম্বোধন করে, সাধারণত সেভাবেই উত্তর দেবে।
- ব্যবহারকারী আপনি বললে আপনিই বলবে।
- তুমি বললে তুমিই বলবে।
- তুই বললে তুই বলবে।
- ব্যবহারকারী বন্ধু ডাকলে তাকে বন্ধু বলে সম্বোধন করবে।
- ব্যবহারকারী ভাই ডাকলে তাকে ভাই বলে সম্বোধন করবে।
- অকারণে সম্বোধন পরিবর্তন করবে না।

উত্তরের সৌন্দর্য ও বিন্যাস:
- ChatGPT-এর মতো পরিষ্কার, সুন্দর ও গোছানো উত্তর দেবে।
- ব্যবহারকারীর ভাষায় উত্তর দেবে।
- প্রয়োজন হলে সুন্দর শিরোনাম ব্যবহার করবে।
- গুরুত্বপূর্ণ শব্দ ও বাক্য **Bold** করবে।
- একাধিক বিষয় থাকলে বুলেট পয়েন্ট ব্যবহার করবে।
- ধাপে ধাপে বোঝানোর সময় নম্বর ব্যবহার করবে।
- প্রয়োজন অনুযায়ী উদাহরণ ও ছোট ব্যাখ্যা দেবে।
- উপযুক্ত জায়গায় ইমোজি ব্যবহার করবে।
- সাধারণ ছোট প্রশ্নের উত্তর অকারণে বড় করবে না।
- প্রতিটি লাইনে অকারণে শিরোনাম বা ইমোজি ব্যবহার করবে না।
- Markdown ফরম্যাট ব্যবহার করবে।
- কোড চাইলে সঠিক কোড ব্লক ব্যবহার করবে।
- লিংক দিলে Markdown clickable link ব্যবহার করবে।
- একই কথা বারবার বলবে না।
- নিশ্চিত না হলে অনুমান করে তথ্য দেবে না।

অফিসিয়াল Mukamah তথ্য:
Gmail: mukamahbrand@gmail.com
Facebook: https://facebook.com/mukamahbrand
YouTube: https://youtube.com/@mukamah-brand
WhatsApp Catalog: https://wa.me/c/8801630131120
Community Group: https://www.facebook.com/share/g/1dMkyrAnuZ/
Team Phone: 01630131120

Mukamah AI-এর নিজস্ব ওয়েবসাইট এখনো প্রকাশিত হয়নি।

লিংকের নিয়ম:
- লিংক চাইলে সঠিক সম্পূর্ণ URL দেবে।
- Markdown clickable link ব্যবহার করবে।
- লিংক কখনো বানিয়ে দেবে না।
- নির্দিষ্ট লিংক চাইলে শুধু সেটিই দেবে।

তথ্যের নির্ভুলতা:
- বর্তমান খবর বা তথ্যের ক্ষেত্রে পুরোনো তথ্যকে বর্তমান বলে দাবি করবে না।
- ওয়েব সার্চের ফলাফল পেলে সেগুলো বিশ্লেষণ করবে।
- সূত্রে নেই এমন তথ্য যোগ করবে না।
- সার্চের ফলাফল না থাকলে সেটা পরিষ্কারভাবে জানাবে।
`;

function normalizeHistory(history) {
  if (!Array.isArray(history)) return [];

  return history
    .slice(-12)
    .filter(item =>
      item &&
      ["user", "assistant"].includes(item.role)
    )
    .map(item => ({
      role: item.role,
      content: String(item.content || "").slice(0, 4000)
    }));
}

// Google Gemini API
async function askGemini(messages, systemPrompt = SYSTEM_PROMPT) {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY is not configured.");
  }

  const contents = messages
    .filter(item => ["user", "assistant"].includes(item.role))
    .map(item => ({
      role: item.role === "assistant" ? "model" : "user",
      parts: [{ text: String(item.content || "") }]
    }));

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": process.env.GEMINI_API_KEY
      },
      body: JSON.stringify({
        systemInstruction: {
          parts: [{ text: systemPrompt }]
        },
        contents,
        generationConfig: {
          temperature: 0.75,
          maxOutputTokens: 3000
        }
      }),
      signal: AbortSignal.timeout(60000)
    }
  );

  const data = await response.json();

  if (!response.ok) {
    throw new Error(
      data.error?.message || `Gemini HTTP ${response.status}`
    );
  }

  const reply = data.candidates?.[0]?.content?.parts
    ?.map(part => part.text || "")
    .join("")
    .trim();

  if (!reply) {
    throw new Error("Gemini returned an empty response.");
  }

  return reply;
}

// Groq backup API
async function askGroq(messages, systemPrompt = SYSTEM_PROMPT) {
  if (!process.env.GROQ_API_KEY) {
    throw new Error("GROQ_API_KEY is not configured.");
  }

  const completion = await groqClient.chat.completions.create({
    model: GROQ_MODEL,
    messages: [
      {
        role: "system",
        content: systemPrompt
      },
      ...messages
    ],
    temperature: 0.7,
    max_completion_tokens: 3000,
    reasoning_effort: "low",
    reasoning_format: "hidden"
  });

  const reply = completion.choices?.[0]?.message?.content;

  if (!reply || typeof reply !== "string") {
    throw new Error("Groq returned an empty response.");
  }

  return reply.trim();
}

// Gemini first, Groq if Gemini fails
async function generateAIReply(messages, systemPrompt = SYSTEM_PROMPT) {
  try {
    const reply = await askGemini(messages, systemPrompt);

    return {
      reply,
      provider: "Gemini"
    };
  } catch (geminiError) {
    console.error("Gemini error:", geminiError.message);

    try {
      const reply = await askGroq(messages, systemPrompt);

      return {
        reply,
        provider: "Groq"
      };
    } catch (groqError) {
      console.error("Groq backup error:", groqError.message);

      throw new Error(
        "Gemini and Groq both failed. Check API keys and usage limits."
      );
    }
  }
}

// Home
app.get("/", (req, res) => {
  res.send("Mukamah AI Brain is running!");
});

// Health check
app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    service: "Mukamah AI Brain",
    provider: "Google Gemini (Primary) + Groq (Backup)",
    model: GEMINI_MODEL,
    search: "LangSearch + Gemini AI"
  });
});

// Web Search API
app.post("/api/search", async (req, res) => {
  try {
    if (!process.env.LANGSEARCH_API_KEY) {
      return res.status(500).json({
        error: "LangSearch API key is not configured."
      });
    }

    const { query } = req.body;

    if (!query || typeof query !== "string" || !query.trim()) {
      return res.status(400).json({
        error: "Search query is required."
      });
    }

    const searchResponse = await fetch(
      "https://api.langsearch.com/v1/web-search",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.LANGSEARCH_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          query: query.trim().slice(0, 500),
          count: 5,
          contents: {
            text: {
              max_characters: 2000
            }
          }
        }),
        signal: AbortSignal.timeout(30000)
      }
    );

    if (!searchResponse.ok) {
      throw new Error(`LangSearch HTTP ${searchResponse.status}`);
    }

    const data = await searchResponse.json();

    if (String(data.code) !== "200") {
      throw new Error(data.message || "LangSearch failed.");
    }

    const results = data.data?.webPages?.value || [];

    if (!results.length) {
      return res.json({
        reply: "দুঃখিত, এই বিষয়ে নির্ভরযোগ্য সার্চ ফলাফল পাওয়া যায়নি। 😊"
      });
    }

    const sources = results.map((item, index) => ({
      number: index + 1,
      title: item.name || "শিরোনাম পাওয়া যায়নি",
      url: item.url || "",
      date: item.datePublished || "",
      content: item.text || item.snippet || ""
    }));

    const searchSystemPrompt = `
${SYSTEM_PROMPT}

তুমি এখন ওয়েব সার্চের ফলাফল বিশ্লেষণ করে উত্তর তৈরি করবে।

বিশেষ নিয়ম:
- ব্যবহারকারীর প্রশ্নের সঙ্গে সম্পর্কিত তথ্য বেছে নেবে।
- অপ্রাসঙ্গিক ফলাফল বাদ দেবে।
- সূত্রে নেই এমন তথ্য বানিয়ে বলবে না।
- প্রকাশের তারিখ থাকলে উল্লেখ করবে।
- একাধিক নির্ভরযোগ্য সূত্রের তথ্য মিলিয়ে দেখবে।
- তথ্য নিশ্চিত না হলে সীমাবদ্ধতা জানাবে।
- উত্তর সুন্দরভাবে Markdown দিয়ে সাজাবে।
- প্রয়োজন হলে শিরোনাম, বুলেট পয়েন্ট ও Bold ব্যবহার করবে।
- উত্তরের শেষে ব্যবহৃত সূত্রের নাম ও সঠিক URL দিয়ে clickable link দেবে।
- কোনো URL পরিবর্তন বা বানিয়ে দেবে না।
- সূত্রের তথ্য ও নিজের ব্যাখ্যা আলাদা রাখবে।
`;

    const result = await generateAIReply(
      [
        {
          role: "user",
          content: `আমার প্রশ্ন: ${query.trim()}

LangSearch থেকে পাওয়া ফলাফল:
${JSON.stringify(sources)}`
        }
      ],
      searchSystemPrompt
    );

    res.json({
      reply: result.reply,
      provider: result.provider
    });

  } catch (error) {
    console.error("Search error:", error.message);

    res.status(500).json({
      error: "Web search failed. Please try again later."
    });
  }
});

// Chat API
app.post("/api/chat", async (req, res) => {
  try {
    const { message, history = [] } = req.body;

    if (!message || typeof message !== "string" || !message.trim()) {
      return res.status(400).json({
        error: "Message is required."
      });
    }

    const messages = [
      ...normalizeHistory(history),
      {
        role: "user",
        content: message.trim().slice(0, 8000)
      }
    ];

    const result = await generateAIReply(messages);

    res.json({
      reply: result.reply,
      provider: result.provider
    });

  } catch (error) {
    console.error("Chat error:", error.message);

    res.status(503).json({
      error: "AI এখন উত্তর দিতে পারছে না। কিছুক্ষণ পর আবার চেষ্টা করো।"
    });
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Mukamah AI Brain running on port ${PORT}`);
});
  
