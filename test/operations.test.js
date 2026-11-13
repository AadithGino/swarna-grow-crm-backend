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
test("demo stages have accountable deadlines and require a logo and prevent fake sharing", async () => {
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
    /logo/
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
  ).send({ decision: "invalid", reason: "Duplicate historical submission; verified with owner" });
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

test("telesales can save a generated demo and managers see its share activity", async () => {
  const created = await auth(request(app).post("/demos")).send({ lead: lead.id, shopName: "Demo Jewellers" });
  assert.equal(created.status, 201);
  const id = created.body._id;
  const ready = await auth(request(app).patch("/demos/" + id)).send({
    status: "ready", logoNote: "Logo in enquiry chat", url: "https://example.com/demo",
  });
  assert.equal(ready.status, 200);
  assert.ok(await Task.exists({ demo: id, owner: agent.id, kind: "send_demo", status: "open" }));
  const sent = await auth(request(app).patch("/demos/" + id)).send({
    status: "sent", confirmSent: true, channel: "WhatsApp",
  });
  assert.equal(sent.status, 200);
  const report = await auth(request(app).get("/reports"), manager);
  assert.equal(report.status, 200);
  assert.equal(report.body.employees.find(row => row.id === agent.id).monitoring.demosSent[0]._id, id);
});

test("manager queue and on-time counts use outstanding work and original deadlines", async () => {
  const deadline = new Date(Date.now() - 60000);
  await Task.create([
    { lead: lead.id, owner: agent.id, key: "queue-callback", kind: "call",
      title: "Return missed call", dueAt: deadline, originalDueAt: deadline },
    { lead: lead.id, owner: agent.id, key: "on-time-callback", kind: "call",
      title: "Promised callback", dueAt: future(), originalDueAt: deadline,
      status: "done", doneAt: deadline },
  ]);
  const report = await auth(request(app).get("/reports"), manager);
  assert.equal(report.status, 200);
  assert.ok(report.body.attention.some(row => row.title === "Return missed call"));
  const staff = report.body.employees.find(row => row.id === agent.id);
  assert.equal(staff.monitoring.followUpsDue.length, 2);
  assert.equal(staff.monitoring.followUpsOnTime.length, 1);
});

test("attendance actions are idempotent and management reports require a manager", async () => {
  const first = await auth(request(app).post("/attendance/in")).send({});
  assert.equal(first.status, 200);
  const repeated = await auth(request(app).post("/attendance/in")).send({});
  assert.equal(repeated.body.checkedInAt, first.body.checkedInAt);
  const out = await auth(request(app).post("/attendance/out")).send({});
  assert.ok(out.body.checkedOutAt);
  const path = `/management/report?agent=${agent.id}&from=${first.body.day}&to=${first.body.day}`;
  assert.equal((await auth(request(app).get(path))).status, 403);
  const report = await auth(request(app).get(path), manager);
  assert.equal(report.status, 200);
  assert.equal(report.body.attendance[0].checkedOutAt, out.body.checkedOutAt);
  assert.equal((await auth(request(app).get(path.replace(/from=[^&]+/, "from=2026-02-30")), manager)).status, 422);
});

test("management report uses IST date boundaries and shows gaps from call end", async () => {
  const day = "2026-11-11";
  await Call.create([
    { clientId: "before-ist", agent: agent.id, direction: "outgoing", startedAt: new Date("2026-11-10T18:29:59Z") },
    { clientId: "first-ist", agent: agent.id, direction: "outgoing", startedAt: new Date("2026-11-10T18:30:00Z"), endedAt: new Date("2026-11-10T18:35:00Z"), answeredAt: new Date("2026-11-10T18:30:01Z"), activeMs: 60000 },
    { clientId: "second-ist", agent: agent.id, direction: "outgoing", startedAt: new Date("2026-11-10T18:45:00Z") },
  ]);
  const report = await auth(request(app).get(`/management/report?agent=${agent.id}&from=${day}&to=${day}`), manager);
  assert.equal(report.status, 200);
  assert.equal(report.body.stats.attempts, 2);
  assert.equal(report.body.stats.answered, 1);
  assert.equal(report.body.attendance[0].gap.ms, 600000);
});

test("day-end reports and meeting reminders are delivered once per recipient", async () => {
  const { managementReminders } = await import("../src/management.js");
  const now = new Date("2026-11-11T15:00:00Z");
  await Call.create({ clientId: "daily", agent: agent.id, direction: "outgoing", startedAt: new Date(+now - 3600000) });
  await Meeting.create({ lead: lead.id, bookedBy: agent.id, reps: [agent.id], status: "scheduled", start: new Date(+now + 600000) });
  await managementReminders(now);
  await managementReminders(now);
  assert.equal(await Notification.countDocuments({ user: manager.id, category: "daily_report" }), 1);
  assert.equal(await Notification.countDocuments({ user: manager.id, category: "meeting" }), 1);
  assert.equal(await Notification.countDocuments({ user: agent.id, category: "meeting" }), 1);
});

test("manager queue claims a task once and detects stale ownership", async () => {
  const dueAt = new Date(Date.now() - 60000);
  const task = await Task.create({ lead: lead.id, owner: agent.id, title: "Callback", kind: "call", dueAt, originalDueAt: dueAt, key: "queue-claim-test" });
  const queue = await auth(request(app).get("/management/action-queue"), manager);
  const item = queue.body.find(row => row.id === task.id);
  assert.ok(item);
  const snapshot = { expectedOwner: agent.id, expectedDueAt: item.dueAt, revision: item.revision };
  const path = `/management/action-queue/task/${task.id}`;
  assert.equal((await auth(request(app).post(path)).send({ action: "claim", ...snapshot })).status, 403);
  const claimed = await auth(request(app).post(path), manager).send({ action: "claim", ...snapshot });
  assert.equal(claimed.body.owner, manager.id);
  const stale = await auth(request(app).post(path), manager).send({ action: "claim", ...snapshot });
  assert.equal(stale.status, 409);
});

test("no-show and named rebooking callback are committed together", async () => {
  const meeting = await Meeting.create({ lead: lead.id, reps: [agent.id], status: "scheduled",
    start: new Date(Date.now() - 7200000), end: new Date(Date.now() - 3600000) });
  const path = `/management/action-queue/meeting/${meeting.id}`;
  const snapshot = { expectedOwner: agent.id, expectedDueAt: meeting.end, revision: meeting.updatedAt };
  const invalid = await auth(request(app).post(path), manager).send({ action: "no_show", owner: agent.id, ...snapshot });
  assert.equal(invalid.status, 422);
  assert.equal((await Meeting.findById(meeting.id)).status, "scheduled");
  const payload = { action: "no_show", owner: agent.id, dueAt: future(), ...snapshot };
  const result = await auth(request(app).post(path), manager).send(payload);
  assert.equal(result.body.status, "no_show");
  assert.equal((await auth(request(app).post(path), manager).send(payload)).status, 409);
  const tasks = await Task.find({ key: `meeting-next:${meeting.id}` });
  assert.equal(tasks.length, 1);
  assert.equal(String(tasks[0].owner), agent.id);
  assert.equal(tasks[0].title, "Call to rebook missed meeting");
});

test("completed demo requires a dated next step and creates a quote task", async () => {
  const demo = await Demo.create({ lead: lead.id, owner: agent.id, token: "demo-close-test", status: "sent" });
  const path = `/demos/${demo.id}`;
  const payload = { status: "responded", customerResponse: "interested", walkthroughCompleted: true };
  const bad = await auth(request(app).patch(path)).send(payload);
  assert.equal(bad.status, 422);
  assert.equal((await Demo.findById(demo.id)).status, "sent");
  const ok = await auth(request(app).patch(path)).send({ ...payload, walkthroughNextAction: "send_quote", nextAt: future() });
  assert.equal(ok.status, 200);
  assert.ok(ok.body.walkthroughCompletedAt);
  assert.equal((await Task.findOne({ key: `demo-response-next:${demo.id}` })).kind, "send_proposal");
});

test("shared coaching is agent-scoped and tracks reviewed later calls", async () => {
  const call = await Call.create({ clientId: "coaching-action-test", agent: agent.id, answeredAt: new Date() });
  const payload = { callId: call.id, step: "discovery", excerpt: "We only use paper cards.", improvement: "Ask how renewals are tracked." };
  const shared = await auth(request(app).post("/management/coaching"), manager).send(payload);
  assert.equal(shared.status, 200);
  await Call.create({ clientId: "coaching-progress-test", agent: agent.id, startedAt: future(), coachingReview: { checks: { discovery: "done" } } });
  const own = await auth(request(app).get("/coaching-actions"));
  assert.equal(own.body[0].progress[0].status, "covered");
  assert.equal((await auth(request(app).get("/coaching-actions"), backup)).body.length, 0);
});

test("lead source funnel uses the latest sent split quote and counts milestones once", async () => {
  const { Proposal } = await import("../src/models.js");
  const { sourceFunnel } = await import("../src/managerActions.js");
  await Lead.updateOne({ _id: lead.id }, { $set: { source: "Meta", stage: "Won" } });
  await Call.create({ clientId: "funnel-connection-test", lead: lead.id, answeredAt: new Date() });
  await Demo.create({ lead: lead.id, token: "funnel-complete-test", walkthroughCompletedAt: new Date() });
  await Proposal.create([
    { lead: lead.id, amount: 120, setupFee: 100, monthlyFee: 20, sentAt: new Date(Date.now() - 60000) },
    { lead: lead.id, amount: 230, setupFee: 200, monthlyFee: 30, sentAt: new Date() },
    { lead: lead.id, amount: 999, setupFee: 999, monthlyFee: 0 },
  ]);
  const [row] = await sourceFunnel({ $gte: new Date(Date.now() - 3600000), $lt: future() }, agent.id);
  assert.deepEqual([row.leads, row.connected, row.demoCompleted, row.quoted, row.won], [1, 1, 1, 1, 1]);
  assert.deepEqual([row.setupWon, row.monthlyWon], [200, 30]);
});

test("sending a linked demo proposal completes both send tasks and creates one decision call", async () => {
  const source = await Task.create({ lead: lead.id, owner: agent.id, key: "demo-response-next:quote-link",
    kind: "send_proposal", title: "Send quote after demo", dueAt: future() });
  const create = () => auth(request(app).post("/proposals")).send({ lead: lead.id, sourceTask: source.id, amount: 30000 });
  const quote = await create();
  assert.equal(quote.status, 200);
  assert.equal(quote.body.sourceTask, source.id);
  assert.equal((await create()).body._id, quote.body._id);
  const send = () => auth(request(app).post(`/proposals/${quote.body._id}/sent`)).send({ nextAt: future() });
  assert.equal((await send()).status, 200);
  assert.equal((await send()).status, 200);
  assert.equal((await Task.findById(source.id)).status, "done");
  assert.equal((await Task.findOne({ key: `proposal-send:${quote.body._id}` })).status, "done");
  assert.equal(await Task.countDocuments({ key: `proposal-follow:${quote.body._id}` }), 1);
});

test("queue rejects stale deadlines even when ownership is unchanged", async () => {
  const task = await Task.create({ lead: lead.id, owner: agent.id, key: "queue-stale-date", kind: "call",
    title: "Callback", dueAt: new Date(Date.now() - 60000) });
  const snapshot = { expectedOwner: agent.id, expectedDueAt: task.dueAt, revision: task.updatedAt };
  const path = `/management/action-queue/task/${task.id}`;
  const payload = { ...snapshot, action: "reschedule", dueAt: future(), reason: "Manager moved callback" };
  assert.equal((await auth(request(app).post(path), manager).send(payload)).status, 200);
  assert.equal((await auth(request(app).post(path), manager).send({ ...payload, dueAt: new Date(Date.now() + 172800000) })).status, 409);
});

test("queue confirmation closes its task and an attended outcome schedules a callback", async () => {
  const meeting = await Meeting.create({ lead: lead.id, reps: [agent.id], status: "scheduled", start: future(), end: future() });
  const task = await Task.create({ lead: lead.id, owner: agent.id, key: `meeting-confirm:${meeting.id}`, kind: "confirmation", dueAt: new Date() });
  const confirm = await auth(request(app).post(`/management/action-queue/task/${task.id}`), manager).send({
    action: "confirm", expectedOwner: agent.id, expectedDueAt: task.dueAt, revision: task.updatedAt,
  });
  assert.equal(confirm.body.confirmed, true);
  assert.equal((await Task.findById(task.id)).status, "done");
  const ended = await Meeting.create({ lead: lead.id, reps: [agent.id], status: "scheduled",
    start: new Date(Date.now() - 7200000), end: new Date(Date.now() - 3600000) });
  const result = await auth(request(app).post(`/management/action-queue/meeting/${ended.id}`), manager).send({
    action: "attended", owner: agent.id, dueAt: future(), reason: "Discussed pricing",
    expectedOwner: agent.id, expectedDueAt: ended.end, revision: ended.updatedAt,
  });
  assert.equal(result.body.status, "completed");
  assert.ok(await Task.exists({ key: `meeting-next:${ended.id}`, owner: agent.id }));
});

test("changed coaching feedback reports conflict and keeps the shared revision", async () => {
  const call = await Call.create({ clientId: "coaching-duplicate", agent: agent.id, answeredAt: new Date() });
  const send = improvement => auth(request(app).post("/management/coaching"), manager).send({
    callId: call.id, step: "discovery", excerpt: "We use paper cards.", improvement,
  });
  assert.equal((await send("Ask about renewals.")).status, 200);
  assert.equal((await send("Ask about reminders.")).status, 409);
  const own = await auth(request(app).get("/coaching-actions"));
  assert.equal(own.body[0].improvement, "Ask about renewals.");
});

test("pending work alone generates tomorrow and overdue sections", async () => {
  const { managementReminders } = await import("../src/management.js");
  const now = new Date("2027-03-22T15:00:00Z");
  await Task.create([
    { lead: lead.id, owner: agent.id, key: "report-tomorrow", title: "Tomorrow callback", kind: "call", dueAt: new Date("2027-03-23T04:00:00Z") },
    { lead: lead.id, owner: agent.id, key: "report-overdue", title: "Overdue callback", kind: "call", dueAt: new Date("2027-03-22T04:00:00Z") },
  ]);
  await Meeting.create({ lead: lead.id, bookedBy: agent.id, reps: [backup.id], confirmed: true,
    status: "scheduled", start: new Date("2027-03-23T05:00:00Z"), end: new Date("2027-03-23T06:00:00Z") });
  await managementReminders(now);
  const report = await Notification.findOne({ user: manager.id, category: "daily_report", title: `${agent.name} · 2027-03-22` });
  assert.match(report.body, /^Tomorrow’s commitments \(2\)[^\n]*\nConfirmed meeting[^\n]*\nTomorrow callback/);
  assert.match(report.body, /Overdue backlog \(1\)\nOverdue callback/);
});

test("import review requires a disposition and links an owned contact deadline", async () => {
  const item = await Import.create({ externalId: "review-linked", status: "failed", sourceCreatedAt: new Date() });
  const resolve = body => auth(request(app).post(`/imports/${item.id}/review`), manager).send(body);
  assert.equal((await resolve({ reason: "Checked" })).status, 422);
  const result = await resolve({ decision: "link_existing", lead: lead.id, reason: "Verified the customer's phone" });
  assert.equal(result.status, 200);
  assert.ok(result.body.commitment.dueAt);
  assert.ok(await Task.exists({ lead: lead.id, owner: agent.id, key: `import-review:${item.id}`, status: "open" }));
  assert.equal((await resolve({ decision: "invalid", reason: "Changed" })).status, 409);
});

test("queue shows missing venue and overdue demo preparation", async () => {
  const dueAt = new Date(Date.now() - 60000);
  const demo = await Demo.create({ lead: lead.id, token: "queue-stage" });
  await Task.create([
    { key: "meeting-place:pending", lead: lead.id, owner: agent.id, dueAt, kind: "meeting_prep" },
    { key: "demo-stage:pending", lead: lead.id, owner: agent.id, dueAt, kind: "internal", demo: demo.id },
  ]);
  const result = await auth(request(app).get("/management/action-queue"), manager);
  assert.equal(result.status, 200);
  assert.ok(result.body.some(row => row.taskKey === "meeting-place:pending"));
  assert.ok(result.body.some(row => row.taskKey === "demo-stage:pending"));
});

test("queue meeting attendance can close a lead without a callback", async () => {
  const meeting = await Meeting.create({ lead: lead.id, bookedBy: agent.id, status: "scheduled",
    start: new Date(Date.now() - 7200000), end: new Date(Date.now() - 3600000) });
  const response = await auth(request(app).post(`/management/action-queue/meeting/${meeting.id}`), manager).send({
    action: "attended", expectedOwner: agent.id, expectedDueAt: meeting.end, revision: meeting.updatedAt,
    reason: "Customer declined further contact", salesOutcome: { outcome: "do_not_contact" },
  });
  assert.equal(response.body.status, "completed");
  assert.equal((await Lead.findById(lead.id)).doNotContact, true);
  assert.equal(await Task.countDocuments({ key: `meeting-next:${meeting.id}` }), 0);
});

test("lead reassignment requires attendance choice and transfers linked work together", async () => {
  const start = future();
  const meeting = await Meeting.create({ lead: lead.id, reps: [agent.id], status: "scheduled",
    start, end: new Date(+start + 3600000) });
  const demo = await Demo.create({ lead: lead.id, owner: agent.id, token: "transfer-active-demo" });
  const prep = await Task.create({ lead: lead.id, owner: agent.id, kind: "meeting_prep",
    dueAt: start, key: `meeting-place:${meeting.id}` });
  const transfer = body => auth(request(app).patch(`/leads/${lead.id}`), manager)
    .send({ owner: backup.id, taskTransfer: "transfer", ...body });
  assert.equal((await transfer({})).status, 422);
  const clash = await Meeting.create({ lead: lead.id, reps: [backup.id], status: "scheduled",
    start, end: new Date(+start + 3600000) });
  assert.equal((await transfer({ meetingTransfer: "replace" })).status, 409);
  assert.equal(String((await Task.findById(prep.id)).owner), agent.id);
  assert.equal(String((await Demo.findById(demo.id)).owner), agent.id);
  await clash.deleteOne();
  assert.equal(String((await Lead.findById(lead.id)).owner), agent.id);
  const result = await transfer({ meetingTransfer: "replace" });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(String((await Lead.findById(lead.id)).owner), backup.id);
  assert.equal(String((await Demo.findById(demo.id)).owner), backup.id);
  assert.equal(String((await Task.findById(prep.id)).owner), backup.id);
  assert.equal(String((await Meeting.findById(meeting.id)).reps[0]), backup.id);
});

test("historical management periods exclude live calendar and demo activity", async () => {
  const { managementReport } = await import("../src/management.js");
  const meeting = await Meeting.create({ lead: lead.id, bookedBy: agent.id, status: "scheduled", start: future() });
  const demo = await Demo.create({ lead: lead.id, owner: agent.id, token: "report-live-demo", status: "sent", sentAt: new Date() });
  const report = await managementReport(agent.id, "2024-01-01", "2024-01-02");
  assert.equal(report.meetings.length, 0);
  assert.equal(report.demos.length, 0);
  assert.ok(report.live.upcomingMeetings.some(row => row._id.equals(meeting.id)));
  assert.ok(report.live.demos.some(row => row._id.equals(demo.id)));
});

test("Nurture requires a date and saves a customer callback with the stage", async () => {
  const update = body => auth(request(app).patch(`/leads/${lead.id}`), manager).send({ stage: "Nurture", ...body });
  assert.equal((await update({})).status, 422);
  const pauseUntil = future();
  assert.equal((await update({ pauseUntil })).status, 200);
  assert.ok(await Task.exists({ lead: lead.id, status: "open", dueAt: pauseUntil, fixed: true, key: /^nurture:/ }));
});

test("confirmed meeting flags an unavailable attendee independently of the lead owner", async () => {
  await User.updateOne({ _id: backup.id }, { $set: { availability: "away" } });
  const start = future();
  const meeting = await Meeting.create({ lead: lead.id, confirmed: true, reps: [backup.id],
    start, end: new Date(+start + 3600000) });
  await operationsSweep();
  assert.ok(await Exception.exists({ key: `meeting-coverage:${meeting.id}`, owner: backup.id, status: "open" }));
});

test("Meta processing claim prevents a review from committing over an in-flight import", async () => {
  const item = await Import.create({ externalId: "claimed-import", status: "failed" });
  await ingestMeta(async () => {
    const review = await auth(request(app).post(`/imports/${item.id}/review`), manager)
      .send({ decision: "invalid", reason: "Manual check" });
    assert.equal(review.status, 409);
    return { id: item.externalId, field_data: [{ name: "phone_number", values: [lead.phone] }] };
  });
  assert.equal((await Import.findById(item.id)).status, "done");
  assert.ok(await Task.exists({ key: "meta:claimed-import" }));
});

test("Meta capture discovery flags active forms missing from reconciliation", async () => {
  const oldPage = process.env.META_PAGE_ID;
  process.env.META_PAGE_ID = "test-page";
  process.env.META_FORM_IDS = "form1";
  try {
    await reconcileMeta(async path => path.startsWith("test-page/") ?
      { data: [{ id: "form1", status: "ACTIVE" }, { id: "new-form", status: "ACTIVE" }] } : { data: [] });
    const check = await Setting.findOne({ key: "metaCheck" });
    assert.equal(check.value.ok, false);
    assert.deepEqual(check.value.missingForms, ["new-form"]);
  } finally {
    if (oldPage === undefined) delete process.env.META_PAGE_ID;
    else process.env.META_PAGE_ID = oldPage;
  }
});

test("retry review hold prevents the sweeps from scheduling another call", async () => {
  lead.retryReviewAt = new Date();
  await lead.save();
  await Task.create({ key: `retry-review:${lead.id}:test`, lead: lead.id, owner: agent.id, title: "Review unanswered lead",
    kind: "internal", dueAt: future(), customerFacing: false });
  const { sweep } = await import("../src/workflow.js");
  await sweep();
  await operationsSweep();
  assert.equal(await Task.countDocuments({ lead: lead.id, status: "open", kind: "call" }), 0);
});


test("linking a missed call schedules one return call, including repeated linking", async () => {
  const call = await Call.create({ clientId: "late-linked-inbound", agent: agent.id, number: lead.phone,
    direction: "incoming", startedAt: new Date(Date.now() - 60000), endedAt: new Date(),
    events: [{ type: "RINGING", at: new Date(Date.now() - 60000) }, { type: "DISCONNECTED", at: new Date() }], disconnectCode: 5 });
  const link = () => auth(request(app).post(`/calls/${call.id}/lead`)).send({ lead: lead.id });
  assert.equal((await link()).status, 200);
  assert.equal((await link()).status, 200);
  assert.equal(await Task.countDocuments({ key: `missed-incoming:${call.id}`, owner: agent.id }), 1);
});

test("manager workspace paginates lead call history and guards manual reviews", async () => {
  const startedAt = new Date();
  await Call.insertMany(Array.from({ length: 31 }, (_, index) => ({
    clientId: "workspace-" + index, agent: agent.id, lead: lead.id, direction: "outgoing",
    number: lead.phone, startedAt, answeredAt: startedAt, transcript: "Sample transcript for playback review.",
    ...(index === 0 ? { ai: {
      summary: "Discussed pricing", objections: ["Monthly fee"],
      scriptAssessment: { steps: [{ key: "discovery", status: "partial" }] },
    } } : {}),
  })));
  const path = "/management/workspace/leads/" + lead.id + "/calls";
  assert.equal((await auth(request(app).get(path))).status, 403);
  const page = await auth(request(app).get(path).query({ page: 2 }), manager).expect(200);
  assert.equal(page.body.total, 31);
  assert.equal(page.body.items.length, 6);
  assert.equal(page.body.items[0].transcript, undefined);
  const flagged = await auth(request(app).get(path).query({ pitch: "gaps" }), manager).expect(200);
  assert.equal(flagged.body.total, 1);
  assert.equal(flagged.body.items[0].ai.summary, "Discussed pricing");
  assert.deepEqual(flagged.body.items[0].ai.objections, ["Monthly fee"]);
  assert.equal(flagged.body.items[0].transcript, undefined);
  const id = page.body.items[0]._id;
  const detail = await auth(request(app).get("/management/workspace/calls/" + id), manager).expect(200);
  assert.match(detail.body.call.transcript, /Sample transcript/);
  const body = { notes: "Discovery covered", revision: detail.body.call.updatedAt };
  await auth(request(app).post("/management/workspace/calls/" + id + "/review"), manager).send(body).expect(200);
  await auth(request(app).post("/management/workspace/calls/" + id + "/review"), manager).send(body).expect(409);
  const reviewed = await auth(request(app).get("/management/call-review?filter=reviewed"), manager).expect(200);
  assert.equal(reviewed.body.total, 1);
  assert.equal(reviewed.body.calls[0]._id, id);
  const today = await auth(request(app).get("/management/workspace/today"), manager).expect(200);
  assert.equal(today.body.reviews, 30);
});

test("manager workspace browses task and exception records and filters report snapshots", async () => {
  const task = await action({ dueAt: new Date(Date.now() - 10000) });
  const actions = await auth(request(app).get("/management/workspace/actions?status=overdue"), manager).expect(200);
  assert.equal(actions.body.items[0]._id, task.id);
  await Exception.create({ key: "workspace-test", title: "Missing contact", owner: agent.id, lead: lead.id, task: task.id });
  const exceptions = await auth(request(app).get("/management/workspace/exceptions?q=contact"), manager).expect(200);
  assert.equal(exceptions.body.items[0].task, task.id);
  await notify(manager.id, "daily-report:2025-03-05:" + agent.id, agent.name + " · 2025-03-05", "Saved report", {
    category: "daily_report", snapshot: { agent: agent.id, date: "2025-03-05", attempts: 3 },
  });
  const reports = await auth(request(app).get("/management/workspace/daily")
    .query({ owner: agent.id, from: "2025-03-05", to: "2025-03-05" }), manager).expect(200);
  assert.equal(reports.body.items[0].snapshot.attempts, 3);
});


test("manager recovery queue surfaces intake and deduplicates a task alert", async () => {
  const task = await action({ kind: "call", dueAt: new Date(Date.now() - 60000) });
  await Exception.create([
    { key: "meta-stale", type: "capture", severity: "critical", title: "Intake failed", detail: "Webhook stale" },
    { key: "overdue:" + task.id, type: "overdue", severity: "warning", title: "Late", task: task.id, lead: lead.id },
  ]);
  const url = "/management/leakage-queue";
  await auth(request(app).get(url)).expect(403);
  const { body } = await auth(request(app).get(url), manager).expect(200);
  assert.equal(body[0].category, "capture");
  assert.equal(body.filter(row => row.id === task.id).length, 1);
  assert.equal(body.find(row => row.id === task.id).category, "overdue");
  const today = await auth(request(app).get("/management/workspace/today"), manager).expect(200);
  assert.equal(today.body.capture.detail, "Webhook stale");
});

test("rescheduling a meeting replaces the schedule atomically and rejects a stale retry", async () => {
  const start = future();
  const end = new Date(+start + 1800000);
  const old = await Meeting.create({ lead: lead.id, bookedBy: agent.id, reps: [agent.id], start, end, type: "online", place: "https://example.com" });
  await action({ key: "meeting-confirm:" + old.id, kind: "confirmation", dueAt: start });
  const path = "/management/workspace/commitments/meeting/" + old.id;
  const detail = await auth(request(app).get(path), manager).expect(200);
  assert.equal(detail.body.tasks.length, 1);
  const next = { revision: old.updatedAt, start: new Date(+start + 86400000), end: new Date(+end + 86400000) };
  await auth(request(app).post(path + "/reschedule"), manager).send(next).expect(200);
  assert.equal((await Meeting.findById(old.id)).status, "cancelled");
  assert.equal((await Task.findOne({ key: "meeting-confirm:" + old.id })).status, "cancelled");
  assert.equal(await Meeting.countDocuments({ lead: lead.id, status: "scheduled" }), 1);
  await auth(request(app).post(path + "/reschedule"), manager).send(next).expect(409);
});

test("lead contact aliases match call journals and are searchable on both surfaces", async () => {
  const alternatePhone = "+919876543211";
  const whatsappPhone = "+919876543212";
  await auth(request(app).patch("/leads/" + lead.id)).send({ alternatePhone, whatsappPhone }).expect(200);
  const lookup = await auth(request(app).get("/leads").query({ q: whatsappPhone })).expect(200);
  assert.equal(lookup.body[0]._id, lead.id);
  const managerLookup = await auth(request(app).get("/management/workspace/leads").query({ q: alternatePhone }), manager).expect(200);
  assert.equal(managerLookup.body.items[0].whatsappPhone, whatsappPhone);
  const start = new Date(Date.now() - 20000);
  const sync = await auth(request(app).post("/calls/sync")).send({ calls: [{
    clientId: "alias-inbound", deviceId: "test-device", direction: "incoming", number: alternatePhone,
    startedAt: start, endedAt: new Date(), disconnectCode: 5,
  }] }).expect(200);
  assert.equal(String(sync.body[0].lead), lead.id);
  await auth(request(app).post("/leads")).send({ name: "Conflicting number", phone: "+919876543213", alternatePhone }).expect(409);
  await auth(request(app).patch("/leads/" + lead.id)).send({ alternatePhone: "" }).expect(200);
  assert.equal((await Lead.findById(lead.id)).alternatePhone, null);
});

test("last status uses the latest interaction, and filters before pagination", async () => {
  const earlier = new Date(Date.now() - 60000);
  const latest = new Date();
  const other = await Lead.create({ name: "Other lead", phone: "+919876543214", owner: agent.id });
  await Call.create({ clientId: "latest-status", lead: lead.id, agent: agent.id, startedAt: earlier, endedAt: earlier, outcome: "no_answer" });
  await Demo.create({ token: "last-status-demo", lead: lead.id, sentAt: latest });
  await Call.create({ clientId: "callback-status", lead: other.id, agent: agent.id, startedAt: earlier, endedAt: latest, outcome: "callback" });
  const mobile = await auth(request(app).get("/leads").query({ lastStatus: "demo_sent", page: 1 })).expect(200);
  assert.deepEqual(mobile.body.items.map(item => item._id), [lead.id]);
  const managerPage = await auth(request(app).get("/management/workspace/leads").query({ lastStatus: "callback" }), manager).expect(200);
  assert.deepEqual(managerPage.body.items.map(item => item._id), [other.id]);
  const stale = await auth(request(app).get("/leads").query({ lastStatus: "not_picked", page: 1 })).expect(200);
  assert.equal(stale.body.total, 0);
  await Meeting.create({ lead: lead.id, status: "completed", start: earlier, end: latest });
  const attended = await auth(request(app).get("/management/workspace/leads").query({ lastStatus: "meeting_attended" }), manager).expect(200);
  assert.deepEqual(attended.body.items.map(item => item._id), [lead.id]);
});
