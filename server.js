import express from "express";
import cors from "cors";
import dotenv from "dotenv";

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
  primarySender: "contact@damonylf.com",
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
  logs: []
};

function log(event, data = {}) {
  const row = {
    time: new Date().toISOString(),
    event,
    data
  };
  state.logs.unshift(row);
  state.logs = state.logs.slice(0, 100);
  console.log(JSON.stringify(row));
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
  res.json({
    ok: true,
    active: true,
    message: "CashCash Revenue Mode activated.",
    mission: MISSION.id
  });
});

app.post("/pause", (req, res) => {
  state.active = false;
  log("MISSION_PAUSED", { source: req.body?.source || "manual" });
  res.json({
    ok: true,
    active: false,
    message: "CashCash Revenue Mode paused."
  });
});

app.post("/lead", (req, res) => {
  const lead = {
    id: `lead_${Date.now()}`,
    name: req.body?.name || "there",
    platform: req.body?.platform || "unknown",
    intent: req.body?.intent || "money",
    region: req.body?.region || "global",
    status: "queued",
    createdAt: new Date().toISOString()
  };

  state.queue.push(lead);
  log("LEAD_QUEUED", lead);

  const personalizedMessage =
`Quick question.

Would you be interested in licensing your own AI-powered money machine?

Your CashCash Figment is ready.

Activation is $50:
${MISSION.stripe}

If you need done-for-you setup, we can route you into Earn Agency after activation.`;

  res.json({
    ok: true,
    lead,
    figment_language: "Your CashCash Figment is ready.",
    message: personalizedMessage
  });
});

app.get("/state", (_, res) => {
  res.json(state);
});

app.listen(PORT, () => {
  log("BOOT", { port: PORT, mission: MISSION.id });
});
