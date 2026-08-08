import express from "express";
import { Resend } from "resend";
import cron from "node-cron";
import fs from "fs";
import os from "os";
import path from "path";
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



function queueLead(raw = {}) {
  const email = raw.email || raw.to || null;

  const lead = {
    id: `lead_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    name: raw.name || "Lead",
    email,
    platform: raw.platform || "manual",
    intent: raw.intent || "CashCash",
    region: raw.region || "global",
    status: "queued",
    createdAt: new Date().toISOString()
  };

  if (!email) {
    log("LEAD_SKIPPED_NO_EMAIL", lead);
    return { ok: false, reason: "NO_EMAIL", lead };
  }

  if (state.suppressed.includes(email)) {
    log("LEAD_SUPPRESSED", { email });
    return { ok: false, reason: "SUPPRESSED", lead };
  }

  if (state.queue.some(x => x.email === email) || state.sent.some(x => x.to === email)) {
    log("LEAD_DUPLICATE", { email });
    return { ok: false, reason: "DUPLICATE", lead };
  }

  state.queue.push(lead);
  state.counters.totalQueued++;
  log("LEAD_QUEUED", lead);

  return { ok: true, lead };
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
    from: process.env.CASHCASH_FROM || "CashCash <onboarding@resend.dev>",
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


import spiderRegistry from "./spider_registry.json" with { type: 'json' };

const ENGINE_REGISTRY_PATH = process.env.CHAIRMAN_ENGINE_REGISTRY ||
  path.join(os.homedir(), "chairman_engine_bus", "registry", "engines.json");

function engineRegistry() {
  try {
    return JSON.parse(fs.readFileSync(ENGINE_REGISTRY_PATH, "utf8"));
  } catch {
    return {
      dreammaker: {url: process.env.DREAMMAKER_URL || spiderRegistry.routes.dreammaker.url},
      chairman: {url: process.env.LOCAL_CHAIRMAN_URL || spiderRegistry.routes.local_chairman.url}
    };
  }
}

function resolvedSpiderRegistry() {
  const resolved = structuredClone(spiderRegistry);
  const engines = engineRegistry();
  resolved.routes.dreammaker.url = engines.dreammaker.url;
  resolved.routes.local_chairman.url = engines.chairman.url;
  return resolved;
}

app.get("/spider", (_, res) => {
  res.json(resolvedSpiderRegistry());
});

app.get("/routes", (_, res) => {
  res.json(resolvedSpiderRegistry().routes);
});

app.post("/route", (req, res) => {
  const intent = String(req.body?.intent || "").toLowerCase();
  const registry = resolvedSpiderRegistry();

  let route = registry.routes.corporate_hq;

  if (intent.includes("money") || intent.includes("cash") || intent.includes("income")) {
    route = { label: "CashCash", role: "money-machine-figment-terminal", url: registry.cashcash.url };
  } else if (intent.includes("custom") || intent.includes("build") || intent.includes("manifest")) {
    route = registry.routes.dreammaker;
  } else if (intent.includes("done") || intent.includes("marketing") || intent.includes("agency")) {
    route = registry.routes.earn_agency;
  } else if (intent.includes("consult")) {
    route = registry.routes.consultation;
  } else if (intent.includes("license") || intent.includes("enterprise") || intent.includes("investor")) {
    route = registry.routes.corporate_hq;
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
  localChairman: process.env.LOCAL_CHAIRMAN_URL || engineRegistry().chairman.url,
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




const towerCommands = [];

app.get("/tower", (_, res) => {
  res.type("html").send(`<!doctype html>
<html>
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>CashCash SPIDERNODE Command Tower</title>
<style>
body{margin:0;background:#05070b;color:#eef6ff;font-family:-apple-system,BlinkMacSystemFont,Inter,Arial,sans-serif}
.wrap{max-width:1180px;margin:0 auto;padding:28px}
.hero{border:1px solid rgba(120,220,255,.22);border-radius:28px;padding:30px;background:linear-gradient(135deg,rgba(9,14,24,.95),rgba(0,255,240,.05));box-shadow:0 30px 90px rgba(0,0,0,.4)}
h1{font-size:clamp(38px,7vw,82px);letter-spacing:-.06em;line-height:.9;margin:0}
p{color:#9fb0c7;line-height:1.55}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:14px;margin-top:18px}
.card{border:1px solid rgba(255,255,255,.12);border-radius:22px;background:rgba(255,255,255,.04);padding:18px}
b{color:#78fff2}
button{border:0;border-radius:999px;padding:12px 16px;font-weight:800;margin:6px;background:#eef6ff;color:#05070b}
button.dark{background:transparent;color:#eef6ff;border:1px solid rgba(255,255,255,.2)}
pre{white-space:pre-wrap;background:#020306;border:1px solid rgba(120,220,255,.18);padding:16px;border-radius:18px;overflow:auto}
</style>
</head>
<body>
<div class="wrap">
<section class="hero">
<div style="font-size:12px;letter-spacing:.2em;color:#78fff2;font-weight:800">SPIDERNODE COMMAND TOWER</div>
<h1>CashCash<br/>Control Surface</h1>
<p>Observe, route, pause, resume, export. Non-destructive command tower for the CashCash Figment terminal.</p>
<button onclick="post('/activate')">Resume Mission</button>
<button class="dark" onclick="post('/pause')">Pause Mission</button>
<button class="dark" onclick="post('/tower-export')">Export State</button>
</section>
<div class="grid">
<div class="card"><h3>Status</h3><pre id="state">Loading...</pre></div>
<div class="card"><h3>Mission</h3><pre id="mission">Loading...</pre></div>
<div class="card"><h3>Routes</h3><pre id="routes">Loading...</pre></div>
<div class="card"><h3>Health</h3><pre id="health">Loading...</pre></div>
</div>
</div>
<script>
async function load(){
  const s=await fetch('/state').then(r=>r.json()).catch(e=>({error:e.message}));
  const m=await fetch('/mission').then(r=>r.json()).catch(e=>({error:e.message}));
  const h=await fetch('/health').then(r=>r.json()).catch(e=>({error:e.message}));
  let routes={};
  try{routes=await fetch('/routes').then(r=>r.json())}catch(e){routes={status:'routes not loaded yet'}}
  state.textContent=JSON.stringify(s,null,2);
  mission.textContent=JSON.stringify(m,null,2);
  health.textContent=JSON.stringify(h,null,2);
  document.getElementById('routes').textContent=JSON.stringify(routes,null,2);
}
async function post(path){
  await fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({source:'tower'})});
  load();
}
load(); setInterval(load,10000);
</script>
</body></html>`);
});

app.get("/tower-health", (_, res) => {
  res.json({
    ok: true,
    tower: "SPIDERNODE_COMMAND_TOWER",
    active: state.active,
    mission: state.mission,
    queue: state.queue?.length || 0,
    sent: state.sent?.length || 0,
    failed: state.failed?.length || 0,
    suppressed: state.suppressed?.length || 0,
    rules: {
      noOverride: true,
      noMutationWithoutProtocol: true,
      operatorSovereignty: true
    }
  });
});

app.get("/tower-dashboard", (_, res) => {
  res.json({
    ok: true,
    dashboard: {
      mission: state.mission,
      active: state.active,
      counters: state.counters || {},
      queue: state.queue || [],
      sent: state.sent || [],
      failed: state.failed || [],
      suppressed: state.suppressed || [],
      recentLogs: state.logs || []
    }
  });
});

app.post("/tower-command", (req, res) => {
  const command = {
    id: `tower_${Date.now()}_${Math.random().toString(36).slice(2,8)}`,
    createdAt: new Date().toISOString(),
    source: req.body?.source || "tower",
    intent: req.body?.intent || "unknown",
    payload: req.body || {},
    safety: {
      nonDestructive: true,
      noOverride: true,
      noRestart: true
    },
    status: "recorded"
  };

  towerCommands.unshift(command);
  if (towerCommands.length > 300) towerCommands.pop();
  log("TOWER_COMMAND", command);

  res.json({ ok: true, command });
});

app.post("/tower-kill", (req, res) => {
  state.active = false;
  log("TOWER_KILL_SWITCH", { source: req.body?.source || "tower" });
  res.json({ ok: true, active: false, message: "Mission paused by tower kill switch." });
});

app.post("/tower-resume", (req, res) => {
  state.active = true;
  log("TOWER_RESUME", { source: req.body?.source || "tower" });
  res.json({ ok: true, active: true, message: "Mission resumed by tower." });
});

app.post("/tower-export", (_, res) => {
  res.json({
    ok: true,
    exportedAt: new Date().toISOString(),
    mission: state.mission,
    active: state.active,
    state,
    towerCommands
  });
});

app.get("/tower-commands", (_, res) => {
  res.json({ ok: true, count: towerCommands.length, commands: towerCommands });
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
    let lead = req.body?.email ? req.body : null;
    if (!lead && req.body?.to) {
      lead = {
        id: `direct_${Date.now()}`,
        name: req.body.name || "Lead",
        email: req.body.to
      };
    }

    if (!lead) {
      if (!state.queue.length) {
        return res.status(400).json({ ok:false, error:"NO_EMAIL" });
      }
      lead = state.queue.shift();
    }

    const sent = await sendLead(lead);
    return res.json({ ok:true, sent });

  } catch (err) {
    state.failed.unshift({
      time: new Date().toISOString(),
      error: err.message
    });
    state.counters.totalFailed++;
    return res.status(500).json({ ok:false, error: err.message });
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
