import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { TolaCloudRuntime, isMountedPath, sha256 } from "../tola_cloud_runtime.mjs";

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

test("persistence status requires a real non-root mount", () => {
  const mountInfo = [
    "29 23 0:25 / / rw,relatime - overlay overlay rw",
    "41 29 8:1 / /var/data/chairman rw,relatime - ext4 /dev/sda1 rw",
  ].join("\n");
  assert.equal(isMountedPath("/var/data/chairman", mountInfo), true);
  assert.equal(isMountedPath("/tmp/chairman-cloud-state", mountInfo), false);
  assert.equal(isMountedPath("/var/data/chairman/jobs", mountInfo), true);
  assert.equal(isMountedPath("/unmounted/path", "29 23 0:25 / / rw,relatime - overlay overlay rw"), false);
});

test("private inbound replay produces one reasoning call and one reply", async t => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "tola-cloud-test-"));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const calls = { openai: 0, send: 0 };
  const fetchImpl = async (url, options = {}) => {
    if (String(url).includes("api.openai.com/v1/responses")) {
      calls.openai += 1;
      return jsonResponse(200, { id: "resp_cloud_test_1", output_text: "I found the harmless result and brought it back here." });
    }
    if (String(url).endsWith("/messages")) {
      calls.send += 1;
      const request = JSON.parse(options.body);
      assert.equal(request.to, "user:15550001111");
      assert.equal(request.context, undefined);
      return jsonResponse(200, { contacts: [{ wa_id: "user:15550001111" }], messages: [{ id: "wamid.outbound-cloud-test" }] });
    }
    throw new Error(`unexpected URL ${url}`);
  };
  const runtime = new TolaCloudRuntime({
    app: {},
    fetchImpl,
    env: {
      TOLA_CLOUD_ENABLED: "0",
      TOLA_STATE_DIR: stateDir,
      TOLA_WHATSAPP_API_KEY: "test-provider-token",
      OPENAI_API_KEY: "test-openai-token",
      TOLA_CLOUD_ADMIN_TOKEN: "test-admin-token",
      TOLA_LOCAL_NODE_TOKEN: "test-local-token",
      CANON_REVISION: "CANON_SHA256:5005421761af682b1b623b43e5d04f3cb38fe9084d72ab18226b5987cc88a358",
    },
  });
  const message = { id: "wamid.inbound-cloud-test", from: "user:15550001111", type: "text", text: { body: "Find the current time in Los Angeles." } };
  const first = await runtime.handleMessage("123456", message, []);
  assert.equal(first.duplicate, false);
  assert.equal(first.provider_message_id, "wamid.outbound-cloud-test");
  assert.equal(first.openai_response_id, "resp_cloud_test_1");
  const replay = await runtime.handleMessage("123456", message, []);
  assert.equal(replay.duplicate, true);
  assert.equal(replay.duplicate_execution, false);
  assert.equal(replay.duplicate_reply, false);
  assert.deepEqual(calls, { openai: 1, send: 1 });
  const source = runtime.store.get(first.job_id);
  assert.equal(source.constraints.whatsapp_reference.producer_identity, "TOLA_WHATSAPP");
  assert.equal(source.result.outbound.relationship_id, source.constraints.whatsapp_reference.relationship_id);
  assert.equal(source.checkpoint.duplicate_count, 1);
  const receipt = runtime.store.receipt(first.receipt_id);
  assert.equal(receipt.status, "COMPLETED");
  assert.equal(receipt.result.duplicate_execution, false);
});

test("clear video WANT uses a genuine provider route and replay performs no duplicate work", async t => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "tola-cloud-video-"));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const videoBytes = Buffer.concat([Buffer.alloc(4), Buffer.from("ftypisom"), Buffer.alloc(1024, 2)]);
  const calls = { openai: 0, generations: 0, validations: 0, uploads: 0, sends: 0 };
  const outbound = [];
  const fetchImpl = async (url, options = {}) => {
    const target = String(url);
    if (target.includes("api.openai.com/v1/responses")) {
      calls.openai += 1;
      const request = JSON.parse(options.body);
      assert.match(String(request.input), /flying dog/i);
      assert.equal(request.tools, undefined);
      return jsonResponse(200, { id: "resp_private_video_1", output_text: "EXECUTE" });
    }
    if (target === "https://v3b.fal.media/files/test/generated.mp4") {
      return new Response(videoBytes, { status: 200, headers: { "content-type": "video/mp4" } });
    }
    if (target.endsWith("/media") && options.method === "POST") {
      calls.uploads += 1;
      assert.ok(options.body instanceof FormData);
      return jsonResponse(200, { id: "provider-media-private" });
    }
    if (target.endsWith("/messages")) {
      calls.sends += 1;
      const request = JSON.parse(options.body);
      outbound.push(request);
      return jsonResponse(200, { contacts: [{ wa_id: request.to }], messages: [{ id: "wamid.private-video-out" }] });
    }
    throw new Error(`unexpected URL ${url}`);
  };
  const videoClient = {
    subscribe: async (model, options) => {
      calls.generations += 1;
      assert.equal(model, "fal-ai/kling-video/v2.6/pro/text-to-video");
      assert.match(options.input.prompt, /genuine temporally coherent moving scene/i);
      assert.match(options.input.prompt, /flying dog/i);
      assert.equal(options.input.aspect_ratio, "9:16");
      assert.equal(options.input.start_image_url, undefined);
      options.onEnqueue("fal-generation-private-video-1");
      return {
        requestId: "fal-generation-private-video-1",
        data: { video: { content_type: "video/mp4", file_size: videoBytes.length, url: "https://v3b.fal.media/files/test/generated.mp4" } },
      };
    },
  };
  const runtime = new TolaCloudRuntime({
    app: {},
    fetchImpl,
    videoClient,
    env: {
      TOLA_STATE_DIR: stateDir,
      TOLA_WHATSAPP_API_KEY: "test-provider-token",
      OPENAI_API_KEY: "test-openai-token",
      TOLA_VIDEO_GENERATION_AUTHORIZED: "1",
      CANON_REVISION: "CANON_SHA256:5005421761af682b1b623b43e5d04f3cb38fe9084d72ab18226b5987cc88a358",
    },
  });
  runtime.validateAndPersistGenuineVideo = async bytes => {
    calls.validations += 1;
    assert.deepEqual(bytes, videoBytes);
    return {
      bytes: Buffer.from(videoBytes), artifact_ref: "deliverable:test", artifact_path: "/var/data/chairman/deliverables/tola/test.mp4",
      mime_type: "video/mp4", filename: "tola-created-video.mp4", sha256: sha256(videoBytes), size_bytes: videoBytes.length,
      duration_seconds: 5, width: 720, height: 1280, resolution: "720x1280", codec: "h264",
      frame_difference: { passed: true, sampled_frames: 10, mean_absolute_difference: 12.5, changed_pixel_ratio: 0.42, local_motion_synthesis: false, repeated_still_rejected: true },
      provider_generated_frames: true, local_motion_synthesis: false,
    };
  };
  const message = { id: "wamid.private-video-in", from: "user:15550001111", type: "text", text: { body: "Create a realistic video of a flying dog. Just do something." } };
  const first = await runtime.handleMessage("123456", message, []);
  assert.equal(first.duplicate, false);
  assert.equal(first.openai_response_id, "resp_private_video_1");
  assert.deepEqual(calls, { openai: 1, generations: 1, validations: 1, uploads: 1, sends: 1 });
  assert.equal(outbound[0].type, "video");
  assert.equal(outbound[0].context, undefined);
  assert.equal(outbound[0].video.caption, "Done — I created the video.");
  const source = runtime.store.get(first.job_id);
  assert.equal(source.result.outbound.media_delivery.type, "video");
  assert.equal(source.result.outbound.media_delivery.sha256, sha256(videoBytes));
  assert.equal(source.result.outbound.media_delivery.generation_id, "fal-generation-private-video-1");
  assert.equal(source.result.outbound.media_delivery.generation_provider, "fal");
  assert.equal(source.result.outbound.media_delivery.frame_difference.passed, true);
  assert.equal(source.result.outbound.media_delivery.local_motion_synthesis, false);
  const capabilityReceipt = runtime.store.receipt(source.result.outbound.capability_receipt_id);
  assert.equal(capabilityReceipt.status, "COMPLETED");
  assert.equal(capabilityReceipt.result.execution_count, 1);
  assert.equal(JSON.stringify(capabilityReceipt).includes("provider-media-private"), false);

  const replay = await runtime.handleMessage("123456", message, []);
  assert.equal(replay.duplicate, true);
  assert.equal(replay.duplicate_execution, false);
  assert.equal(replay.duplicate_reply, false);
  assert.deepEqual(calls, { openai: 1, generations: 1, validations: 1, uploads: 1, sends: 1 });
});

test("video WANT fails closed before image generation when genuine video is unbound", async t => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "tola-cloud-video-unbound-"));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const calls = { openai: 0, uploads: 0, sends: 0 };
  let sent = null;
  const fetchImpl = async (url, options = {}) => {
    const target = String(url);
    if (target.includes("api.openai.com")) calls.openai += 1;
    if (target.endsWith("/media")) calls.uploads += 1;
    if (target.endsWith("/messages")) {
      calls.sends += 1;
      sent = JSON.parse(options.body);
      return jsonResponse(200, { contacts: [{ wa_id: sent.to }], messages: [{ id: "wamid.video-block-out" }] });
    }
    throw new Error(`unexpected URL ${url}`);
  };
  const runtime = new TolaCloudRuntime({
    app: {}, fetchImpl,
    env: {
      TOLA_STATE_DIR: stateDir,
      TOLA_WHATSAPP_API_KEY: "test-provider-token",
      OPENAI_API_KEY: "test-openai-token",
      CANON_REVISION: "CANON_SHA256:5005421761af682b1b623b43e5d04f3cb38fe9084d72ab18226b5987cc88a358",
    },
  });
  const message = { id: "wamid.video-block-in", from: "user:15550001111", type: "text", text: { body: "Create a realistic video of a flying dog. Just do something." } };
  const first = await runtime.handleMessage("123456", message, []);
  assert.equal(first.duplicate, false);
  assert.deepEqual(calls, { openai: 0, uploads: 0, sends: 1 });
  assert.equal(sent.type, "text");
  assert.match(sent.text.body, /Real video generation isn’t connected yet/);
  assert.match(sent.text.body, /won’t fake it with an animated still/);
  assert.equal(fs.existsSync(path.join(stateDir, "deliverables", "tola")), false);
  const replay = await runtime.handleMessage("123456", message, []);
  assert.equal(replay.duplicate, true);
  assert.deepEqual(calls, { openai: 0, uploads: 0, sends: 1 });
});

test("temporal validator rejects a repeated still and accepts genuine changing frames", async t => {
  const ffmpeg = process.env.FFMPEG_PATH || "/opt/homebrew/bin/ffmpeg";
  const ffprobe = process.env.FFPROBE_PATH || "/opt/homebrew/bin/ffprobe";
  if (!fs.existsSync(ffmpeg) || !fs.existsSync(ffprobe)) return t.skip("ffmpeg/ffprobe unavailable");
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "tola-cloud-temporal-"));
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "tola-video-fixtures-"));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  t.after(() => fs.rmSync(fixtureDir, { recursive: true, force: true }));
  const staticFile = path.join(fixtureDir, "static.mp4");
  const movingFile = path.join(fixtureDir, "moving.mp4");
  execFileSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=blue:s=320x240:r=24:d=2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-y", staticFile]);
  execFileSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=24:duration=2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-y", movingFile]);
  const runtime = new TolaCloudRuntime({ app: {}, env: { TOLA_STATE_DIR: stateDir, FFMPEG_PATH: ffmpeg, FFPROBE_PATH: ffprobe } });
  await assert.rejects(() => runtime.validateAndPersistGenuineVideo(fs.readFileSync(staticFile), { idempotency_key: "static" }), /TOLA_VIDEO_TEMPORAL_VARIATION_FAILED/);
  const moving = await runtime.validateAndPersistGenuineVideo(fs.readFileSync(movingFile), { idempotency_key: "moving" });
  assert.equal(moving.codec, "h264");
  assert.equal(moving.frame_difference.passed, true);
  assert.ok(moving.frame_difference.sampled_frames >= 3);
  assert.ok(moving.frame_difference.mean_absolute_difference >= 1);
  assert.ok(moving.frame_difference.changed_pixel_ratio >= 0.02);
  assert.equal(moving.local_motion_synthesis, false);
});

test("TOLA behavior contract precedes capability reasoning and survives restart continuity", async t => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "tola-cloud-contract-"));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const requests = [];
  const sent = [];
  const fetchImpl = async (url, options = {}) => {
    if (String(url).includes("api.openai.com/v1/responses")) {
      const request = JSON.parse(options.body);
      requests.push(request);
      return jsonResponse(200, {
        id: `resp_contract_${requests.length}`,
        output_text: "I can answer questions, summarize, translate, and draft messages.",
      });
    }
    if (String(url).endsWith("/messages")) {
      const request = JSON.parse(options.body);
      sent.push(request);
      return jsonResponse(200, {
        contacts: [{ wa_id: request.to }],
        messages: [{ id: `wamid.contract-out-${sent.length}` }],
      });
    }
    throw new Error(`unexpected URL ${url}`);
  };
  const env = {
    TOLA_CLOUD_ENABLED: "0",
    TOLA_STATE_DIR: stateDir,
    TOLA_WHATSAPP_API_KEY: "test-provider-token",
    OPENAI_API_KEY: "test-openai-token",
    TOLA_CLOUD_ADMIN_TOKEN: "test-admin-token",
    TOLA_LOCAL_NODE_TOKEN: "test-local-token",
    CANON_REVISION: "CANON_SHA256:5005421761af682b1b623b43e5d04f3cb38fe9084d72ab18226b5987cc88a358",
  };
  const firstRuntime = new TolaCloudRuntime({ app: {}, fetchImpl, env });
  const first = await firstRuntime.handleMessage("123456", {
    id: "wamid.capability-u-1",
    from: "user:15550001111",
    type: "text",
    text: { body: "What can u do" },
  });
  assert.equal(first.duplicate, false);
  assert.match(requests[0].instructions, /TOLA BEHAVIOR CONTRACT TOLA_EXECUTION_LAW_2026-10-04_V3_GENUINE_VIDEO/);
  assert.match(requests[0].instructions, /CURRENT MESSAGE CLASSIFICATION: CAPABILITY QUESTION/);
  assert.match(requests[0].instructions, /Never give a generic capability list/);
  assert.equal(requests[0].metadata.tola_contract_revision, "TOLA_EXECUTION_LAW_2026-10-04_V3_GENUINE_VIDEO");
  assert.equal(sent[0].text.body, "Tell me the result you want. I’ll work out what needs to happen and take it from there. If I need anything from you, I’ll ask.");
  firstRuntime.store.db.close();

  const restartedRuntime = new TolaCloudRuntime({ app: {}, fetchImpl, env });
  const afterRestart = await restartedRuntime.handleMessage("123456", {
    id: "wamid.capability-u-2",
    from: "user:15550001111",
    type: "text",
    text: { body: "What do u do?" },
  });
  assert.equal(afterRestart.duplicate, false);
  assert.equal(requests[1].previous_response_id, "resp_contract_1");
  assert.match(requests[1].instructions, /CURRENT MESSAGE CLASSIFICATION: CAPABILITY QUESTION/);
  assert.equal(sent[1].text.body, sent[0].text.body);
  restartedRuntime.store.db.close();
});

test("hydrated image reasoning receives the same TOLA behavior contract", async t => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "tola-cloud-media-contract-"));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const bytes = Buffer.from("image-fixture");
  const digest = sha256(bytes);
  let openaiRequest = null;
  const fetchImpl = async (url, options = {}) => {
    const target = String(url);
    if (target.includes("/media/media-contract-1")) return jsonResponse(200, {
      mime_type: "image/jpeg",
      file_size: bytes.length,
      sha256: digest,
      url: "https://cdn.whatsapp.net/media-contract-1",
    });
    if (target === "https://cdn.whatsapp.net/media-contract-1") return new Response(bytes, {
      status: 200,
      headers: { "content-length": String(bytes.length) },
    });
    if (target.includes("api.openai.com/v1/responses")) {
      openaiRequest = JSON.parse(options.body);
      return jsonResponse(200, { id: "resp_media_contract_1", output_text: "I inspected the supplied image." });
    }
    if (target.endsWith("/messages")) return jsonResponse(200, {
      contacts: [{ wa_id: "user:15550001111" }],
      messages: [{ id: "wamid.media-contract-out" }],
    });
    throw new Error(`unexpected URL ${url}`);
  };
  const runtime = new TolaCloudRuntime({
    app: {},
    fetchImpl,
    env: {
      TOLA_STATE_DIR: stateDir,
      TOLA_WHATSAPP_API_KEY: "test-provider-token",
      OPENAI_API_KEY: "test-openai-token",
      CANON_REVISION: "CANON_SHA256:5005421761af682b1b623b43e5d04f3cb38fe9084d72ab18226b5987cc88a358",
    },
  });
  await runtime.handleMessage("123456", {
    id: "wamid.media-contract-in",
    from: "user:15550001111",
    type: "image",
    image: { id: "media-contract-1", mime_type: "image/jpeg", sha256: digest, caption: "Use this image for the clear WANT." },
  });
  assert.match(openaiRequest.instructions, /TOLA BEHAVIOR CONTRACT TOLA_EXECUTION_LAW_2026-10-04_V3_GENUINE_VIDEO/);
  assert.match(openaiRequest.instructions, /CURRENT MESSAGE CLASSIFICATION: WANT OR CONTINUATION/);
  assert.equal(openaiRequest.input[0].content[1].type, "input_image");
  assert.equal(openaiRequest.metadata.tola_contract_revision, "TOLA_EXECUTION_LAW_2026-10-04_V3_GENUINE_VIDEO");
});

test("a migrated local receipt suppresses a pre-cloud provider replay", async t => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "tola-cloud-migrated-replay-"));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  let externalCalls = 0;
  const runtime = new TolaCloudRuntime({
    app: {},
    fetchImpl: async () => {
      externalCalls += 1;
      throw new Error("migrated replay must not call a provider or model");
    },
    env: {
      TOLA_STATE_DIR: stateDir,
      TOLA_WHATSAPP_API_KEY: "test-provider-token",
      OPENAI_API_KEY: "test-openai-token",
    },
  });
  const message = { id: "wamid.pre-cloud-completed", from: "user:15550001111", type: "text", text: { body: "Previously completed WANT" } };
  const reference = runtime.reference("123456", message, null);
  const historical = runtime.store.createJob({
    worker_type: "HISTORICAL_TOLA_RECEIPT_IMPORT",
    owner: "TOLA_WHATSAPP",
    intent: "Preserve completed pre-cloud TOLA transaction lineage",
    success_condition: "Historical receipt is visible to cloud replay suppression",
    idempotency_key: `historical:${reference.action_id}`,
    constraints: { actionable: false, source_receipt: reference.action_id },
    result: { imported: true, terminal_state: "EXECUTED" },
    terminal_state: "EXECUTED",
  }).job;
  runtime.store.beginAction(historical.job_id, reference.action_id);
  runtime.store.finishAction(historical.job_id, reference.action_id, { imported: true }, []);
  const replay = await runtime.handleMessage("123456", message, []);
  assert.equal(replay.duplicate, true);
  assert.equal(replay.duplicate_execution, false);
  assert.equal(replay.duplicate_reply, false);
  assert.equal(replay.job_id, historical.job_id);
  assert.equal(externalCalls, 0);
});

test("firewall rejects stale Canon and consequential action without authority", async t => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "tola-cloud-firewall-"));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const runtime = new TolaCloudRuntime({ app: {}, fetchImpl: async () => { throw new Error("not called"); }, env: { TOLA_STATE_DIR: stateDir } });
  const reference = {
    provider: "WHATSAPP_AGENT_PLATFORM", channel: "whatsapp", account_identity: "TOLA", producer_identity: "TOLA_WHATSAPP",
    agent_id: "123", participant_id: "user:1", thread_id: "user:1", relationship_id: "whatsapp-thread:test",
    message_id: "wamid.test", reply_context_message_id: "wamid.test", action_id: "whatsapp:inbound:test",
  };
  const source = runtime.store.createJob({ worker_type: "TOLA_WHATSAPP_INBOUND", owner: "TOLA_WHATSAPP", intent: "harmless", success_condition: "accepted", idempotency_key: reference.action_id, constraints: { whatsapp_reference: reference }, result: { terminal_state: "EXECUTED" }, terminal_state: "EXECUTED" }).job;
  const issued = new Date().toISOString();
  const base = {
    A2A_ID: "a2a-test", OPPORTUNITY_ID: "opp-test", WANT_ID: "want-test", TRANSACTION_ID: "tx-test",
    RELATIONSHIP_ID: reference.relationship_id, CHANNEL_THREAD_ID: reference.thread_id, provider_message_id: reference.message_id,
    producer_identity: "TOLA_WHATSAPP", recipient_identity: "OPENAI_COMMAND_TOWER_RUNTIME",
    CANON_REVISION: runtime.canonRevision, created_at: issued, ttl_ms: 60000, idempotency_key: "a2a:a2a-test",
    action_class: "RESOLVE", payload_ref: { kind: "JOB_INTENT", job_id: source.job_id, sha256: sha256("harmless") },
    PAI: { identity: "TOLA_WHATSAPP", scopes: ["A2A_REASONING"] }, authority: { scopes: ["A2A_REASONING"] },
    surface_permission: "WHATSAPP_PRIVATE_SAME_THREAD",
  };
  assert.throws(() => runtime.validateEnvelope({ ...base, CANON_REVISION: "CANON_SHA256:" + "0".repeat(64) }, source), /A2A_CANON_REVISION_STALE/);
  assert.throws(() => runtime.validateEnvelope({ ...base, action_class: "EXECUTE" }, source), /A2A_EXECUTE_AUTHORITY_REQUIRED/);
});

test("an existing STARTED receipt is never authorized a second time", t => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "tola-cloud-action-"));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const runtime = new TolaCloudRuntime({ app: {}, env: { TOLA_STATE_DIR: stateDir } });
  const job = runtime.store.createJob({
    worker_type: "TEST",
    owner: "TEST",
    intent: "test",
    success_condition: "test",
    idempotency_key: "job:test-action",
  }).job;
  const first = runtime.store.beginAction(job.job_id, "action:test");
  const second = runtime.store.beginAction(job.job_id, "action:test");
  assert.equal(first.execute, true);
  assert.equal(first.reason, "CLAIMED");
  assert.equal(second.execute, false);
  assert.equal(second.reason, "IN_PROGRESS");
});

test("credential-shaped inbound text is rejected without persistence or model transmission", async t => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "tola-cloud-credential-"));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const calls = { openai: 0, send: 0 };
  const fetchImpl = async url => {
    if (String(url).includes("api.openai.com")) {
      calls.openai += 1;
      throw new Error("model must not be called");
    }
    if (String(url).endsWith("/messages")) {
      calls.send += 1;
      return jsonResponse(200, { contacts: [{ wa_id: "user:15550001111" }], messages: [{ id: "wamid.credential-warning" }] });
    }
    throw new Error(`unexpected URL ${url}`);
  };
  const runtime = new TolaCloudRuntime({
    app: {},
    fetchImpl,
    env: { TOLA_STATE_DIR: stateDir, TOLA_WHATSAPP_API_KEY: "test-provider-token" },
  });
  const synthetic = `OPENAI_API_KEY=sk-${"A".repeat(24)}`;
  const result = await runtime.handleMessage("123456", {
    id: "wamid.credential-input",
    from: "user:15550001111",
    type: "text",
    text: { body: synthetic },
  });
  assert.equal(result.rejected_credential_input, true);
  assert.deepEqual(calls, { openai: 0, send: 1 });
  const persisted = [
    fs.readFileSync(path.join(stateDir, "value-provenance", "events.jsonl"), "utf8"),
    JSON.stringify(runtime.store.get(result.job_id)),
    JSON.stringify(runtime.store.receipt(result.receipt_id)),
  ].join("\n");
  assert.equal(persisted.includes(synthetic), false);
  assert.equal(persisted.includes(`sk-${"A".repeat(24)}`), false);
});

test("media download denies redirects and streams with the declared hard limit", async t => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "tola-cloud-media-"));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const byte = Buffer.from("x");
  const hash = sha256(byte);
  let redirectMode = null;
  const runtime = new TolaCloudRuntime({
    app: {},
    env: { TOLA_STATE_DIR: stateDir, TOLA_WHATSAPP_API_KEY: "test-provider-token" },
    fetchImpl: async (url, options = {}) => {
      if (String(url).includes("/media/")) {
        return jsonResponse(200, { mime_type: "image/jpeg", file_size: 1, sha256: hash, url: "https://cdn.whatsapp.net/item" });
      }
      redirectMode = options.redirect;
      return new Response(byte, { status: 200 });
    },
  });
  const media = await runtime.fetchMedia({ type: "image", image: { id: "media-1", mime_type: "image/jpeg", sha256: hash } });
  assert.equal(redirectMode, "manual");
  assert.equal(media.size_bytes, 1);

  const oversized = new TolaCloudRuntime({
    app: {},
    env: { TOLA_STATE_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "tola-cloud-media-large-")), TOLA_WHATSAPP_API_KEY: "test-provider-token" },
    fetchImpl: async url => String(url).includes("/media/")
      ? jsonResponse(200, { mime_type: "image/jpeg", file_size: 1, sha256: hash, url: "https://cdn.whatsapp.net/item" })
      : new Response(new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array([120, 120]));
            controller.close();
          },
        }), { status: 200 }),
  });
  t.after(() => fs.rmSync(oversized.stateDir, { recursive: true, force: true }));
  await assert.rejects(
    oversized.fetchMedia({ type: "image", image: { id: "media-2", mime_type: "image/jpeg", sha256: hash } }),
    /WHATSAPP_MEDIA_RESPONSE_SIZE_EXCEEDED/,
  );
});
