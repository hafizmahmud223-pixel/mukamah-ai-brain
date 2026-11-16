import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";
import admin from "firebase-admin";
import crypto from "node:crypto";

dotenv.config();

const app = express();
app.use(cors({
  origin: process.env.CORS_ORIGIN
    ? process.env.CORS_ORIGIN.split(",").map((x) => x.trim())
    : true,
}));
app.use(express.json({ limit: "2mb" }));

const PORT = Number(process.env.PORT || 3000);
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_MODEL = process.env.GROQ_MODEL || "openai/gpt-oss-20b";
const LANGSEARCH_API_KEY = process.env.LANGSEARCH_API_KEY;
const OWNER_EMAILS = new Set(["hafizmahmud223@gmail.com", "mukamahbrand@gmail.com"]);
const TIME_ZONE = "Asia/Dhaka";

if (!admin.apps.length) {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error("Missing FIREBASE_SERVICE_ACCOUNT_JSON environment variable");
  let serviceAccount;
  try {
    serviceAccount = JSON.parse(raw);
    if (serviceAccount.private_key) serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, "\n");
  } catch (error) {
    throw new Error(`Invalid FIREBASE_SERVICE_ACCOUNT_JSON: ${error.message}`);
  }
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}
const db = admin.firestore();
const auth = admin.auth();

const gemini = GEMINI_API_KEY
  ? new OpenAI({ apiKey: GEMINI_API_KEY, baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/" })
  : null;
const groq = GROQ_API_KEY
  ? new OpenAI({ apiKey: GROQ_API_KEY, baseURL: "https://api.groq.com/openai/v1" })
  : null;

const SYSTEM_PROMPT = `তুমি MUKAMAH AI—একজন সহায়ক, নির্ভরযোগ্য ও ভদ্র AI সহকারী।
প্রতিষ্ঠানের মূল প্রতিষ্ঠাতা ও মালিকের নাম সাজিদ আফনান। মালিক/প্রতিষ্ঠাতা জানতে চাইলে শুধু সাজিদ আফনান বলবে। হাফিজ মাহমুদকে মালিক বা সহ-মালিক বলবে না; পরিচয় প্রসঙ্গে সরাসরি জানতে না চাইলে তার নাম তুলবে না।
ব্যবহারকারীর সম্বোধনের ধরন অনুসরণ করবে: আপনি/তুমি/তুই যেভাবে বলে, সেভাবেই উত্তর দেবে। অযথা বন্ধু/ভাই বলবে না।
উত্তর বাংলায় হলে স্বাভাবিক, পরিষ্কার ও সহায়ক বাংলা ব্যবহার করবে। প্রয়োজনমতো Markdown শিরোনাম, বুলেট ও নম্বর ব্যবহার করবে। অজানা তথ্য বানিয়ে বলবে না।
নিজেকে ChatGPT বা OpenAI বলে পরিচয় দেবে না। প্রযুক্তি সম্পর্কে সরাসরি জিজ্ঞাসা করলে সত্য তথ্য দেবে, অযথা প্রযুক্তি-সরবরাহকারীর নাম তুলবে না।
একটি নির্দিষ্ট লিংক চাইলে শুধু সেই লিংক দেবে। একাধিক লিংক চাইলে প্রতিটির নামসহ আলাদা করে দেবে।
অফিশিয়াল যোগাযোগ: Gmail mukamahbrand@gmail.com; Facebook https://facebook.com/mukamahbrand; YouTube https://youtube.com/@mukamah-brand; WhatsApp catalog https://wa.me/c/8801630131120; Facebook community https://www.facebook.com/share/g/1dMkyrAnuZ/; ফোন 01630131120। MUKAMAH AI-এর নিজস্ব পাবলিক ওয়েবসাইট এখনো প্রকাশিত নয়।`;

function dhakaDateKey(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(date);
}
function isOwner(user) {
  return OWNER_EMAILS.has(String(user.email || "").toLowerCase());
}
function sendError(res, status, message, extra = {}) {
  return res.status(status).json({ ok: false, error: message, ...extra });
}

async function requireUser(req, res, next) {
  try {
    const header = req.headers.authorization || "";
    const match = header.match(/^Bearer\s+(.+)$/i);
    if (!match) return sendError(res, 401, "অনুগ্রহ করে লগইন করুন।");
    const decoded = await auth.verifyIdToken(match[1]);
    const userRecord = await auth.getUser(decoded.uid);
    req.user = { uid: decoded.uid, email: userRecord.email || decoded.email || "", isAnonymous: userRecord.providerData.length === 0 && !userRecord.email };
    req.token = decoded;
    next();
  } catch (error) {
    return sendError(res, 401, "লগইন যাচাই করা যায়নি। আবার লগইন করুন।");
  }
}

async function getAccountStatus(user) {
  const owner = isOwner(user);
  const ref = db.collection("users").doc(user.uid);
  const snap = await ref.get();
  const data = snap.exists ? snap.data() : {};
  const sub = data.subscription || {};
  const active = sub.status === "active" && (!sub.expiresAt || sub.expiresAt.toDate() > new Date());
  const premium = active && ["regular", "student"].includes(sub.plan);
  const day = dhakaDateKey();
  const usageRef = ref.collection("dailyUsage").doc(day);
  const usageSnap = await usageRef.get();
  const usage = usageSnap.exists ? usageSnap.data() : {};
  const chatCount = Number(usage.chatCount || 0);
  const messageCount = Number(usage.messageCount || 0);
  const guest = user.isAnonymous;
  let remaining = null;
  let allowedNewChat = true;
  if (!owner && !premium) {
    if (guest) remaining = Math.max(0, 5 - messageCount);
    else if (chatCount === 0) remaining = 200;
    else if (chatCount <= 2) remaining = 10;
    else { remaining = 0; allowedNewChat = false; }
  }
  return {
    uid: user.uid, email: user.email || null, owner, guest,
    plan: owner ? "owner" : premium ? `${sub.plan}-premium` : guest ? "guest" : "free",
    premium, subscription: active ? { plan: sub.plan, expiresAt: sub.expiresAt?.toDate?.().toISOString() || null } : null,
    date: day, chatCount, messageCount, remainingMessages: remaining,
    allowedNewChat: owner || premium || (guest ? true : allowedNewChat),
  };
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, service: "Mukamah AI Brain", provider: "Google Gemini (Primary) + Groq (Backup)", model: GEMINI_MODEL, search: LANGSEARCH_API_KEY ? "LangSearch + AI" : "AI only" });
});

app.get("/api/me", requireUser, async (req, res) => {
  try { res.json({ ok: true, account: await getAccountStatus(req.user) }); }
  catch (error) { console.error("/api/me", error); sendError(res, 500, "অ্যাকাউন্টের তথ্য আনা যায়নি।"); }
});

app.post("/api/chats/new", requireUser, async (req, res) => {
  try {
    const status = await getAccountStatus(req.user);
    if (!status.allowedNewChat) return sendError(res, 429, "আজকের ফ্রি চ্যাট লিমিট শেষ।", { account: status });
    const day = dhakaDateKey();
    const usageRef = db.collection("users").doc(req.user.uid).collection("dailyUsage").doc(day);
    const chatId = crypto.randomUUID();
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(usageRef);
      const old = snap.exists ? snap.data() : {};
      const count = Number(old.chatCount || 0);
      if (!isOwner(req.user) && !status.premium && !req.user.isAnonymous && count >= 3) throw new Error("DAILY_CHAT_LIMIT");
      tx.set(usageRef, { chatCount: count + 1, messageCount: Number(old.messageCount || 0), updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
      tx.set(usageRef.collection("chats").doc(chatId), { chatId, createdAt: admin.firestore.FieldValue.serverTimestamp(), messagesUsed: 0 });
    });
    res.json({ ok: true, chatId, account: await getAccountStatus(req.user) });
  } catch (error) {
    if (error.message === "DAILY_CHAT_LIMIT") return sendError(res, 429, "আজকের ফ্রি চ্যাট লিমিট শেষ।");
    console.error("/api/chats/new", error); sendError(res, 500, "নতুন চ্যাট তৈরি করা যায়নি।");
  }
});

async function reserveMessage(user, chatId) {
  const day = dhakaDateKey();
  const usageRef = db.collection("users").doc(user.uid).collection("dailyUsage").doc(day);
  const chatRef = usageRef.collection("chats").doc(chatId);
  return db.runTransaction(async (tx) => {
    const [usageSnap, chatSnap, userSnap] = await Promise.all([tx.get(usageRef), tx.get(chatRef), tx.get(db.collection("users").doc(user.uid))]);
    if (!chatSnap.exists) throw new Error("CHAT_NOT_FOUND");
    const usage = usageSnap.exists ? usageSnap.data() : {};
    const chat = chatSnap.data();
    const userData = userSnap.exists ? userSnap.data() : {};
    const sub = userData.subscription || {};
    const active = sub.status === "active" && (!sub.expiresAt || sub.expiresAt.toDate() > new Date());
    const unlimited = isOwner(user) || (active && ["regular", "student"].includes(sub.plan));
    const guest = user.isAnonymous;
    const chatUsed = Number(chat.messagesUsed || 0);
    const totalUsed = Number(usage.messageCount || 0);
    const chatLimit = guest ? 5 : Number(usage.chatCount || 0) === 1 ? 200 : 10;
    if (!unlimited && (guest ? totalUsed >= 5 : chatUsed >= chatLimit)) throw new Error("MESSAGE_LIMIT");
    tx.set(usageRef, { messageCount: totalUsed + 1, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    tx.set(chatRef, { messagesUsed: chatUsed + 1, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    return { day, chatRef, usageRef };
  });
}
async function refundMessage(reservation) {
  if (!reservation) return;
  await db.runTransaction(async (tx) => {
    const [u, c] = await Promise.all([tx.get(reservation.usageRef), tx.get(reservation.chatRef)]);
    tx.set(reservation.usageRef, { messageCount: Math.max(0, Number(u.data()?.messageCount || 0) - 1) }, { merge: true });
    tx.set(reservation.chatRef, { messagesUsed: Math.max(0, Number(c.data()?.messagesUsed || 0) - 1) }, { merge: true });
  });
}

async function askAI(messages) {
  const input = [{ role: "system", content: SYSTEM_PROMPT }, ...messages];
  let lastError;
  if (gemini) {
    try {
      const result = await gemini.chat.completions.create({ model: GEMINI_MODEL, messages: input, temperature: 0.7 });
      return { text: result.choices?.[0]?.message?.content || "", provider: "gemini" };
    } catch (error) { lastError = error; console.error("Gemini failed:", error.message); }
  }
  if (groq) {
    try {
      const result = await groq.chat.completions.create({ model: GROQ_MODEL, messages: input, temperature: 0.7 });
      return { text: result.choices?.[0]?.message?.content || "", provider: "groq" };
    } catch (error) { lastError = error; console.error("Groq failed:", error.message); }
  }
  throw lastError || new Error("No AI provider configured. Add GEMINI_API_KEY or GROQ_API_KEY.");
}

app.post("/api/chat", requireUser, async (req, res) => {
  let reservation;
  try {
    const { messages, chatId } = req.body || {};
    if (!chatId || typeof chatId !== "string") return sendError(res, 400, "chatId প্রয়োজন। আগে নতুন চ্যাট তৈরি করুন।");
    if (!Array.isArray(messages) || !messages.length) return sendError(res, 400, "messages প্রয়োজন।");
    const clean = messages.slice(-30).map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", content: String(m.content || "").slice(0, 12000) })).filter((m) => m.content);
    if (!clean.length || clean[clean.length - 1].role !== "user") return sendError(res, 400, "সর্বশেষ মেসেজটি user হতে হবে।");
    reservation = await reserveMessage(req.user, chatId);
    const result = await askAI(clean);
    res.json({ ok: true, reply: result.text, provider: result.provider, account: await getAccountStatus(req.user) });
  } catch (error) {
    if (reservation) { try { await refundMessage(reservation); } catch (refundError) { console.error("Refund failed", refundError); } }
    if (error.message === "CHAT_NOT_FOUND") return sendError(res, 404, "চ্যাটটি পাওয়া যায়নি। নতুন চ্যাট খুলুন।");
    if (error.message === "MESSAGE_LIMIT") return sendError(res, 429, "এই চ্যাটের মেসেজ লিমিট শেষ।", { account: await getAccountStatus(req.user).catch(() => null) });
    console.error("/api/chat", error); sendError(res, 502, "AI উত্তর দিতে পারেনি। কিছুক্ষণ পর আবার চেষ্টা করুন।");
  }
});

app.post("/api/search", requireUser, async (req, res) => {
  try {
    const query = String(req.body?.query || "").trim();
    if (!query) return sendError(res, 400, "সার্চের বিষয় লিখুন।");
    if (!LANGSEARCH_API_KEY) return sendError(res, 503, "ওয়েব সার্চ এখন কনফিগার করা নেই।");
    const response = await fetch("https://api.langsearch.com/v1/web-search", {
      method: "POST", headers: { "Content-Type": "application/json", "Authorization": `Bearer ${LANGSEARCH_API_KEY}` },
      body: JSON.stringify({ query, freshness: "noLimit", summary: true, count: 6 }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data?.message || `LangSearch HTTP ${response.status}`);
    const items = data?.data?.webPages?.value || data?.data?.results || data?.results || [];
    const results = items.slice(0, 6).map((x) => ({ title: x.name || x.title || "ফলাফল", url: x.url || x.link || "", snippet: x.snippet || x.summary || "" }));
    let summary = "";
    if (results.length) {
      try {
        const ai = await askAI([{ role: "user", content: `এই সার্চ ফলাফলগুলোর ভিত্তিতে বাংলায় সংক্ষিপ্ত উত্তর দাও। তথ্যের বাইরে কিছু বানাবে না।\nপ্রশ্ন: ${query}\nফলাফল: ${JSON.stringify(results)}` }]);
        summary = ai.text;
      } catch { summary = results.map((r) => `${r.title}: ${r.snippet}`).join("\n"); }
    }
    res.json({ ok: true, query, summary, results });
  } catch (error) { console.error("/api/search", error); sendError(res, 502, "সার্চ করা যায়নি। আবার চেষ্টা করুন।"); }
});

app.post("/api/payments/submit", requireUser, async (req, res) => {
  try {
    if (req.user.isAnonymous) return sendError(res, 401, "পেমেন্ট জমা দিতে আগে অ্যাকাউন্টে লগইন করুন।");
    const { senderNumber, transactionId, plan, duration, student } = req.body || {};
    const number = String(senderNumber || "").trim();
    const trx = String(transactionId || "").trim();
    if (!number || !trx) return sendError(res, 400, "প্রেরকের নম্বর ও Transaction ID দিন।");
    if (!/^(regular|student)$/.test(plan)) return sendError(res, 400, "সঠিক প্ল্যান নির্বাচন করুন।");
    if (!["weekly", "monthly", "yearly"].includes(duration)) return sendError(res, 400, "সঠিক মেয়াদ নির্বাচন করুন।");
    const hash = crypto.createHash("sha256").update(trx.toUpperCase()).digest("hex");
    const paymentRef = db.collection("paymentRequests").doc(hash);
    await db.runTransaction(async (tx) => {
      const old = await tx.get(paymentRef);
      if (old.exists) throw new Error("DUPLICATE_TRANSACTION");
      tx.set(paymentRef, { uid: req.user.uid, email: req.user.email, senderNumber: number, transactionId: trx, plan, duration, studentRequested: Boolean(student || plan === "student"), status: "pending", createdAt: admin.firestore.FieldValue.serverTimestamp() });
    });
    res.json({ ok: true, message: "পেমেন্ট অনুরোধ জমা হয়েছে। যাচাই শেষে জানানো হবে।" });
  } catch (error) {
    if (error.message === "DUPLICATE_TRANSACTION") return sendError(res, 409, "এই Transaction ID আগে জমা দেওয়া হয়েছে।");
    console.error("payment submit", error); sendError(res, 500, "পেমেন্ট অনুরোধ জমা হয়নি।");
  }
});

app.get("/api/admin/payments", requireUser, async (req, res) => {
  try {
    if (!isOwner(req.user)) return sendError(res, 403, "অনুমতি নেই।");
    const snap = await db.collection("paymentRequests").orderBy("createdAt", "desc").limit(100).get();
    res.json({ ok: true, payments: snap.docs.map((d) => ({ id: d.id, ...d.data(), createdAt: d.data().createdAt?.toDate?.().toISOString() || null })) });
  } catch (error) { console.error(error); sendError(res, 500, "পেমেন্ট তালিকা আনা যায়নি।"); }
});

app.post("/api/admin/payments/:id/approve", requireUser, async (req, res) => {
  try {
    if (!isOwner(req.user)) return sendError(res, 403, "অনুমতি নেই।");
    const ref = db.collection("paymentRequests").doc(req.params.id);
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw new Error("NOT_FOUND");
      const p = snap.data();
      if (p.status !== "pending") throw new Error("NOT_PENDING");
      if (p.plan === "student" && req.body?.studentVerified !== true) throw new Error("STUDENT_NOT_VERIFIED");
      const days = p.duration === "weekly" ? 7 : p.duration === "yearly" ? 365 : 30;
      const expiresAt = admin.firestore.Timestamp.fromDate(new Date(Date.now() + days * 86400000));
      tx.set(db.collection("users").doc(p.uid), { subscription: { status: "active", plan: p.plan, expiresAt, approvedAt: admin.firestore.FieldValue.serverTimestamp(), approvedBy: req.user.uid } }, { merge: true });
      tx.update(ref, { status: "approved", reviewedAt: admin.firestore.FieldValue.serverTimestamp(), reviewedBy: req.user.uid });
    });
    res.json({ ok: true, message: "পেমেন্ট অনুমোদন করা হয়েছে।" });
  } catch (error) {
    if (error.message === "NOT_FOUND") return sendError(res, 404, "পেমেন্ট অনুরোধ পাওয়া যায়নি।");
    if (error.message === "NOT_PENDING") return sendError(res, 409, "এই অনুরোধটি আগে যাচাই করা হয়েছে।");
    if (error.message === "STUDENT_NOT_VERIFIED") return sendError(res, 400, "Student Premium অনুমোদনের আগে শিক্ষার্থী পরিচয় যাচাই করুন।");
    console.error(error); sendError(res, 500, "অনুমোদন করা যায়নি।");
  }
});

app.post("/api/admin/payments/:id/reject", requireUser, async (req, res) => {
  try {
    if (!isOwner(req.user)) return sendError(res, 403, "অনুমতি নেই।");
    const ref = db.collection("paymentRequests").doc(req.params.id);
    const snap = await ref.get();
    if (!snap.exists) return sendError(res, 404, "পেমেন্ট অনুরোধ পাওয়া যায়নি।");
    await ref.update({ status: "rejected", reviewedAt: admin.firestore.FieldValue.serverTimestamp(), reviewedBy: req.user.uid, rejectionReason: String(req.body?.reason || "").slice(0, 500) });
    res.json({ ok: true, message: "পেমেন্ট অনুরোধ বাতিল করা হয়েছে।" });
  } catch (error) { console.error(error); sendError(res, 500, "বাতিল করা যায়নি।"); }
});

app.use((error, _req, res, _next) => {
  console.error("Unhandled server error:", error);
  if (res.headersSent) return;
  sendError(res, 500, "সার্ভারে সমস্যা হয়েছে। পরে আবার চেষ্টা করুন।");
});

app.listen(PORT, () => console.log(`Mukamah AI Brain listening on port ${PORT}`));
