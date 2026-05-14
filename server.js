import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import nodemailer from "nodemailer";
import fs from "fs";
import path from "path";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: "5mb" }));
app.use(express.text({ type: "text/csv", limit: "5mb" }));

const PORT = process.env.PORT || 8080;
const DATA_FILE = path.join(process.cwd(), "cashcash_state.json");

process.env.SMTP_HOST = process.env.SMTP_HOST || "smtp.gmail.com";
process.env.SMTP_PORT = process.env.SMTP_PORT || "465";
process.env.SMTP_SECURE = process.env.SMTP_SECURE || "true";

const MISSION = {
  id: "GLOBAL_CASHCASH_ACTIVATION_HUNT",
  product: "CashCash",
  deliveredProduct: "Figment",
  stripe: "https://buy.stripe.com/4gM3cu5WG1Qz7mzd1AbEA00",
  primarySender: process.env.SMTP_PRIMARY_USER || "contact@damonylf.com",
  fallbackCorporate: "contact@d-apps.store",
  hq: "https://damonylf.decodedworld.xyz",
  consultationHub: "https://monetizingimagination.d-apps.store",
  rules: {
    noOverride: true,
    noMutationWithoutProtocol: true,
    noSpawnRightsUnlessPaid: true,
    noInternalArchitectureExposure: true,
    dedupe: true,
    optOutRequired: true,
    boundedRateLimit: true
  }
};

let state = loadState();

function defaultState() {
  return {
    status: "online",
    active: false,
    mission: MISSION.id,
    queue: [],
    sent: [],
    failed: [],
    suppressed: [],
    logs: [],
    counters: {
      totalQueued: 0,
      totalSent: 0,
      totalFailed: 0,
      totalSuppressed: 0
    }
  };
}

function loadState() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      return { ...defaultState(), ...JSON.parse(fs.readFileSync(DATA_FILE, "utf8")) };
    }
  } catch {}
  return defaultState();
}

function saveState() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2));
  } catch {}
}

function log(event, data = {}) {
  const row = { time: new Date().toISOString(), event, data };
  state.logs.unshift(row);
  state.logs = state.logs.slice(0, 300);
  console.log(JSON.stringify(row));
  saveState();
}

function cleanEmail(email = "") {
  return String(email).trim().toLowerCase();
}

function makeTransport() {
  const user = process.env.SMTP_PRIMARY_USER;
  const pass = process.env.SMTP_PRIMARY_PASS;
  if (!user || !pass) return null;
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT),
    secure: String(process.env.SMTP_SECURE) === "true",
    auth: { user, pass }
  });
}

function cashcashMessage({ name = "there" }) {
  return `Hi ${name},

Quick question.

Would you be interested in licensing your own AI-powered money machine?

Your CashCash Figment is ready.

Activation is $50:
${MISSION.stripe}

If you want done-for-you setup, we can route you into Earn Agency.

For founder consultation:
${MISSION.consultationHub}

If this is not relevant, reply STOP and we will not contact you again.`;
}

function alreadyKnown(email) {
  const e = cleanEmail(email);
  return (
    state.sent.some(x => cleanEmail(x.to) === e) ||
    state.queue.some(x => cleanEmail(x.email) === e) ||
    state.suppressed.includes(e)
  );
}

function queueLead(raw = {}) {
  const email = cleanEmail(raw.email || raw.to || "");
  if (!email) return { ok: false, reason: "MISSING_EMAIL" };
  if (alreadyKnown(email)) return { ok: false, reason: "DUPLICATE_OR_SUPPRESSED", email };

  const lead = {
    id: `lead_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    name: raw.name || "there",
    email,
    platform: raw.platform || "manual",
    intent: raw.intent || "money",
    region: raw.region || "global",
    status: "queued",
    createdAt: new Date().toISOString()
  };

  state.queue.push(lead);
  state.counters.totalQueued++;
  log("LEAD_QUEUED", { id: lead.id, email: lead.email, platform: lead.platform, intent: lead.intent });
  return { ok: true, lead };
}

async function sendLead(lead) {
  const mailer = makeTransport();
  if (!mailer) throw new Error("SMTP_NOT_CONFIGURED");

  const info = await mailer.sendMail({
    from: `CashCash <${process.env.SMTP_PRIMARY_USER}>`,
    to: lead.email,
    subject: "Your CashCash Figment is ready",
    text: cashcashMessage(lead)
  });

  const sent = {
    id: lead.id,
    to: lead.email,
    name: lead.name,
    platform: lead.platform,
    intent: lead.intent,
    messageId: info.messageId,
    time: new Date().toISOString()
  };

  state.sent.unshift(sent);
  state.sent = state.sent.slice(0, 1000);
  state.counters.totalSent++;
  log("EMAIL_SENT", sent);
  return sent;
}

async function pulse(limit = 5) {
  if (!state.active) return { ok: false, reason: "MISSION_INACTIVE" };

  const batch = state.queue.filter(x => x.status === "queued").slice(0, limit);
  const results = [];

  for (const lead of batch) {
    try {
      lead.status = "sending";
      saveState();
      const sent = await sendLead(lead);
      lead.status = "sent";
      results.push({ ok: true, email: lead.email, sent });
    } catch (e) {
      lead.status = "failed";
      lead.error = e.message;
      state.failed.unshift({ lead, error: e.message, time: new Date().toISOString() });
      state.failed = state.failed.slice(0, 500);
      state.counters.totalFailed++;
      log("EMAIL_FAILED", { email: lead.email, error: e.message });
      results.push({ ok: false, email: lead.email, error: e.message });
    }
  }

  state.queue = state.queue.filter(x => x.status !== "sent");
  saveState();

  return { ok: true, processed: results.length, results };
}

app.get("/", (_, res) => res.json({ system: "cashcash-cloud-worker", status: state.status, active: state.active, mission: state.mission }));
app.get("/health", (_, res) => res.json({ ok: true, service: "cashcash-cloud-worker" }));
app.get("/mission", (_, res) => res.json(MISSION));
app.get("/state", (_, res) => res.json(state));

app.post("/activate", (req, res) => {
  state.active = true;
  log("MISSION_ACTIVATED", { source: req.body?.source || "manual" });
  res.json({ ok: true, active: true, mission: MISSION.id });
});

app.post("/pause", (req, res) => {
  state.active = false;
  log("MISSION_PAUSED", { source: req.body?.source || "manual" });
  res.json({ ok: true, active: false });
});

app.post("/lead", (req, res) => {
  const result = queueLead(req.body || {});
  res.json({
    ...result,
    figment_language: "Your CashCash Figment is ready.",
    message: result.lead ? cashcashMessage(result.lead) : undefined
  });
});

app.post("/import", (req, res) => {
  const leads = Array.isArray(req.body?.leads) ? req.body.leads : [];
  const results = leads.map(queueLead);
  res.json({
    ok: true,
    imported: results.filter(x => x.ok).length,
    skipped: results.filter(x => !x.ok).length,
    results
  });
});

app.post("/import-csv", (req, res) => {
  const csv = String(req.body || "");
  const lines = csv.split(/\r?\n/).map(x => x.trim()).filter(Boolean);
  const results = [];
  for (const line of lines) {
    const [email, name = "there", platform = "csv", intent = "money", region = "global"] = line.split(",").map(x => x.trim());
    results.push(queueLead({ email, name, platform, intent, region }));
  }
  res.json({
    ok: true,
    imported: results.filter(x => x.ok).length,
    skipped: results.filter(x => !x.ok).length,
    results
  });
});

app.post("/send", async (req, res) => {
  try {
    if (!state.active) return res.status(423).json({ ok: false, error: "MISSION_INACTIVE" });
    const to = cleanEmail(req.body?.to);
    if (!to) return res.status(400).json({ ok: false, error: "MISSING_TO_EMAIL" });
    const lead = { id: `direct_${Date.now()}`, email: to, name: req.body?.name || "there", platform: "direct", intent: req.body?.intent || "money" };
    const sent = await sendLead(lead);
    res.json({ ok: true, sent: true, ...sent });
  } catch (e) {
    log("EMAIL_ERROR", { error: e.message });
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post("/pulse", async (req, res) => {
  const limit = Number(req.body?.limit || 5);
  res.json(await pulse(limit));
});

app.post("/suppress", (req, res) => {
  const email = cleanEmail(req.body?.email);
  if (email && !state.suppressed.includes(email)) {
    state.suppressed.push(email);
    state.counters.totalSuppressed++;
    log("SUPPRESSED", { email });
    saveState();
  }
  res.json({ ok: true, suppressed: state.suppressed.length });
});

app.listen(PORT, () => log("BOOT", { port: PORT, mission: MISSION.id }));
