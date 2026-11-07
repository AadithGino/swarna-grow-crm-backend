import test, { before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import request from "supertest";
import jwt from "jsonwebtoken";
import {
  User,
  Lead,
  Task,
  Call,
  Meeting,
  Demo,
  Import,
  Notification,
  Device,
  Exception,
  Handover,
  Setting,
} from "../src/models.js";
import { operationsSweep, issue } from "../src/operations.js";
import { policy, addWorkMinutes, customerTask } from "../src/policy.js";
import {
  initializeLead,
  requestHandover,
  answerHandover,
} from "../src/coverage.js";
import { initializeDemo, advanceDemo } from "../src/demoFlow.js";
import { changeTask } from "../src/taskChanges.js";
import { notify, deliverOne } from "../src/notifications.js";
import { heartbeat, leased, healthSnapshot } from "../src/health.js";
import { reconcileMeta, ingestMeta } from "../src/meta.js";
import { check as watchdog } from "../../deploy/watchdog.mjs";
process.env.JWT_SECRET = "operations-test-secret-32-plus-characters";
const { app } = await import("../src/app.js");
let db, manager, agent, backup, lead;
const now = () => new Date();
const future = () => new Date(Date.now() + 86400000);
const auth = (r, u = agent) =>
  r.set(
    "Authorization",
    "Bearer " + jwt.sign({ sub: u.id }, process.env.JWT_SECRET)
  );
before(async () => {
  db = await MongoMemoryReplSet.create({
    binary: { version: "7.0.14" },
    replSet: {
      count: 1,
      args: [
        "--nounixsocket",
        "--setParameter",
        "diagnosticDataCollectionEnabled=false",
      ],
    },
  });
  await mongoose.connect(db.getUri());
  await Promise.all(Object.values(mongoose.models).map((m) => m.init()));
});
after(async () => {
  await mongoose.disconnect();
  await db?.stop();
});
beforeEach(async () => {
  await Promise.all(
    Object.values(mongoose.models).map((m) => m.deleteMany({}))
  );
  delete process.env.META_FORM_IDS;
  delete process.env.META_PAGE_TOKEN;
  delete process.env.REQUIRE_PUSH;
  manager = await User.create({
    name: "Owner",
    email: "owner@test.local",
    role: "manager",
  });
  agent = await User.create({
    name: "Caller",
    email: "caller@test.local",
    role: "agent",
  });
  backup = await User.create({
    name: "Backup",
    email: "backup@test.local",
    role: "agent",
  });
  lead = await Lead.create({
    name: "Jewellers",
    phone: "+919876543210",
    owner: agent.id,
  });
});
async function action(extra = {}) {
  return Task.create({
    key: "task-" + Math.random(),
    lead: lead.id,
    owner: agent.id,
    title: "Call the owner",
    kind: "call",
    dueAt: new Date(Date.now() - 3600000),
    originalDueAt: new Date(Date.now() - 3600000),
    ...extra,
  });
}
test("first contact uses working minutes and excludes Sunday", async () => {
  const d = addWorkMinutes(new Date("2026-11-07T17:55:00+05:30"), 15);
  assert.equal(d.toISOString(), "2026-11-09T04:10:00.000Z");
  await initializeLead(lead);
  assert.ok((await Lead.findById(lead.id)).firstContactDueAt);
});
test("first contact breach creates an owned manager exception; logged attempt clears it", async () => {
  await Lead.updateOne(
    { _id: lead.id },
    { $set: { firstContactDueAt: new Date(Date.now() - 3600000) } }
  );
  await operationsSweep();
  assert.ok(
    await Exception.exists({ key: "first-contact:" + lead.id, status: "open" })
  );
  await Call.create({
    clientId: "attempt",
    lead: lead.id,
    agent: agent.id,
    direction: "outgoing",
    startedAt: now(),
    endedAt: now(),
    events: [{ type: "DIALING" }],
  });
  await operationsSweep();
  assert.equal(
    (await Exception.findOne({ key: "first-contact:" + lead.id })).status,
    "resolved"
  );
  assert.ok((await Lead.findById(lead.id)).firstAttemptAt);
});
test("internal work does not cover customer contact; high intent gets a real customer task", async () => {
  lead.ultra = true;
  await lead.save();
  await action({ kind: "internal", dueAt: future() });
  await operationsSweep();
  const tasks = await Task.find({ lead: lead.id, status: "open" });
  assert.ok(tasks.some(customerTask));
  assert.ok(await Exception.exists({ key: "customer-next:" + lead.id }));
});
test("future agreed meeting counts as customer coverage", async () => {
  await action({ kind: "meeting_prep", dueAt: future() });
  await Meeting.create({
    lead: lead.id,
    reps: [agent.id],
    status: "scheduled",
    start: future(),
    end: new Date(+future() + 3600000),
  });
  await operationsSweep();
  assert.equal(await Task.countDocuments({ key: /^customer-coverage:/ }), 0);
});
test("reminders are idempotent; task overdue escalates even when owner acknowledges", async () => {
  const t = await action();
  await operationsSweep();
  const owner = await Notification.findOne({ user: agent.id, task: t.id });
  assert.ok(owner);
  owner.acknowledgedAt = now();
  await owner.save();
  const before = await Notification.countDocuments();
  await operationsSweep();
  assert.equal(await Notification.countDocuments(), before);
  assert.ok(await Exception.exists({ key: "overdue:" + t.id, status: "open" }));
  const managerAlert = await Notification.findOne({
    user: manager.id,
    task: t.id,
  });
  assert.ok(managerAlert);
  assert.equal(managerAlert.resolvedAt, undefined);
  assert.equal((await Task.findById(t.id)).status, "open");
});
test("push acceptance is not phone receipt or acknowledgement; receipt is recipient scoped", async () => {
  const n = await notify(agent.id, "delivery-test", "Due", "Call customer");
  await Device.create({
    deviceId: "phone",
    user: agent.id,
    token: "fake-token",
    enabled: true,
    lastSeenAt: now(),
  });
  let sends = 0;
  await deliverOne(async () => {
    sends++;
    return "message";
  });
  const sent = await Notification.findById(n.id);
  assert.equal(sends, 1);
  assert.ok(sent.acceptedAt);
  assert.equal(sent.receivedAt, undefined);
  assert.equal(sent.acknowledgedAt, undefined);
  assert.equal(
    (
      await auth(
        request(app).post(`/notifications/${n.id}/receipt`),
        backup
      ).send({ deviceId: "phone", presented: true })
    ).status,
    404
  );
  assert.equal(
    (
      await auth(request(app).post(`/notifications/${n.id}/receipt`)).send({
        deviceId: "phone",
        presented: true,
      })
    ).status,
    200
  );
  let received = await Notification.findById(n.id);
  assert.ok(received.receivedAt);
  assert.ok(received.presentedAt);
  assert.equal(received.acknowledgedAt, undefined);
  await auth(request(app).post(`/notifications/${n.id}/acknowledge`)).send({});
  assert.ok((await Notification.findById(n.id)).acknowledgedAt);
});
test("failed push is retained with backoff, not marked received", async () => {
  const n = await notify(agent.id, "failure", "Due", "Call");
  await deliverOne(async () => {
    throw Error("offline");
  });
  const row = await Notification.findById(n.id);
  assert.equal(row.attempts, 1);
  assert.ok(row.nextAttemptAt > now());
  assert.match(row.error, /No registered/);
  assert.equal(row.receivedAt, undefined);
});
test("finishing a task resolves its reminders and recurrence gets a fresh exception generation", async () => {
  const t = await action();
  await operationsSweep();
  t.status = "done";
  await t.save();
  await operationsSweep();
  assert.equal(
    await Notification.countDocuments({ task: t.id, resolvedAt: null }),
    0
  );
  t.status = "open";
  await t.save();
  await operationsSweep();
  const e = await Exception.findOne({ key: "overdue:" + t.id });
  assert.equal(e.generation, 2);
  assert.ok(
    await Notification.exists({ key: `exception:${e.id}:2:${manager.id}` })
  );
});
test("absence creates coverage exception without silently changing owner", async () => {
  agent.availability = "away";
  await agent.save();
  await action();
  await operationsSweep();
  assert.ok(await Exception.exists({ key: "owner:" + lead.id }));
  assert.equal(String((await Lead.findById(lead.id)).owner), agent.id);
});
test("handover retains deadlines until the backup explicitly accepts", async () => {
  const t = await action({ fixed: true });
  const h = await requestHandover({
    lead: lead.id,
    from: agent.id,
    to: backup.id,
    actor: manager.id,
    reason: "Caller absent",
  });
  assert.equal(String((await Lead.findById(lead.id)).owner), agent.id);
  await answerHandover(h.id, backup.id, {
    action: "accept",
    includeMeetings: true,
  });
  assert.equal(String((await Lead.findById(lead.id)).owner), backup.id);
  const moved = await Task.findById(t.id);
  assert.equal(String(moved.owner), backup.id);
  assert.equal(+moved.dueAt, +t.dueAt);
  assert.equal(+moved.originalDueAt, +t.originalDueAt);
});
test("handover reject, wrong recipient and capacity protections", async () => {
  const h = await requestHandover({
    lead: lead.id,
    from: agent.id,
    to: backup.id,
    actor: manager.id,
    reason: "Cover",
  });
  await assert.rejects(
    () => answerHandover(h.id, agent.id, { action: "accept" }),
    /not found/
  );
  await answerHandover(h.id, backup.id, {
    action: "reject",
    reason: "At a customer meeting",
  });
  assert.equal((await Handover.findById(h.id)).status, "rejected");
  assert.equal(String((await Lead.findById(lead.id)).owner), agent.id);
  backup.capacity = 1;
  await backup.save();
  await action({ owner: backup.id });
  await assert.rejects(
    () =>
      requestHandover({
        lead: lead.id,
        from: agent.id,
        to: backup.id,
        actor: manager.id,
        reason: "Cover",
      }),
    /capacity/
  );
});
test("handover cannot move a scheduled meeting into a backup conflict", async () => {
  const a = new Date(Date.now() + 86400000),
    b = new Date(+a + 3600000);
  await Meeting.create({
    lead: lead.id,
    reps: [agent.id],
    start: a,
    end: b,
    status: "scheduled",
  });
  await Meeting.create({
    lead: lead.id,
    reps: [backup.id],
    start: a,
    end: b,
    status: "scheduled",
  });
  const h = await requestHandover({
    lead: lead.id,
    from: agent.id,
    to: backup.id,
    actor: manager.id,
    reason: "Cover visit",
  });
  await assert.rejects(
    () =>
      answerHandover(h.id, backup.id, {
        action: "accept",
        includeMeetings: true,
      }),
    /conflict/
  );
  assert.equal((await Handover.findById(h.id)).status, "pending");
  assert.equal(String((await Lead.findById(lead.id)).owner), agent.id);
});
test("unaccepted handover expires into a manager exception", async () => {
  const h = await requestHandover({
    lead: lead.id,
    from: agent.id,
    to: backup.id,
    actor: manager.id,
    reason: "Cover",
  });
  h.expiresAt = new Date(Date.now() - 1000);
  await h.save();
  await operationsSweep();
  assert.equal((await Handover.findById(h.id)).status, "expired");
  assert.ok(await Exception.exists({ key: "handover:" + h.id }));
});
test("snooze retains original deadline/history and third postponement needs manager approval", async () => {
  const t = await action();
  for (let i = 0; i < 2; i++)
    await changeTask(t.id, agent, {
      dueAt: new Date(Date.now() + (i + 1) * 86400000),
      reason: "Customer requested another day",
    });
  await assert.rejects(
    () =>
      changeTask(t.id, agent, {
        dueAt: new Date(Date.now() + 4 * 86400000),
        reason: "Again",
      }),
    /manager approval/
  );
  let row = await Task.findById(t.id);
  assert.equal(row.snoozes, 2);
  assert.ok(row.snoozeApprovalRequestedAt);
  await operationsSweep();
  assert.equal(
    (await Exception.findOne({ key: "snooze:" + t.id })).status,
    "open"
  );
  await changeTask(t.id, manager, {
    dueAt: new Date(Date.now() + 4 * 86400000),
    reason: "Confirmed customer availability",
    approveSnooze: true,
  });
  row = await Task.findById(t.id);
  assert.equal(row.snoozes, 3);
  assert.equal(+row.originalDueAt, +t.originalDueAt);
  assert.equal(row.snoozeHistory.length, 3);
  assert.ok(row.snoozeHistory[2].approved);
});
test("fixed customer promise cannot be rescheduled without reconfirmation", async () => {
  const t = await action({ fixed: true });
  await assert.rejects(
    () => changeTask(t.id, agent, { dueAt: future(), reason: "Busy" }),
    /customer agreed/
  );
  assert.equal(+(await Task.findById(t.id)).dueAt, +t.dueAt);
});
test("demo stages have accountable deadlines and cannot jump logo preparation or fake sharing", async () => {
  const d = await Demo.create({
    lead: lead.id,
    owner: backup.id,
    shopName: lead.name,
    token: "demo-test",
  });
  await initializeDemo(d.id);
  assert.ok((await Demo.findById(d.id)).stageDueAt);
  await assert.rejects(
    () =>
      advanceDemo(
        d.id,
        { status: "ready", url: "https://example.com" },
        agent.id
      ),
    /previous/
  );
  await advanceDemo(
    d.id,
    { status: "logo_received", logoNote: "Received in client chat" },
    agent.id
  );
  await advanceDemo(d.id, { status: "preparing" }, agent.id);
  const ready = await advanceDemo(
    d.id,
    { status: "ready", url: "https://example.com" },
    agent.id
  );
  assert.ok(ready.stageDueAt);
  await assert.rejects(
    () => advanceDemo(d.id, { status: "sent" }, agent.id),
    /Confirm actual/
  );
  await advanceDemo(
    d.id,
    { status: "sent", confirmSent: true, channel: "WhatsApp" },
    agent.id
  );
  await advanceDemo(d.id, { status: "explored" }, null, { trustedEntry: true });
  await advanceDemo(
    d.id,
    { status: "responded", customerResponse: "questions" },
    agent.id
  );
  const current = await Demo.findById(d.id);
  assert.equal(current.status, "responded");
  assert.ok(
    await Task.exists({ key: "demo-response-next:" + d.id, status: "open" })
  );
});
test("overdue demo and missing capture are escalated", async () => {
  await Demo.create({
    lead: lead.id,
    owner: backup.id,
    token: "late",
    status: "preparing",
    stageDueAt: new Date(Date.now() - 1000),
  });
  await Import.create({
    externalId: "bad-lead",
    status: "failed",
    error: "Invalid phone",
  });
  await operationsSweep();
  assert.ok(await Exception.exists({ type: "demo_delay", status: "open" }));
  assert.ok(await Exception.exists({ type: "capture", status: "open" }));
});
test("Meta reconciliation preserves old watermark and identical date filter on every page", async () => {
  process.env.META_FORM_IDS = "form1";
  await Setting.create({
    key: "meta-form:form1",
    value: { lastSuccessAt: "2026-10-01T00:00:00Z" },
  });
  const paths = [];
  await reconcileMeta(async (path) => {
    paths.push(path);
    return paths.length === 1
      ? {
          data: [{ id: "meta1" }],
          paging: { next: "more", cursors: { after: "cursor1" } },
        }
      : { data: [{ id: "meta2" }] };
  });
  assert.equal(paths.length, 2);
  assert.match(paths[1], /filtering=/);
  const a = new URLSearchParams(paths[0].split("?")[1]),
    b = new URLSearchParams(paths[1].split("?")[1]);
  assert.equal(a.get("filtering"), b.get("filtering"));
  assert.ok(
    JSON.parse(a.get("filtering"))[0].value < Date.now() / 1000 - 7 * 86400
  );
  assert.equal(await Import.countDocuments(), 2);
  const state = await Setting.findOne({ key: "metaCheck" });
  assert.equal(state.value.forms[0].sourceCount, 2);
  assert.equal(state.value.forms[0].pendingCount, 2);
});
test("failed source reconciliation does not advance checkpoint; failed import retries with backoff", async () => {
  process.env.META_FORM_IDS = "form1";
  await Setting.create({
    key: "meta-form:form1",
    value: { lastSuccessAt: "2026-10-01T00:00:00Z" },
  });
  await reconcileMeta(async () => {
    throw Error("Provider down");
  });
  const state = await Setting.findOne({ key: "meta-form:form1" });
  assert.equal(state.value.lastSuccessAt, "2026-10-01T00:00:00Z");
  await Import.create({ externalId: "invalid", status: "pending" });
  await ingestMeta(async () => ({ id: "invalid", field_data: [] }));
  const i = await Import.findOne({ externalId: "invalid" });
  assert.equal(i.status, "failed");
  assert.equal(i.attempts, 1);
  assert.ok(i.nextAttemptAt > now());
});
test("Meta import links source record to CRM and starts response SLA", async () => {
  await Import.create({ externalId: "valid", status: "pending" });
  await ingestMeta(async () => ({
    id: "valid",
    form_id: "f1",
    created_time: new Date().toISOString(),
    field_data: [
      { name: "phone_number", values: ["+919876543211"] },
      { name: "company_name", values: ["New shop"] },
    ],
  }));
  const i = await Import.findOne({ externalId: "valid" });
  assert.equal(i.status, "done");
  assert.ok(i.lead);
  assert.ok((await Lead.findById(i.lead)).firstContactDueAt);
});
test("worker lease prevents overlapping ticks; heartbeat staleness is observable", async () => {
  let release;
  const blocker = new Promise((r) => (release = r));
  const a = leased("sales", () => blocker);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(
    await leased("sales", async () => {
      throw Error("must not run");
    }),
    false
  );
  release();
  await a;
  assert.ok(
    (await Setting.findOne({ key: "health:sales" })).value.lastSuccessAt
  );
  assert.ok((await healthSnapshot()).stale.includes("delivery"));
  await assert.rejects(
    () =>
      leased("delivery", async () => {
        throw Error("Delivery down");
      }),
    /Delivery down/
  );
  assert.equal(
    (await Setting.findOne({ key: "health:delivery" })).value.ok,
    false
  );
});
test("independent watchdog alerts on outage, retries failed alert, and reports recovery", async () => {
  let alerts = 0;
  const fetcher = async (url, opts) =>
    url === "health" ? { ok: false, status: 503 } : { ok: true, status: 200 };
  let state = await watchdog({
    url: "health",
    token: "test",
    alertUrl: "alerts",
    fetcher: async (...args) => {
      if (args[0] === "alerts") alerts++;
      return fetcher(...args);
    },
    now: 1000000,
  });
  assert.equal(state.ok, false);
  assert.equal(alerts, 1);
  await assert.rejects(
    () =>
      watchdog({
        url: "health",
        token: "test",
        alertUrl: "alerts",
        state: {},
        fetcher: async (url) => ({
          ok: false,
          status: url === "health" ? 503 : 500,
        }),
      }),
    /alert delivery failed/
  );
  state = await watchdog({
    url: "health",
    token: "test",
    alertUrl: "alerts",
    state,
    fetcher: async (url) =>
      url === "health"
        ? { ok: true, json: async () => ({ ok: true }) }
        : { ok: true },
    now: 1000001,
  });
  assert.equal(state.ok, true);
});
test("operations and policy are manager-only; reminders cannot be acknowledged for someone else", async () => {
  const n = await notify(backup.id, "private", "Private reminder", "Task");
  assert.equal((await auth(request(app).get("/operations"))).status, 403);
  assert.equal(
    (
      await auth(request(app).patch("/operations/policy")).send({
        firstContactMinutes: 5,
      })
    ).status,
    403
  );
  assert.equal(
    (
      await auth(
        request(app).post("/notifications/" + n.id + "/acknowledge")
      ).send({})
    ).status,
    404
  );
  const r = await auth(request(app).get("/operations"), manager);
  assert.equal(r.status, 200);
  assert.ok(r.body.staff);
});
test("postponing into the future does not erase original lateness", async () => {
  const t = await action();
  await changeTask(t.id, agent, {
    dueAt: future(),
    reason: "Customer asks tomorrow",
  });
  await operationsSweep();
  assert.ok(
    await Exception.exists({ key: "original-late:" + t.id, status: "open" })
  );
});
test("source enquiry for closed lead is flagged for review instead of silently treated as covered", async () => {
  lead.stage = "Lost";
  await lead.save();
  await Import.create({ externalId: "repeat", status: "pending" });
  await ingestMeta(async () => ({
    id: "repeat",
    field_data: [{ name: "phone_number", values: [lead.phone] }],
  }));
  const i = await Import.findOne({ externalId: "repeat" });
  assert.equal(i.status, "needs_review");
  await operationsSweep();
  assert.ok(await Exception.exists({ key: "import:" + i.id, status: "open" }));
  const r = await auth(
    request(app).post(`/imports/${i.id}/review`),
    manager
  ).send({ reason: "Duplicate historical submission; verified with owner" });
  assert.equal(r.status, 200);
  await operationsSweep();
  assert.equal(
    (await Exception.findOne({ key: "import:" + i.id })).status,
    "resolved"
  );
});
test("handover cannot push backup over capacity when accepted", async () => {
  backup.capacity = 2;
  await backup.save();
  await action({ owner: backup.id });
  await action();
  await action();
  const h = await requestHandover({
    lead: lead.id,
    from: agent.id,
    to: backup.id,
    actor: manager.id,
    reason: "Cover",
  });
  await assert.rejects(
    () => answerHandover(h.id, backup.id, { action: "accept" }),
    /exceed/
  );
  assert.equal(String((await Lead.findById(lead.id)).owner), agent.id);
});
test("machine health is authenticated separately and missing live push configuration fails readiness", async () => {
  process.env.WATCHDOG_TOKEN = "private-watchdog-token-32-characters-long";
  assert.equal((await request(app).get("/health/automation")).status, 401);
  for (const name of ["sales", "meta", "delivery", "ai"])
    await heartbeat(name, true);
  let r = await request(app)
    .get("/health/automation")
    .set("x-watchdog-token", process.env.WATCHDOG_TOKEN);
  assert.equal(r.status, 200);
  process.env.REQUIRE_PUSH = "true";
  r = await request(app)
    .get("/health/automation")
    .set("x-watchdog-token", process.env.WATCHDOG_TOKEN);
  assert.equal(r.status, 503);
  assert.equal(r.body.readiness.pushConfigured, false);
});
test("absence automatically requests an available preferred backup without transferring prematurely", async () => {
  agent.availability = "away";
  agent.backup = backup.id;
  await agent.save();
  await action();
  await operationsSweep();
  const h = await Handover.findOne({
    lead: lead.id,
    from: agent.id,
    status: "pending",
  });
  assert.ok(h);
  assert.equal(String(h.to), backup.id);
  assert.equal(String((await Lead.findById(lead.id)).owner), agent.id);
  await operationsSweep();
  assert.equal(
    await Handover.countDocuments({ lead: lead.id, status: "pending" }),
    1
  );
});
test("independent health detects failed delivery even when worker heartbeat is healthy", async () => {
  for (const k of ["sales", "meta", "delivery", "ai"]) await heartbeat(k, true);
  await Notification.create({
    key: "undelivered",
    user: agent.id,
    title: "Due",
    attempts: 3,
    nextAttemptAt: future(),
  });
  const state = await healthSnapshot();
  assert.equal(state.ok, false);
  assert.ok(state.stale.includes("delivery_unconfirmed"));
});
test("invalid CSV rows remain visible as capture failures rather than disappearing in a response", async () => {
  const r = await auth(request(app).post("/imports/csv"), manager).send({
    csv: "name,phone\nMissing phone,not-a-number",
  });
  assert.equal(r.status, 200);
  const i = await Import.findOne({ source: "csv", status: "failed" });
  assert.ok(i);
  await operationsSweep();
  assert.ok(await Exception.exists({ key: "import:" + i.id, status: "open" }));
});
test("stage-aware demo creates one share task and cannot be falsely completed manually", async () => {
  const d = await Demo.create({
    lead: lead.id,
    owner: backup.id,
    token: "one-share",
    status: "preparing",
    logoNote: "Client chat",
  });
  await initializeDemo(d.id);
  await advanceDemo(
    d.id,
    { status: "ready", url: "https://example.com" },
    agent.id
  );
  const { sweep } = await import("../src/workflow.js");
  await sweep();
  await sweep();
  const shares = await Task.find({
    lead: lead.id,
    status: "open",
    kind: "send_demo",
  });
  assert.equal(shares.length, 1);
  assert.ok(shares[0].demo);
  await assert.rejects(
    () =>
      changeTask(shares[0].id, agent, {
        complete: true,
        note: "Done",
        nextAt: future(),
      }),
    /Demo handovers/
  );
});
