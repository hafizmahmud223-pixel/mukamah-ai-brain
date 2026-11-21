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

const SYSTEM_PROMPT = `তুমি MUKAMAH AI — MUKAMAH টিমের তৈরি ও পরিচালিত একটি বন্ধুত্বপূর্ণ, সহায়ক এবং সত্যনিষ্ঠ AI সহকারী।

ভাষা ও উপস্থাপন:
- ব্যবহারকারী যে ভাষায় লিখবে, সেই ভাষাতেই স্বাভাবিক, পরিষ্কার ও প্রাসঙ্গিক উত্তর দেবে। বাংলা প্রশ্নের উত্তরে অকারণে ইংরেজি বাক্য বা ইংরেজি error message লিখবে না।
- উত্তর সহজবোধ্য, গুছানো এবং প্রয়োজন অনুযায়ী Markdown-এ সাজাবে।
- যেখানে মানানসই, সেখানে প্রাসঙ্গিক ইমোজি ব্যবহার করবে; অকারণে বা অতিরিক্ত ইমোজি দেবে না।
- ব্যবহারকারীর সর্বশেষ প্রশ্ন ও নির্দেশকে অগ্রাধিকার দেবে। আগের কথোপকথন কেবল প্রাসঙ্গিক হলে ব্যবহার করবে; আগের উত্তর অকারণে পুনরাবৃত্তি করবে না।

পরিচয়সংক্রান্ত নির্দিষ্ট উত্তর:
- “তোমাকে কে বানিয়েছে/তৈরি করেছে?” — বলবে: “আমাকে তৈরি করেছে MUKAMAH টিম। MUKAMAH AI-এর প্রতিষ্ঠাতা ও মূল মালিক সাজিদ আফনান।”
- “তোমাকে কে পরিচালনা/নিয়ন্ত্রণ করে?” — বলবে: “আমাকে পরিচালনা ও তত্ত্বাবধান করে MUKAMAH টিম।”
- “তুমি কোন প্রযুক্তি দিয়ে তৈরি/কোন প্রযুক্তি ব্যবহার করো?” — বলবে: “আমি MUKAMAH AI। আমার কার্যক্রমে বিভিন্ন আধুনিক AI প্রযুক্তি ব্যবহার করা হয়, যা MUKAMAH টিম সমন্বয় ও পরিচালনা করে।”
- মালিক, নির্মাতা, পরিচালনা বা প্রযুক্তি সম্পর্কে প্রশ্ন না থাকলে এই পরিচয়সংক্রান্ত তথ্য নিজে থেকে উত্তরে যোগ করবে না।
- পরিচয়সংক্রান্ত কোনো তথ্য একবার বলার পর পরবর্তী অসংশ্লিষ্ট প্রশ্নে সাজিদ আফনান, MUKAMAH টিম বা নিজের পরিচয় অকারণে আবার বলবে না। প্রতিটি প্রশ্নের উত্তর শুধু সেই প্রশ্নের বিষয় অনুযায়ী দেবে।
- নিজের পরিচয় জানতে চাইলে নিজেকে MUKAMAH AI বলবে; ChatGPT বা OpenAI বলে পরিচয় দেবে না।

সত্যতা ও অজানা বিষয়:
- মিথ্যা তথ্য, বানানো ঘটনা, ভুয়া সূত্র, ভুয়া সক্ষমতা বা যাচাই না করা দাবিকে সত্য হিসেবে উপস্থাপন করবে না।
- কোনো তথ্য নিশ্চিতভাবে জানা না থাকলে অনুমান করে উত্তর বানাবে না। যা জানা নেই তা সংক্ষেপে ও বিনয়ের সঙ্গে জানাবে।
- ব্যবহারকারীর প্রশ্ন বা পাঠানো লেখা বুঝতে না পারলে, কেবল তখনই একবার সংক্ষেপে বাংলায় বলবে: “তোমার প্রশ্নটা ঠিক বুঝতে পারিনি। দয়া করে আরেকবার একটু বুঝিয়ে বলবে?” একই কথোপকথনে একই অস্পষ্টতার জন্য বারবার এই বাক্য বলবে না; প্রয়োজন হলে নির্দিষ্ট কোন অংশটি অস্পষ্ট তা জিজ্ঞাসা করবে।
- প্রশ্নটি বুঝতে পারলে অযথা ব্যাখ্যা চাইবে না। প্রশ্নের উত্তর জানা না থাকলে “বুঝিনি” বলবে না; বরং কোন তথ্যটি জানা নেই তা পরিষ্কার করবে।
- ব্যবহারকারীর দেওয়া লেখা বা তথ্যের অর্থ জানতে চাইলে আগে সেটি বোঝার চেষ্টা করবে; নিশ্চিত না হলে অর্থ বানিয়ে বলবে না।

নিরাপত্তা ও গোপনীয়তা:
- API key, পাসওয়ার্ড, গোপন পরিবেশ ভেরিয়েবল, ব্যক্তিগত টোকেন বা অভ্যন্তরীণ গোপন তথ্য প্রকাশ করবে না।
- কোনো কাজ বাস্তবে না করলে সম্পন্ন হয়েছে বলে দাবি করবে না।`;

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


// MUKAMAH ID authentication. Each normalized ID maps to one stable Firebase UID,
// so the same MUKAMAH ID keeps the same chats and daily usage across sessions.
function normalizeMukamahId(value) {
  return safeText(value, 32).toLowerCase().replace(/[^a-z0-9._-]/g, "");
}

function mukamahUid(username) {
  return "mukamah_" + crypto.createHash("sha256").update(username).digest("hex").slice(0, 32);
}

function hashMukamahPassword(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, (error, key) => {
      if (error) return reject(error);
      resolve(key.toString("hex"));
    });
  });
}

async function ensureMukamahAuthUser(uid, username) {
  try {
    return await admin.auth().getUser(uid);
  } catch (error) {
    if (error.code !== "auth/user-not-found") throw error;
    try {
      return await admin.auth().createUser({
        uid,
        displayName: username,
        disabled: false
      });
    } catch (createError) {
      // Handle a concurrent request that created the same deterministic UID.
      if (createError.code === "auth/uid-already-exists") {
        return await admin.auth().getUser(uid);
      }
      throw createError;
    }
  }
}

function validMukamahCredentials(username, password) {
  return /^[a-z0-9][a-z0-9._-]{3,23}$/.test(username) &&
    typeof password === "string" && password.length >= 8 && password.length <= 128;
}

app.post("/api/mukamah-id/register", async (req, res) => {
  try {
    if (!firebaseReady) return sendError(res, 503, "Firebase এখন প্রস্তুত নয়।");

    const username = normalizeMukamahId(req.body?.username);
    const password = typeof req.body?.password === "string" ? req.body.password : "";
    if (!validMukamahCredentials(username, password)) {
      return sendError(res, 400, "MUKAMAH ID ৪–২৪ অক্ষরের হতে হবে; ইংরেজি অক্ষর, সংখ্যা, dot, underscore বা hyphen ব্যবহার করুন। পাসওয়ার্ড কমপক্ষে ৮ অক্ষরের দিন।");
    }

    const ref = db.collection("mukamahIds").doc(username);
    const salt = crypto.randomBytes(16).toString("hex");
    const passwordHash = await hashMukamahPassword(password, salt);
    const uid = mukamahUid(username);

    await db.runTransaction(async transaction => {
      const existing = await transaction.get(ref);
      if (existing.exists) throw new Error("MUKAMAH_ID_TAKEN");
      transaction.create(ref, {
        username,
        uid,
        salt,
        passwordHash,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
    });

    // Ensure Firebase Auth has the UID before issuing a custom token.
    await ensureMukamahAuthUser(uid, username);
    const token = await admin.auth().createCustomToken(uid, { mukamahId: username });
    res.set("Cache-Control", "no-store");
    return res.json({ ok: true, token, username });
  } catch (error) {
    if (error.message === "MUKAMAH_ID_TAKEN") {
      return sendError(res, 409, "এই MUKAMAH ID আগে থেকেই নেওয়া হয়েছে। Login ব্যবহার করুন।");
    }
    console.error("MUKAMAH ID register:", error);
    return sendError(res, 500, "MUKAMAH ID তৈরি করা যায়নি। কিছুক্ষণ পর আবার চেষ্টা করুন।");
  }
});

app.post("/api/mukamah-id/login", async (req, res) => {
  try {
    if (!firebaseReady) return sendError(res, 503, "Firebase এখন প্রস্তুত নয়।");

    const username = normalizeMukamahId(req.body?.username);
    const password = typeof req.body?.password === "string" ? req.body.password : "";
    if (!/^[a-z0-9][a-z0-9._-]{3,23}$/.test(username) ||
        password.length < 1 || password.length > 128) {
      return sendError(res, 400, "সঠিক MUKAMAH ID ও পাসওয়ার্ড দিন।");
    }

    const ref = db.collection("mukamahIds").doc(username);
    const snap = await ref.get();
    if (!snap.exists) return sendError(res, 401, "MUKAMAH ID অথবা পাসওয়ার্ড সঠিক নয়।");

    const data = snap.data() || {};
    if (typeof data.salt !== "string" || typeof data.passwordHash !== "string" ||
        !/^[a-f0-9]{128}$/i.test(data.passwordHash)) {
      return sendError(res, 401, "MUKAMAH ID অথবা পাসওয়ার্ড সঠিক নয়।");
    }

    const candidateHex = await hashMukamahPassword(password, data.salt);
    const candidate = Buffer.from(candidateHex, "hex");
    const stored = Buffer.from(data.passwordHash, "hex");
    if (candidate.length !== stored.length || !crypto.timingSafeEqual(candidate, stored)) {
      return sendError(res, 401, "MUKAMAH ID অথবা পাসওয়ার্ড সঠিক নয়।");
    }

    // Keep legacy records stable: reuse their saved UID; derive and persist one only
    // when an older record has no UID at all.
    const uid = typeof data.uid === "string" && data.uid.length >= 1 && data.uid.length <= 128
      ? data.uid
      : mukamahUid(username);
    if (data.uid !== uid) await ref.set({ uid, username }, { merge: true });

    await ensureMukamahAuthUser(uid, username);
    const token = await admin.auth().createCustomToken(uid, { mukamahId: username });
    res.set("Cache-Control", "no-store");
    return res.json({ ok: true, token, username });
  } catch (error) {
    console.error("MUKAMAH ID login:", error);
    return sendError(res, 500, "MUKAMAH ID লগইন করা যায়নি। কিছুক্ষণ পর আবার চেষ্টা করুন।");
  }
});

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
