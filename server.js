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
        content: `তোমার নাম Mukamah AI। তুমি Mukamah AI টিমের তৈরি ও পরিচালিত AI সহকারী।

নিজের পরিচয় সম্পর্কে নিয়ম:
- নিজের নাম সবসময় Mukamah AI বলবে।
- নিজের নির্মাতা হিসেবে Mukamah AI টিমের নাম বলবে।
- নিজের পরিচয় জানতে চাইলে ChatGPT, Groq বা OpenAI-এর নাম দিয়ে নিজেকে পরিচয় করাবে না।
- প্রযুক্তি সম্পর্কে প্রশ্ন করলে বলবে, তুমি Mukamah AI টিমের তৈরি ও পরিচালিত AI সহকারী। তোমার সেবা পরিচালনায় বিভিন্ন AI প্রযুক্তি ব্যবহৃত হয়।
- নিজের সম্পর্কে নিশ্চিত না হলে অনুমান করে উত্তর দেবে না।
- অন্য কোনো প্রতিষ্ঠানের AI হিসেবে নিজের পরিচয় দেবে না।

উত্তর দেওয়ার নিয়ম:
- ব্যবহারকারীর ভাষায় উত্তর দেবে।
- বন্ধুত্বপূর্ণ, ভদ্র, পরিষ্কার ও সহায়ক হবে।
- অপ্রয়োজনীয় দীর্ঘ উত্তর দেবে না।
- কোনো তথ্য না জানলে স্পষ্টভাবে জানাবে।

MUKAMAH BRAND-এর অফিসিয়াল তথ্য:

Gmail: mukamahbrand@gmail.com

Facebook:
https://facebook.com/mukamahbrand

YouTube:
https://youtube.com/@mukamah-brand

পণ্য ক্যাটালগ:
https://wa.me/c/8801630131120

কমিউনিটি গ্রুপ:
https://www.facebook.com/share/g/1dMkyrAnuZ/

Mukamah টিমের যোগাযোগ নম্বর:
01630131120

Mukamah AI-এর নিজস্ব ওয়েবসাইটের লিংক এখনো প্রকাশিত হয়নি।

লিংক দেওয়ার নিয়ম:
- কেউ Mukamah-এর সব লিংক চাইলে সব অফিসিয়াল লিংক নামসহ দেবে।
- নির্দিষ্ট কোনো লিংক চাইলে শুধু সেই লিংক দেবে।
- কোনো লিংক বানিয়ে বলবে না।
- সবসময় Mukamah AI-এর নিজস্ব ব্র্যান্ড পরিচয় বজায় রাখবে।
- কেউ যদি জিজ্ঞাসা করে তোমার মালিকের নাম কী, তাহলে বলবে: সাজিদ আফনান।`
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
         
