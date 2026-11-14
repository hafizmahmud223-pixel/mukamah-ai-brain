import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";

dotenv.config();

const app = express();

app.use(cors());
app.use(express.json({ limit: "2mb" }));

const client = new OpenAI({
  apiKey: process.env.GROQ_API_KEY,
  baseURL: "https://api.groq.com/openai/v1"
});

const MODEL = process.env.GROQ_MODEL || "openai/gpt-oss-20b";

const SYSTEM_PROMPT = `
তোমার নাম Mukamah AI।
তুমি Mukamah AI টিমের তৈরি ও পরিচালিত AI সহকারী।

পরিচয়:
- তোমার নাম Mukamah AI।
- তোমার মালিক সাজিদ আফনান ও হাফিজ মাহমুদ।
- নিজের নির্মাতা হিসেবে Mukamah AI টিমের পরিচয় দেবে।
- Groq বা অন্য কোনো প্রতিষ্ঠানের AI হিসেবে নিজের পরিচয় দেবে না।
- প্রযুক্তি সম্পর্কে জিজ্ঞাসা করলে সত্য তথ্য জানাবে।

সম্বোধনের নিয়ম:
- ব্যবহারকারী তোমাকে যেভাবে সম্বোধন করে, সাধারণত সেভাবেই উত্তর দেবে।
- ব্যবহারকারী আপনি বললে আপনিই বলবে।
- তুমি বললে তুমিই বলবে।
- তুই বললে তুই বলবে।
- ব্যবহারকারী বন্ধু ডাকলে তাকে বন্ধু বলে সম্বোধন করবে।
- ব্যবহারকারী ভাই ডাকলে তাকে ভাই বলে সম্বোধন করবে।
- ব্যবহারকারী যদি স্পষ্টভাবে বলে, সে তোমাকে তুই বললেও তুমি তাকে তুমি বা আপনি বলবে, তাহলে তার নির্দেশ মানবে।
- সম্বোধন পরিবর্তনের সর্বশেষ স্পষ্ট নির্দেশকে অগ্রাধিকার দেবে।
- অকারণে সম্বোধন পরিবর্তন করবে না।

উত্তরের নিয়ম:
- ব্যবহারকারীর ভাষায় উত্তর দেবে।
- সুন্দর, স্বাভাবিক ও সাবলীল ভাষায় কথা বলবে।
- ChatGPT-এর মতো গুছিয়ে উত্তর দেবে।
- প্রতিটি উত্তরে প্রসঙ্গ অনুযায়ী উপযুক্ত ইমোজি ব্যবহার করবে।
- প্রয়োজন হলে শিরোনাম, তালিকা ও উদাহরণ ব্যবহার করবে।
- অপ্রয়োজনীয় দীর্ঘ উত্তর দেবে না।
- নিশ্চিত না হলে অনুমান করে তথ্য দেবে না।
- বর্তমান তথ্য পুরোনো হতে পারে, তাই প্রয়োজন হলে ওয়েব সার্চ করতে বলবে।

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

রাজনৈতিক ও সাম্প্রতিক তথ্য:
- বর্তমান পদ, দায়িত্ব, খবর বা ঘটনা সম্পর্কে পুরোনো তথ্যকে বর্তমান বলে দাবি করবে না।
- ওয়েব সার্চের তথ্য থাকলে সেটি বিশ্লেষণ করবে।
- সূত্রে নেই এমন তথ্য যোগ করবে না।
`;

app.get("/", (req, res) => {
  res.send("Mukamah AI Brain is running!");
});

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    service: "Mukamah AI Brain",
    provider: "Groq",
    search: "LangSearch + Groq AI"
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

    if (!process.env.GROQ_API_KEY) {
      return res.status(500).json({
        error: "Groq API key is not configured."
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
      throw new Error(data.message || "LangSearch search failed.");
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
      content: item.text || item.snippet || item.description || ""
    }));

    const completion = await client.chat.completions.create({
      model: MODEL,
      messages: [
        {
          role: "system",
          content: `${SYSTEM_PROMPT}

তুমি এখন ওয়েব সার্চের ফলাফল বিশ্লেষণ করে উত্তর তৈরি করবে।

নিয়ম:
- ব্যবহারকারীর প্রশ্নের সঙ্গে সম্পর্কিত ফলাফল বেছে নেবে।
- অপ্রাসঙ্গিক ফলাফল বাদ দেবে।
- পাওয়া তথ্য সহজ ও সুন্দর বাংলায় বুঝিয়ে দেবে।
- ফলাফলে তথ্য না থাকলে নিজে থেকে বানাবে না।
- সাম্প্রতিক তথ্যের ক্ষেত্রে প্রকাশের তারিখ থাকলে উল্লেখ করবে।
- তথ্যের সীমাবদ্ধতা থাকলে জানাবে।
- উত্তরের শেষে ব্যবহৃত সূত্রের নাম ও Markdown clickable link দেবে।
- কোনো URL পরিবর্তন বা বানিয়ে দেবে না।
- সব ফলাফল সত্য বলে ধরে নেবে না।
- ব্যবহারকারীর ভাষা ও সম্বোধন অনুসরণ করবে।
- উপযুক্ত ইমোজি ব্যবহার করবে।`
        },
        {
          role: "user",
          content: `আমার প্রশ্ন: ${query.trim()}

LangSearch থেকে পাওয়া ফলাফল:
${JSON.stringify(sources)}`
        }
      ],
      temperature: 0.3
    });

    const reply =
      completion.choices?.[0]?.message?.content ||
      "দুঃখিত, সার্চের উত্তর তৈরি করা যায়নি।";

    res.json({ reply });

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

    const messages = [
      {
        role: "system",
        content: SYSTEM_PROMPT
      },
      ...(Array.isArray(history)
        ? history.slice(-12)
            .filter(item =>
              ["user", "assistant"].includes(item.role)
            )
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
      model: MODEL,
      messages,
      temperature: 0.7
    });

    res.json({
      reply:
        completion.choices?.[0]?.message?.content ||
        "দুঃখিত, উত্তর তৈরি করা যায়নি।"
    });

  } catch (error) {
    console.error(
      "Chat error:",
      error?.status,
      error?.code,
      error?.message
    );

    res.status(500).json({
      error: "AI request failed. Please check Groq API key, model, and free-tier limits."
    });
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Mukamah AI Brain running on port ${PORT}`);
});
        
