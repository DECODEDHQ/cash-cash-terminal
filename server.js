import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import nodemailer from "nodemailer";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 8080;

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

let state = {
  status: "online",
  active: false,
  mission: MISSION.id,
  queue: [],
  sent: [],
  logs: []
};

function log(event, data = {}) {
  const row = { time: new Date().toISOString(), event, data };
  state.logs.unshift(row);
  state.logs = state.logs.slice(0, 200);
  console.log(JSON.stringify(row));
}

function makeTransport() {
  const user = process.env.SMTP_PRIMARY_USER;
  const pass = process.env.SMTP_PRIMARY_PASS;
  if (!user || !pass) return null;

  return nodemailer.createTransport({
    host: process.env.SMTP_HOST || "smtp.gmail.com",
    port: Number(process.env.SMTP_PORT || 465),
    secure: String(process.env.SMTP_SECURE || "true") === "true",
    auth: { user, pass }
  });
}

function cashcashMessage({ name = "there", intent = "make money" }) {
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

app.get("/", (_, res) => {
  res.json({
    system: "cashcash-cloud-worker",
    status: state.status,
    active: state.active,
    mission: state.mission
  });
});

app.get("/health", (_, res) => {
  res.json({ ok: true, service: "cashcash-cloud-worker" });
});

app.get("/mission", (_, res) => {
  res.json(MISSION);
});

app.post("/activate", (req, res) => {
  state.active = true;
  log("MISSION_ACTIVATED", { source: req.body?.source || "manual" });
  res.json({ ok: true, active: true, message: "CashCash Revenue Mode activated.", mission: MISSION.id });
});

app.post("/pause", (req, res) => {
  state.active = false;
  log("MISSION_PAUSED", { source: req.body?.source || "manual" });
  res.json({ ok: true, active: false, message: "CashCash Revenue Mode paused." });
});

app.post("/lead", (req, res) => {
  const lead = {
    id: `lead_${Date.now()}`,
    name: req.body?.name || "there",
    email: req.body?.email || null,
    platform: req.body?.platform || "unknown",
    intent: req.body?.intent || "money",
    region: req.body?.region || "global",
    status: "queued",
    createdAt: new Date().toISOString()
  };

  state.queue.push(lead);
  log("LEAD_QUEUED", lead);

  res.json({
    ok: true,
    lead,
    figment_language: "Your CashCash Figment is ready.",
    message: cashcashMessage(lead)
  });
});

app.post("/send", async (req, res) => {
  try {
    if (!state.active) return res.status(423).json({ ok: false, error: "MISSION_INACTIVE" });

    const to = req.body?.to;
    if (!to) return res.status(400).json({ ok: false, error: "MISSING_TO_EMAIL" });

    const mailer = makeTransport();
    if (!mailer) return res.status(500).json({ ok: false, error: "SMTP_NOT_CONFIGURED" });

    const name = req.body?.name || "there";
    const intent = req.body?.intent || "money";
    const subject = req.body?.subject || "Your CashCash Figment is ready";
    const text = req.body?.text || cashcashMessage({ name, intent });

    const info = await mailer.sendMail({
      from: `CashCash <${process.env.SMTP_PRIMARY_USER}>`,
      to,
      subject,
      text
    });

    const sent = {
      to,
      from: process.env.SMTP_PRIMARY_USER,
      messageId: info.messageId,
      time: new Date().toISOString()
    };

    state.sent.unshift(sent);
    state.sent = state.sent.slice(0, 200);
    log("EMAIL_SENT", sent);

    res.json({ ok: true, sent: true, ...sent });
  } catch (err) {
    log("EMAIL_ERROR", { error: err.message });
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/state", (_, res) => {
  res.json(state);
});

app.listen(PORT, () => {
  log("BOOT", { port: PORT, mission: MISSION.id });
});
