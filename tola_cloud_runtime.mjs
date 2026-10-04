import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const PROVIDER_BASE = "https://api.whatsapp.com/agent/v1";
const OPENAI_URL = "https://api.openai.com/v1/responses";
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
const DEFAULT_REPLY = "Tell me what you want. I’ll work out the rest.";
const CAPABILITY_REPLY = "Tell me the result you want. I’ll work out what needs to happen and take it from there. If I need anything from you, I’ll ask.";

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
  const text = String(value || "").trim().toLowerCase().replace(/[^a-z0-9' ]+/g, " ").replace(/\s+/g, " ");
  return text.length <= 220 && /^(?:so )?(?:what can you do|what are you able to do|can you help me|can you actually do things for me|how can you help)(?: for me)?$/.test(text);
}

function normalizeReply(value, fallback = DEFAULT_REPLY) {
  const reply = String(value || "")
    .replace(/\b(?:OPENAI_COMMAND_TOWER_RUNTIME|CHAIRMAN_LOCAL|MUSE_REN|A2A_FIREWALL)\b/g, "TOLA")
    .trim()
    .slice(0, 4096);
  if (!reply) return fallback;
  if (/\b(?:i(?:'m| am) an ai assistant|i can(?:not|'t) take real[- ]world actions|i can only help you think|if you want, i can)\b/i.test(reply)) return fallback;
  return reply;
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

  finishAction(jobId, key, result, evidence = []) {
    this.db.prepare("UPDATE action_receipts SET status='COMPLETED',result=?,evidence=?,completed_at=? WHERE idempotency_key=? AND job_id=?")
      .run(JSON.stringify(result), JSON.stringify(evidence), now(), key, jobId);
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

  cursor() {
    try { return JSON.parse(fs.readFileSync(this.cursorFile, "utf8")); }
    catch { return { next_offset: null, agent_id: null, updated_at: null }; }
  }

  setCursor(cursor) { atomicJson(this.cursorFile, cursor); }
}

class TolaCloudRuntime {
  constructor({ app, env = process.env, fetchImpl = globalThis.fetch } = {}) {
    this.app = app;
    this.env = env;
    this.fetch = fetchImpl;
    this.enabled = /^(?:1|true|yes|on)$/i.test(String(env.TOLA_CLOUD_ENABLED || ""));
    this.token = env.TOLA_WHATSAPP_API_KEY || "";
    this.apiKey = env.OPENAI_API_KEY || "";
    this.adminToken = env.TOLA_CLOUD_ADMIN_TOKEN || "";
    this.localNodeToken = env.TOLA_LOCAL_NODE_TOKEN || "";
    this.model = env.OPENAI_COMMAND_TOWER_MODEL || "gpt-5.4-mini";
    this.canonRevision = env.CANON_REVISION || "CANON_SHA256:5005421761af682b1b623b43e5d04f3cb38fe9084d72ab18226b5987cc88a358";
    this.stateDir = env.TOLA_STATE_DIR || "/tmp/chairman-cloud-state";
    this.store = new CloudStore(this.stateDir);
    this.running = false;
    this.cursor = this.store.cursor();
    this.lastPollAt = null;
    this.lastError = null;
    this.transientMedia = new Map();
  }

  assertConfig() {
    if (!this.token) throw new Error("TOLA_WHATSAPP_API_KEY_MISSING");
    if (!this.apiKey) throw new Error("OPENAI_API_KEY_MISSING");
    if (!this.adminToken || !this.localNodeToken) throw new Error("TOLA_CLOUD_CONTROL_TOKEN_MISSING");
    if (!/^CANON_SHA256:[a-f0-9]{64}$/.test(this.canonRevision)) throw new Error("CANON_REVISION_INVALID");
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
      });
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
      const receiptId = `local-reconcile:${sha256(keys).slice(0, 40)}`;
      const result = { completed, incomplete: keys.filter(key => !completed.includes(key)), duplicate_execution_count: 0, reconciled_at: now() };
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
    else if (message.type === "video") processingPath = "VIDEO_CONTENT_PROCESSING_UNAVAILABLE";
    else if (message.type === "audio") processingPath = "AUDIO_CONTENT_PROCESSING_UNAVAILABLE";
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

  async reason(job, source, media) {
    const envelope = job.constraints.a2a_envelope;
    this.validateEnvelope(envelope, source);
    const previousResponseId = this.priorResponse(envelope.TRANSACTION_ID, job.job_id);
    const inputEnvelope = {
      A2A_ID: envelope.A2A_ID, OPPORTUNITY_ID: envelope.OPPORTUNITY_ID, WANT_ID: envelope.WANT_ID,
      TRANSACTION_ID: envelope.TRANSACTION_ID, RELATIONSHIP_ID: envelope.RELATIONSHIP_ID,
      producer_identity: envelope.producer_identity, action_class: envelope.action_class,
      payload: source.intent,
      capability_truth: {
        cloud_reasoning: true, whatsapp_private_reply: true,
        chairman_local: this.store.availability("CHAIRMAN_LOCAL").state,
        consequential_actions: "EXACT_AUTHORITY_AND_PAI_REQUIRED",
      },
      media_processing: media ? { type: media.type, mime_type: media.mime_type, size_bytes: media.size_bytes, sha256: media.sha256, processing_path: media.processing_path } : null,
    };
    const inputText = JSON.stringify(inputEnvelope);
    let input = inputText;
    if (media?.processing_path === "OPENAI_INPUT_IMAGE") input = [{ role: "user", content: [{ type: "input_text", text: inputText }, { type: "input_image", image_url: `data:${media.mime_type};base64,${media.bytes.toString("base64")}`, detail: "high" }] }];
    else if (media?.processing_path === "OPENAI_INPUT_FILE") input = [{ role: "user", content: [{ type: "input_text", text: inputText }, { type: "input_file", filename: media.filename, file_data: `data:${media.mime_type};base64,${media.bytes.toString("base64")}` }] }];
    const request = {
      model: this.model,
      store: true,
      instructions: [
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
      metadata: { a2a_id: envelope.A2A_ID, opportunity_id: envelope.OPPORTUNITY_ID, producer: envelope.producer_identity, canon_revision: sha256(envelope.CANON_REVISION) },
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
        previous_response_id: previousResponseId, reasoning_output: output,
        next_action: "TOLA_REPLY_TO_ORIGINAL_WHATSAPP_THREAD",
        receipt: { idempotency_key: envelope.idempotency_key, status: "COMPLETED", execution_count: 1, completed_at: now() },
        terminal_state: "EXECUTED",
        terminal_evidence: { executor_invoked: "OPENAI_COMMAND_TOWER_RUNTIME", authority_result: "REASONING_ONLY_ALLOWED", external_action_performed: "NONE_REASONING_RESULT_ONLY", downstream_effects_authorized: false },
      },
      evidence: [{ type: "A2A_OPENAI_RESPONSES_RESULT", verified: true, openai_response_id: body.id, previous_response_id: previousResponseId, model: this.model, media_supplied: ["OPENAI_INPUT_IMAGE", "OPENAI_INPUT_FILE"].includes(media?.processing_path), request_sha256: sha256(request), at: now() }],
    };
  }

  async sendReply(reference, text) {
    const response = await this.provider("/messages", { method: "POST", body: { messaging_product: "whatsapp", to: reference.participant_id, type: "text", context: { message_id: reference.message_id }, text: { body: text, preview_url: false } }, timeoutMs: 60000 });
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
      constraints: { actionable: false, channel: "whatsapp", whatsapp_reference: reference, whatsapp_media: mediaMetadata, PAI: { identity: "TOLA_WHATSAPP", authorized: true, scopes: ["A2A_REASONING", "WHATSAPP_PRIVATE_REPLY"], exact_recipient: reference.participant_id, exact_message_id: reference.message_id }, authority: { authorized: true, scopes: ["A2A_REASONING", "WHATSAPP_PRIVATE_REPLY"], exact_recipient: reference.participant_id, exact_thread: reference.thread_id, exact_message_id: reference.message_id, denied_effects: ["bulk_outreach", "public_distribution", "spending", "payment"] } },
      provenance: { source: "WHATSAPP_AGENT_PLATFORM", relationship_id: reference.relationship_id, provider_message_id: reference.message_id, canon_revision: this.canonRevision },
      result: inboundResult, evidence: [{ type: "TOLA_WHATSAPP_RECEIVED", verified: true, provider_message_id: reference.message_id, relationship_id: reference.relationship_id, at: now() }, ...(media ? [{ type: "TOLA_WHATSAPP_MEDIA_FETCHED", verified: true, mime_type: media.mime_type, size_bytes: media.size_bytes, sha256: media.sha256, bytes_persisted: false }] : [])], terminal_state: "EXECUTED",
    }).job;
    const inboundAction = this.store.beginAction(source.job_id, reference.action_id);
    if (inboundAction.execute) this.store.finishAction(source.job_id, reference.action_id, inboundResult, source.evidence);
    this.store.appendEffect("RESPONSE_RECEIVED", { job_id: source.job_id, opportunity_id: opportunityId, want_id: wantId, producer_identity: "TOLA_WHATSAPP", channel: "whatsapp", message_ref: { inbound_provider_message_id: reference.message_id, relationship_id: reference.relationship_id }, authority_state: "PRIVATE_MESSAGE_ACCEPTED", evidence_ref: `whatsapp-inbound:${reference.action_id}` });

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
    const outcome = await this.reason(reasoning, source, media);
    this.store.finishAction(reasoning.job_id, envelope.idempotency_key, outcome.result, outcome.evidence);
    this.store.updateJob(reasoning.job_id, { state: "COMPLETED", completed_at: now(), result: outcome.result, evidence: outcome.evidence, terminal_state: "EXECUTED", terminal_evidence: outcome.result.terminal_evidence });
    this.store.appendEffect("RESPONSE_RECEIVED", { job_id: reasoning.job_id, opportunity_id: opportunityId, want_id: wantId, producer_identity: "TOLA_WHATSAPP", destination: "TOLA_WHATSAPP", counterparty: "OPENAI_COMMAND_TOWER_RUNTIME", authority_state: "REASONING_ONLY_ALLOWED", message_ref: { A2A_ID: a2aId, reasoning_result_ref: outcome.result.reasoning_result_ref }, next_action: outcome.result.next_action, evidence_ref: `a2a-result:${a2aId}:${outcome.result.openai_response_id}` });

    const reply = isOpening(intent) ? DEFAULT_REPLY : isCapabilityQuestion(intent) ? CAPABILITY_REPLY : normalizeReply(outcome.result.reasoning_output);
    const sendKey = `whatsapp:send:${reference.agent_id}:${shortHash(reference.action_id)}`;
    const sendAction = this.store.beginAction(source.job_id, sendKey);
    if (!sendAction.execute) return { duplicate: true, job_id: source.job_id, a2a_id: a2aId, duplicate_execution: false, duplicate_reply: false };
    const sent = await this.sendReply(reference, reply);
    const sendResult = { status: "WHATSAPP_REPLY_ACCEPTED", inbound_provider_message_id: reference.message_id, outbound_provider_message_id: sent.provider_message_id, relationship_id: reference.relationship_id, channel_thread_id: reference.thread_id, A2A_ID: a2aId, OPPORTUNITY_ID: opportunityId, WANT_ID: wantId, job_id: source.job_id, reasoning_job_id: reasoning.job_id, openai_response_id: outcome.result.openai_response_id, reasoning_result_ref: outcome.result.reasoning_result_ref, receipt_id: sendKey, delivery_state: "accepted", duplicate_execution: false, duplicate_reply: false, chairman_availability: this.store.availability("CHAIRMAN_LOCAL").state };
    const sendEvidence = [{ type: "TOLA_WHATSAPP_SEND_ACCEPTED", verified: true, inbound_provider_message_id: reference.message_id, outbound_provider_message_id: sent.provider_message_id, relationship_id: reference.relationship_id, same_thread: sent.recipient_id === reference.participant_id, at: now() }];
    this.store.finishAction(source.job_id, sendKey, sendResult, sendEvidence);
    this.store.updateJob(source.job_id, { result: { ...inboundResult, outbound: sendResult, outbound_receipt_id: sendKey }, evidence: [...source.evidence, ...sendEvidence] });
    this.store.event(source.job_id, "TOLA_WHATSAPP_REPLY_SENT", sendResult);
    this.store.appendEffect("OUTBOUND_SENT", { job_id: source.job_id, opportunity_id: opportunityId, want_id: wantId, producer_identity: "TOLA_WHATSAPP", channel: "whatsapp", destination: reference.relationship_id, counterparty: "TOLA", authority_state: "EXACT_PRIVATE_REPLY_AUTHORIZED", message_ref: { inbound_provider_message_id: reference.message_id, outbound_provider_message_id: sent.provider_message_id, relationship_id: reference.relationship_id }, evidence_ref: `whatsapp-send:${sent.provider_message_id}` });
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
    const receipts = this.store.db.prepare("SELECT * FROM action_receipts WHERE idempotency_key LIKE 'whatsapp:send:%' AND status='COMPLETED'").all();
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
    const query = new URLSearchParams({ limit: "50", timeout: "25" });
    if (Number.isSafeInteger(this.cursor.next_offset)) query.set("offset", String(this.cursor.next_offset));
    const response = await this.provider(`/updates?${query}`, { timeoutMs: 40000 });
    this.lastPollAt = now();
    this.store.heartbeat("OPENAI_COMMAND_TOWER_RUNTIME", "ONLINE", { receiver: "TOLA_WHATSAPP", canon_revision: this.canonRevision, enabled: this.enabled });
    if (response.status === 204) return [];
    return this.processPayload(response.body);
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
