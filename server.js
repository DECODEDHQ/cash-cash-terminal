import express from "express";
import { Resend } from "resend";
import cron from "node-cron";
import fs from "fs";
import { parse } from "csv-parse/sync";

const app = express();
app.use(express.json({ limit: "10mb" }));

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

const state = {
  active: true,
  mission: "GLOBAL_CASHCASH_ACTIVATION_HUNT",
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

function log(event, data = {}) {
  state.logs.unshift({
    time: new Date().toISOString(),
    event,
    data
  });
  state.logs = state.logs.slice(0, 200);
}

function cashcashMessage(lead) {
  return `Hi ${lead.name || "there"},

Quick question.

Would you be interested in licensing your own AI-powered money machine?

Your CashCash Figment is ready.

Activation is $50:
https://buy.stripe.com/4gM3cu5WG1Qz7mzd1AbEA00

If you want done-for-you setup, we can route you into Earn Agency.

Founder consultation:
https://monetizingimagination.d-apps.store

Reply STOP to opt out.`;
}

async function sendLead(lead) {
  if (!resend) throw new Error("RESEND_NOT_CONFIGURED");
  if (!lead.email) throw new Error("NO_EMAIL");

  const r = await resend.emails.send({
    from: "CashCash <onboarding@resend.dev>",
    to: [lead.email],
    subject: "Your CashCash Figment is ready",
    text: cashcashMessage(lead)
  });

  const sent = {
    id: lead.id,
    to: lead.email,
    provider: "resend",
    messageId: r.data?.id || "queued",
    time: new Date().toISOString()
  };

  state.sent.unshift(sent);
  state.counters.totalSent++;
  log("EMAIL_SENT", sent);
  return sent;
}

async function processQueue() {
  if (!state.active || !state.queue.length) return;

  const lead = state.queue.shift();

  if (state.suppressed.includes(lead.email)) {
    state.counters.totalSuppressed++;
    log("SUPPRESSED", { email: lead.email });
    return;
  }

  try {
    await sendLead(lead);
  } catch (e) {
    state.failed.unshift({
      lead,
      error: e.message
    });
    state.counters.totalFailed++;
    log("EMAIL_ERROR", { error: e.message, email: lead.email });
  }
}

cron.schedule("*/1 * * * *", async () => {
  await processQueue();
});


import spiderRegistry from "./spider_registry.json" assert { type: "json" };

app.get("/spider", (_, res) => {
  res.json(spiderRegistry);
});

app.get("/routes", (_, res) => {
  res.json(spiderRegistry.routes);
});

app.post("/route", (req, res) => {
  const intent = String(req.body?.intent || "").toLowerCase();

  let route = spiderRegistry.routes.corporate_hq;

  if (intent.includes("money") || intent.includes("cash") || intent.includes("income")) {
    route = { label: "CashCash", role: "money-machine-figment-terminal", url: spiderRegistry.cashcash.url };
  } else if (intent.includes("custom") || intent.includes("build") || intent.includes("manifest")) {
    route = spiderRegistry.routes.dreammaker;
  } else if (intent.includes("done") || intent.includes("marketing") || intent.includes("agency")) {
    route = spiderRegistry.routes.earn_agency;
  } else if (intent.includes("consult")) {
    route = spiderRegistry.routes.consultation;
  } else if (intent.includes("license") || intent.includes("enterprise") || intent.includes("investor")) {
    route = spiderRegistry.routes.corporate_hq;
  }

  res.json({
    ok: true,
    intent,
    route,
    product_language: "Figment"
  });
});

app.post("/figment", (req, res) => {
  const name = req.body?.name || "CashCash";
  const intent = req.body?.intent || "money";
  const buyer = req.body?.buyer || "there";

  res.json({
    ok: true,
    figment: {
      name,
      buyer,
      intent,
      language: "Figment",
      activation: "https://buy.stripe.com/4gM3cu5WG1Qz7mzd1AbEA00",
      consultation: "https://monetizingimagination.d-apps.store",
      hq: "https://damonylf.decodedworld.xyz"
    },
    message: `${buyer}, your ${name} Figment is ready.`
  });
});

app.get("/health", (_, res) => {
  res.json({ ok: true, service: "cashcash-cloud-worker" });
});

app.get("/state", (_, res) => {
  res.json(state);
});

app.post("/activate", (req, res) => {
  state.active = true;
  log("MISSION_ACTIVATED", req.body || {});
  res.json({
    ok: true,
    active: true,
    mission: state.mission
  });
});

app.post("/deactivate", (_, res) => {
  state.active = false;
  log("MISSION_DEACTIVATED");
  res.json({ ok: true });
});

app.post("/lead", (req, res) => {
  const lead = {
    id: `lead_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    name: req.body.name || "Lead",
    email: req.body.email,
    platform: req.body.platform || "manual",
    intent: req.body.intent || "CashCash",
    region: req.body.region || "global",
    createdAt: new Date().toISOString()
  };

  state.queue.push(lead);
  state.counters.totalQueued++;
  log("LEAD_QUEUED", lead);

  res.json({
    ok: true,
    lead,
    message: cashcashMessage(lead)
  });
});

app.post("/send", async (req, res) => {
  try {
    const result = await sendLead({
      id: `direct_${Date.now()}`,
      name: req.body.name || "Lead",
      email: req.body.to
    });

    res.json({
      ok: true,
      sent: true,
      ...result
    });
  } catch (e) {
    res.json({
      ok: false,
      error: e.message
    });
  }
});

app.post("/suppress", (req, res) => {
  if (req.body.email && !state.suppressed.includes(req.body.email)) {
    state.suppressed.push(req.body.email);
  }
  res.json({ ok: true });
});

app.post("/bulk-import", (req, res) => {
  const leads = req.body.leads || [];
  for (const lead of leads) {
    state.queue.push({
      id: `bulk_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      ...lead
    });
    state.counters.totalQueued++;
  }
  log("BULK_IMPORT", { count: leads.length });
  res.json({ ok: true, imported: leads.length });
});

app.post("/csv-import", (req, res) => {
  try {
    const csv = fs.readFileSync("./leads.csv", "utf8");
    const rows = parse(csv, { columns: true });

    rows.forEach(row => {
      state.queue.push({
        id: `csv_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        name: row.name || "Lead",
        email: row.email,
        platform: row.platform || "csv",
        intent: row.intent || "CashCash"
      });
      state.counters.totalQueued++;
    });

    log("CSV_IMPORT", { count: rows.length });
    res.json({ ok: true, imported: rows.length });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

const PORT = process.env.PORT || 10000;

app.listen(PORT, () => {
  log("BOOT", { port: PORT, mission: state.mission });
});
