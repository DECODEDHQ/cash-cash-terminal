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



const BRIDGE = {
  name: "CASHCASH_CHAIRMAN_BRIDGE",
  mode: "NON_DESTRUCTIVE_FEDERATION",
  localChairman: process.env.LOCAL_CHAIRMAN_URL || "http://127.0.0.1:58195",
  cloudCashCash: "https://cash-cash-terminal.onrender.com",
  rules: {
    doNotRestartPm2: true,
    doNotOverrideRoutes: true,
    doNotReplaceConfig: true,
    queueIfUnavailable: true,
    operatorSovereignty: true
  }
};

const bridgeQueue = [];

async function safeFetchJson(url, options = {}) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3500);
    const res = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timeout);
    const text = await res.text();
    try {
      return { ok: res.ok, status: res.status, json: JSON.parse(text) };
    } catch {
      return { ok: res.ok, status: res.status, text };
    }
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

app.get("/bridge", (_, res) => {
  res.json({
    ok: true,
    bridge: BRIDGE,
    queue: bridgeQueue.length
  });
});

app.get("/bridge-health", async (_, res) => {
  const localHealth = await safeFetchJson(`${BRIDGE.localChairman}/health`);
  const localRoot = await safeFetchJson(`${BRIDGE.localChairman}/`);
  res.json({
    ok: true,
    bridge: BRIDGE.name,
    cashcash: {
      online: true,
      active: state.active,
      mission: state.mission
    },
    localChairman: {
      health: localHealth,
      root: localRoot
    },
    status: localHealth.ok ? "FEDERATED" : "CLOUD_ONLY_LOCAL_UNREACHABLE"
  });
});

app.get("/federation", async (_, res) => {
  const local = await safeFetchJson(`${BRIDGE.localChairman}/`);
  res.json({
    ok: true,
    federation: {
      cashcash: {
        url: BRIDGE.cloudCashCash,
        role: "cloud money-machine figment terminal",
        active: state.active
      },
      chairman: {
        url: BRIDGE.localChairman,
        role: "local sovereign command authority",
        reachableFromCloud: local.ok,
        note: local.ok ? "local route reachable" : "local route not reachable from cloud, expected unless tunnel/bridge is exposed"
      },
      rules: BRIDGE.rules
    }
  });
});

app.post("/command", async (req, res) => {
  const command = {
    id: `cmd_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    createdAt: new Date().toISOString(),
    source: req.body?.source || "cloud",
    intent: req.body?.intent || "unknown",
    mode: req.body?.mode || "cashcash",
    payload: req.body || {},
    safety: {
      nonDestructive: true,
      doNotOverride: true,
      doNotRestart: true
    },
    status: "queued"
  };

  bridgeQueue.push(command);
  log("BRIDGE_COMMAND_QUEUED", command);

  res.json({
    ok: true,
    command,
    message: "Command queued non-destructively."
  });
});

app.post("/forward", async (req, res) => {
  const payload = {
    intent: "ADD_MISSION_OR_COMMAND",
    safety: {
      non_destructive: true,
      do_not_override_existing_routes: true,
      do_not_replace_config: true,
      do_not_restart_pm2: true,
      queue_if_route_unclear: true
    },
    command: req.body || {}
  };

  const result = await safeFetchJson(`${BRIDGE.localChairman}/engine`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  if (!result.ok) {
    const fallback = {
      id: `fallback_${Date.now()}`,
      createdAt: new Date().toISOString(),
      payload,
      reason: result.error || "LOCAL_FORWARD_FAILED",
      status: "queued_for_local_pickup"
    };
    bridgeQueue.push(fallback);
    log("LOCAL_FORWARD_FALLBACK_QUEUED", fallback);
    return res.json({
      ok: true,
      forwarded: false,
      queued: true,
      result,
      fallback
    });
  }

  log("LOCAL_FORWARD_SUCCESS", { result });

  res.json({
    ok: true,
    forwarded: true,
    result
  });
});

app.get("/bridge-queue", (_, res) => {
  res.json({
    ok: true,
    count: bridgeQueue.length,
    queue: bridgeQueue
  });
});

app.post("/bridge-clear", (_, res) => {
  const cleared = bridgeQueue.length;
  bridgeQueue.length = 0;
  log("BRIDGE_QUEUE_CLEARED", { cleared });
  res.json({ ok: true, cleared });
});




const figmentRegistry = [];

function makeFigment(payload = {}) {
  const id = `fig_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const figment = {
    id,
    createdAt: new Date().toISOString(),
    name: payload.name || "CashCash",
    buyer: payload.buyer || payload.name || "there",
    intent: payload.intent || "money",
    type: payload.type || "Money Machine Figment",
    status: "manifested_preview",
    rights: {
      access: true,
      commercial: Boolean(payload.commercial),
      whiteLabel: Boolean(payload.whiteLabel),
      spawn: Boolean(payload.spawnRightsPaid),
      transferable: false,
      sourceIncluded: false
    },
    routes: {
      activation: "https://buy.stripe.com/4gM3cu5WG1Qz7mzd1AbEA00",
      consultation: "https://monetizingimagination.d-apps.store",
      earnAgency: "https://earnagency.d-apps.store",
      earnAI: "https://earnai.d-apps.store",
      hq: "https://damonylf.decodedworld.xyz"
    },
    publicLanguage: {
      product: "Figment",
      message: `${payload.buyer || payload.name || "there"}, your ${payload.name || "CashCash"} Figment is ready.`
    }
  };

  figmentRegistry.unshift(figment);
  if (figmentRegistry.length > 500) figmentRegistry.pop();
  log("FIGMENT_MANIFESTED", { id: figment.id, name: figment.name, intent: figment.intent });
  return figment;
}

app.get("/dreammaker", (_, res) => {
  res.json({
    ok: true,
    system: "DreamMaker Federation",
    mode: "manifestation routing",
    cashcash: "https://cash-cash-terminal.onrender.com",
    rule: "Figments are licensed, non-transferable, and spawn rights require paid authorization."
  });
});

app.post("/manifest", (req, res) => {
  const figment = makeFigment(req.body || {});
  res.json({
    ok: true,
    figment,
    message: figment.publicLanguage.message
  });
});

app.post("/spawn-request", (req, res) => {
  const paid = Boolean(req.body?.spawnRightsPaid);

  if (!paid) {
    const figment = makeFigment({
      ...(req.body || {}),
      spawnRightsPaid: false
    });

    return res.json({
      ok: true,
      approved: false,
      reason: "SPAWN_RIGHTS_NOT_INCLUDED",
      route: "https://monetizingimagination.d-apps.store",
      figment,
      message: "This Figment can be activated, but self-spawning rights require a Creator or Enterprise license."
    });
  }

  const figment = makeFigment({
    ...(req.body || {}),
    spawnRightsPaid: true,
    type: req.body?.type || "Creator Licensed Figment"
  });

  res.json({
    ok: true,
    approved: true,
    figment,
    message: "Spawn-capable Figment request approved under paid rights."
  });
});

app.get("/figment-registry", (_, res) => {
  res.json({
    ok: true,
    count: figmentRegistry.length,
    figments: figmentRegistry
  });
});

app.get("/figment/:id", (req, res) => {
  const found = figmentRegistry.find(x => x.id === req.params.id);
  if (!found) return res.status(404).json({ ok: false, error: "FIGMENT_NOT_FOUND" });
  res.json({ ok: true, figment: found });
});




const campaigns = [];

function scoreIntent(text = "") {
  const t = String(text).toLowerCase();
  let score = 0;
  const hits = [];

  const rules = [
    ["make money", 25],
    ["side hustle", 20],
    ["ai income", 25],
    ["digital product", 20],
    ["automation", 15],
    ["ecommerce", 15],
    ["flipping", 20],
    ["creator", 10],
    ["monetize", 20],
    ["business", 10],
    ["cash", 25],
    ["license", 25],
    ["startup", 10],
    ["sales", 15],
    ["leads", 15]
  ];

  for (const [term, points] of rules) {
    if (t.includes(term)) {
      score += points;
      hits.push(term);
    }
  }

  let tier = "cold";
  if (score >= 50) tier = "hot";
  else if (score >= 25) tier = "warm";

  return { score, tier, hits };
}

function routeIntent(text = "") {
  const t = String(text).toLowerCase();

  if (t.includes("custom") || t.includes("build") || t.includes("manifest")) {
    return { route: "DreamMaker", url: "https://monetizingimagination.d-apps.store" };
  }

  if (t.includes("done for you") || t.includes("marketing") || t.includes("agency")) {
    return { route: "Earn Agency", url: "https://earnagency.d-apps.store" };
  }

  if (t.includes("consult")) {
    return { route: "Monetizing Imagination", url: "https://monetizingimagination.d-apps.store" };
  }

  if (t.includes("license") || t.includes("enterprise") || t.includes("partner")) {
    return { route: "Corporate HQ", url: "https://damonylf.decodedworld.xyz" };
  }

  return { route: "CashCash", url: "https://cash-cash-terminal.onrender.com" };
}

app.get("/hunt", (_, res) => {
  res.json({
    ok: true,
    system: "CashCash Omni Hunter",
    mission: "Find money intent, create Figment route, feed CashCash queue.",
    platforms: ["x", "instagram", "tiktok_pimpgpt", "gmail", "manual"],
    safe: true
  });
});

app.post("/hunt-intake", (req, res) => {
  const text = req.body?.text || req.body?.bio || req.body?.post || req.body?.intent || "";
  const email = req.body?.email || null;
  const name = req.body?.name || req.body?.handle || "Lead";
  const platform = req.body?.platform || "unknown";
  const region = req.body?.region || "global";

  const intentScore = scoreIntent(text);
  const route = routeIntent(text);

  const payload = {
    name,
    email,
    platform,
    intent: text || "CashCash",
    region,
    score: intentScore.score,
    tier: intentScore.tier,
    route: route.route,
    routeUrl: route.url,
    createdAt: new Date().toISOString()
  };

  log("HUNT_INTAKE", payload);

  if (email && intentScore.tier !== "cold") {
    const queued = queueLead({
      name,
      email,
      platform,
      intent: text || "CashCash",
      region
    });

    return res.json({
      ok: true,
      scored: intentScore,
      route,
      queued
    });
  }

  res.json({
    ok: true,
    scored: intentScore,
    route,
    queued: false,
    reason: email ? "LOW_INTENT" : "NO_EMAIL"
  });
});

app.post("/platform-intake", (req, res) => {
  const platform = req.body?.platform || "manual";
  const items = Array.isArray(req.body?.items) ? req.body.items : [];

  const results = items.map(item => {
    const text = item.text || item.bio || item.post || item.intent || "";
    const scored = scoreIntent(text);
    const route = routeIntent(text);

    const normalized = {
      name: item.name || item.handle || "Lead",
      email: item.email || null,
      platform,
      intent: text,
      region: item.region || "global",
      score: scored.score,
      tier: scored.tier,
      route
    };

    if (normalized.email && scored.tier !== "cold") {
      normalized.queued = queueLead(normalized);
    } else {
      normalized.queued = false;
    }

    return normalized;
  });

  log("PLATFORM_INTAKE", { platform, count: items.length });

  res.json({
    ok: true,
    platform,
    processed: results.length,
    results
  });
});

app.post("/campaign", (req, res) => {
  const campaign = {
    id: `camp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    name: req.body?.name || "CashCash Campaign",
    platform: req.body?.platform || "omni",
    target: req.body?.target || "money intent",
    message: req.body?.message || "Your CashCash Figment is ready.",
    route: req.body?.route || "CashCash",
    status: "active",
    createdAt: new Date().toISOString()
  };

  campaigns.unshift(campaign);
  log("CAMPAIGN_CREATED", campaign);

  res.json({ ok: true, campaign });
});

app.get("/campaigns", (_, res) => {
  res.json({
    ok: true,
    count: campaigns.length,
    campaigns
  });
});

app.post("/hot-reply", (req, res) => {
  const reply = {
    id: `reply_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    name: req.body?.name || "Lead",
    email: req.body?.email || null,
    platform: req.body?.platform || "unknown",
    message: req.body?.message || "",
    route: routeIntent(req.body?.message || ""),
    score: scoreIntent(req.body?.message || ""),
    createdAt: new Date().toISOString()
  };

  log("HOT_REPLY", reply);

  res.json({
    ok: true,
    reply,
    recommended_next_action:
      reply.score.tier === "hot"
        ? "Send payment link or route to consultation."
        : "Ask one qualifying question."
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
