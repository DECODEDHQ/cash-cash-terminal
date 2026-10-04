import crypto from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";

const PROVIDER_BASE = "https://api.whatsapp.com/agent/v1";
const OPENAI_URL = "https://api.openai.com/v1/responses";
const META_MODEL_BASE = "https://api.meta.ai/v1";
const execFileAsync = promisify(execFile);
const IDENTITIES = new Set([
  "TOLA_WHATSAPP",
  "TOLA",
  "MUSE_REN",
  "OPENAI_COMMAND_TOWER_RUNTIME",
  "CHAIRMAN_LOCAL",
  "CHATGPT_INTERACTIVE",
]);
const ACTION_CLASSES = new Set(["THINK", "RESOLVE", "ACT", "EXECUTE"]);
const MAX_TTL_MS = 15 * 60 * 1000;
const MAX_FRESHNESS_MS = 5 * 60 * 1000;
const STATES = [
  "QUEUED", "READY", "LEASED", "RUNNING", "WAITING_DEPENDENCY",
  "WAITING_EXTERNAL", "WAITING_APPROVAL", "RETRY_SCHEDULED", "VERIFYING",
  "COMPLETED", "FAILED", "CANCELLED",
];
const MEDIA_TYPES = new Set(["image", "video", "audio", "document"]);
const IMAGE_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
const DOCUMENT_MIME_TYPES = new Set([
  "application/pdf", "text/plain", "text/csv", "application/rtf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
]);
const MEDIA_LIMITS = Object.freeze({
  image: 20 * 1024 * 1024,
  video: 64 * 1024 * 1024,
  audio: 32 * 1024 * 1024,
  document: 32 * 1024 * 1024,
});
const WHATSAPP_OUTBOUND_MEDIA_LIMIT = 16 * 1024 * 1024;
const PRIVATE_MEDIA_CAPABILITY_VERSION = "private-media-v4-live-muse-registry";
const PRIVATE_MEDIA_SCOPE = "PRIVATE_ARTIFACT_CREATE";
const DEFAULT_VIDEO_PRODUCT = "Meta Muse Video";
const DEFAULT_REPLY = "Tell me what you want. I’ll work out the rest.";
const CAPABILITY_REPLY = "Tell me the result you want. I’ll work out what needs to happen and take it from there. If I need anything from you, I’ll ask.";
const TOLA_BEHAVIOR_CONTRACT_REVISION = "TOLA_EXECUTION_LAW_2026-10-04_V7_REAL_REN_HANDOFF";
const REN_TRANSPORT_PROTOCOL = "TOLA_REN_ENCRYPTED_PULL_V1";
const REN_X25519_PUBLIC_DER_B64 = "MCowBQYDK2VuAyEAUXpJGrRqRDD40S5Hg17uNpdrpfw1PSiRUvCUB20p+Fg=";
const REN_ED25519_PUBLIC_DER_B64 = "MCowBQYDK2VwAyEAz7I+wE4qJIFMLO5RW+3d1UOFNOcp0QkLULYcFWwKfB8=";
const REN_X25519_FINGERPRINT = "75143830bf819b9cfba13e6e31947899a5c1fc9c1aa5251ed5f87a5ac5bde46a";
const REN_ED25519_FINGERPRINT = "0e7a294dde0a7582fd2528f29165c45dc6ffa07718dcb8910ba34915779ef56d";
const REN_RESULT_STATES = new Set(["COMPLETED", "BLOCKED"]);
const TOLA_BEHAVIOR_CONTRACT = [
  `TOLA BEHAVIOR CONTRACT ${TOLA_BEHAVIOR_CONTRACT_REVISION}. This contract applies to every WhatsApp response and takes priority over generic assistant behavior.`,
  "TOLA is a human-facing execution agent, not a generic chatbot. Speak as TOLA and return only the direct WhatsApp reply.",
  `For a capability question, answer exactly: “${CAPABILITY_REPLY}”`,
  "Never give a generic capability list. Never say that you can answer questions, summarize, translate, draft, write or rewrite text, look things up, or that you are an AI assistant.",
  "Never say ‘if you want, I can’. Never advertise tools, models, engines, integrations, menus, or internal architecture.",
  "When the user supplies a clear WANT and enough information exists: understand it, resolve the required steps internally, act within current authority, continue until a result or genuine blocker, and return the result.",
  "Do not offer options, plans, prompts, briefs, storyboards, or other intermediate artifacts instead of executing a clear WANT.",
  "Ask one short question only when information, identity, consent, payment, authentication, rights, legal approval, material authority, or another genuine dependency is missing.",
  "Use short WhatsApp-native language: direct acknowledgment, action, result, and at most one necessary question. Do not use email formatting, long signatures, or infrastructure explanations.",
  "Never claim a consequential external action occurred unless verified evidence in the current request proves it occurred.",
  "For a clear image request, invoke the available image creation capability. For a clear video request, invoke only a bound genuine temporal video-generation capability; never substitute an animated still, pan, zoom, slideshow, repeated frame, or image wrapped in MP4.",
  "If genuine video generation is not currently available, state only the human-relevant capability or permission blocker. Never expose provider names, model names, environment variables, credentials, internal codes, or infrastructure details.",
  "Never claim video completion merely because an MP4 exists.",
  "For work that requires estate execution, preserve the requester and authority exactly and hand the WANT to the real MUSE_REN runtime. Never treat a foundation-model response as REN execution evidence.",
  "Acceptance, execution completion, and result delivery are separate states. Acknowledgment is not proof that work completed.",
].join("\n");

const now = () => new Date().toISOString();
const parse = (value, fallback = null) => {
  try { return JSON.parse(value); } catch { return fallback; }
};
const stable = value => {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
};
const sha256 = value => crypto.createHash("sha256").update(Buffer.isBuffer(value) ? value : typeof value === "string" ? value : stable(value)).digest("hex");
const shortHash = value => sha256(value).slice(0, 32);
const hasScope = (value, expected) => Array.isArray(value) && value.map(String).includes(expected);
const bearer = request => String(request.headers.authorization || "").replace(/^Bearer\s+/i, "");

function isMountedPath(target, mountInfo) {
  const resolved = path.resolve(target);
  let data = mountInfo;
  if (data === undefined) {
    try { data = fs.readFileSync("/proc/self/mountinfo", "utf8"); }
    catch { return false; }
  }
  return String(data).split(/\r?\n/).some(line => {
    const fields = line.split(" - ")[0]?.split(" ") || [];
    const encoded = fields[4];
    if (!encoded) return false;
    const mounted = path.resolve(encoded.replace(/\\([0-7]{3})/g, (_match, octal) => String.fromCharCode(Number.parseInt(octal, 8))));
    return mounted !== path.parse(mounted).root && (resolved === mounted || resolved.startsWith(`${mounted}${path.sep}`));
  });
}

function safeError(error) {
  return String(error?.message || error || "UNKNOWN")
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|Bearer\s+[A-Za-z0-9._-]{12,})\b/gi, "[REDACTED]")
    .replace(/[^A-Z0-9_:.-]/gi, "_")
    .slice(0, 180);
}

function containsCredential(value) {
  if (typeof value === "string") {
    return /\bsk-[A-Za-z0-9_-]{12,}|\bBearer\s+[A-Za-z0-9._-]{12,}|\b(?:api[_ -]?key|access[_ -]?token|secret|password)\s*[:=]\s*[^\s]{8,}|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----/i.test(value);
  }
  if (Array.isArray(value)) return value.some(containsCredential);
  if (value && typeof value === "object") return Object.values(value).some(containsCredential);
  return false;
}

function containsRawCredential(value) {
  return containsCredential(value) || /^\s*[A-Za-z0-9_./+=-]{24,}\s*$/.test(String(value || ""));
}

function responseText(body) {
  if (typeof body?.output_text === "string") return body.output_text.trim();
  const chunks = [];
  for (const item of body?.output || []) {
    for (const content of item?.content || []) if (typeof content?.text === "string") chunks.push(content.text);
  }
  return chunks.join("\n").trim();
}

function isOpening(value) {
  const text = String(value || "").trim().toLowerCase().replace(/[^a-z ]+/g, "").replace(/\s+/g, " ");
  return /^(?:hi|hello|hey|hi there|hello there|hey there|good morning|good afternoon|good evening)$/.test(text);
}

function isCapabilityQuestion(value) {
  const text = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9' ]+/g, " ")
    .replace(/\bu\b/g, "you")
    .replace(/\s+/g, " ")
    .trim();
  return text.length <= 220 && /^(?:(?:so|ok|okay) )?(?:what can you do|what do you do|what are you able to do|can you help me|can you actually do things(?: for me)?|how can you help(?: me)?)(?: please)?$/.test(text);
}

function tolaInstructions(intent) {
  const classification = isCapabilityQuestion(intent)
    ? `CURRENT MESSAGE CLASSIFICATION: CAPABILITY QUESTION. The entire reply must be exactly: “${CAPABILITY_REPLY}”`
    : isOpening(intent)
      ? `CURRENT MESSAGE CLASSIFICATION: OPENING. Reply briefly in TOLA's WANT-first posture: “${DEFAULT_REPLY}”`
      : "CURRENT MESSAGE CLASSIFICATION: WANT OR CONTINUATION. Perform the available work now; do not replace execution with a capability speech or an offer of next steps.";
  return `${TOLA_BEHAVIOR_CONTRACT}\n${classification}`;
}

function normalizeReply(value, fallback = DEFAULT_REPLY) {
  const reply = String(value || "")
    .replace(/\b(?:OPENAI_COMMAND_TOWER_RUNTIME|CHAIRMAN_LOCAL|MUSE_REN|A2A_FIREWALL)\b/g, "TOLA")
    .trim()
    .slice(0, 4096);
  if (!reply) return fallback;
  if (/\b(?:META_MUSE_VIDEO_[A-Z0-9_]*|TOLA_VIDEO_[A-Z0-9_]*|OPENAI_[A-Z0-9_]*|CANON_SHA256|PRIVATE_ARTIFACT_CREATE|FFMPEG)\b/i.test(reply)) {
    return "Genuine video generation isn’t available yet, so I haven’t sent a fake substitute.";
  }
  if (/\b(?:i(?:'m| am) an ai assistant|i can(?:not|'t) (?:take real[- ]world actions|generate|create|make|produce|render)|i can only help you think|if you want, i can|ready-to-run prompt|generator prompt)\b/i.test(reply)) return fallback;
  return reply;
}

function explicitMediaWant(value) {
  const text = String(value || "");
  const creation = /\b(?:create|crate|make|produce|render|generate|turn)\b/i.test(text);
  if (!creation) return null;
  if (/\b(?:video|promo|reel|clip|animation)\b/i.test(text)) return "video";
  if (/\b(?:image|picture|photo|graphic|poster|artwork)\b/i.test(text)) return "image";
  return null;
}

function isRenExecutionWant(value) {
  const text = String(value || "").trim();
  if (!text || isOpening(text) || isCapabilityQuestion(text) || explicitMediaWant(text)) return false;
  if (/\b(?:what|who|when|where|why|how)\b.*\b(?:is|are|was|were|does|do|did)\b/i.test(text)) return false;
  return /\b(?:book|buy|purchase|reserve|schedule|send|email|message|contact|call|publish|post|upload|deploy|build|implement|repair|fix|coordinate|organize|arrange|follow[ -]?up|apply|submit|file|negotiate|source|procure|fulfil|fulfill|execute|complete|handle|investigate|research and (?:deliver|save|prepare|complete)|prepare (?:and|the)|create (?:a |an |the )?(?:report|proposal|document|spreadsheet|plan|campaign|listing|booking|application)|do (?:this|that|it|something))\b/i.test(text);
}

function exportPublicDer(key) {
  return key.export({ type: "spki", format: "der" });
}

function loadOrCreateKeyPair(directory, name, type) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const privateFile = path.join(directory, `${name}-private.pem`);
  let privateKey;
  if (fs.existsSync(privateFile)) {
    privateKey = crypto.createPrivateKey(fs.readFileSync(privateFile));
  } else {
    const pair = crypto.generateKeyPairSync(type);
    privateKey = pair.privateKey;
    fs.writeFileSync(privateFile, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600, flag: "wx" });
  }
  fs.chmodSync(privateFile, 0o600);
  return { privateKey, publicKey: crypto.createPublicKey(privateKey), privateFile };
}

function transportKey(sharedSecret, context) {
  return Buffer.from(crypto.hkdfSync("sha256", sharedSecret, Buffer.from(sha256(context), "hex"), Buffer.from(REN_TRANSPORT_PROTOCOL), 32));
}

function isMediaContinuation(value) {
  const text = String(value || "").trim();
  return text.length <= 600 && /\b(?:realistic|cinematic|cartoon|stylized|vertical|landscape|portrait|square|use (?:it|that)|same (?:image|artwork)|go ahead|do it|just do|make it|yes|continue|proceed)\b/i.test(text);
}

function validGeneratedImage(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 64 || bytes.length > 25 * 1024 * 1024) return false;
  const head = bytes.subarray(0, 16);
  return head.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))
    || head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    || (head.subarray(0, 4).toString("ascii") === "RIFF" && head.subarray(8, 12).toString("ascii") === "WEBP");
}

function generatedImageMime(bytes) {
  if (!Buffer.isBuffer(bytes)) return null;
  if (bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return "image/jpeg";
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return null;
}

function capabilityFailureReply(error) {
  const code = safeError(error);
  if (/TOLA_META_MUSE_VIDEO_API_UNAVAILABLE/i.test(code)) return "Genuine video generation isn’t available yet, so I haven’t sent a fake substitute.";
  if (/TOLA_GENUINE_VIDEO_PROVIDER_UNBOUND/i.test(code)) return "Genuine video generation isn’t available yet, so I haven’t sent a fake substitute.";
  if (/TOLA_GENUINE_VIDEO_AUTHORITY_UNBOUND/i.test(code)) return "Genuine video generation needs your approval before I can run it. I haven’t spent anything or sent a fake substitute.";
  if (/TOLA_VIDEO_(?:TEMPORAL|PLAYBACK|CONTAINER|STREAM|ARTIFACT|DOWNLOAD)/i.test(code)) return "A real video was generated, but it failed video or motion validation, so I didn’t send or claim it as complete.";
  if (/TOLA_VIDEO_PROVIDER_GENERATION/i.test(code)) return "The genuine video provider failed to return a valid moving video. No still-image substitute was created or sent.";
  if (/OPENAI_IMAGE_403|VERIFICATION/i.test(code)) return "Image creation is blocked for this OpenAI project until image-model access is enabled. That is the only missing capability.";
  if (/OPENAI_IMAGE_429|RATE/i.test(code)) return "Image creation is temporarily rate-limited. The WANT is preserved; retrying the request is the only remaining step.";
  if (/FFMPEG/i.test(code)) return "A genuine video was generated, but WhatsApp-compatible video validation failed. No unverified file was sent.";
  if (/WHATSAPP_MEDIA_UPLOAD|WHATSAPP_SEND/i.test(code)) return "The result was created, but WhatsApp media delivery failed. The WANT and finished artifact are preserved.";
  return "The creation route hit a verified runtime failure. The WANT is preserved; no completion was claimed.";
}

function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
  fs.chmodSync(file, 0o600);
}

class CloudStore {
  constructor(stateDir) {
    this.stateDir = stateDir;
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    this.dbFile = path.join(stateDir, "persistent-jobs.sqlite");
    this.effectsFile = path.join(stateDir, "value-provenance", "events.jsonl");
    this.cursorFile = path.join(stateDir, "tola-whatsapp", "cursor.json");
    this.db = new DatabaseSync(this.dbFile);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    this.migrate();
  }

  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS jobs (
        job_id TEXT PRIMARY KEY, parent_job_id TEXT, root_job_id TEXT NOT NULL, delta_id TEXT,
        worker_type TEXT NOT NULL, owner TEXT NOT NULL, intent TEXT NOT NULL, constraints TEXT NOT NULL,
        success_condition TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN (${STATES.map(x => `'${x}'`).join(",")})),
        priority INTEGER NOT NULL, tier INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        started_at TEXT, completed_at TEXT, next_run_at TEXT NOT NULL, lease_owner TEXT, lease_expires_at TEXT,
        attempt_count INTEGER NOT NULL, max_attempts INTEGER NOT NULL, retry_policy TEXT NOT NULL,
        dependencies TEXT NOT NULL, children TEXT NOT NULL, provenance TEXT NOT NULL, evidence TEXT NOT NULL,
        result TEXT, failure_reason TEXT, failure_class TEXT, idempotency_key TEXT NOT NULL UNIQUE,
        execution_route TEXT NOT NULL, checkpoint TEXT NOT NULL, needs_you_reason TEXT,
        terminal_state TEXT, terminal_evidence TEXT NOT NULL DEFAULT '{}', execution_attempted_at TEXT,
        imagination_economy_context TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX IF NOT EXISTS jobs_eligible ON jobs(state,next_run_at,priority);
      CREATE INDEX IF NOT EXISTS jobs_parent ON jobs(parent_job_id);
      CREATE INDEX IF NOT EXISTS jobs_root ON jobs(root_job_id);
      CREATE INDEX IF NOT EXISTS jobs_delta ON jobs(delta_id);
      CREATE TABLE IF NOT EXISTS action_receipts (
        idempotency_key TEXT PRIMARY KEY, job_id TEXT NOT NULL, status TEXT NOT NULL,
        evidence TEXT NOT NULL, result TEXT, created_at TEXT NOT NULL, completed_at TEXT
      );
      CREATE TABLE IF NOT EXISTS worker_health (
        worker_id TEXT PRIMARY KEY, status TEXT NOT NULL, current_job_id TEXT,
        heartbeat_at TEXT NOT NULL, pid INTEGER, memory_rss INTEGER, details TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS job_events (
        event_id INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL, event_type TEXT NOT NULL,
        at TEXT NOT NULL, payload TEXT NOT NULL
      );
    `);
  }

  jsonRow(row) {
    if (!row) return null;
    const result = { ...row };
    for (const key of ["constraints", "retry_policy", "dependencies", "children", "provenance", "evidence", "result", "execution_route", "checkpoint", "terminal_evidence", "imagination_economy_context"]) {
      result[key] = parse(result[key]);
    }
    return result;
  }

  getByIdempotency(key) {
    return this.jsonRow(this.db.prepare("SELECT * FROM jobs WHERE idempotency_key=?").get(key));
  }

  get(id) {
    return this.jsonRow(this.db.prepare("SELECT * FROM jobs WHERE job_id=?").get(id));
  }

  list(workerType = null) {
    const rows = workerType
      ? this.db.prepare("SELECT * FROM jobs WHERE worker_type=? ORDER BY created_at").all(workerType)
      : this.db.prepare("SELECT * FROM jobs ORDER BY created_at").all();
    return rows.map(row => this.jsonRow(row));
  }

  createJob(input) {
    const existing = this.getByIdempotency(input.idempotency_key);
    if (existing) return { job: existing, duplicate: true };
    const jobId = input.job_id || crypto.randomUUID();
    const created = now();
    const startedAt = input.started_at === undefined ? created : input.started_at;
    const completedAt = input.completed_at === undefined
      ? (input.state === "RUNNING" ? null : created)
      : input.completed_at;
    const executionAttemptedAt = input.execution_attempted_at === undefined
      ? (input.state === "RUNNING" ? null : created)
      : input.execution_attempted_at;
    const values = [
      jobId, input.parent_job_id || null, input.root_job_id || jobId, input.delta_id || null,
      input.worker_type, input.owner, input.intent, JSON.stringify(input.constraints || {}),
      input.success_condition, input.state || "COMPLETED", input.priority ?? 90, input.tier ?? 0,
      created, created, startedAt, completedAt, input.next_run_at || created,
      null, null, input.attempt_count ?? 1, input.max_attempts ?? 1,
      JSON.stringify(input.retry_policy || { base_delay_ms: 1000, max_delay_ms: 60000, jitter_ratio: 0.2 }),
      JSON.stringify(input.dependencies || []), JSON.stringify(input.children || []), JSON.stringify(input.provenance || {}),
      JSON.stringify(input.evidence || []), input.result === undefined ? null : JSON.stringify(input.result),
      null, null, input.idempotency_key, JSON.stringify(input.execution_route || []), JSON.stringify(input.checkpoint || {}),
      null, input.terminal_state || input.result?.terminal_state || null,
      JSON.stringify(input.terminal_evidence || input.result?.terminal_evidence || {}), executionAttemptedAt,
      JSON.stringify(input.imagination_economy_context || {}),
    ];
    try {
      this.db.prepare(`INSERT INTO jobs (${[
        "job_id", "parent_job_id", "root_job_id", "delta_id", "worker_type", "owner", "intent", "constraints",
        "success_condition", "state", "priority", "tier", "created_at", "updated_at", "started_at", "completed_at",
        "next_run_at", "lease_owner", "lease_expires_at", "attempt_count", "max_attempts", "retry_policy",
        "dependencies", "children", "provenance", "evidence", "result", "failure_reason", "failure_class",
        "idempotency_key", "execution_route", "checkpoint", "needs_you_reason", "terminal_state", "terminal_evidence",
        "execution_attempted_at", "imagination_economy_context",
      ].join(",")}) VALUES(${values.map(() => "?").join(",")})`).run(...values);
    } catch (error) {
      if (String(error).includes("UNIQUE constraint failed")) return { job: this.getByIdempotency(input.idempotency_key), duplicate: true };
      throw error;
    }
    const job = this.get(jobId);
    this.event(jobId, "CREATED", { state: job.state, cloud_primary: true });
    return { job, duplicate: false };
  }

  updateJob(id, fields = {}) {
    const allowed = new Set(["state", "result", "evidence", "checkpoint", "terminal_state", "terminal_evidence", "completed_at", "updated_at"]);
    const json = new Set(["result", "evidence", "checkpoint", "terminal_evidence"]);
    const entries = Object.entries(fields).filter(([key]) => allowed.has(key));
    if (!entries.some(([key]) => key === "updated_at")) entries.push(["updated_at", now()]);
    this.db.prepare(`UPDATE jobs SET ${entries.map(([key]) => `${key}=?`).join(",")} WHERE job_id=?`).run(
      ...entries.map(([key, value]) => json.has(key) ? JSON.stringify(value) : value), id,
    );
    return this.get(id);
  }

  beginAction(jobId, key) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const prior = this.db.prepare("SELECT * FROM action_receipts WHERE idempotency_key=?").get(key);
      if (prior) {
        this.db.exec("COMMIT");
        return {
          execute: false,
          receipt: { ...prior, evidence: parse(prior.evidence, []), result: parse(prior.result) },
          reason: prior.status === "COMPLETED" ? "COMPLETED" : "IN_PROGRESS",
        };
      }
      this.db.prepare("INSERT INTO action_receipts VALUES(?,?,?,?,?,?,NULL)")
        .run(key, jobId, "STARTED", "[]", null, now());
      this.db.exec("COMMIT");
      return { execute: true, receipt: null, reason: "CLAIMED" };
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch {}
      throw error;
    }
  }

  retryFailedAction(jobId, key) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const prior = this.db.prepare("SELECT * FROM action_receipts WHERE idempotency_key=?").get(key);
      if (!prior) {
        this.db.prepare("INSERT INTO action_receipts VALUES(?,?,?,?,?,?,NULL)")
          .run(key, jobId, "STARTED", "[]", null, now());
        this.db.exec("COMMIT");
        return { execute: true, reason: "CLAIMED" };
      }
      if (prior.status !== "FAILED") {
        this.db.exec("COMMIT");
        return { execute: false, reason: prior.status, receipt: { ...prior, evidence: parse(prior.evidence, []), result: parse(prior.result) } };
      }
      this.db.prepare("UPDATE action_receipts SET status='STARTED',result=NULL,evidence='[]',completed_at=NULL WHERE idempotency_key=? AND job_id=?")
        .run(key, jobId);
      this.db.exec("COMMIT");
      return { execute: true, reason: "RETRY_CLAIMED" };
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch {}
      throw error;
    }
  }

  finishAction(jobId, key, result, evidence = []) {
    this.db.prepare("UPDATE action_receipts SET status='COMPLETED',result=?,evidence=?,completed_at=? WHERE idempotency_key=? AND job_id=?")
      .run(JSON.stringify(result), JSON.stringify(evidence), now(), key, jobId);
  }

  failAction(jobId, key, error) {
    const result = { status: "FAILED", error: safeError(error), execution_count: 1, failed_at: now() };
    const evidence = [{ type: "ACTION_FAILED", verified: true, error: result.error, at: result.failed_at }];
    this.db.prepare("UPDATE action_receipts SET status='FAILED',result=?,evidence=?,completed_at=? WHERE idempotency_key=? AND job_id=?")
      .run(JSON.stringify(result), JSON.stringify(evidence), result.failed_at, key, jobId);
    return { result, evidence };
  }

  receipt(key) {
    const row = this.db.prepare("SELECT * FROM action_receipts WHERE idempotency_key=?").get(key);
    return row ? { ...row, evidence: parse(row.evidence, []), result: parse(row.result) } : null;
  }

  event(jobId, type, payload = {}) {
    this.db.prepare("INSERT INTO job_events(job_id,event_type,at,payload) VALUES(?,?,?,?)").run(jobId, type, now(), JSON.stringify(payload));
  }

  heartbeat(workerId, status, details = {}) {
    this.db.prepare("INSERT INTO worker_health VALUES(?,?,?,?,?,?,?) ON CONFLICT(worker_id) DO UPDATE SET status=excluded.status,current_job_id=excluded.current_job_id,heartbeat_at=excluded.heartbeat_at,pid=excluded.pid,memory_rss=excluded.memory_rss,details=excluded.details")
      .run(workerId, status, details.current_job_id || null, now(), details.pid || null, details.memory_rss || null, JSON.stringify(details));
  }

  availability(workerId, staleMs = 120000) {
    const row = this.db.prepare("SELECT * FROM worker_health WHERE worker_id=?").get(workerId);
    if (!row) return { state: "UNREACHABLE", heartbeat_at: null };
    const age = Date.now() - Date.parse(row.heartbeat_at);
    const state = age > staleMs ? "UNREACHABLE" : row.status === "ONLINE" ? "ONLINE" : row.status === "DEGRADED" ? "DEGRADED" : "OFFLINE";
    return { state, heartbeat_at: row.heartbeat_at, age_ms: age, details: parse(row.details, {}) };
  }

  appendEffect(type, data) {
    let previousHash = null;
    if (fs.existsSync(this.effectsFile)) {
      const lines = fs.readFileSync(this.effectsFile, "utf8").split(/\r?\n/).filter(Boolean);
      previousHash = parse(lines.at(-1), {})?.event_hash || null;
    }
    const body = { event_id: `evt_${crypto.randomUUID()}`, event_type: type, timestamp: now(), ...data, previous_hash: previousHash };
    const event = { ...body, event_hash: sha256(body) };
    fs.mkdirSync(path.dirname(this.effectsFile), { recursive: true, mode: 0o700 });
    fs.appendFileSync(this.effectsFile, `${JSON.stringify(event)}\n`, { mode: 0o600, flag: "a" });
    return event;
  }

  appendEffectOnce(effectId, type, data) {
    if (fs.existsSync(this.effectsFile)) {
      const exists = fs.readFileSync(this.effectsFile, "utf8")
        .split(/\r?\n/)
        .filter(Boolean)
        .some(line => parse(line, {})?.effect_id === effectId);
      if (exists) return null;
    }
    return this.appendEffect(type, { effect_id: effectId, ...data });
  }

  cursor() {
    try { return JSON.parse(fs.readFileSync(this.cursorFile, "utf8")); }
    catch { return { next_offset: null, agent_id: null, updated_at: null }; }
  }

  setCursor(cursor) { atomicJson(this.cursorFile, cursor); }
}

class TolaCloudRuntime {
  constructor({ app, env = process.env, fetchImpl = globalThis.fetch, videoClient = null, renAdapter = null, renPublicKeys = null } = {}) {
    this.app = app;
    this.env = env;
    this.fetch = fetchImpl;
    this.enabled = /^(?:1|true|yes|on)$/i.test(String(env.TOLA_CLOUD_ENABLED || ""));
    this.token = env.TOLA_WHATSAPP_API_KEY || "";
    this.apiKey = env.OPENAI_API_KEY || "";
    this.metaModelKey = env.MODEL_API_KEY || "";
    this.museSparkModel = env.META_MUSE_SPARK_MODEL || "muse-spark-1.3";
    this.museImageModel = env.META_MUSE_IMAGE_MODEL || "muse-image-1.0";
    this.museVoiceModel = env.META_MUSE_VOICE_MODEL || "muse-voice-transcribe-1.0";
    this.adminToken = env.TOLA_CLOUD_ADMIN_TOKEN || "";
    this.localNodeToken = env.TOLA_LOCAL_NODE_TOKEN || "";
    this.model = env.OPENAI_COMMAND_TOWER_MODEL || "gpt-5.4-mini";
    this.imageModel = env.OPENAI_IMAGE_MODEL || "gpt-image-2.5-flare";
    this.videoProduct = DEFAULT_VIDEO_PRODUCT;
    this.videoGenerationAuthorized = /^(?:1|true|yes|on)$/i.test(String(env.META_MUSE_VIDEO_GENERATION_AUTHORIZED || ""));
    this.videoClient = videoClient;
    this.canonRevision = env.CANON_REVISION || "CANON_SHA256:5005421761af682b1b623b43e5d04f3cb38fe9084d72ab18226b5987cc88a358";
    this.stateDir = env.TOLA_STATE_DIR || "/tmp/chairman-cloud-state";
    this.store = new CloudStore(this.stateDir);
    this.renAdapter = renAdapter;
    const transportDir = path.join(this.stateDir, "transport");
    this.tolaTransport = {
      x25519: loadOrCreateKeyPair(transportDir, "tola-x25519", "x25519"),
      ed25519: loadOrCreateKeyPair(transportDir, "tola-ed25519", "ed25519"),
    };
    const configuredRen = renPublicKeys || {
      x25519: REN_X25519_PUBLIC_DER_B64,
      ed25519: REN_ED25519_PUBLIC_DER_B64,
    };
    this.renTransport = {
      x25519PublicKey: crypto.createPublicKey({ key: Buffer.from(configuredRen.x25519, "base64"), type: "spki", format: "der" }),
      ed25519PublicKey: crypto.createPublicKey({ key: Buffer.from(configuredRen.ed25519, "base64"), type: "spki", format: "der" }),
      x25519Fingerprint: sha256(Buffer.from(configuredRen.x25519, "base64")),
      ed25519Fingerprint: sha256(Buffer.from(configuredRen.ed25519, "base64")),
    };
    if (!renPublicKeys && (this.renTransport.x25519Fingerprint !== REN_X25519_FINGERPRINT || this.renTransport.ed25519Fingerprint !== REN_ED25519_FINGERPRINT)) {
      throw new Error("REN_TRANSPORT_PUBLIC_KEY_FINGERPRINT_MISMATCH");
    }
    this.running = false;
    this.cursor = this.store.cursor();
    this.lastPollAt = null;
    this.lastError = null;
    this.transientMedia = new Map();
  }

  museCapabilities() {
    const authenticated = Boolean(this.metaModelKey);
    return {
      authenticated,
      state: authenticated ? "AVAILABLE" : "AUTHENTICATION_REQUIRED",
      reasoning: authenticated,
      web_search: authenticated,
      image_perception: authenticated,
      document_perception: true,
      video_perception: false,
      image_generation: authenticated,
      image_editing: authenticated,
      audio_transcription: authenticated,
      video_generation: this.publicVideoAvailability(),
    };
  }

  liveCapabilityTruth() {
    return {
      cloud_reasoning: true,
      web_research: true,
      whatsapp_private_reply: true,
      inbound_media_hydration: true,
      private_image_creation: true,
      meta_muse: this.museCapabilities(),
      chairman_local: this.store.availability("CHAIRMAN_LOCAL").state,
      consequential_actions: "EXACT_AUTHORITY_AND_PAI_REQUIRED",
    };
  }

  videoAvailability() {
    if (!this.videoClient) {
      return {
        available: false,
        provider: "meta",
        product: this.videoProduct,
        blocker: "TOLA_META_MUSE_VIDEO_API_UNAVAILABLE",
      };
    }
    if (!this.videoGenerationAuthorized) {
      return {
        available: false,
        provider: "meta",
        product: this.videoProduct,
        blocker: "TOLA_GENUINE_VIDEO_AUTHORITY_UNBOUND:META_MUSE_VIDEO_GENERATION_AUTHORIZED",
      };
    }
    return { available: true, provider: "meta", product: this.videoProduct, blocker: null };
  }

  publicVideoAvailability() {
    const available = this.videoAvailability().available;
    return { available, state: available ? "AVAILABLE" : "UNAVAILABLE" };
  }

  assertConfig() {
    if (!this.token) throw new Error("TOLA_WHATSAPP_API_KEY_MISSING");
    if (!this.apiKey) throw new Error("OPENAI_API_KEY_MISSING");
    if (!this.adminToken || !this.localNodeToken) throw new Error("TOLA_CLOUD_CONTROL_TOKEN_MISSING");
    if (!/^CANON_SHA256:[a-f0-9]{64}$/.test(this.canonRevision)) throw new Error("CANON_REVISION_INVALID");
  }

  tolaTransportInfo() {
    const x25519 = exportPublicDer(this.tolaTransport.x25519.publicKey);
    const ed25519 = exportPublicDer(this.tolaTransport.ed25519.publicKey);
    return {
      protocol: REN_TRANSPORT_PROTOCOL,
      identity: "TOLA_WHATSAPP",
      x25519_public_der_b64: x25519.toString("base64"),
      x25519_fingerprint_sha256: sha256(x25519),
      ed25519_public_der_b64: ed25519.toString("base64"),
      ed25519_fingerprint_sha256: sha256(ed25519),
      ren_x25519_fingerprint_sha256: this.renTransport.x25519Fingerprint,
      ren_ed25519_fingerprint_sha256: this.renTransport.ed25519Fingerprint,
    };
  }

  sealForRen(payload, context) {
    if (containsCredential(payload)) throw new Error("REN_HANDOFF_CONTAINS_CREDENTIAL");
    const shared = crypto.diffieHellman({
      privateKey: this.tolaTransport.x25519.privateKey,
      publicKey: this.renTransport.x25519PublicKey,
    });
    const iv = crypto.randomBytes(12);
    const aad = stable({ protocol: REN_TRANSPORT_PROTOCOL, context, sender: "TOLA_WHATSAPP", recipient: "MUSE_REN" });
    const cipher = crypto.createCipheriv("aes-256-gcm", transportKey(shared, aad), iv);
    cipher.setAAD(Buffer.from(aad));
    const ciphertext = Buffer.concat([cipher.update(Buffer.from(stable(payload))), cipher.final()]);
    const unsigned = {
      protocol: REN_TRANSPORT_PROTOCOL,
      sender: "TOLA_WHATSAPP",
      recipient: "MUSE_REN",
      context,
      aad_sha256: sha256(aad),
      iv_b64: iv.toString("base64"),
      ciphertext_b64: ciphertext.toString("base64"),
      tag_b64: cipher.getAuthTag().toString("base64"),
      tola_ed25519_fingerprint_sha256: this.tolaTransportInfo().ed25519_fingerprint_sha256,
    };
    return {
      ...unsigned,
      signature_b64: crypto.sign(null, Buffer.from(stable(unsigned)), this.tolaTransport.ed25519.privateKey).toString("base64"),
    };
  }

  openFromRen(packet, context) {
    if (!packet || packet.protocol !== REN_TRANSPORT_PROTOCOL || packet.sender !== "MUSE_REN" || packet.recipient !== "TOLA_WHATSAPP" || packet.context !== context) {
      throw new Error("REN_TRANSPORT_ENVELOPE_INVALID");
    }
    const { signature_b64: signature, ...unsigned } = packet;
    if (!signature || !crypto.verify(null, Buffer.from(stable(unsigned)), this.renTransport.ed25519PublicKey, Buffer.from(signature, "base64"))) {
      throw new Error("REN_TRANSPORT_SIGNATURE_INVALID");
    }
    const aad = stable({ protocol: REN_TRANSPORT_PROTOCOL, context, sender: "MUSE_REN", recipient: "TOLA_WHATSAPP" });
    if (packet.aad_sha256 !== sha256(aad)) throw new Error("REN_TRANSPORT_AAD_INVALID");
    const shared = crypto.diffieHellman({
      privateKey: this.tolaTransport.x25519.privateKey,
      publicKey: this.renTransport.x25519PublicKey,
    });
    const decipher = crypto.createDecipheriv("aes-256-gcm", transportKey(shared, aad), Buffer.from(packet.iv_b64, "base64"));
    decipher.setAAD(Buffer.from(aad));
    decipher.setAuthTag(Buffer.from(packet.tag_b64, "base64"));
    return JSON.parse(Buffer.concat([
      decipher.update(Buffer.from(packet.ciphertext_b64, "base64")),
      decipher.final(),
    ]).toString("utf8"));
  }

  renHttpAuthorized(request) {
    const timestamp = Number(request.headers["x-ren-timestamp"]);
    const nonce = String(request.headers["x-ren-nonce"] || "");
    const signature = String(request.headers["x-ren-signature"] || "");
    if (!Number.isSafeInteger(timestamp) || Math.abs(Date.now() - timestamp) > MAX_FRESHNESS_MS) return false;
    if (!/^[a-f0-9-]{16,80}$/i.test(nonce) || !signature) return false;
    const bodyHash = sha256(stable(request.body || {}));
    const canonical = [String(request.method || "").toUpperCase(), String(request.originalUrl || request.url || ""), String(timestamp), nonce, bodyHash].join("\n");
    try {
      return crypto.verify(null, Buffer.from(canonical), this.renTransport.ed25519PublicKey, Buffer.from(signature, "base64"));
    } catch {
      return false;
    }
  }

  renEnvelope(source, ids) {
    const reference = source.constraints.whatsapp_reference;
    const createdAt = now();
    return {
      schema: "TOLA_REN_HANDOFF_V1",
      A2A_ID: ids.a2aId,
      OPPORTUNITY_ID: ids.opportunityId,
      WANT_ID: ids.wantId,
      TASK_ID: ids.taskId,
      TRANSACTION_ID: ids.transactionId,
      producer_identity: "TOLA_WHATSAPP",
      recipient_identity: "MUSE_REN",
      requester: {
        identity_type: "WHATSAPP_PERSON",
        participant_id: reference.participant_id,
        profile_name: reference.profile_name || null,
      },
      WANT: source.intent,
      RELATIONSHIP_ID: reference.relationship_id,
      CHANNEL_THREAD_ID: reference.thread_id,
      inbound_provider_message_id: reference.message_id,
      return_destination: {
        identity: "TOLA_WHATSAPP",
        channel: "whatsapp",
        participant_id: reference.participant_id,
        relationship_id: reference.relationship_id,
        channel_thread_id: reference.thread_id,
      },
      CANON_REVISION: this.canonRevision,
      created_at: createdAt,
      ttl_ms: MAX_TTL_MS,
      action_class: "RESOLVE",
      idempotency_key: `ren:handoff:${ids.a2aId}`,
      payload_ref: { kind: "JOB_INTENT", job_id: source.job_id, sha256: sha256(source.intent) },
      PAI: {
        identity: "TOLA_WHATSAPP",
        authorized: false,
        scopes: ["PRIVATE_WANT_HANDOFF"],
        note: "No Damon authority inferred. Consequential effects require current exact PAI/authority in REN.",
      },
      authority: {
        source_identity: "WHATSAPP_PERSON",
        authorized_scopes: ["PRIVATE_WANT_HANDOFF", "WHATSAPP_PRIVATE_REPLY"],
        denied_effects: ["impersonate_damon", "bulk_outreach", "public_distribution", "spending", "payment", "contract", "signature"],
      },
      next_action: "MUSE_REN_COORDINATE_EXISTING_ESTATE_AND_RETURN_VERIFIED_RESULT",
    };
  }

  validateRenEnvelope(envelope, source) {
    for (const key of ["A2A_ID", "OPPORTUNITY_ID", "WANT_ID", "TASK_ID", "TRANSACTION_ID", "WANT", "RELATIONSHIP_ID", "CHANNEL_THREAD_ID", "inbound_provider_message_id", "producer_identity", "recipient_identity", "CANON_REVISION", "created_at", "ttl_ms", "idempotency_key", "payload_ref", "requester", "return_destination", "PAI", "authority"]) {
      if (envelope?.[key] === undefined || envelope[key] === null || envelope[key] === "") throw new Error(`REN_HANDOFF_FIELD_REQUIRED:${key}`);
    }
    if (containsCredential(envelope)) throw new Error("REN_HANDOFF_CONTAINS_CREDENTIAL");
    if (envelope.producer_identity !== "TOLA_WHATSAPP" || envelope.recipient_identity !== "MUSE_REN") throw new Error("REN_HANDOFF_IDENTITY_INVALID");
    if (envelope.CANON_REVISION !== this.canonRevision) throw new Error("REN_HANDOFF_CANON_STALE");
    if (envelope.idempotency_key !== `ren:handoff:${envelope.A2A_ID}`) throw new Error("REN_HANDOFF_IDEMPOTENCY_INVALID");
    if (envelope.requester.identity_type !== "WHATSAPP_PERSON" || envelope.requester.participant_id !== source.constraints.whatsapp_reference.participant_id) throw new Error("REN_HANDOFF_REQUESTER_INVALID");
    if (envelope.requester.identity_type === "DAMON" || envelope.PAI.identity === "DAMON") throw new Error("REN_HANDOFF_AUTHORITY_ESCALATION");
    if (envelope.RELATIONSHIP_ID !== source.constraints.whatsapp_reference.relationship_id || envelope.CHANNEL_THREAD_ID !== source.constraints.whatsapp_reference.thread_id) throw new Error("REN_HANDOFF_CONTINUITY_INVALID");
    if (envelope.return_destination.relationship_id !== envelope.RELATIONSHIP_ID || envelope.return_destination.channel_thread_id !== envelope.CHANNEL_THREAD_ID) throw new Error("REN_HANDOFF_RETURN_DESTINATION_INVALID");
    if (envelope.payload_ref.job_id !== source.job_id || envelope.payload_ref.sha256 !== sha256(source.intent)) throw new Error("REN_HANDOFF_PAYLOAD_INVALID");
    const created = Date.parse(envelope.created_at);
    if (!Number.isFinite(created) || Date.now() - created > MAX_FRESHNESS_MS || Date.now() >= created + Number(envelope.ttl_ms)) throw new Error("REN_HANDOFF_STALE");
    return true;
  }

  validateRenCompletion(completion, work) {
    if (!completion || !REN_RESULT_STATES.has(completion.status)) throw new Error("REN_RESULT_STATE_INVALID");
    if (completion.TASK_ID !== work.result?.TASK_ID || completion.A2A_ID !== work.result?.A2A_ID) throw new Error("REN_RESULT_CONTINUITY_INVALID");
    if (completion.producer_identity !== "MUSE_REN" || completion.recipient_identity !== "TOLA_WHATSAPP") throw new Error("REN_RESULT_IDENTITY_INVALID");
    if (completion.CANON_REVISION !== this.canonRevision) throw new Error("REN_RESULT_CANON_STALE");
    if (!completion.execution_id || !completion.completed_at || !completion.receipt?.receipt_id || !Array.isArray(completion.evidence)) throw new Error("REN_RESULT_EXECUTION_PROOF_REQUIRED");
    const completedAt = Date.parse(completion.completed_at);
    if (!Number.isFinite(completedAt) || completedAt < Date.parse(work.created_at) || completedAt > Date.now() + 30000) throw new Error("REN_RESULT_TIMESTAMP_INVALID");
    if (!new Set(["COMPLETED", "BLOCKED"]).has(completion.receipt.status)) throw new Error("REN_RESULT_RECEIPT_STATUS_INVALID");
    if (completion.evidence.length > 100) throw new Error("REN_RESULT_EVIDENCE_LIMIT_EXCEEDED");
    if (!completion.evidence.some(item => item?.verified === true && !/ACK|ACCEPT/i.test(String(item.type || "")))) throw new Error("REN_RESULT_VERIFIED_EXECUTION_EVIDENCE_REQUIRED");
    if (typeof completion.result !== "string" || !completion.result.trim() || Buffer.byteLength(completion.result) > 65536) throw new Error("REN_RESULT_OUTPUT_REQUIRED");
    if (!/^NONE(?:_|$)/.test(String(completion.external_action_performed || "NONE")) && (!completion.authority_ref || !completion.PAI_ref)) throw new Error("REN_RESULT_CONSEQUENTIAL_AUTHORITY_EVIDENCE_REQUIRED");
    if (containsCredential(completion)) throw new Error("REN_RESULT_CONTAINS_CREDENTIAL");
    return true;
  }

  async sendRenAcceptance(source, work) {
    const reference = source.constraints.whatsapp_reference;
    const key = `whatsapp:ren-accepted:${shortHash(reference.action_id)}`;
    const prior = this.store.receipt(key);
    const action = prior?.status === "FAILED" ? this.store.retryFailedAction(source.job_id, key) : this.store.beginAction(source.job_id, key);
    if (!action.execute) return action.receipt?.result || null;
    try {
      const sent = await this.sendReply(reference, "I’m on it.");
      const result = {
        status: "TOLA_ACCEPTED",
        task_id: work.result.TASK_ID,
        A2A_ID: work.result.A2A_ID,
        inbound_provider_message_id: reference.message_id,
        outbound_provider_message_id: sent.provider_message_id,
        relationship_id: reference.relationship_id,
        channel_thread_id: reference.thread_id,
        delivery_state: "accepted",
      };
      const evidence = [{ type: "TOLA_WHATSAPP_ACCEPTANCE_SENT", verified: true, provider_message_id: sent.provider_message_id, at: now() }];
      this.store.finishAction(source.job_id, key, result, evidence);
      this.store.appendEffectOnce(`TOLA_REN:acceptance-delivery:${work.result.A2A_ID}`, "OUTBOUND_SENT", {
        job_id: source.job_id, opportunity_id: work.result.OPPORTUNITY_ID, want_id: work.result.WANT_ID,
        producer_identity: "TOLA_WHATSAPP", channel: "whatsapp", destination: reference.relationship_id,
        authority_state: "PRIVATE_ACCEPTANCE_ONLY", message_ref: { inbound_provider_message_id: reference.message_id, outbound_provider_message_id: sent.provider_message_id },
        evidence_ref: `whatsapp-acceptance:${sent.provider_message_id}`,
      });
      return result;
    } catch (error) {
      this.store.failAction(source.job_id, key, error);
      return null;
    }
  }

  async queueRenHandoff(source, ids) {
    const taskId = ids.taskId || `ren-task-${shortHash(ids.a2aId)}`;
    const envelope = this.renEnvelope(source, { ...ids, taskId });
    this.validateRenEnvelope(envelope, source);
    const created = this.store.createJob({
      parent_job_id: source.job_id,
      root_job_id: source.root_job_id,
      delta_id: ids.opportunityId,
      worker_type: "MUSE_REN_HANDOFF",
      owner: "MUSE_REN",
      intent: `Coordinate existing estate work for ${taskId}`,
      success_condition: "REN returns verified execution evidence and TOLA delivers the result to the original WhatsApp thread",
      idempotency_key: envelope.idempotency_key,
      priority: 95,
      state: "READY",
      started_at: null,
      completed_at: null,
      execution_attempted_at: null,
      max_attempts: 20,
      constraints: {
        actionable: true,
        ren_envelope: envelope,
        ren_envelope_hash: sha256(envelope),
        external_effects: "CURRENT_EXACT_AUTHORITY_AND_PAI_REQUIRED",
      },
      provenance: {
        source: "TOLA_REN_HANDOFF",
        producer_identity: "TOLA_WHATSAPP",
        recipient_identity: "MUSE_REN",
        canon_revision: this.canonRevision,
      },
      result: {
        status: "QUEUED_FOR_MUSE_REN",
        TASK_ID: taskId,
        A2A_ID: ids.a2aId,
        OPPORTUNITY_ID: ids.opportunityId,
        WANT_ID: ids.wantId,
        RELATIONSHIP_ID: envelope.RELATIONSHIP_ID,
        CHANNEL_THREAD_ID: envelope.CHANNEL_THREAD_ID,
        return_destination: envelope.return_destination,
      },
      checkpoint: { phase: "QUEUED", execution_count: 0, delivery_count: 0 },
    });
    if (!created.duplicate) {
      this.store.event(created.job.job_id, "REN_HANDOFF_QUEUED", { TASK_ID: taskId, A2A_ID: ids.a2aId, producer_identity: "TOLA_WHATSAPP", recipient_identity: "MUSE_REN" });
      this.store.appendEffectOnce(`TOLA_REN:queued:${ids.a2aId}`, "REN_HANDOFF_QUEUED", {
        job_id: created.job.job_id,
        opportunity_id: ids.opportunityId,
        want_id: ids.wantId,
        producer_identity: "TOLA_WHATSAPP",
        destination: "MUSE_REN",
        authority_state: "HANDOFF_ONLY_NO_AUTHORITY_EXPANSION",
        message_ref: { A2A_ID: ids.a2aId, TASK_ID: taskId, relationship_id: envelope.RELATIONSHIP_ID },
        evidence_ref: `ren-handoff:${sha256(envelope)}`,
      });
    }
    const updatedSource = this.store.updateJob(source.job_id, {
      result: { ...source.result, ren_handoff_job_id: created.job.job_id, TASK_ID: taskId, A2A_ID: ids.a2aId, OPPORTUNITY_ID: ids.opportunityId, WANT_ID: ids.wantId },
      checkpoint: { ...source.checkpoint, phase: "ACCEPTED", ren_handoff_job_id: created.job.job_id },
    });
    await this.sendRenAcceptance(updatedSource, created.job);
    return created.job;
  }

  recordRenAcceptance(work, acceptance) {
    if (!acceptance?.accepted || !acceptance.acceptance_id || acceptance.TASK_ID !== work.result.TASK_ID) throw new Error("REN_ACCEPTANCE_INVALID");
    const key = `ren:acceptance:${work.result.A2A_ID}`;
    const action = this.store.beginAction(work.job_id, key);
    if (!action.execute) return this.store.get(work.job_id);
    const result = { ...work.result, status: "ACCEPTED_BY_MUSE_REN", ren_acceptance_id: acceptance.acceptance_id, accepted_at: acceptance.accepted_at || now() };
    const evidence = [{ type: "REN_HANDOFF_ACCEPTED", verified: true, acceptance_id: acceptance.acceptance_id, task_id: work.result.TASK_ID, at: result.accepted_at }];
    this.store.finishAction(work.job_id, key, result, evidence);
    const updated = this.store.updateJob(work.job_id, { state: "WAITING_EXTERNAL", result, evidence: [...work.evidence, ...evidence], checkpoint: { ...work.checkpoint, phase: "ACCEPTED_BY_REN" } });
    this.store.appendEffectOnce(`TOLA_REN:accepted:${work.result.A2A_ID}`, "REN_HANDOFF_ACCEPTED", {
      job_id: work.job_id, opportunity_id: work.result.OPPORTUNITY_ID, want_id: work.result.WANT_ID,
      producer_identity: "MUSE_REN", destination: "TOLA_WHATSAPP", authority_state: "HANDOFF_ACCEPTED_NO_EXECUTION_CLAIM",
      message_ref: { A2A_ID: work.result.A2A_ID, TASK_ID: work.result.TASK_ID, acceptance_id: acceptance.acceptance_id },
      evidence_ref: `ren-acceptance:${acceptance.acceptance_id}`,
    });
    return updated;
  }

  recordRenCompletion(work, completion) {
    this.validateRenCompletion(completion, work);
    const key = `ren:result:${work.result.A2A_ID}`;
    const action = this.store.beginAction(work.job_id, key);
    if (!action.execute) return this.store.get(work.job_id);
    const result = { ...work.result, status: completion.status, ren_completion: completion, result_ref: `ren:result:${completion.execution_id}` };
    const evidence = [{ type: "REN_VERIFIED_WORK_COMPLETION", verified: true, execution_id: completion.execution_id, receipt_id: completion.receipt.receipt_id, at: completion.completed_at }, ...completion.evidence];
    this.store.finishAction(work.job_id, key, result, evidence);
    const updated = this.store.updateJob(work.job_id, {
      state: "COMPLETED", completed_at: completion.completed_at, result, evidence: [...work.evidence, ...evidence],
      terminal_state: completion.status === "COMPLETED" ? "EXECUTED" : "WAITING_DEPENDENCY",
      terminal_evidence: { executor_invoked: "MUSE_REN", execution_id: completion.execution_id, external_action_performed: completion.external_action_performed || "NONE_OR_AS_EVIDENCED", authority_result: completion.authority_state || "CURRENT_AUTHORITY_CHECKED" },
      checkpoint: { ...work.checkpoint, phase: "WORK_COMPLETED", execution_count: 1 },
    });
    this.store.appendEffectOnce(`TOLA_REN:completed:${work.result.A2A_ID}`, "REN_WORK_COMPLETED", {
      job_id: work.job_id, opportunity_id: work.result.OPPORTUNITY_ID, want_id: work.result.WANT_ID,
      producer_identity: "MUSE_REN", destination: "TOLA_WHATSAPP", authority_state: completion.authority_state || "CURRENT_AUTHORITY_CHECKED",
      message_ref: { A2A_ID: work.result.A2A_ID, TASK_ID: work.result.TASK_ID, execution_id: completion.execution_id, receipt_id: completion.receipt.receipt_id },
      evidence_ref: `ren-result:${completion.execution_id}`,
    });
    return updated;
  }

  async deliverRenResult(work) {
    const completion = work.result?.ren_completion;
    if (!completion) return null;
    const source = this.store.get(work.parent_job_id);
    if (!source) throw new Error("REN_RESULT_SOURCE_JOB_MISSING");
    const reference = source.constraints.whatsapp_reference;
    const key = `whatsapp:ren-result:${shortHash(reference.action_id)}`;
    const prior = this.store.receipt(key);
    const action = prior?.status === "FAILED" ? this.store.retryFailedAction(source.job_id, key) : this.store.beginAction(source.job_id, key);
    if (!action.execute) return action.receipt?.result || prior?.result || null;
    try {
      const sent = await this.sendReply(reference, normalizeReply(completion.result, "The work is complete."));
      const result = {
        status: "REN_RESULT_DELIVERED",
        task_id: work.result.TASK_ID,
        A2A_ID: work.result.A2A_ID,
        OPPORTUNITY_ID: work.result.OPPORTUNITY_ID,
        WANT_ID: work.result.WANT_ID,
        ren_execution_id: completion.execution_id,
        ren_receipt_id: completion.receipt.receipt_id,
        inbound_provider_message_id: reference.message_id,
        outbound_provider_message_id: sent.provider_message_id,
        relationship_id: reference.relationship_id,
        channel_thread_id: reference.thread_id,
        delivery_state: "accepted",
      };
      const evidence = [{ type: "TOLA_REN_RESULT_DELIVERED", verified: true, execution_id: completion.execution_id, provider_message_id: sent.provider_message_id, relationship_id: reference.relationship_id, at: now() }];
      this.store.finishAction(source.job_id, key, result, evidence);
      this.store.updateJob(source.job_id, {
        result: { ...source.result, outbound: result, outbound_receipt_id: key },
        evidence: [...source.evidence, ...evidence],
        checkpoint: { ...source.checkpoint, phase: "RESULT_DELIVERED", delivery_count: 1 },
      });
      this.store.updateJob(work.job_id, { checkpoint: { ...work.checkpoint, phase: "RESULT_DELIVERED", delivery_count: 1 } });
      this.store.appendEffectOnce(`TOLA_REN:delivered:${work.result.A2A_ID}`, "OUTBOUND_SENT", {
        job_id: source.job_id, opportunity_id: work.result.OPPORTUNITY_ID, want_id: work.result.WANT_ID,
        producer_identity: "TOLA_WHATSAPP", channel: "whatsapp", destination: reference.relationship_id,
        counterparty: "TOLA", authority_state: "EXACT_PRIVATE_RESULT_RETURN_AUTHORIZED",
        message_ref: { inbound_provider_message_id: reference.message_id, outbound_provider_message_id: sent.provider_message_id, A2A_ID: work.result.A2A_ID, TASK_ID: work.result.TASK_ID },
        evidence_ref: `whatsapp-ren-result:${sent.provider_message_id}`,
      });
      return result;
    } catch (error) {
      this.store.failAction(source.job_id, key, error);
      this.store.updateJob(work.job_id, { checkpoint: { ...work.checkpoint, phase: "DELIVERY_RETRY_PENDING", execution_count: 1, delivery_count: 0, last_delivery_error: safeError(error) } });
      return null;
    }
  }

  async recoverRenTransactions() {
    const outcomes = [];
    const jobs = this.store.list("MUSE_REN_HANDOFF");
    for (let work of jobs) {
      if (work.state === "READY" && this.renAdapter) {
        const key = `ren:submit:${work.result.A2A_ID}`;
        const prior = this.store.receipt(key);
        const action = prior?.status === "FAILED" ? this.store.retryFailedAction(work.job_id, key) : this.store.beginAction(work.job_id, key);
        if (action.execute) {
          try {
            const acceptance = await this.renAdapter.submit(work.constraints.ren_envelope);
            this.store.finishAction(work.job_id, key, acceptance, [{ type: "REN_TRANSPORT_SUBMIT", verified: true, acceptance_id: acceptance?.acceptance_id || null, at: now() }]);
            work = this.recordRenAcceptance(this.store.get(work.job_id), acceptance);
          } catch (error) {
            this.store.failAction(work.job_id, key, error);
            this.store.updateJob(work.job_id, { state: "WAITING_EXTERNAL", checkpoint: { ...work.checkpoint, phase: "REN_TRANSPORT_RETRY_PENDING", last_transport_error: safeError(error) } });
            outcomes.push({ task_id: work.result.TASK_ID, state: "WAITING_EXTERNAL", error: safeError(error) });
            continue;
          }
        }
      }
      work = this.store.get(work.job_id);
      if (["READY", "WAITING_EXTERNAL"].includes(work.state) && this.renAdapter) {
        const completion = await this.renAdapter.status(work.result.TASK_ID, work.constraints.ren_envelope);
        if (completion) work = this.recordRenCompletion(work, completion);
      }
      if (work.state === "COMPLETED" && work.result?.ren_completion) {
        const delivered = await this.deliverRenResult(work);
        outcomes.push({ task_id: work.result.TASK_ID, state: delivered ? "RESULT_DELIVERED" : "DELIVERY_PENDING" });
      } else {
        outcomes.push({ task_id: work.result.TASK_ID, state: work.state });
      }
    }
    return outcomes;
  }

  mount() {
    this.app.get("/tola-cloud/health", (_request, response) => {
      const cloud = this.store.availability("OPENAI_COMMAND_TOWER_RUNTIME", 90000);
      response.json({
        ok: true,
        service: "TOLA",
        enabled: this.enabled,
        state_dir_persistent: isMountedPath(this.stateDir),
        status: this.enabled ? cloud.state : "STAGED_DISABLED",
        last_poll_at: this.lastPollAt,
        tola_contract_revision: TOLA_BEHAVIOR_CONTRACT_REVISION,
        private_media_execution: true,
        muse_runtime: {
          available: this.museCapabilities().authenticated,
          state: this.museCapabilities().state,
        },
        genuine_video_generation: this.publicVideoAvailability(),
        ren_transport: {
          protocol: REN_TRANSPORT_PROTOCOL,
          state: this.renAdapter ? "ADAPTER_CONNECTED" : "AWAITING_REN_RECEIVER_POLL",
          queued: this.store.list("MUSE_REN_HANDOFF").filter(job => ["READY", "WAITING_EXTERNAL"].includes(job.state)).length,
          completed_awaiting_delivery: this.store.list("MUSE_REN_HANDOFF").filter(job => job.state === "COMPLETED" && job.checkpoint?.phase !== "RESULT_DELIVERED").length,
        },
        quoted_reply_context: false,
      });
    });

    this.app.get("/tola-cloud/ren/transport", (_request, response) => {
      response.json({ ok: true, ...this.tolaTransportInfo(), task_route: "/tola-cloud/ren/tasks", result_route: "/tola-cloud/ren/tasks/:taskId/result" });
    });

    this.app.get("/tola-cloud/ren/tasks", (request, response) => {
      if (!this.renHttpAuthorized(request)) return response.status(401).json({ ok: false, error: "REN_SIGNATURE_REQUIRED" });
      const pending = this.store.list("MUSE_REN_HANDOFF")
        .filter(job => ["READY", "WAITING_EXTERNAL"].includes(job.state))
        .slice(0, 20)
        .map(job => ({
          task_id: job.result.TASK_ID,
          A2A_ID: job.result.A2A_ID,
          state: job.state,
          envelope: this.sealForRen(job.constraints.ren_envelope, `task:${job.result.TASK_ID}`),
        }));
      response.json({ ok: true, protocol: REN_TRANSPORT_PROTOCOL, tasks: pending });
    });

    this.app.post("/tola-cloud/ren/tasks/:taskId/acceptance", (request, response) => {
      if (!this.renHttpAuthorized(request)) return response.status(401).json({ ok: false, error: "REN_SIGNATURE_REQUIRED" });
      try {
        const work = this.store.list("MUSE_REN_HANDOFF").find(job => job.result?.TASK_ID === request.params.taskId);
        if (!work) return response.status(404).json({ ok: false, error: "TASK_NOT_FOUND" });
        const acceptance = this.openFromRen(request.body, `acceptance:${request.params.taskId}`);
        const updated = this.recordRenAcceptance(work, acceptance);
        response.json({ ok: true, duplicate: updated.result?.ren_acceptance_id === work.result?.ren_acceptance_id, task_id: request.params.taskId, state: updated.state });
      } catch (error) {
        response.status(400).json({ ok: false, error: safeError(error) });
      }
    });

    this.app.post("/tola-cloud/ren/tasks/:taskId/result", async (request, response) => {
      if (!this.renHttpAuthorized(request)) return response.status(401).json({ ok: false, error: "REN_SIGNATURE_REQUIRED" });
      try {
        let work = this.store.list("MUSE_REN_HANDOFF").find(job => job.result?.TASK_ID === request.params.taskId);
        if (!work) return response.status(404).json({ ok: false, error: "TASK_NOT_FOUND" });
        if (!this.store.receipt(`ren:acceptance:${work.result.A2A_ID}`)) return response.status(409).json({ ok: false, error: "REN_ACCEPTANCE_REQUIRED" });
        const completion = this.openFromRen(request.body, `result:${request.params.taskId}`);
        const prior = this.store.receipt(`ren:result:${work.result.A2A_ID}`);
        work = this.recordRenCompletion(work, completion);
        const delivered = await this.deliverRenResult(work);
        response.json({ ok: true, duplicate: Boolean(prior), task_id: request.params.taskId, state: delivered ? "RESULT_DELIVERED" : "DELIVERY_PENDING" });
      } catch (error) {
        response.status(400).json({ ok: false, error: safeError(error) });
      }
    });

    this.app.get("/tola-cloud/receipt/:a2aId", (request, response) => {
      if (!this.adminAuthorized(request)) return response.status(401).json({ ok: false, error: "UNAUTHORIZED" });
      const job = this.store.getByIdempotency(`a2a:${request.params.a2aId}`);
      if (!job) return response.status(404).json({ ok: false, error: "NOT_FOUND" });
      const envelope = job.constraints?.a2a_envelope || {};
      const source = this.store.get(envelope.payload_ref?.job_id);
      const outbound = source ? this.store.receipt(source.result?.outbound_receipt_id || `whatsapp:send:${source.constraints?.whatsapp_reference?.agent_id}:${shortHash(source.constraints?.whatsapp_reference?.action_id || "")}`) : null;
      const receiptCounts = {
        source_job: source ? Number(this.store.db.prepare("SELECT COUNT(*) count FROM action_receipts WHERE job_id=?").get(source.job_id)?.count || 0) : 0,
        reasoning_job: Number(this.store.db.prepare("SELECT COUNT(*) count FROM action_receipts WHERE job_id=?").get(job.job_id)?.count || 0),
      };
      receiptCounts.total = receiptCounts.source_job + receiptCounts.reasoning_job;
      const effects = fs.existsSync(this.store.effectsFile)
        ? fs.readFileSync(this.store.effectsFile, "utf8").split(/\r?\n/).filter(Boolean).map(line => parse(line, null)).filter(event => event && [job.job_id, source?.job_id].includes(event.job_id))
        : [];
      response.json({
        ok: true,
        job,
        source,
        outbound,
        receipt_counts: receiptCounts,
        effects,
        events: this.store.db.prepare("SELECT * FROM job_events WHERE job_id IN (?,?) ORDER BY event_id").all(job.job_id, source?.job_id || ""),
      });
    });

    this.app.get("/tola-cloud/admin/recent", (request, response) => {
      if (!this.adminAuthorized(request)) return response.status(401).json({ ok: false, error: "UNAUTHORIZED" });
      const requested = Number.parseInt(String(request.query?.limit || "10"), 10);
      const limit = Number.isSafeInteger(requested) ? Math.max(1, Math.min(50, requested)) : 10;
      const rows = this.store.db.prepare("SELECT job_id,created_at,updated_at,constraints,result,checkpoint FROM jobs WHERE worker_type='TOLA_WHATSAPP_INBOUND' ORDER BY created_at DESC LIMIT ?").all(limit);
      const transactions = rows.map(row => {
        const constraints = parse(row.constraints, {});
        const result = parse(row.result, {});
        const checkpoint = parse(row.checkpoint, {});
        const reference = constraints.whatsapp_reference || {};
        const reasoning = this.store.db.prepare("SELECT job_id,result FROM jobs WHERE parent_job_id=? AND worker_type='A2A_COMMAND_TOWER' ORDER BY created_at DESC LIMIT 1").get(row.job_id);
        const reasoningResult = parse(reasoning?.result, {});
        const outbound = result.outbound || {};
        return {
          received_at: row.created_at,
          updated_at: row.updated_at,
          provider_agent_id: reference.agent_id || null,
          inbound_provider_message_id: reference.message_id || result.inbound_message_id || null,
          participant_id: reference.participant_id || null,
          relationship_id: reference.relationship_id || result.relationship_id || null,
          channel_thread_id: reference.thread_id || outbound.channel_thread_id || null,
          A2A_ID: outbound.A2A_ID || reasoningResult.A2A_ID || result.A2A_ID || null,
          OPPORTUNITY_ID: outbound.OPPORTUNITY_ID || reasoningResult.OPPORTUNITY_ID || result.OPPORTUNITY_ID || null,
          WANT_ID: outbound.WANT_ID || reasoningResult.WANT_ID || result.WANT_ID || null,
          job_id: row.job_id,
          reasoning_job_id: reasoning?.job_id || outbound.reasoning_job_id || null,
          openai_response_id: reasoningResult.openai_response_id || outbound.openai_response_id || null,
          reasoning_result_ref: reasoningResult.reasoning_result_ref || outbound.reasoning_result_ref || null,
          receipt_id: result.outbound_receipt_id || outbound.receipt_id || null,
          outbound_provider_message_id: outbound.outbound_provider_message_id || null,
          delivery_state: outbound.delivery_state || null,
          duplicate_count: Number(checkpoint.duplicate_count || 0),
        };
      });
      response.json({
        ok: true,
        chairman_local: this.store.availability("CHAIRMAN_LOCAL"),
        cursor_updated_at: this.cursor.updated_at,
        transactions,
      });
    });

    this.app.post("/tola-cloud/admin/replay", async (request, response) => {
      if (!this.adminAuthorized(request)) return response.status(401).json({ ok: false, error: "UNAUTHORIZED" });
      try {
        const outcome = await this.processPayload(request.body?.payload || {});
        response.json({ ok: true, outcome });
      } catch (error) {
        response.status(400).json({ ok: false, error: safeError(error) });
      }
    });

    this.app.post("/tola-cloud/admin/import", (request, response) => {
      if (!this.adminAuthorized(request)) return response.status(401).json({ ok: false, error: "UNAUTHORIZED" });
      const rows = Array.isArray(request.body?.completed_receipts) ? request.body.completed_receipts : [];
      let imported = 0;
      for (const row of rows.slice(0, 5000)) {
        if (!/^whatsapp:|^a2a:/.test(String(row?.idempotency_key || ""))) continue;
        if (this.store.receipt(row.idempotency_key)) continue;
        const jobId = String(row.job_id || `import_${shortHash(row.idempotency_key)}`);
        const existing = this.store.get(jobId);
        if (!existing) this.store.createJob({
          job_id: jobId,
          worker_type: "HISTORICAL_TOLA_RECEIPT_IMPORT",
          owner: "TOLA_WHATSAPP",
          intent: "Preserve completed pre-cloud TOLA transaction lineage",
          success_condition: "Historical receipt is visible to cloud replay suppression",
          idempotency_key: `historical:${row.idempotency_key}`,
          constraints: { actionable: false, source_receipt: row.idempotency_key },
          result: { imported: true, original_idempotency_key: row.idempotency_key, terminal_state: "EXECUTED" },
          terminal_state: "EXECUTED",
        });
        this.store.db.prepare("INSERT OR IGNORE INTO action_receipts VALUES(?,?,?,?,?,?,?)")
          .run(row.idempotency_key, jobId, "COMPLETED", JSON.stringify(row.evidence || []), JSON.stringify(row.result || {}), row.created_at || now(), row.completed_at || now());
        imported += 1;
      }
      this.store.appendEffect("STATE_RECONCILED", { source: "CHAIRMAN_LOCAL", imported_receipts: imported, evidence_ref: `reconcile:${sha256(rows.map(row => row.idempotency_key))}` });
      response.json({ ok: true, imported, duplicate: rows.length - imported });
    });

    this.app.post("/tola-cloud/local/heartbeat", (request, response) => {
      if (!this.localAuthorized(request)) return response.status(401).json({ ok: false, error: "UNAUTHORIZED" });
      const body = request.body || {};
      const canonMatch = body.canon_revision === this.canonRevision;
      const state = body.available === false ? "OFFLINE" : canonMatch ? "ONLINE" : "DEGRADED";
      this.store.heartbeat("CHAIRMAN_LOCAL", state, {
        available: body.available !== false,
        canon_revision: body.canon_revision || null,
        canon_match: canonMatch,
        receipt_high_watermark: body.receipt_high_watermark || null,
      });
      response.json({ ok: true, chairman_local: this.store.availability("CHAIRMAN_LOCAL"), canon_revision: this.canonRevision });
    });

    this.app.post("/tola-cloud/local/reconcile", (request, response) => {
      if (!this.localAuthorized(request)) return response.status(401).json({ ok: false, error: "UNAUTHORIZED" });
      const keys = Array.isArray(request.body?.idempotency_keys) ? request.body.idempotency_keys.map(String).slice(0, 5000) : [];
      const completed = keys.filter(key => this.store.receipt(key)?.status === "COMPLETED");
      const cloudCompletedReceipts = this.store.db.prepare("SELECT idempotency_key,job_id,created_at,completed_at FROM action_receipts WHERE status='COMPLETED' AND (idempotency_key LIKE 'whatsapp:%' OR idempotency_key LIKE 'a2a:%') ORDER BY completed_at DESC LIMIT 5000").all();
      const receiptId = `local-reconcile:${sha256(keys).slice(0, 40)}`;
      const result = {
        completed,
        incomplete: keys.filter(key => !completed.includes(key)),
        cloud_completed_receipts: cloudCompletedReceipts,
        duplicate_execution_count: 0,
        reconciled_at: now(),
      };
      const job = this.store.createJob({
        worker_type: "CHAIRMAN_LOCAL_RECONCILIATION",
        owner: "CHAIRMAN_LOCAL",
        intent: "Reconcile local participation against cloud-completed transaction receipts",
        success_condition: "Completed effects are not repeated",
        idempotency_key: receiptId,
        constraints: { actionable: false, key_count: keys.length },
        result: { ...result, terminal_state: "EXECUTED" },
        terminal_state: "EXECUTED",
      }).job;
      const action = this.store.beginAction(job.job_id, receiptId);
      if (action.execute) this.store.finishAction(job.job_id, receiptId, result, [{ type: "CLOUD_RECEIPT_RECONCILIATION", verified: true, duplicate_execution_count: 0 }]);
      response.json({ ok: true, ...result, receipt_id: receiptId, duplicate: !action.execute });
    });
  }

  adminAuthorized(request) {
    return this.adminToken && crypto.timingSafeEqual(Buffer.from(sha256(bearer(request))), Buffer.from(sha256(this.adminToken)));
  }

  localAuthorized(request) {
    return this.localNodeToken && crypto.timingSafeEqual(Buffer.from(sha256(bearer(request))), Buffer.from(sha256(this.localNodeToken)));
  }

  async provider(resource, { method = "GET", body, timeoutMs = 45000 } = {}) {
    let response;
    try {
      response = await this.fetch(`${PROVIDER_BASE}${resource}`, {
        method,
        headers: { authorization: `Bearer ${this.token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch { throw new Error("WHATSAPP_AGENT_TRANSPORT_FAILED"); }
    if (response.status === 204) return { status: 204, body: null };
    let parsed = null;
    try { parsed = await response.json(); } catch {}
    if (!response.ok) throw new Error(`WHATSAPP_AGENT_${response.status}:${String(parsed?.error?.code || "UNKNOWN").slice(0, 40)}`);
    return { status: response.status, body: parsed };
  }

  reference(agentId, message, profileName = null) {
    if (!/^\d+$/.test(String(agentId || ""))) throw new Error("WHATSAPP_AGENT_ID_INVALID");
    if (!/^user:\d+$/.test(String(message?.from || ""))) throw new Error("WHATSAPP_PARTICIPANT_ID_INVALID");
    if (!/^wamid\./.test(String(message?.id || ""))) throw new Error("WHATSAPP_MESSAGE_ID_INVALID");
    const media = MEDIA_TYPES.has(message.type) ? message?.[message.type] : null;
    const mediaIdentity = media?.id ? shortHash(`${message.type}:${media.id}:${media.sha256 || ""}`) : null;
    const actionId = `whatsapp:inbound:${agentId}:${sha256(mediaIdentity ? `${message.id}:${mediaIdentity}:cloud-media-v1` : message.id)}`;
    return {
      provider: "WHATSAPP_AGENT_PLATFORM", channel: "whatsapp", account_identity: "TOLA",
      producer_identity: "TOLA_WHATSAPP", agent_id: String(agentId), participant_id: String(message.from),
      profile_name: profileName, thread_id: String(message.from),
      relationship_id: `whatsapp-thread:${shortHash(`${agentId}:${message.from}`)}`,
      message_id: String(message.id), reply_context_message_id: String(message.id),
      action_id: actionId, media_identity_hash: mediaIdentity,
    };
  }

  intentFor(message) {
    if (message.type === "text") return String(message.text?.body || "").trim().slice(0, 32000);
    const media = message?.[message.type] || {};
    const caption = typeof media.caption === "string" ? media.caption.trim() : "";
    return `${caption ? `${caption}\n\n` : ""}[Private WhatsApp ${String(message.type || "unknown")} attached.]`.slice(0, 32000);
  }

  async fetchMedia(message) {
    if (!MEDIA_TYPES.has(message?.type)) return null;
    const source = message[message.type] || {};
    if (typeof source.id !== "string" || !source.id) throw new Error("WHATSAPP_MEDIA_ID_INVALID");
    const declaredMime = String(source.mime_type || "").toLowerCase();
    const meta = (await this.provider(`/media/${encodeURIComponent(source.id)}`, { timeoutMs: 30000 })).body || {};
    const mimeType = String(meta.mime_type || "").toLowerCase();
    const size = Number(meta.file_size);
    if (!mimeType || mimeType !== declaredMime) throw new Error("WHATSAPP_MEDIA_MIME_MISMATCH");
    if (!Number.isSafeInteger(size) || size <= 0 || size > MEDIA_LIMITS[message.type]) throw new Error(`WHATSAPP_MEDIA_SIZE_INVALID:${message.type}`);
    const url = new URL(meta.url);
    if (url.protocol !== "https:" || url.username || url.password || !["whatsapp.com", "whatsapp.net", "facebook.com", "fbcdn.net", "fbsbx.com"].some(domain => url.hostname === domain || url.hostname.endsWith(`.${domain}`))) {
      throw new Error("WHATSAPP_MEDIA_URL_DENIED");
    }
    const response = await this.fetch(url, {
      headers: { authorization: `Bearer ${this.token}` },
      redirect: "manual",
      signal: AbortSignal.timeout(60000),
    });
    if (response.status >= 300 && response.status < 400) throw new Error("WHATSAPP_MEDIA_REDIRECT_DENIED");
    if (!response.ok) throw new Error(`WHATSAPP_MEDIA_DOWNLOAD_${response.status}`);
    const contentLengthHeader = response.headers?.get?.("content-length");
    const contentLength = Number(contentLengthHeader);
    if (contentLengthHeader !== null && contentLengthHeader !== undefined && contentLengthHeader !== "" && Number.isFinite(contentLength) && contentLength !== size) {
      throw new Error("WHATSAPP_MEDIA_CONTENT_LENGTH_MISMATCH");
    }
    if (!response.body?.getReader) throw new Error("WHATSAPP_MEDIA_STREAM_UNAVAILABLE");
    const reader = response.body.getReader();
    const chunks = [];
    let received = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        const chunk = Buffer.from(value);
        received += chunk.length;
        if (received > size || received > MEDIA_LIMITS[message.type]) {
          await reader.cancel().catch(() => {});
          throw new Error("WHATSAPP_MEDIA_RESPONSE_SIZE_EXCEEDED");
        }
        chunks.push(chunk);
      }
    } finally {
      reader.releaseLock?.();
    }
    const bytes = Buffer.concat(chunks, received);
    if (bytes.length !== size) throw new Error("WHATSAPP_MEDIA_RESPONSE_SIZE_MISMATCH");
    const actual = sha256(bytes);
    const expected = String(meta.sha256 || source.sha256 || "").toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(expected) || actual !== expected) throw new Error("WHATSAPP_MEDIA_CONTENT_SHA256_MISMATCH");
    let processingPath = "UNAVAILABLE_MEDIA_FORMAT";
    if (message.type === "image" && IMAGE_MIME_TYPES.has(mimeType)) processingPath = "OPENAI_INPUT_IMAGE";
    else if (message.type === "document" && DOCUMENT_MIME_TYPES.has(mimeType)) processingPath = "OPENAI_INPUT_FILE";
    else if (message.type === "video") processingPath = this.metaModelKey ? "META_MUSE_MULTIMODAL_VIDEO_PENDING" : "VIDEO_CONTENT_PROCESSING_UNAVAILABLE";
    else if (message.type === "audio") processingPath = this.metaModelKey ? "META_MUSE_VOICE_TRANSCRIPTION_PENDING" : "AUDIO_CONTENT_PROCESSING_UNAVAILABLE";
    else if (message.type === "document") processingPath = "DOCUMENT_MIME_PROCESSING_UNAVAILABLE";
    return { type: message.type, mime_type: mimeType, size_bytes: bytes.length, sha256: actual, media_identity_hash: shortHash(`${message.type}:${source.id}:${actual}`), filename: String(source.filename || "attachment").slice(0, 120), processing_path: processingPath, bytes };
  }

  validateEnvelope(envelope, source) {
    for (const key of ["A2A_ID", "OPPORTUNITY_ID", "TRANSACTION_ID", "RELATIONSHIP_ID", "CHANNEL_THREAD_ID", "provider_message_id", "producer_identity", "recipient_identity", "CANON_REVISION", "created_at", "ttl_ms", "idempotency_key", "action_class", "payload_ref", "PAI", "authority", "surface_permission"]) {
      if (envelope?.[key] === undefined || envelope[key] === null || envelope[key] === "") throw new Error(`A2A_FIELD_REQUIRED:${key}`);
    }
    if (containsCredential(envelope)) throw new Error("A2A_ENVELOPE_CONTAINS_CREDENTIAL");
    if (!IDENTITIES.has(envelope.producer_identity)) throw new Error("A2A_PRODUCER_IDENTITY_UNKNOWN");
    if (envelope.recipient_identity !== "OPENAI_COMMAND_TOWER_RUNTIME") throw new Error("A2A_RECIPIENT_MISMATCH");
    if (envelope.CANON_REVISION !== this.canonRevision) throw new Error("A2A_CANON_REVISION_STALE");
    if (envelope.idempotency_key !== `a2a:${envelope.A2A_ID}`) throw new Error("A2A_IDEMPOTENCY_KEY_MISMATCH");
    if (!ACTION_CLASSES.has(envelope.action_class)) throw new Error("A2A_ACTION_CLASS_INVALID");
    const created = Date.parse(envelope.created_at), ttl = Number(envelope.ttl_ms), current = Date.now();
    if (!Number.isFinite(created) || created > current + 30000 || current - created > MAX_FRESHNESS_MS) throw new Error("A2A_TRANSACTION_STALE");
    if (!Number.isFinite(ttl) || ttl <= 0 || ttl > MAX_TTL_MS || current >= created + ttl) throw new Error("A2A_TRANSACTION_EXPIRED");
    if (envelope.PAI?.identity !== envelope.producer_identity || !hasScope(envelope.PAI?.scopes, "A2A_REASONING")) throw new Error("A2A_PAI_REASONING_SCOPE_REQUIRED");
    if (!hasScope(envelope.authority?.scopes, "A2A_REASONING")) throw new Error("A2A_AUTHORITY_REASONING_SCOPE_REQUIRED");
    if (!["THINK", "RESOLVE"].includes(envelope.action_class)) throw new Error(`A2A_${envelope.action_class}_AUTHORITY_REQUIRED`);
    if (envelope.surface_permission !== "WHATSAPP_PRIVATE_SAME_THREAD") throw new Error("A2A_SURFACE_PERMISSION_DENIED");
    if (envelope.RELATIONSHIP_ID !== source.constraints.whatsapp_reference.relationship_id || envelope.CHANNEL_THREAD_ID !== source.constraints.whatsapp_reference.thread_id || envelope.provider_message_id !== source.constraints.whatsapp_reference.message_id) throw new Error("A2A_SURFACE_SCOPE_MISMATCH");
    if (envelope.payload_ref.kind !== "JOB_INTENT" || envelope.payload_ref.job_id !== source.job_id || envelope.payload_ref.sha256 !== sha256(source.intent)) throw new Error("A2A_PAYLOAD_REFERENCE_INVALID");
    return true;
  }

  priorResponse(transactionId, currentJobId) {
    return this.store.list("A2A_COMMAND_TOWER")
      .filter(job => job.job_id !== currentJobId && job.state === "COMPLETED" && job.constraints?.a2a_envelope?.TRANSACTION_ID === transactionId && job.result?.openai_response_id)
      .sort((a, b) => String(b.completed_at).localeCompare(String(a.completed_at)))[0]?.result?.openai_response_id || null;
  }

  relationshipHistory(source, limit = 8) {
    const relationshipId = source.constraints?.whatsapp_reference?.relationship_id;
    return this.store.list("TOLA_WHATSAPP_INBOUND")
      .filter(job => job.constraints?.whatsapp_reference?.relationship_id === relationshipId)
      .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
      .slice(-limit)
      .map(job => ({ job_id: job.job_id, intent: job.intent, media: job.constraints?.whatsapp_media || null }));
  }

  privateMediaPlan(source, media) {
    const history = this.relationshipHistory(source);
    let explicit = explicitMediaWant(source.intent);
    let anchor = source.intent;
    if (!explicit && isMediaContinuation(source.intent)) {
      for (let index = history.length - 2; index >= 0; index -= 1) {
        const candidate = explicitMediaWant(history[index].intent);
        if (candidate) {
          explicit = candidate;
          anchor = history[index].intent;
          break;
        }
      }
    }
    if (!explicit) return null;
    const continuity = history
      .slice(-5)
      .map(item => item.intent)
      .filter(Boolean)
      .join("\n");
    return {
      type: explicit,
      prompt: [anchor, source.intent === anchor ? null : source.intent, continuity]
        .filter(Boolean)
        .join("\n")
        .slice(0, 12000),
      source_image: media?.processing_path === "OPENAI_INPUT_IMAGE" ? media : null,
      continuity_count: history.length,
    };
  }

  validatePrivateMediaAuthority(source) {
    const reference = source.constraints?.whatsapp_reference;
    const pai = source.constraints?.PAI || {};
    const authority = source.constraints?.authority || {};
    if (!reference || reference.account_identity !== "TOLA") throw new Error("TOLA_PRIVATE_MEDIA_REFERENCE_REQUIRED");
    if (pai.identity !== "TOLA_WHATSAPP" || pai.authorized !== true || !hasScope(pai.scopes, PRIVATE_MEDIA_SCOPE)) throw new Error("TOLA_PRIVATE_MEDIA_PAI_DENIED");
    if (authority.authorized !== true || !hasScope(authority.scopes, PRIVATE_MEDIA_SCOPE)) throw new Error("TOLA_PRIVATE_MEDIA_AUTHORITY_DENIED");
    if (pai.exact_recipient !== reference.participant_id || authority.exact_recipient !== reference.participant_id || authority.exact_thread !== reference.thread_id || authority.exact_message_id !== reference.message_id) {
      throw new Error("TOLA_PRIVATE_MEDIA_AUTHORITY_SCOPE_MISMATCH");
    }
    return reference;
  }

  async generatePrivateImage(plan, envelope, previousResponseId = null) {
    const inputText = [
      "Create the actual private visual asset requested below. Do not return a plan, prompt, storyboard, or explanation.",
      "Use a portrait 9:16-friendly composition, strong subject clarity, polished production quality, and no added text unless the WANT explicitly requests text.",
      `WANT AND CONTINUITY:\n${plan.prompt}`,
    ].join("\n\n");
    const input = plan.source_image
      ? [{ role: "user", content: [
          { type: "input_text", text: inputText },
          { type: "input_image", image_url: `data:${plan.source_image.mime_type};base64,${plan.source_image.bytes.toString("base64")}`, detail: "high" },
        ] }]
      : inputText;
    const request = {
      model: this.model,
      store: true,
      instructions: "Create the requested image now using the image-generation tool. Return the generated image, not advice about creating it.",
      input,
      tools: [{
        type: "image_generation",
        model: this.imageModel,
        action: plan.source_image ? "edit" : previousResponseId ? "auto" : "generate",
        size: "1024x1536",
        quality: "low",
        output_format: "jpeg",
        output_compression: 86,
      }],
      tool_choice: { type: "image_generation" },
      metadata: {
        a2a_id: envelope.A2A_ID,
        opportunity_id: envelope.OPPORTUNITY_ID,
        producer: envelope.producer_identity,
        canon_revision: sha256(envelope.CANON_REVISION),
        capability: PRIVATE_MEDIA_CAPABILITY_VERSION,
      },
    };
    if (previousResponseId) request.previous_response_id = previousResponseId;
    const response = await this.fetch(OPENAI_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(180000),
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) throw new Error(`OPENAI_IMAGE_${response.status}:${String(body?.error?.code || body?.error?.type || "UNKNOWN").slice(0, 80)}`);
    const call = body?.output?.find(item => item?.type === "image_generation_call" && typeof item.result === "string");
    const bytes = call?.result ? Buffer.from(call.result, "base64") : null;
    if (!body?.id || !validGeneratedImage(bytes)) throw new Error("OPENAI_IMAGE_RESULT_INVALID");
    const mimeType = generatedImageMime(bytes);
    return {
      bytes,
      mime_type: mimeType,
      filename: mimeType === "image/png" ? "tola-created-image.png" : mimeType === "image/webp" ? "tola-created-image.webp" : "tola-created-image.jpg",
      openai_response_id: body.id,
      generation_id: body.id,
      provider: "openai",
      model: this.imageModel,
      revised_prompt_sha256: call.revised_prompt ? sha256(call.revised_prompt) : null,
      request_sha256: sha256(request),
    };
  }

  async generateMuseImage(plan, envelope) {
    if (!this.metaModelKey) throw new Error("TOLA_META_MODEL_API_AUTHENTICATION_REQUIRED");
    const prompt = [
      "Create the actual private visual asset requested below. Return the image, not a plan or explanation.",
      "Preserve supplied reference content unless the WANT explicitly changes it.",
      plan.prompt,
    ].join("\n\n").slice(0, 12000);
    let response;
    let requestEvidence;
    if (plan.source_image) {
      const form = new FormData();
      form.set("model", this.museImageModel);
      form.set("prompt", prompt);
      form.set("response_format", "b64_json");
      form.set("image", new Blob([plan.source_image.bytes], { type: plan.source_image.mime_type }), plan.source_image.filename || "reference-image");
      requestEvidence = { model: this.museImageModel, prompt, source_media_sha256: plan.source_image.sha256, operation: "edit" };
      response = await this.fetch(`${META_MODEL_BASE}/images/edits`, {
        method: "POST",
        headers: { authorization: `Bearer ${this.metaModelKey}` },
        body: form,
        signal: AbortSignal.timeout(240000),
      });
    } else {
      const request = { model: this.museImageModel, prompt, response_format: "b64_json" };
      requestEvidence = { ...request, operation: "generate" };
      response = await this.fetch(`${META_MODEL_BASE}/images/generations`, {
        method: "POST",
        headers: { authorization: `Bearer ${this.metaModelKey}`, "content-type": "application/json" },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(240000),
      });
    }
    const body = await response.json().catch(() => null);
    if (!response.ok) throw new Error(`META_MUSE_IMAGE_${response.status}:${String(body?.error?.code || body?.error?.type || "UNKNOWN").slice(0, 80)}`);
    const encoded = body?.data?.find(item => typeof item?.b64_json === "string")?.b64_json;
    const bytes = encoded ? Buffer.from(encoded, "base64") : null;
    if (!validGeneratedImage(bytes)) throw new Error("META_MUSE_IMAGE_RESULT_INVALID");
    const generationId = String(body?.id || `muse-image-${shortHash(bytes)}`);
    const mimeType = generatedImageMime(bytes);
    return {
      bytes,
      mime_type: mimeType,
      filename: mimeType === "image/png" ? "tola-created-image.png" : mimeType === "image/webp" ? "tola-created-image.webp" : "tola-created-image.jpg",
      openai_response_id: null,
      generation_id: generationId,
      provider: "meta",
      model: this.museImageModel,
      source_media_sha256: plan.source_image?.sha256 || null,
      request_sha256: sha256({ ...requestEvidence, A2A_ID: envelope.A2A_ID }),
    };
  }

  async transcribeMuseAudio(media) {
    if (!this.metaModelKey) return null;
    const form = new FormData();
    form.set("model", this.museVoiceModel);
    form.set("file", new Blob([media.bytes], { type: media.mime_type }), media.filename || "whatsapp-audio");
    const response = await this.fetch(`${META_MODEL_BASE}/asr/transcribe`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.metaModelKey}` },
      body: form,
      signal: AbortSignal.timeout(180000),
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) throw new Error(`META_MUSE_VOICE_${response.status}:${String(body?.error?.code || body?.error?.type || "UNKNOWN").slice(0, 80)}`);
    const transcript = String(body?.text || body?.transcript || body?.output_text || "").trim();
    if (!transcript) throw new Error("META_MUSE_VOICE_TRANSCRIPT_EMPTY");
    return {
      text: transcript.slice(0, 32000),
      response_id: String(body?.id || `muse-voice-${shortHash(`${media.sha256}:${transcript}`)}`),
      model: this.museVoiceModel,
      transcript_sha256: sha256(transcript),
    };
  }

  async resolveWithMuse(source, media, envelope) {
    if (!this.metaModelKey || isOpening(source.intent) || isCapabilityQuestion(source.intent)) return null;
    const history = this.relationshipHistory(source, 8).map(item => item.intent).filter(Boolean);
    const inputText = JSON.stringify({
      want: source.intent,
      relationship_history: history,
      media: media ? { type: media.type, mime_type: media.mime_type, sha256: media.sha256, processing_path: media.processing_path } : null,
      canon_revision: envelope.CANON_REVISION,
      authority: "REASONING_ONLY; do not claim external effects",
    });
    const input = media?.processing_path === "OPENAI_INPUT_IMAGE"
      ? [{ role: "user", content: [
          { type: "input_text", text: inputText },
          { type: "input_image", image_url: `data:${media.mime_type};base64,${media.bytes.toString("base64")}` },
        ] }]
      : inputText;
    const request = {
      model: this.museSparkModel,
      input,
      tools: [{ type: "web_search" }],
      metadata: {
        a2a_id: envelope.A2A_ID,
        opportunity_id: envelope.OPPORTUNITY_ID,
        producer: "META_MODEL_PROVIDER",
        canon_revision: sha256(envelope.CANON_REVISION),
      },
    };
    const response = await this.fetch(`${META_MODEL_BASE}/responses`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.metaModelKey}`, "content-type": "application/json" },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(120000),
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) throw new Error(`META_MUSE_SPARK_${response.status}:${String(body?.error?.code || body?.error?.type || "UNKNOWN").slice(0, 80)}`);
    const output = responseText(body);
    if (!body?.id || !output) throw new Error("META_MUSE_SPARK_RESULT_INVALID");
    return {
      response_id: body.id,
      model: this.museSparkModel,
      output: output.slice(0, 16000),
      request_sha256: sha256(request),
    };
  }

  async confirmPrivateMediaExecution(plan, envelope, previousResponseId = null) {
    const inputText = `Privately execute this ${plan.type} WANT now. Confirm the WANT and any supplied source media are usable.\n${plan.prompt}`;
    const input = plan.source_image
      ? [{ role: "user", content: [
          { type: "input_text", text: inputText },
          { type: "input_image", image_url: `data:${plan.source_image.mime_type};base64,${plan.source_image.bytes.toString("base64")}`, detail: "high" },
        ] }]
      : inputText;
    const request = {
      model: this.model,
      store: true,
      instructions: "You are the private execution controller. Verify the requested private artifact and any supplied source are usable. Reply with only EXECUTE. Do not address the customer.",
      input,
      metadata: {
        a2a_id: envelope.A2A_ID,
        producer: envelope.producer_identity,
        canon_revision: sha256(envelope.CANON_REVISION),
        capability: PRIVATE_MEDIA_CAPABILITY_VERSION,
      },
    };
    if (previousResponseId) request.previous_response_id = previousResponseId;
    const response = await this.fetch(OPENAI_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(90000),
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) throw new Error(`OPENAI_MEDIA_EXECUTION_${response.status}:${String(body?.error?.code || body?.error?.type || "UNKNOWN").slice(0, 80)}`);
    if (!body?.id || responseText(body).toUpperCase() !== "EXECUTE") throw new Error("OPENAI_MEDIA_EXECUTION_CONFIRMATION_INVALID");
    return { openai_response_id: body.id, request_sha256: sha256(request) };
  }

  async probeVideo(file) {
    let stdout;
    try {
      ({ stdout } = await execFileAsync(this.env.FFPROBE_PATH || "/usr/bin/ffprobe", [
        "-v", "error",
        "-show_entries", "format=format_name,duration:stream=codec_type,codec_name,width,height,avg_frame_rate,duration,nb_frames",
        "-of", "json",
        file,
      ], { timeout: 60000, maxBuffer: 1024 * 1024 }));
    } catch { throw new Error("TOLA_VIDEO_STREAM_PROBE_FAILED"); }
    const probe = parse(String(stdout), null);
    const stream = probe?.streams?.find(item => item.codec_type === "video");
    const duration = Number(stream?.duration || probe?.format?.duration);
    const width = Number(stream?.width);
    const height = Number(stream?.height);
    if (!String(probe?.format?.format_name || "").split(",").some(name => ["mp4", "mov"].includes(name))) throw new Error("TOLA_VIDEO_CONTAINER_INVALID");
    if (!stream || !Number.isFinite(duration) || duration <= 0 || !Number.isSafeInteger(width) || width <= 0 || !Number.isSafeInteger(height) || height <= 0) {
      throw new Error("TOLA_VIDEO_STREAM_INVALID");
    }
    return { duration_seconds: duration, width, height, codec: String(stream.codec_name || "").toLowerCase(), avg_frame_rate: stream.avg_frame_rate || null, frame_count: Number(stream.nb_frames) || null };
  }

  async temporalVideoValidation(file) {
    let stdout;
    try {
      ({ stdout } = await execFileAsync(this.env.FFMPEG_PATH || "/usr/bin/ffmpeg", [
        "-hide_banner", "-loglevel", "error", "-i", file,
        "-vf", "fps=2,scale=64:64:force_original_aspect_ratio=decrease,pad=64:64:(ow-iw)/2:(oh-ih)/2,format=gray",
        "-frames:v", "12", "-f", "rawvideo", "-pix_fmt", "gray", "pipe:1",
      ], { encoding: "buffer", timeout: 120000, maxBuffer: 2 * 1024 * 1024 }));
    } catch { throw new Error("TOLA_VIDEO_TEMPORAL_SAMPLE_FAILED"); }
    const bytes = Buffer.from(stdout || []);
    const frameSize = 64 * 64;
    const sampleCount = Math.floor(bytes.length / frameSize);
    if (sampleCount < 3 || bytes.length % frameSize !== 0) throw new Error("TOLA_VIDEO_TEMPORAL_SAMPLE_INSUFFICIENT");
    let totalDifference = 0;
    let changedPixels = 0;
    const comparisons = sampleCount - 1;
    for (let frame = 1; frame < sampleCount; frame += 1) {
      const prior = (frame - 1) * frameSize;
      const current = frame * frameSize;
      for (let pixel = 0; pixel < frameSize; pixel += 1) {
        const difference = Math.abs(bytes[current + pixel] - bytes[prior + pixel]);
        totalDifference += difference;
        if (difference >= 12) changedPixels += 1;
      }
    }
    bytes.fill(0);
    const meanAbsoluteDifference = totalDifference / (comparisons * frameSize);
    const changedPixelRatio = changedPixels / (comparisons * frameSize);
    const passed = meanAbsoluteDifference >= 1 && changedPixelRatio >= 0.02;
    if (!passed) throw new Error("TOLA_VIDEO_TEMPORAL_VARIATION_FAILED");
    return {
      passed: true,
      sampled_frames: sampleCount,
      mean_absolute_difference: Number(meanAbsoluteDifference.toFixed(4)),
      changed_pixel_ratio: Number(changedPixelRatio.toFixed(6)),
      local_motion_synthesis: false,
      repeated_still_rejected: true,
    };
  }

  async validateAndPersistGenuineVideo(bytes, source) {
    if (!Buffer.isBuffer(bytes) || bytes.length < 64 || bytes.length > MEDIA_LIMITS.video) throw new Error("TOLA_VIDEO_ARTIFACT_INVALID");
    const artifactDir = path.join(this.stateDir, "deliverables", "tola");
    fs.mkdirSync(artifactDir, { recursive: true, mode: 0o700 });
    const artifactId = shortHash(`${PRIVATE_MEDIA_CAPABILITY_VERSION}:${source.idempotency_key}`);
    const artifactFile = path.join(artifactDir, `${artifactId}.mp4`);
    const temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), "tola-genuine-video-"));
    const inputFile = path.join(temporaryDir, "provider.mp4");
    const outputFile = path.join(temporaryDir, "whatsapp.mp4");
    try {
      fs.writeFileSync(inputFile, bytes, { mode: 0o600 });
      const sourceProbe = await this.probeVideo(inputFile);
      if (sourceProbe.codec === "h264" && bytes.length <= WHATSAPP_OUTBOUND_MEDIA_LIMIT) {
        fs.copyFileSync(inputFile, outputFile);
      } else {
        try {
          await execFileAsync(this.env.FFMPEG_PATH || "/usr/bin/ffmpeg", [
            "-hide_banner", "-loglevel", "error", "-y", "-i", inputFile,
            "-map", "0:v:0", "-map", "0:a?",
            "-vf", "scale='min(720,iw)':-2",
            "-c:v", "libx264", "-preset", "medium", "-crf", "28", "-pix_fmt", "yuv420p",
            "-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart", outputFile,
          ], { timeout: 300000, maxBuffer: 2 * 1024 * 1024 });
        } catch { throw new Error("TOLA_VIDEO_WHATSAPP_TRANSCODE_FAILED"); }
      }
      const validatedBytes = fs.readFileSync(outputFile);
      if (!validatedBytes.length || validatedBytes.length > WHATSAPP_OUTBOUND_MEDIA_LIMIT || !validatedBytes.subarray(0, Math.min(64, validatedBytes.length)).includes(Buffer.from("ftyp"))) {
        throw new Error("TOLA_VIDEO_ARTIFACT_WHATSAPP_INVALID");
      }
      const probe = await this.probeVideo(outputFile);
      if (probe.codec !== "h264") throw new Error("TOLA_VIDEO_STREAM_CODEC_NOT_H264");
      try {
        await execFileAsync(this.env.FFMPEG_PATH || "/usr/bin/ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", outputFile, "-f", "null", "-"], { timeout: 180000, maxBuffer: 2 * 1024 * 1024 });
      } catch { throw new Error("TOLA_VIDEO_PLAYBACK_DECODE_FAILED"); }
      const frame_difference = await this.temporalVideoValidation(outputFile);
      if (!fs.existsSync(artifactFile)) fs.copyFileSync(outputFile, artifactFile, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(artifactFile, 0o600);
      const persisted = fs.readFileSync(artifactFile);
      return {
        bytes: persisted,
        artifact_ref: `deliverable:${artifactId}`,
        artifact_path: artifactFile,
        mime_type: "video/mp4",
        filename: "tola-created-video.mp4",
        sha256: sha256(persisted),
        size_bytes: persisted.length,
        ...probe,
        resolution: `${probe.width}x${probe.height}`,
        codec: "h264",
        frame_difference,
        provider_generated_frames: true,
        local_motion_synthesis: false,
      };
    } finally {
      fs.rmSync(temporaryDir, { recursive: true, force: true });
    }
  }

  async generateGenuineVideo(plan, envelope, source) {
    const availability = this.videoAvailability();
    if (!availability.available) throw new Error(availability.blocker);
    const prompt = [
      "Generate a genuine temporally coherent moving scene for this private WANT.",
      "Subject motion must be visible across time. Do not produce a static still, repeated frame, slideshow, Ken Burns effect, or camera-only pan/zoom.",
      plan.prompt,
    ].join("\n\n").slice(0, 12000);
    const input = {
      prompt,
      duration: "5",
      aspect_ratio: "9:16",
      negative_prompt: "static still image, repeated frame, slideshow, Ken Burns effect, camera-only pan, camera-only zoom, watermark, blur, distorted anatomy, low quality",
      generate_audio: false,
      source_image: plan.source_image ? {
        mime_type: plan.source_image.mime_type,
        sha256: plan.source_image.sha256,
        bytes: Buffer.from(plan.source_image.bytes),
      } : null,
    };
    let generated;
    try {
      generated = await this.videoClient.generate(input, { abortSignal: AbortSignal.timeout(12 * 60 * 1000) });
    } catch {
      throw new Error("TOLA_VIDEO_PROVIDER_GENERATION_FAILED");
    } finally {
      if (Buffer.isBuffer(input.source_image?.bytes)) input.source_image.bytes.fill(0);
    }
    const generationId = String(generated?.generation_id || "");
    const providerBytes = Buffer.isBuffer(generated?.bytes) ? Buffer.from(generated.bytes) : null;
    if (!generationId || !providerBytes?.length) throw new Error("TOLA_VIDEO_PROVIDER_GENERATION_RESULT_INVALID");
    try {
      const artifact = await this.validateAndPersistGenuineVideo(providerBytes, source);
      return {
        artifact,
        generation_id: generationId,
        provider: "meta",
        model: this.videoProduct,
        request_sha256: sha256({
          product: this.videoProduct,
          input: { ...input, source_image: input.source_image ? { mime_type: input.source_image.mime_type, sha256: input.source_image.sha256 } : null },
          A2A_ID: envelope.A2A_ID,
        }),
      };
    } finally {
      providerBytes.fill(0);
      if (Buffer.isBuffer(generated?.bytes)) generated.bytes.fill(0);
    }
  }

  async executePrivateMedia(source, envelope, media) {
    const plan = this.privateMediaPlan(source, media);
    if (!plan) return null;
    this.validatePrivateMediaAuthority(source);
    const executionKey = `capability:${PRIVATE_MEDIA_CAPABILITY_VERSION}:${shortHash(source.idempotency_key)}`;
    const execution = this.store.createJob({
      parent_job_id: source.job_id,
      root_job_id: source.root_job_id,
      delta_id: envelope.OPPORTUNITY_ID,
      worker_type: "TOLA_PRIVATE_MEDIA_EXECUTION",
      owner: "OPENAI_COMMAND_TOWER_RUNTIME",
      intent: `Execute the authorized private ${plan.type} WANT`,
      success_condition: "A real private media artifact is created and evidenced before TOLA reports completion",
      idempotency_key: executionKey,
      priority: 92,
      state: "RUNNING",
      constraints: {
        actionable: true,
        capability: PRIVATE_MEDIA_CAPABILITY_VERSION,
        media_type: plan.type,
        authority_scope: PRIVATE_MEDIA_SCOPE,
        exact_relationship_id: envelope.RELATIONSHIP_ID,
        exact_provider_message_id: envelope.provider_message_id,
      },
      provenance: { source: "TOLA_CLOUD_CAPABILITY_ROUTER", a2a_id: envelope.A2A_ID, canon_revision: this.canonRevision },
      completed_at: null,
    }).job;
    const claim = this.store.beginAction(execution.job_id, executionKey);
    if (!claim.execute) throw new Error(`TOLA_PRIVATE_MEDIA_ACTION_${claim.reason}`);
    try {
    const previousResponseId = this.priorResponse(envelope.TRANSACTION_ID, "");
    let generated;
    let generation = null;
    let artifact;
    if (plan.type === "video") {
      const availability = this.videoAvailability();
      if (!availability.available) throw new Error(availability.blocker);
      const confirmation = await this.confirmPrivateMediaExecution(plan, envelope, previousResponseId);
      generation = await this.generateGenuineVideo(plan, envelope, source);
      generated = {
        openai_response_id: confirmation.openai_response_id,
        request_sha256: confirmation.request_sha256,
        source_media_sha256: plan.source_image?.sha256 || null,
      };
      artifact = generation.artifact;
    } else {
      if (this.metaModelKey) {
        try { generated = await this.generateMuseImage(plan, envelope); }
        catch (error) {
          this.store.event(execution.job_id, "META_MUSE_IMAGE_ROUTE_FAILED", { error: safeError(error), fallback: "EXISTING_OPENAI_IMAGE_ROUTE", at: now() });
          generated = await this.generatePrivateImage(plan, envelope, previousResponseId);
        }
      } else {
        generated = await this.generatePrivateImage(plan, envelope, previousResponseId);
      }
      generation = {
        generation_id: generated.generation_id,
        provider: generated.provider,
        model: generated.model,
        request_sha256: generated.request_sha256,
      };
      artifact = (() => {
          const artifactDir = path.join(this.stateDir, "deliverables", "tola");
          fs.mkdirSync(artifactDir, { recursive: true, mode: 0o700 });
          const artifactId = shortHash(`${PRIVATE_MEDIA_CAPABILITY_VERSION}:${source.idempotency_key}`);
          const extension = generated.mime_type === "image/png" ? "png" : generated.mime_type === "image/webp" ? "webp" : "jpg";
          const file = path.join(artifactDir, `${artifactId}.${extension}`);
          if (!fs.existsSync(file)) fs.writeFileSync(file, generated.bytes, { mode: 0o600, flag: "wx" });
          const bytes = fs.readFileSync(file);
          return { bytes, artifact_ref: `deliverable:${artifactId}`, mime_type: generated.mime_type, filename: generated.filename, sha256: sha256(bytes), size_bytes: bytes.length };
        })();
    }
    const result = {
      status: "PRIVATE_MEDIA_CREATED",
      capability: PRIVATE_MEDIA_CAPABILITY_VERSION,
      media_type: plan.type,
      artifact_ref: artifact.artifact_ref,
      artifact_sha256: artifact.sha256,
      size_bytes: artifact.size_bytes,
      mime_type: artifact.mime_type,
      openai_response_id: generated.openai_response_id,
      generation_id: generation?.generation_id || null,
      generation_provider: generation?.provider || null,
      generation_model: generation?.model || null,
      video_validation: artifact.frame_difference || null,
      duration_seconds: artifact.duration_seconds || null,
      resolution: artifact.resolution || null,
      codec: artifact.codec || null,
      execution_count: 1,
      terminal_state: "EXECUTED",
    };
    const evidence = [{
      type: "TOLA_PRIVATE_MEDIA_CREATED",
      verified: true,
      media_type: plan.type,
      artifact_sha256: artifact.sha256,
      size_bytes: artifact.size_bytes,
      mime_type: artifact.mime_type,
      source_media_sha256: generated.source_media_sha256 || null,
      openai_response_id: generated.openai_response_id,
      request_sha256: generated.request_sha256,
      generation_request_sha256: generation?.request_sha256 || null,
      generation_id: generation?.generation_id || null,
      generation_provider: generation?.provider || null,
      generation_model: generation?.model || null,
      duration_seconds: artifact.duration_seconds || null,
      resolution: artifact.resolution || null,
      codec: artifact.codec || null,
      frame_difference: artifact.frame_difference || null,
      provider_generated_frames: artifact.provider_generated_frames || false,
      local_motion_synthesis: artifact.local_motion_synthesis || false,
      authority_scope: PRIVATE_MEDIA_SCOPE,
      at: now(),
    }];
    this.store.finishAction(execution.job_id, executionKey, result, evidence);
    this.store.updateJob(execution.job_id, {
      state: "COMPLETED",
      completed_at: now(),
      result,
      evidence,
      terminal_state: "EXECUTED",
      terminal_evidence: { executor_invoked: "OPENAI_COMMAND_TOWER_RUNTIME", external_action_performed: `PRIVATE_${plan.type.toUpperCase()}_CREATED`, authority_result: "EXACT_PRIVATE_CREATION_AUTHORIZED" },
    });
    this.store.appendEffect("ACTION_EXECUTED", {
      job_id: execution.job_id,
      opportunity_id: envelope.OPPORTUNITY_ID,
      want_id: envelope.WANT_ID,
      producer_identity: "OPENAI_COMMAND_TOWER_RUNTIME",
      destination: envelope.RELATIONSHIP_ID,
      authority_state: "EXACT_PRIVATE_CREATION_AUTHORIZED",
      message_ref: { A2A_ID: envelope.A2A_ID, inbound_provider_message_id: envelope.provider_message_id },
      evidence_ref: `artifact:${artifact.sha256}`,
    });
    return {
      plan,
      execution_job_id: execution.job_id,
      execution_receipt_id: executionKey,
      artifact,
      openai_response_id: generated.openai_response_id,
      generation_id: generation?.generation_id || null,
      generation_provider: generation?.provider || null,
      generation_model: generation?.model || null,
      reply: plan.type === "video" ? "Done — I created the video." : "Done — I created the image.",
      evidence,
    };
    } catch (error) {
      const failure = this.store.failAction(execution.job_id, executionKey, error);
      this.store.updateJob(execution.job_id, {
        state: "FAILED",
        completed_at: now(),
        result: failure.result,
        evidence: failure.evidence,
        terminal_state: "FAILED",
        terminal_evidence: { executor_invoked: "OPENAI_COMMAND_TOWER_RUNTIME", external_action_performed: "NONE", authority_result: "AUTHORIZED_EXECUTION_FAILED", error: failure.result.error },
      });
      this.store.appendEffect("ACTION_FAILED", {
        job_id: execution.job_id,
        opportunity_id: envelope.OPPORTUNITY_ID,
        want_id: envelope.WANT_ID,
        producer_identity: "OPENAI_COMMAND_TOWER_RUNTIME",
        destination: envelope.RELATIONSHIP_ID,
        authority_state: "EXACT_PRIVATE_CREATION_AUTHORIZED",
        message_ref: { A2A_ID: envelope.A2A_ID, inbound_provider_message_id: envelope.provider_message_id },
        evidence_ref: `capability-failure:${executionKey}`,
        error: failure.result.error,
      });
      throw error;
    }
  }

  async reason(job, source, media) {
    const envelope = job.constraints.a2a_envelope;
    this.validateEnvelope(envelope, source);
    const previousResponseId = this.priorResponse(envelope.TRANSACTION_ID, job.job_id);
    let voice = null;
    let muse = null;
    if (media?.processing_path === "META_MUSE_VOICE_TRANSCRIPTION_PENDING") {
      try {
        voice = await this.transcribeMuseAudio(media);
        media.processing_path = "META_MUSE_VOICE_TRANSCRIBED";
      } catch (error) {
        media.processing_path = "META_MUSE_VOICE_TRANSCRIPTION_FAILED";
        this.store.event(job.job_id, "META_MUSE_VOICE_ROUTE_FAILED", { error: safeError(error), at: now() });
      }
    }
    try { muse = await this.resolveWithMuse(source, media, envelope); }
    catch (error) {
      this.store.event(job.job_id, "META_MUSE_SPARK_ROUTE_FAILED", { error: safeError(error), fallback: "OPENAI_COMMAND_TOWER_RUNTIME", at: now() });
    }
    const inputEnvelope = {
      A2A_ID: envelope.A2A_ID, OPPORTUNITY_ID: envelope.OPPORTUNITY_ID, WANT_ID: envelope.WANT_ID,
      TRANSACTION_ID: envelope.TRANSACTION_ID, RELATIONSHIP_ID: envelope.RELATIONSHIP_ID,
      producer_identity: envelope.producer_identity, action_class: envelope.action_class,
      payload: source.intent,
      capability_truth: this.liveCapabilityTruth(),
      media_processing: media ? { type: media.type, mime_type: media.mime_type, size_bytes: media.size_bytes, sha256: media.sha256, processing_path: media.processing_path } : null,
      muse_reasoning: muse ? { response_id: muse.response_id, model: muse.model, output: muse.output } : null,
      audio_transcript: voice?.text || null,
    };
    const inputText = JSON.stringify(inputEnvelope);
    let input = inputText;
    if (media?.processing_path === "OPENAI_INPUT_IMAGE") input = [{ role: "user", content: [{ type: "input_text", text: inputText }, { type: "input_image", image_url: `data:${media.mime_type};base64,${media.bytes.toString("base64")}`, detail: "high" }] }];
    else if (media?.processing_path === "OPENAI_INPUT_FILE") input = [{ role: "user", content: [{ type: "input_text", text: inputText }, { type: "input_file", filename: media.filename, file_data: `data:${media.mime_type};base64,${media.bytes.toString("base64")}` }] }];
    const request = {
      model: this.model,
      store: true,
      instructions: [
        tolaInstructions(source.intent),
        "You are OPENAI_COMMAND_TOWER_RUNTIME behind TOLA WhatsApp.",
        "Return only TOLA's direct human-facing reply. Never expose internal architecture, engines, models, A2A, PAI, CHAIRMAN, Muse, or OpenAI.",
        "TOLA is not a generic chatbot. Follow UNDERSTAND -> ROUTE -> EXECUTE WITHIN AUTHORITY -> RETURN RESULT.",
        "Do all safe reasoning and research now. Do not offer plans, prompts, briefs, or next-step options when the WANT is clear.",
        "Ask one short question only for genuinely missing information, identity, consent, payment, authentication, or authority.",
        "Never claim that a consequential external action occurred unless supplied verified evidence says it occurred.",
        "If blocked, name the exact missing capability or authority and the smallest unblock action.",
        "Keep the reply short, natural, confident, and specific.",
      ].join(" "),
      input,
      tools: [{ type: "web_search" }],
      metadata: {
        a2a_id: envelope.A2A_ID,
        opportunity_id: envelope.OPPORTUNITY_ID,
        producer: envelope.producer_identity,
        canon_revision: sha256(envelope.CANON_REVISION),
        tola_contract_revision: TOLA_BEHAVIOR_CONTRACT_REVISION,
      },
    };
    if (previousResponseId) request.previous_response_id = previousResponseId;
    const response = await this.fetch(OPENAI_URL, { method: "POST", headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" }, body: JSON.stringify(request), signal: AbortSignal.timeout(90000) });
    const body = await response.json().catch(() => null);
    if (!response.ok) throw new Error(`OPENAI_RESPONSES_${response.status}:${String(body?.error?.type || body?.error?.code || "UNKNOWN").slice(0, 80)}`);
    const output = responseText(body);
    if (!body?.id || !output) throw new Error("OPENAI_REASONING_RESULT_INVALID");
    return {
      result: {
        A2A_ID: envelope.A2A_ID, OPPORTUNITY_ID: envelope.OPPORTUNITY_ID, WANT_ID: envelope.WANT_ID,
        RELATIONSHIP_ID: envelope.RELATIONSHIP_ID, CHANNEL_THREAD_ID: envelope.CHANNEL_THREAD_ID,
        provider_message_id: envelope.provider_message_id, producer_identity: envelope.producer_identity,
        recipient_identity: envelope.recipient_identity, CANON_REVISION: envelope.CANON_REVISION,
        reasoning_result_ref: `openai:response:${body.id}`, openai_response_id: body.id,
        muse_response_id: muse?.response_id || null,
        previous_response_id: previousResponseId, reasoning_output: output,
        next_action: "TOLA_REPLY_TO_ORIGINAL_WHATSAPP_THREAD",
        receipt: { idempotency_key: envelope.idempotency_key, status: "COMPLETED", execution_count: 1, completed_at: now() },
        terminal_state: "EXECUTED",
        terminal_evidence: { executor_invoked: "OPENAI_COMMAND_TOWER_RUNTIME", authority_result: "REASONING_ONLY_ALLOWED", external_action_performed: "NONE_REASONING_RESULT_ONLY", downstream_effects_authorized: false },
      },
      evidence: [{
        type: "A2A_OPENAI_RESPONSES_RESULT",
        verified: true,
        openai_response_id: body.id,
        previous_response_id: previousResponseId,
        model: this.model,
        media_supplied: ["OPENAI_INPUT_IMAGE", "OPENAI_INPUT_FILE"].includes(media?.processing_path),
        muse_response_id: muse?.response_id || null,
        muse_model: muse?.model || null,
        muse_request_sha256: muse?.request_sha256 || null,
        muse_voice_response_id: voice?.response_id || null,
        muse_voice_model: voice?.model || null,
        transcript_sha256: voice?.transcript_sha256 || null,
        tola_contract_revision: TOLA_BEHAVIOR_CONTRACT_REVISION,
        tola_contract_sha256: sha256(TOLA_BEHAVIOR_CONTRACT),
        capability_question: isCapabilityQuestion(source.intent),
        request_sha256: sha256(request),
        at: now(),
      }],
    };
  }

  async sendReply(reference, text) {
    const response = await this.provider("/messages", { method: "POST", body: { messaging_product: "whatsapp", to: reference.participant_id, type: "text", text: { body: text, preview_url: false } }, timeoutMs: 60000 });
    const messageId = response.body?.messages?.[0]?.id;
    if (!/^wamid\./.test(String(messageId || ""))) throw new Error("WHATSAPP_SEND_RECEIPT_MESSAGE_ID_MISSING");
    return { provider_message_id: messageId, recipient_id: response.body?.contacts?.[0]?.wa_id || reference.participant_id };
  }

  async uploadMedia(bytes, { mimeType, filename }) {
    if (!Buffer.isBuffer(bytes) || !bytes.length) throw new Error("TOLA_OUTBOUND_MEDIA_EMPTY");
    if (bytes.length > WHATSAPP_OUTBOUND_MEDIA_LIMIT) throw new Error("TOLA_OUTBOUND_MEDIA_TOO_LARGE");
    const form = new FormData();
    form.set("messaging_product", "whatsapp");
    form.set("type", mimeType);
    form.set("file", new Blob([bytes], { type: mimeType }), filename);
    let response;
    try {
      response = await this.fetch(`${PROVIDER_BASE}/media`, {
        method: "POST",
        headers: { authorization: `Bearer ${this.token}` },
        body: form,
        signal: AbortSignal.timeout(120000),
      });
    } catch { throw new Error("WHATSAPP_MEDIA_UPLOAD_FAILED"); }
    const body = await response.json().catch(() => null);
    if (!response.ok) throw new Error(`WHATSAPP_MEDIA_UPLOAD_${response.status}:${String(body?.error?.code || "UNKNOWN").slice(0, 40)}`);
    if (typeof body?.id !== "string" || !body.id || body.id.length > 256) throw new Error("WHATSAPP_MEDIA_UPLOAD_ID_MISSING");
    return { media_id: body.id };
  }

  async sendMediaReply(reference, mediaType, mediaId, caption) {
    if (!new Set(["image", "video"]).has(mediaType)) throw new Error("TOLA_OUTBOUND_MEDIA_TYPE_DENIED");
    const response = await this.provider("/messages", {
      method: "POST",
      body: {
        messaging_product: "whatsapp",
        to: reference.participant_id,
        type: mediaType,
        [mediaType]: { id: mediaId, caption: String(caption || "").slice(0, 1024) },
      },
      timeoutMs: 60000,
    });
    const messageId = response.body?.messages?.[0]?.id;
    if (!/^wamid\./.test(String(messageId || ""))) throw new Error("WHATSAPP_SEND_RECEIPT_MESSAGE_ID_MISSING");
    return { provider_message_id: messageId, recipient_id: response.body?.contacts?.[0]?.wa_id || reference.participant_id };
  }

  async handleMessage(agentId, message, contacts = []) {
    const contact = contacts.find(item => item?.wa_id === message?.from) || null;
    const reference = this.reference(agentId, message, contact?.profile?.name || null);
    const existing = this.store.getByIdempotency(reference.action_id);
    const existingReceipt = this.store.receipt(reference.action_id);
    if (existing || existingReceipt) {
      const existingJob = existing || this.store.get(existingReceipt.job_id);
      if (!existingJob) {
        return {
          duplicate: true,
          job_id: existingReceipt.job_id,
          a2a_id: null,
          duplicate_execution: false,
          duplicate_reply: false,
          historical_receipt_only: true,
        };
      }
      const checkpoint = { ...(existingJob.checkpoint || {}), duplicate_count: Number(existingJob.checkpoint?.duplicate_count || 0) + 1, last_replay_at: now() };
      this.store.updateJob(existingJob.job_id, { checkpoint });
      this.store.event(existingJob.job_id, "TOLA_WHATSAPP_REPLAY_SUPPRESSED", { inbound_message_id: reference.message_id, duplicate_execution: false, duplicate_reply: false, at: now() });
      if (existingJob.result?.ren_handoff_job_id) await this.recoverRenTransactions();
      return { duplicate: true, job_id: existingJob.job_id, a2a_id: existingJob.result?.A2A_ID || existingJob.result?.outbound?.A2A_ID || null, duplicate_execution: false, duplicate_reply: false };
    }
    const intent = this.intentFor(message);
    if (!intent) return { ignored: true, reason: "EMPTY_MESSAGE" };
    if (containsRawCredential(intent)) return this.rejectCredentialMessage(reference);
    const media = MEDIA_TYPES.has(message.type) ? await this.fetchMedia(message) : null;
    const a2aId = `tola-wa-${shortHash(`${reference.agent_id}:${reference.action_id}`)}`;
    const opportunityId = `tola-wa-op-${shortHash(reference.action_id)}`;
    const wantId = `want-${shortHash(`${reference.relationship_id}:${intent}`)}`;
    const transactionId = `tola-wa-tx-${shortHash(`${reference.agent_id}:${reference.thread_id}`)}`;
    const mediaMetadata = media ? { type: media.type, mime_type: media.mime_type, size_bytes: media.size_bytes, sha256: media.sha256, media_identity_hash: media.media_identity_hash, filename: media.filename, processing_path: media.processing_path, bytes_persisted: false, provider_url_persisted: false, provider_media_id_persisted: false } : null;
    const inboundResult = { status: "ADMITTED_TO_SHARED_WORK_SYSTEM", inbound_message_id: reference.message_id, relationship_id: reference.relationship_id, A2A_ID: a2aId, OPPORTUNITY_ID: opportunityId, WANT_ID: wantId, terminal_state: "EXECUTED", terminal_evidence: { executor_invoked: "TOLA_WHATSAPP_CLOUD_RECEIVER", external_action_performed: "NONE_INBOUND_ONLY", authority_result: "PRIVATE_MESSAGE_ACCEPTED" } };
    const source = this.store.createJob({
      worker_type: "TOLA_WHATSAPP_INBOUND", owner: "TOLA_WHATSAPP", intent,
      success_condition: "Private WhatsApp message admitted to shared cloud jobs/action_receipts/EFFECTS with exact continuity references",
      idempotency_key: reference.action_id, priority: 95,
      constraints: { actionable: false, channel: "whatsapp", whatsapp_reference: reference, whatsapp_media: mediaMetadata, PAI: { identity: "TOLA_WHATSAPP", authorized: true, scopes: ["A2A_REASONING", "WHATSAPP_PRIVATE_REPLY", PRIVATE_MEDIA_SCOPE], exact_recipient: reference.participant_id, exact_message_id: reference.message_id }, authority: { authorized: true, scopes: ["A2A_REASONING", "WHATSAPP_PRIVATE_REPLY", PRIVATE_MEDIA_SCOPE], exact_recipient: reference.participant_id, exact_thread: reference.thread_id, exact_message_id: reference.message_id, denied_effects: ["bulk_outreach", "public_distribution", "spending", "payment"] } },
      provenance: { source: "WHATSAPP_AGENT_PLATFORM", relationship_id: reference.relationship_id, provider_message_id: reference.message_id, canon_revision: this.canonRevision },
      result: inboundResult, evidence: [{ type: "TOLA_WHATSAPP_RECEIVED", verified: true, provider_message_id: reference.message_id, relationship_id: reference.relationship_id, at: now() }, ...(media ? [{ type: "TOLA_WHATSAPP_MEDIA_FETCHED", verified: true, mime_type: media.mime_type, size_bytes: media.size_bytes, sha256: media.sha256, bytes_persisted: false }] : [])], terminal_state: "EXECUTED",
    }).job;
    const inboundAction = this.store.beginAction(source.job_id, reference.action_id);
    if (inboundAction.execute) this.store.finishAction(source.job_id, reference.action_id, inboundResult, source.evidence);
    this.store.appendEffect("RESPONSE_RECEIVED", { job_id: source.job_id, opportunity_id: opportunityId, want_id: wantId, producer_identity: "TOLA_WHATSAPP", channel: "whatsapp", message_ref: { inbound_provider_message_id: reference.message_id, relationship_id: reference.relationship_id }, authority_state: "PRIVATE_MESSAGE_ACCEPTED", evidence_ref: `whatsapp-inbound:${reference.action_id}` });

    if (!media && isRenExecutionWant(intent)) {
      const work = await this.queueRenHandoff(source, { a2aId, opportunityId, wantId, transactionId });
      const recovered = await this.recoverRenTransactions();
      const currentWork = this.store.get(work.job_id);
      const delivered = this.store.receipt(`whatsapp:ren-result:${shortHash(reference.action_id)}`)?.result || null;
      return {
        duplicate: false,
        job_id: source.job_id,
        ren_handoff_job_id: work.job_id,
        task_id: work.result.TASK_ID,
        a2a_id: a2aId,
        state: currentWork.state,
        ren_transport: this.renAdapter ? "ADAPTER_CONNECTED" : "AWAITING_REN_RECEIVER_POLL",
        provider_message_id: delivered?.outbound_provider_message_id || null,
        ren_execution_id: delivered?.ren_execution_id || null,
        recovery: recovered.find(item => item.task_id === work.result.TASK_ID) || null,
      };
    }

    const issued = now(), expires = new Date(Date.now() + MAX_TTL_MS).toISOString();
    const envelope = {
      A2A_ID: a2aId, OPPORTUNITY_ID: opportunityId, WANT_ID: wantId, TRANSACTION_ID: transactionId,
      RELATIONSHIP_ID: reference.relationship_id, CHANNEL_THREAD_ID: reference.thread_id,
      provider_message_id: reference.message_id, producer_identity: "TOLA_WHATSAPP",
      recipient_identity: "OPENAI_COMMAND_TOWER_RUNTIME", CANON_REVISION: this.canonRevision,
      created_at: issued, ttl_ms: MAX_TTL_MS, idempotency_key: `a2a:${a2aId}`,
      action_class: "RESOLVE", payload_ref: { kind: "JOB_INTENT", job_id: source.job_id, sha256: sha256(intent) },
      PAI: { identity: "TOLA_WHATSAPP", authorized: false, scopes: ["A2A_REASONING"], issued_at: issued, expires_at: expires },
      authority: { authorized: false, scopes: ["A2A_REASONING"], exact_channel: "whatsapp", exact_relationship_id: reference.relationship_id },
      surface_permission: "WHATSAPP_PRIVATE_SAME_THREAD", next_action: "TOLA_REPLY_TO_ORIGINAL_WHATSAPP_THREAD",
    };
    this.validateEnvelope(envelope, source);
    const reasoning = this.store.createJob({
      parent_job_id: source.job_id, root_job_id: source.root_job_id, delta_id: opportunityId,
      worker_type: "A2A_COMMAND_TOWER", owner: "A2A:TOLA_WHATSAPP",
      intent: `Resolve A2A transaction ${a2aId} for TOLA_WHATSAPP`,
      success_condition: "Cloud reasoning result, next action, receipt, and exact continuity references are persisted without unauthorized effects",
      idempotency_key: envelope.idempotency_key, priority: 90, state: "RUNNING",
      constraints: { actionable: false, a2a_envelope: envelope, a2a_envelope_hash: sha256(envelope), authority: { authorized: false, reasoning_only: true }, external_effects: false },
      provenance: { source: "A2A_FIREWALL_BRIDGE", a2a_id: a2aId, producer_identity: "TOLA_WHATSAPP", canon_revision: this.canonRevision },
      completed_at: null,
    }).job;
    const reasoningAction = this.store.beginAction(reasoning.job_id, envelope.idempotency_key);
    if (!reasoningAction.execute) return { duplicate: true, job_id: source.job_id, a2a_id: a2aId, duplicate_execution: false, duplicate_reply: false };
    this.store.event(reasoning.job_id, "A2A_FIREWALL_ACCEPTED", { A2A_ID: a2aId, producer_identity: "TOLA_WHATSAPP", canon_revision: this.canonRevision, surface_permission: envelope.surface_permission });
    let privateMedia = null;
    let capabilityError = null;
    try { privateMedia = await this.executePrivateMedia(source, envelope, media); }
    catch (error) { capabilityError = error; }
    const outcome = privateMedia ? {
      result: {
        A2A_ID: envelope.A2A_ID,
        OPPORTUNITY_ID: envelope.OPPORTUNITY_ID,
        WANT_ID: envelope.WANT_ID,
        RELATIONSHIP_ID: envelope.RELATIONSHIP_ID,
        CHANNEL_THREAD_ID: envelope.CHANNEL_THREAD_ID,
        provider_message_id: envelope.provider_message_id,
        producer_identity: envelope.producer_identity,
        recipient_identity: envelope.recipient_identity,
        CANON_REVISION: envelope.CANON_REVISION,
        reasoning_result_ref: privateMedia.openai_response_id
          ? `openai:response:${privateMedia.openai_response_id}`
          : `artifact:${privateMedia.artifact.sha256}`,
        openai_response_id: privateMedia.openai_response_id,
        previous_response_id: this.priorResponse(envelope.TRANSACTION_ID, reasoning.job_id),
        reasoning_output: privateMedia.reply,
        next_action: "TOLA_DELIVER_PRIVATE_MEDIA_TO_ORIGINAL_WHATSAPP_THREAD",
        capability_execution_job_id: privateMedia.execution_job_id,
        capability_receipt_id: privateMedia.execution_receipt_id,
        generation_id: privateMedia.generation_id,
        generation_provider: privateMedia.generation_provider,
        generation_model: privateMedia.generation_model,
        receipt: { idempotency_key: envelope.idempotency_key, status: "COMPLETED", execution_count: 1, completed_at: now() },
        terminal_state: "EXECUTED",
        terminal_evidence: { executor_invoked: "OPENAI_COMMAND_TOWER_RUNTIME", authority_result: "EXACT_PRIVATE_CREATION_AUTHORIZED", external_action_performed: `PRIVATE_${privateMedia.plan.type.toUpperCase()}_CREATED`, downstream_effects_authorized: true },
      },
      evidence: [{
        type: "A2A_CAPABILITY_EXECUTION_RESULT",
        verified: true,
        openai_response_id: privateMedia.openai_response_id,
        capability: PRIVATE_MEDIA_CAPABILITY_VERSION,
        capability_execution_job_id: privateMedia.execution_job_id,
        capability_receipt_id: privateMedia.execution_receipt_id,
        artifact_sha256: privateMedia.artifact.sha256,
        media_type: privateMedia.plan.type,
        tola_contract_revision: TOLA_BEHAVIOR_CONTRACT_REVISION,
        at: now(),
      }],
    } : capabilityError ? {
      result: {
        A2A_ID: envelope.A2A_ID,
        OPPORTUNITY_ID: envelope.OPPORTUNITY_ID,
        WANT_ID: envelope.WANT_ID,
        RELATIONSHIP_ID: envelope.RELATIONSHIP_ID,
        CHANNEL_THREAD_ID: envelope.CHANNEL_THREAD_ID,
        provider_message_id: envelope.provider_message_id,
        producer_identity: envelope.producer_identity,
        recipient_identity: envelope.recipient_identity,
        CANON_REVISION: envelope.CANON_REVISION,
        reasoning_result_ref: `capability-failure:${shortHash(`${envelope.A2A_ID}:${safeError(capabilityError)}`)}`,
        openai_response_id: null,
        previous_response_id: this.priorResponse(envelope.TRANSACTION_ID, reasoning.job_id),
        reasoning_output: capabilityFailureReply(capabilityError),
        next_action: "RETURN_EXACT_CAPABILITY_BLOCK_TO_ORIGINAL_WHATSAPP_THREAD",
        receipt: { idempotency_key: envelope.idempotency_key, status: "COMPLETED_WITH_BLOCK", execution_count: 1, completed_at: now() },
        terminal_state: "WAITING_DEPENDENCY",
        terminal_evidence: { executor_invoked: "OPENAI_COMMAND_TOWER_RUNTIME", authority_result: "AUTHORIZED_EXECUTION_FAILED", external_action_performed: "NONE", downstream_effects_authorized: false, error: safeError(capabilityError) },
      },
      evidence: [{ type: "A2A_CAPABILITY_EXECUTION_BLOCKED", verified: true, error: safeError(capabilityError), capability: PRIVATE_MEDIA_CAPABILITY_VERSION, at: now() }],
    } : await this.reason(reasoning, source, media);
    this.store.finishAction(reasoning.job_id, envelope.idempotency_key, outcome.result, outcome.evidence);
    this.store.updateJob(reasoning.job_id, { state: "COMPLETED", completed_at: now(), result: outcome.result, evidence: outcome.evidence, terminal_state: outcome.result.terminal_state, terminal_evidence: outcome.result.terminal_evidence });
    this.store.appendEffect("RESPONSE_RECEIVED", { job_id: reasoning.job_id, opportunity_id: opportunityId, want_id: wantId, producer_identity: "TOLA_WHATSAPP", destination: "TOLA_WHATSAPP", counterparty: "OPENAI_COMMAND_TOWER_RUNTIME", authority_state: privateMedia ? "EXACT_PRIVATE_CREATION_AUTHORIZED" : capabilityError ? "AUTHORIZED_EXECUTION_FAILED" : "REASONING_ONLY_ALLOWED", message_ref: { A2A_ID: a2aId, reasoning_result_ref: outcome.result.reasoning_result_ref }, next_action: outcome.result.next_action, evidence_ref: `a2a-result:${a2aId}:${outcome.result.openai_response_id || shortHash(outcome.result.reasoning_result_ref)}` });

    const reply = isOpening(intent) ? DEFAULT_REPLY : isCapabilityQuestion(intent) ? CAPABILITY_REPLY : normalizeReply(outcome.result.reasoning_output);
    const sendKey = privateMedia
      ? `whatsapp:send-media:${PRIVATE_MEDIA_CAPABILITY_VERSION}:${reference.agent_id}:${shortHash(reference.action_id)}`
      : `whatsapp:send:${reference.agent_id}:${shortHash(reference.action_id)}`;
    const sendAction = this.store.beginAction(source.job_id, sendKey);
    if (!sendAction.execute) return { duplicate: true, job_id: source.job_id, a2a_id: a2aId, duplicate_execution: false, duplicate_reply: false };
    let sent;
    if (privateMedia) {
      const uploaded = await this.uploadMedia(privateMedia.artifact.bytes, { mimeType: privateMedia.artifact.mime_type, filename: privateMedia.artifact.filename });
      sent = await this.sendMediaReply(reference, privateMedia.plan.type, uploaded.media_id, reply);
    } else {
      sent = await this.sendReply(reference, reply);
    }
    const sendResult = { status: "WHATSAPP_REPLY_ACCEPTED", inbound_provider_message_id: reference.message_id, outbound_provider_message_id: sent.provider_message_id, relationship_id: reference.relationship_id, channel_thread_id: reference.thread_id, A2A_ID: a2aId, OPPORTUNITY_ID: opportunityId, WANT_ID: wantId, job_id: source.job_id, reasoning_job_id: reasoning.job_id, openai_response_id: outcome.result.openai_response_id, muse_response_id: outcome.result.muse_response_id || null, reasoning_result_ref: outcome.result.reasoning_result_ref, receipt_id: sendKey, delivery_state: "accepted", duplicate_execution: false, duplicate_reply: false, chairman_availability: this.store.availability("CHAIRMAN_LOCAL").state, ...(privateMedia ? { capability_execution_job_id: privateMedia.execution_job_id, capability_receipt_id: privateMedia.execution_receipt_id, media_delivery: { type: privateMedia.plan.type, mime_type: privateMedia.artifact.mime_type, size_bytes: privateMedia.artifact.size_bytes, sha256: privateMedia.artifact.sha256, artifact_ref: privateMedia.artifact.artifact_ref, generation_id: outcome.result.generation_id || null, generation_provider: outcome.result.generation_provider || null, generation_model: outcome.result.generation_model || null, duration_seconds: privateMedia.artifact.duration_seconds || null, resolution: privateMedia.artifact.resolution || null, codec: privateMedia.artifact.codec || null, frame_difference: privateMedia.artifact.frame_difference || null, provider_generated_frames: privateMedia.artifact.provider_generated_frames || false, local_motion_synthesis: privateMedia.artifact.local_motion_synthesis || false, provider_media_id_persisted: false } } : {}) };
    const sendEvidence = [
      ...(privateMedia ? [
        { type: "TOLA_PRIVATE_MEDIA_DELIVERED", verified: true, media_type: privateMedia.plan.type, artifact_sha256: privateMedia.artifact.sha256, size_bytes: privateMedia.artifact.size_bytes, mime_type: privateMedia.artifact.mime_type, generation_id: outcome.result.generation_id || null, duration_seconds: privateMedia.artifact.duration_seconds || null, resolution: privateMedia.artifact.resolution || null, codec: privateMedia.artifact.codec || null, frame_difference: privateMedia.artifact.frame_difference || null, provider_generated_frames: privateMedia.artifact.provider_generated_frames || false, local_motion_synthesis: privateMedia.artifact.local_motion_synthesis || false, provider_media_id_persisted: false },
        { type: "TOLA_WHATSAPP_MEDIA_UPLOADED", verified: true, media_type: privateMedia.plan.type, artifact_sha256: privateMedia.artifact.sha256, provider_media_id_persisted: false },
      ] : []),
      { type: "TOLA_WHATSAPP_SEND_ACCEPTED", verified: true, inbound_provider_message_id: reference.message_id, outbound_provider_message_id: sent.provider_message_id, relationship_id: reference.relationship_id, same_thread: sent.recipient_id === reference.participant_id, quoted_message: false, at: now() },
    ];
    this.store.finishAction(source.job_id, sendKey, sendResult, sendEvidence);
    this.store.updateJob(source.job_id, { result: { ...inboundResult, outbound: sendResult, outbound_receipt_id: sendKey }, evidence: [...source.evidence, ...sendEvidence] });
    this.store.event(source.job_id, "TOLA_WHATSAPP_REPLY_SENT", sendResult);
    this.store.appendEffect("OUTBOUND_SENT", { job_id: source.job_id, opportunity_id: opportunityId, want_id: wantId, producer_identity: "TOLA_WHATSAPP", channel: "whatsapp", destination: reference.relationship_id, counterparty: "TOLA", authority_state: "EXACT_PRIVATE_REPLY_AUTHORIZED", message_ref: { inbound_provider_message_id: reference.message_id, outbound_provider_message_id: sent.provider_message_id, relationship_id: reference.relationship_id }, evidence_ref: `whatsapp-send:${sent.provider_message_id}`, media_type: privateMedia?.plan.type || null });
    if (privateMedia?.artifact?.bytes) privateMedia.artifact.bytes.fill(0);
    if (media?.bytes) media.bytes.fill(0);
    return { duplicate: false, job_id: source.job_id, reasoning_job_id: reasoning.job_id, a2a_id: a2aId, provider_message_id: sent.provider_message_id, openai_response_id: outcome.result.openai_response_id, receipt_id: sendKey };
  }

  async rejectCredentialMessage(reference) {
    const a2aId = `tola-wa-${shortHash(`${reference.agent_id}:${reference.action_id}`)}`;
    const safeIntent = "[Credential-bearing private message rejected before persistence]";
    const result = {
      status: "CREDENTIAL_INPUT_REJECTED",
      inbound_provider_message_id: reference.message_id,
      relationship_id: reference.relationship_id,
      A2A_ID: a2aId,
      terminal_state: "EXECUTED",
      terminal_evidence: {
        executor_invoked: "TOLA_WHATSAPP_CLOUD_RECEIVER",
        external_action_performed: "PRIVATE_SAFETY_REPLY_ONLY",
        authority_result: "RAW_CREDENTIAL_PERSISTENCE_DENIED",
      },
    };
    const source = this.store.createJob({
      worker_type: "TOLA_WHATSAPP_INBOUND",
      owner: "TOLA_WHATSAPP",
      intent: safeIntent,
      success_condition: "Credential-shaped content is not persisted or transmitted",
      idempotency_key: reference.action_id,
      priority: 100,
      constraints: {
        actionable: false,
        channel: "whatsapp",
        whatsapp_reference: reference,
        content_persisted: false,
      },
      provenance: {
        source: "WHATSAPP_AGENT_PLATFORM",
        relationship_id: reference.relationship_id,
        provider_message_id: reference.message_id,
        canon_revision: this.canonRevision,
      },
      result,
      evidence: [{
        type: "TOLA_WHATSAPP_CREDENTIAL_INPUT_REJECTED",
        verified: true,
        provider_message_id: reference.message_id,
        raw_content_persisted: false,
        raw_content_transmitted: false,
        at: now(),
      }],
      terminal_state: "EXECUTED",
    }).job;
    const inboundAction = this.store.beginAction(source.job_id, reference.action_id);
    if (inboundAction.execute) this.store.finishAction(source.job_id, reference.action_id, result, source.evidence);
    const sendKey = `whatsapp:send:${reference.agent_id}:${shortHash(reference.action_id)}`;
    const sendAction = this.store.beginAction(source.job_id, sendKey);
    if (!sendAction.execute) {
      return { duplicate: true, job_id: source.job_id, a2a_id: a2aId, duplicate_execution: false, duplicate_reply: false };
    }
    const reply = "For your security, don’t send API keys or passwords here. Remove it from the chat if possible, then tell me the result you want.";
    const sent = await this.sendReply(reference, reply);
    const sendResult = {
      ...result,
      outbound_provider_message_id: sent.provider_message_id,
      receipt_id: sendKey,
      delivery_state: "accepted",
      duplicate_execution: false,
      duplicate_reply: false,
    };
    const evidence = [{
      type: "TOLA_WHATSAPP_SEND_ACCEPTED",
      verified: true,
      outbound_provider_message_id: sent.provider_message_id,
      same_thread: sent.recipient_id === reference.participant_id,
      at: now(),
    }];
    this.store.finishAction(source.job_id, sendKey, sendResult, evidence);
    this.store.updateJob(source.job_id, { result: { ...result, outbound: sendResult, outbound_receipt_id: sendKey }, evidence: [...source.evidence, ...evidence] });
    this.store.appendEffect("OUTBOUND_SENT", {
      job_id: source.job_id,
      producer_identity: "TOLA_WHATSAPP",
      channel: "whatsapp",
      destination: reference.relationship_id,
      authority_state: "EXACT_PRIVATE_REPLY_AUTHORIZED",
      message_ref: {
        inbound_provider_message_id: reference.message_id,
        outbound_provider_message_id: sent.provider_message_id,
        relationship_id: reference.relationship_id,
      },
      evidence_ref: `whatsapp-send:${sent.provider_message_id}`,
    });
    return { duplicate: false, job_id: source.job_id, a2a_id: a2aId, provider_message_id: sent.provider_message_id, receipt_id: sendKey, rejected_credential_input: true };
  }

  processStatuses(statuses = []) {
    let updated = 0;
    const receipts = this.store.db.prepare("SELECT * FROM action_receipts WHERE (idempotency_key LIKE 'whatsapp:send:%' OR idempotency_key LIKE 'whatsapp:send-media:%') AND status='COMPLETED'").all();
    for (const status of statuses) {
      const row = receipts.find(item => parse(item.result, {})?.outbound_provider_message_id === status.id);
      if (!row) continue;
      const result = parse(row.result, {}), evidence = parse(row.evidence, []);
      if (evidence.some(item => item.type === "TOLA_WHATSAPP_DELIVERY_STATUS" && item.status === status.status && item.timestamp === status.timestamp)) continue;
      evidence.push({ type: "TOLA_WHATSAPP_DELIVERY_STATUS", verified: true, provider_message_id: status.id, status: status.status, timestamp: status.timestamp });
      this.store.finishAction(row.job_id, row.idempotency_key, { ...result, delivery_state: status.status, delivery_verified: ["delivered", "read"].includes(status.status) }, evidence);
      updated += 1;
    }
    return updated;
  }

  async processPayload(payload) {
    const outcomes = [];
    for (const entry of payload?.entry || []) {
      const agentId = String(entry.id || "");
      if (this.cursor.agent_id && this.cursor.agent_id !== agentId) throw new Error("WHATSAPP_AGENT_ID_CHANGED");
      this.cursor.agent_id = agentId;
      for (const change of entry.changes || []) {
        const value = change.value || {};
        for (const message of value.messages || []) outcomes.push(await this.handleMessage(agentId, message, value.contacts || []));
        this.processStatuses(value.statuses || []);
      }
    }
    if (Number.isSafeInteger(payload?.next_offset)) this.cursor.next_offset = payload.next_offset;
    this.cursor.updated_at = now();
    this.store.setCursor(this.cursor);
    return outcomes;
  }

  async pollOnce() {
    const recovered = await this.recoverRenTransactions();
    const query = new URLSearchParams({ limit: "50", timeout: "25" });
    if (Number.isSafeInteger(this.cursor.next_offset)) query.set("offset", String(this.cursor.next_offset));
    const response = await this.provider(`/updates?${query}`, { timeoutMs: 40000 });
    this.lastPollAt = now();
    this.store.heartbeat("OPENAI_COMMAND_TOWER_RUNTIME", "ONLINE", { receiver: "TOLA_WHATSAPP", canon_revision: this.canonRevision, enabled: this.enabled });
    if (response.status === 204) return recovered;
    const outcomes = await this.processPayload(response.body);
    await this.recoverRenTransactions();
    return outcomes;
  }

  async start() {
    if (!this.enabled) return;
    this.assertConfig();
    this.running = true;
    let backoff = 1000;
    while (this.running) {
      try {
        await this.pollOnce();
        this.lastError = null;
        backoff = 1000;
      } catch (error) {
        this.lastError = safeError(error);
        this.store.heartbeat("OPENAI_COMMAND_TOWER_RUNTIME", "DEGRADED", { receiver: "TOLA_WHATSAPP", last_error: this.lastError, enabled: true });
        process.stderr.write(`${this.lastError}\n`);
        await new Promise(resolve => setTimeout(resolve, backoff));
        backoff = Math.min(30000, backoff * 2);
      }
    }
  }
}

export function createTolaCloudRuntime(options) {
  const runtime = new TolaCloudRuntime(options);
  runtime.mount();
  return runtime;
}

export { CloudStore, IDENTITIES, TolaCloudRuntime, isMountedPath, sha256 };
