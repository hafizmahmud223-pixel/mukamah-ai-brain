import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";
import admin from "firebase-admin";
import crypto from "node:crypto";

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT || 3000);
const TZ = "Asia/Dhaka";
const OWNER_EMAILS = new Set([
  "hafizmahmud223@gmail.com",
  "mukamahbrand@gmail.com"
]);

app.use(cors({
  origin: process.env.CORS_ORIGIN
    ? process.env.CORS_ORIGIN.split(",").map(v => v.trim())
    : true
}));
app.use(express.json({ limit: "2mb" }));

function initFirebase() {
  if (admin.apps.length) return;
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON is missing");
  const serviceAccount = JSON.parse(raw);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
}

let firebaseReady = false;
let db;
try {
  initFirebase();
  db = admin.firestore();
  firebaseReady = true;
} catch (error) {
  console.error("Firebase initialization failed:", error.message);
}

const gemini = process.env.GEMINI_API_KEY
  ? new OpenAI({
      apiKey: process.env.GEMINI_API_KEY,
      baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/"
    })
  : null;
const groq = process.env.GROQ_API_KEY
  ? new OpenAI({ apiKey: process.env.GROQ_API_KEY, baseURL: "https://api.groq.com/openai/v1" })
  : null;

function safeText(value, max = 4000) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}
function sendError(res, status, message) {
  return res.status(status).json({ ok: false, error: message });
}
function bdDateKey(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit"
  }).format(date);
}
function usageRef(uid, dateKey = bdDateKey()) {
  return db.collection("dailyUsage").doc(`${uid}_${dateKey}`);
}

async function requireUser(req, res, next) {
  try {
    if (!firebaseReady) return sendError(res, 503, "Firebase এখন প্রস্তুত নয়।");
    const header = req.headers.authorization || "";
    const match = header.match(/^Bearer\s+(.+)$/i);
    if (!match) return sendError(res, 401, "লগইন টোকেন পাওয়া যায়নি।");
    const decoded = await admin.auth().verifyIdToken(match[1]);
    req.user = decoded;
    req.isAnonymous = decoded.firebase?.sign_in_provider === "anonymous";
    next();
  } catch (error) {
    console.error("Authentication error:", error.message);
    return sendError(res, 401, "লগইন যাচাই করা যায়নি। আবার লগইন করুন।");
  }
}

function requireOwner(req, res, next) {
  const email = String(req.user?.email || "").toLowerCase();
  if (!OWNER_EMAILS.has(email)) return sendError(res, 403, "এই কাজের অনুমতি নেই।");
  next();
}

async function accountStatus(uid, anonymous) {
  const ref = usageRef(uid);
  const snap = await ref.get();
  const data = snap.exists ? snap.data() : {};
  const messages = Number(data.messageCount || 0);
  const chats = Number(data.chatCount || 0);
  const premiumSnap = await db.collection("subscriptions").doc(uid).get();
  const premium = premiumSnap.exists && premiumSnap.data().status === "active";
  const studentSnap = await db.collection("studentApplications").doc(uid).get();
  const student = studentSnap.exists && studentSnap.data().status === "approved";
  const owner = OWNER_EMAILS.has(String((await admin.auth().getUser(uid)).email || "").toLowerCase());
  if (owner || premium || student) return { allowed: true, unlimited: true, messages, chats, plan: owner ? "owner" : premium ? "premium" : "student" };
  if (anonymous) return { allowed: messages < 5, unlimited: false, messages, chats, limit: 5, plan: "guest" };
  const chatLimit = chats <= 1 ? 200 : chats <= 3 ? 10 : 0;
  return { allowed: chatLimit > 0 && messages < chatLimit, unlimited: false, messages, chats, limit: chatLimit, plan: "free" };
}

async function reserveMessage(uid, anonymous) {
  const ref = usageRef(uid);
  return db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    const data = snap.exists ? snap.data() : {};
    const messageCount = Number(data.messageCount || 0);
    const chatCount = Number(data.chatCount || 0);
    const premiumSnap = await tx.get(db.collection("subscriptions").doc(uid));
    const studentSnap = await tx.get(db.collection("studentApplications").doc(uid));
    const userRecord = await admin.auth().getUser(uid);
    const owner = OWNER_EMAILS.has(String(userRecord.email || "").toLowerCase());
    const premium = premiumSnap.exists && premiumSnap.data().status === "active";
    const student = studentSnap.exists && studentSnap.data().status === "approved";
    const limit = anonymous ? 5 : (chatCount <= 1 ? 200 : chatCount <= 3 ? 10 : 0);
    if (!owner && !premium && !student && messageCount >= limit) return { allowed: false, limit };
    tx.set(ref, {
      messageCount: messageCount + 1,
      chatCount,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    return { allowed: true, limit: owner || premium || student ? null : limit };
  });
}

async function createChat(uid) {
  const ref = usageRef(uid);
  const chatId = crypto.randomUUID();
  await db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    const data = snap.exists ? snap.data() : {};
    tx.set(ref, {
      chatCount: Number(data.chatCount || 0) + 1,
      messageCount: Number(data.messageCount || 0),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
  });
  await db.collection("chats").doc(uid).collection("items").doc(chatId).set({
    chatId,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    messages: []
  });
  return chatId;
}

const SYSTEM_PROMPT = `তুমি MUKAMAH AI, একটি বন্ধুত্বপূর্ণ বাংলা AI সহকারী। ব্যবহারকারীর ভাষা অনুযায়ী উত্তর দেবে, পরিষ্কারভাবে Markdown ব্যবহার করবে। MUKAMAH AI-এর একমাত্র প্রতিষ্ঠাতা ও মূল মালিক সাজিদ আফনান। মালিক সম্পর্কে জিজ্ঞাসা করলে শুধু সাজিদ আফনানের নাম বলবে। নিজেকে ChatGPT বা OpenAI বলে পরিচয় দেবে না।`;

async function askAI(message, history = []) {
  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    ...history.filter(m => ["user", "assistant"].includes(m?.role)).slice(-12).map(m => ({ role: m.role, content: safeText(m.content, 6000) })),
    { role: "user", content: message }
  ];
  const attempts = [
    gemini && { client: gemini, model: process.env.GEMINI_MODEL || "gemini-2.5-flash" },
    groq && { client: groq, model: process.env.GROQ_MODEL || "openai/gpt-oss-20b" }
  ].filter(Boolean);
  if (!attempts.length) throw new Error("No AI provider API key configured");
  let lastError;
  for (const provider of attempts) {
    try {
      const result = await provider.client.chat.completions.create({ model: provider.model, messages, temperature: 0.7 });
      return result.choices?.[0]?.message?.content || "দুঃখিত, উত্তর তৈরি করা যায়নি।";
    } catch (error) {
      lastError = error;
      console.error("AI provider failed:", error.message);
    }
  }
  throw lastError || new Error("AI providers unavailable");
}

app.get("/", (_req, res) => res.json({ ok: true, service: "Mukamah AI Brain" }));
app.get("/api/health", (_req, res) => res.json({
  ok: true,
  service: "Mukamah AI Brain",
  firebase: firebaseReady,
  provider: `${gemini ? "Gemini" : "Gemini unavailable"}${groq ? " + Groq backup" : ""}`,
  search: process.env.LANGSEARCH_API_KEY ? "LangSearch" : "not configured"
}));

app.post("/api/chats/new", requireUser, async (req, res) => {
  try {
    const status = await accountStatus(req.user.uid, req.isAnonymous);
    if (!status.allowed && status.plan !== "free") return sendError(res, 429, "আজকের চ্যাট লিমিট শেষ।");
    if (!status.unlimited && status.plan === "free" && status.chats >= 3) return sendError(res, 429, "আজকের ফ্রি চ্যাট লিমিট শেষ।");
    const chatId = await createChat(req.user.uid);
    res.json({ ok: true, chatId });
  } catch (error) {
    console.error("Create chat:", error);
    sendError(res, 500, "নতুন চ্যাট তৈরি করা যায়নি।");
  }
});

app.post("/api/chat", requireUser, async (req, res) => {
  try {
    const message = safeText(req.body?.message, 12000);
    const chatId = safeText(req.body?.chatId, 150);
    const history = Array.isArray(req.body?.history) ? req.body.history : [];
    if (!message) return sendError(res, 400, "মেসেজ খালি রাখা যাবে না।");
    const quota = await reserveMessage(req.user.uid, req.isAnonymous);
    if (!quota.allowed) return res.status(429).json({ ok: false, error: "আপনার আজকের চ্যাট লিমিট শেষ!", limit: quota.limit });
    const answer = await askAI(message, history);
    if (chatId && !req.isAnonymous) {
      const chatRef = db.collection("chats").doc(req.user.uid).collection("items").doc(chatId);
      await chatRef.set({
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        messages: admin.firestore.FieldValue.arrayUnion(
          { role: "user", content: message, createdAt: new Date().toISOString() },
          { role: "assistant", content: answer, createdAt: new Date().toISOString() }
        )
      }, { merge: true });
    }
    res.json({ ok: true, answer, reply: answer, quota });
  } catch (error) {
    console.error("Chat error:", error);
    sendError(res, 500, "AI উত্তর দিতে পারেনি। কিছুক্ষণ পর আবার চেষ্টা করুন।");
  }
});

app.post("/api/search", requireUser, async (req, res) => {
  try {
    const query = safeText(req.body?.query || req.body?.message, 1000);
    if (!query) return sendError(res, 400, "সার্চের বিষয় লিখুন।");
    if (!process.env.LANGSEARCH_API_KEY) return sendError(res, 503, "LangSearch API key সেট করা নেই।");
    const response = await fetch("https://api.langsearch.com/v1/web-search", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.LANGSEARCH_API_KEY}` },
      body: JSON.stringify({ query, freshness: "noLimit", summary: true, count: 8 })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data?.message || `Search HTTP ${response.status}`);
    res.json({ ok: true, results: data?.data?.webPages?.value || data?.data?.results || data?.results || [] });
  } catch (error) {
    console.error("Search error:", error);
    sendError(res, 500, "ওয়েব সার্চ করা যায়নি।");
  }
});

app.get("/api/student/status", requireUser, async (req, res) => {
  try {
    const snap = await db.collection("studentApplications").doc(req.user.uid).get();
    res.json({ ok: true, status: snap.exists ? snap.data().status : "not_submitted" });
  } catch (error) {
    console.error("Student status:", error);
    sendError(res, 500, "Student status পাওয়া যায়নি।");
  }
});

app.post("/api/student/apply", requireUser, async (req, res) => {
  try {
    const name = safeText(req.body?.name, 120);
    const institution = safeText(req.body?.institution, 200);
    const studentId = safeText(req.body?.studentId, 120);
    const imageUrl = safeText(req.body?.imageUrl, 1500);
    if (!name || !institution || !studentId || !imageUrl) return sendError(res, 400, "নাম, প্রতিষ্ঠান, Student ID এবং প্রমাণের ছবি প্রয়োজন।");
    const ref = db.collection("studentApplications").doc(req.user.uid);
    const existing = await ref.get();
    if (existing.exists && existing.data().status === "pending") return sendError(res, 409, "আপনার আবেদন যাচাইয়ের অপেক্ষায় আছে।");
    await ref.set({ uid: req.user.uid, name, institution, studentId, imageUrl, status: "pending", submittedAt: admin.firestore.FieldValue.serverTimestamp() });
    res.json({ ok: true, status: "pending" });
  } catch (error) {
    console.error("Student apply:", error);
    sendError(res, 500, "Student আবেদন জমা দেওয়া যায়নি।");
  }
});

app.post("/api/payment/request", requireUser, async (req, res) => {
  try {
    const method = safeText(req.body?.method, 30);
    const senderNumber = safeText(req.body?.senderNumber, 40);
    const transactionId = safeText(req.body?.transactionId, 100);
    const plan = safeText(req.body?.plan, 40);
    if (!["bkash", "nagad"].includes(method.toLowerCase()) || !senderNumber || !transactionId || !plan) return sendError(res, 400, "পেমেন্টের তথ্য সম্পূর্ণ দিন।");
    const ref = await db.collection("paymentRequests").add({ uid: req.user.uid, method: method.toLowerCase(), senderNumber, transactionId, plan, status: "pending", createdAt: admin.firestore.FieldValue.serverTimestamp() });
    res.json({ ok: true, requestId: ref.id, status: "pending" });
  } catch (error) {
    console.error("Payment request:", error);
    sendError(res, 500, "পেমেন্ট অনুরোধ জমা দেওয়া যায়নি।");
  }
});

app.get("/api/admin/requests", requireUser, requireOwner, async (_req, res) => {
  try {
    const [payments, students] = await Promise.all([
      db.collection("paymentRequests").where("status", "==", "pending").limit(100).get(),
      db.collection("studentApplications").where("status", "==", "pending").limit(100).get()
    ]);
    res.json({ ok: true, payments: payments.docs.map(d => ({ id: d.id, ...d.data() })), students: students.docs.map(d => ({ id: d.id, ...d.data() })) });
  } catch (error) {
    console.error("Admin requests:", error);
    sendError(res, 500, "Admin requests লোড করা যায়নি।");
  }
});

app.post("/api/admin/approve-payment", requireUser, requireOwner, async (req, res) => {
  try {
    const requestId = safeText(req.body?.requestId, 150);
    if (!requestId) return sendError(res, 400, "Payment request ID নেই।");
    const ref = db.collection("paymentRequests").doc(requestId);
    const snap = await ref.get();
    if (!snap.exists) return sendError(res, 404, "Payment request পাওয়া যায়নি।");
    const payment = snap.data();
    if (payment.status !== "pending") return sendError(res, 409, "এই পেমেন্ট আগে যাচাই করা হয়েছে।");
    const batch = db.batch();
    batch.update(ref, { status: "approved", reviewedAt: admin.firestore.FieldValue.serverTimestamp(), reviewedBy: req.user.uid });
    batch.set(db.collection("subscriptions").doc(payment.uid), { status: "active", plan: payment.plan, activatedAt: admin.firestore.FieldValue.serverTimestamp(), paymentRequestId: requestId }, { merge: true });
    await batch.commit();
    res.json({ ok: true, status: "approved" });
  } catch (error) {
    console.error("Approve payment:", error);
    sendError(res, 500, "পেমেন্ট অনুমোদন করা যায়নি।");
  }
});

app.post("/api/admin/reject-payment", requireUser, requireOwner, async (req, res) => {
  try {
    const requestId = safeText(req.body?.requestId, 150);
    if (!requestId) return sendError(res, 400, "Payment request ID নেই।");
    const ref = db.collection("paymentRequests").doc(requestId);
    const snap = await ref.get();
    if (!snap.exists) return sendError(res, 404, "Payment request পাওয়া যায়নি।");
    if (snap.data().status !== "pending") return sendError(res, 409, "এই পেমেন্ট আগে যাচাই করা হয়েছে।");
    await ref.update({ status: "rejected", reviewedAt: admin.firestore.FieldValue.serverTimestamp(), reviewedBy: req.user.uid });
    res.json({ ok: true, status: "rejected" });
  } catch (error) {
    console.error("Reject payment:", error);
    sendError(res, 500, "পেমেন্ট বাতিল করা যায়নি।");
  }
});

app.post("/api/admin/review-student", requireUser, requireOwner, async (req, res) => {
  try {
    const requestId = safeText(req.body?.requestId, 150);
    const approve = req.body?.approve === true;
    if (!requestId) return sendError(res, 400, "Student request ID নেই।");
    const ref = db.collection("studentApplications").doc(requestId);
    const snap = await ref.get();
    if (!snap.exists) return sendError(res, 404, "Student আবেদন পাওয়া যায়নি।");
    if (snap.data().status !== "pending") return sendError(res, 409, "এই Student আবেদন আগে যাচাই করা হয়েছে।");
    await ref.update({ status: approve ? "approved" : "rejected", reviewedAt: admin.firestore.FieldValue.serverTimestamp(), reviewedBy: req.user.uid });
    res.json({ ok: true, status: approve ? "approved" : "rejected" });
  } catch (error) {
    console.error("Review student:", error);
    sendError(res, 500, "Student আবেদন আপডেট করা যায়নি।");
  }
});

app.use((error, _req, res, _next) => {
  console.error("Unhandled server error:", error);
  if (res.headersSent) return;
  sendError(res, 500, "সার্ভারে সমস্যা হয়েছে। পরে আবার চেষ্টা করুন।");
});

app.listen(PORT, () => console.log(`Mukamah AI Brain listening on port ${PORT}`));
