import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import request from "supertest";
import jwt from "jsonwebtoken";
import { callFacts } from "../src/callFacts.js";
process.env.JWT_SECRET = "call-automation-test-secret-not-for-production";
const { app } = await import("../src/app.js");
const { User, Lead, Call, Task, Meeting } = await import("../src/models.js");
let db,
  agent,
  manager,
  token,
  count = 0;
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
  agent = await User.create({
    name: "Caller",
    email: "caller@test.local",
    role: "agent",
  });
  manager = await User.create({
    name: "Manager",
    email: "manager@test.local",
    role: "manager",
  });
  token = jwt.sign({ sub: agent.id }, process.env.JWT_SECRET);
});
after(async () => {
  await mongoose.disconnect();
  await db?.stop();
});
const auth = (r) => r.set("Authorization", "Bearer " + token);
async function fixture(extra = {}) {
  const lead = await Lead.create({
    name: "Lead " + ++count,
    phone: "+91987654" + String(count).padStart(4, "0"),
    owner: agent.id,
    ...extra,
  });
  return {
    lead,
    journal: {
      clientId: "auto-" + count,
      deviceId: "test-phone",
      direction: "outgoing",
      number: lead.phone,
      startedAt: new Date(Date.now() - 60000).toISOString(),
      endedAt: new Date().toISOString(),
      disconnectCode: 3,
      events: [{ type: "DIALING" }, { type: "DISCONNECTED" }],
    },
  };
}
async function sync(journal) {
  const r = await auth(request(app).post("/calls/sync")).send({
    calls: [journal],
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body[0];
}
test("REMOTE before answer is no answer, not proof of customer rejection", () => {
  const r = callFacts({
    direction: "outgoing",
    endedAt: new Date(),
    disconnectCode: 3,
    events: [{ type: "DISCONNECTED" }],
  });
  assert.equal(r.technicalResult, "not_answered");
  assert.equal(r.endedBy, "unknown");
  assert.equal(r.autoOutcome, "no_answer");
});
test("ambiguous, local, incoming rejection and answered calls never infer sales intent", () => {
  for (const c of [
    { disconnectCode: 0 },
    { disconnectCode: 2 },
    { disconnectCode: 4 },
    { disconnectCode: 6, direction: "incoming" },
    { disconnectCode: 3, localEndRequested: true },
    {
      disconnectCode: 3,
      events: [{ type: "ACTIVE" }, { type: "DISCONNECTED" }],
    },
  ])
    assert.equal(
      callFacts({
        direction: "outgoing",
        endedAt: new Date(),
        events: [{ type: "DISCONNECTED" }],
        ...c,
      }).autoOutcome,
      null
    );
});
test("known unanswered call auto saves and schedules one retry, including duplicate sync", async () => {
  const { lead, journal } = await fixture();
  const c = await sync(journal);
  assert.equal(c.outcomeSaved, true);
  assert.equal(c.outcomeSource, "events");
  assert.equal(c.technicalResult, "not_answered");
  assert.ok(c.autoNextAt);
  await sync(journal);
  assert.equal(await Task.countDocuments({ key: `outcome:${c._id}` }), 1);
  assert.equal(await Call.countDocuments({ lead: lead.id }), 1);
});
test("busy event schedules retry without claiming spoken customer was busy", async () => {
  const { journal } = await fixture();
  journal.disconnectCode = 7;
  const c = await sync(journal);
  assert.equal(c.technicalResult, "line_busy");
  assert.equal(c.outcome, "no_answer");
  assert.equal(c.outcomeSource, "events");
});
test("ACTIVE event is sufficient without answeredAt; sales disposition remains agent task", async () => {
  const { journal } = await fixture();
  journal.events.unshift({ type: "ACTIVE", at: journal.startedAt });
  const c = await sync(journal);
  assert.equal(c.outcomeSaved, false);
  assert.equal(c.technicalResult, "connected");
  assert.ok(c.answeredAt);
  assert.equal(c.endedBy, "remote_reported");
});
test("unknown code stays unsaved; duration cannot be used to guess", async () => {
  const { journal } = await fixture();
  journal.disconnectCode = 0;
  journal.activeMs = 30000;
  const c = await sync(journal);
  assert.equal(c.outcomeSaved, false);
  assert.equal(c.technicalResult, "unknown");
});
test("automatic retry preserves customer-promised time", async () => {
  const { lead, journal } = await fixture();
  const t = await Task.create({
    key: "fixed-" + lead.id,
    lead: lead.id,
    owner: agent.id,
    title: "Customer promise",
    kind: "call",
    fixed: true,
    dueAt: new Date(Date.now() + 86400000),
  });
  const c = await sync(journal);
  assert.equal(+new Date(c.autoNextAt), +t.dueAt);
  assert.equal(await Task.countDocuments({ lead: lead.id }), 1);
  assert.equal((await Task.findById(t.id)).status, "open");
});
test("call before booked meeting does not create an extra sales retry", async () => {
  const { lead, journal } = await fixture();
  await Meeting.create({
    lead: lead.id,
    reps: [agent.id],
    start: new Date(Date.now() + 3600000),
    end: new Date(Date.now() + 7200000),
    type: "online",
    place: "https://meet.example.com",
    status: "scheduled",
  });
  const c = await sync(journal);
  assert.equal(c.outcomeSource, "events");
  assert.equal(await Task.countDocuments({ lead: lead.id }), 0);
});
test("closed lead never gets automatic retry", async () => {
  const { lead, journal } = await fixture({ stage: "Lost" });
  const c = await sync(journal);
  assert.equal(c.outcomeSaved, false);
  assert.equal(await Task.countDocuments({ lead: lead.id }), 0);
});
test("selectable next action persists kind and rejects unsupported action", async () => {
  const { lead } = await fixture();
  const t = await Task.create({
    key: "complete-" + lead.id,
    lead: lead.id,
    owner: agent.id,
    title: "Call",
    kind: "call",
    dueAt: new Date(),
  });
  let r = await auth(request(app).patch("/tasks/" + t.id)).send({
    complete: true,
    note: "Requested details",
    nextAction: "bogus",
    nextAt: new Date(Date.now() + 3600000),
  });
  assert.equal(r.status, 422);
  assert.equal((await Task.findById(t.id)).status, "open");
  r = await auth(request(app).patch("/tasks/" + t.id)).send({
    complete: true,
    note: "Requested details",
    nextAction: "send_details",
    nextAt: new Date(Date.now() + 3600000),
  });
  assert.equal(r.status, 200);
  const n = await Task.findOne({ key: "after:" + t.id });
  assert.equal(n.kind, "send_details");
  assert.equal(n.title, "Send product details");
});
test("reports expose employee fields and reject invalid ranges", async () => {
  const managerToken = jwt.sign({ sub: manager.id }, process.env.JWT_SECRET);
  const r = await request(app)
    .get("/reports")
    .set("Authorization", "Bearer " + managerToken);
  assert.equal(r.status, 200);
  const e = r.body.employees.find((e) => e.id === agent.id);
  assert.equal(e.role, "agent");
  assert.equal(typeof e.overdueCount, "number");
  assert.equal(typeof e.meetingsBooked, "number");
  assert.ok(r.body.period.since);
  const bad = await request(app)
    .get("/reports?since=wrong")
    .set("Authorization", "Bearer " + managerToken);
  assert.equal(bad.status, 422);
});

test("a later ACTIVE journal reopens sales result and cancels only its generated retry", async () => {
  const { journal } = await fixture();
  let c = await sync(journal);
  assert.equal(c.outcomeSource, "events");
  journal.events.unshift({ type: "ACTIVE", at: journal.startedAt });
  c = await sync(journal);
  assert.equal(c.outcomeSaved, false);
  assert.equal(c.technicalResult, "connected");
  assert.equal(
    (await Task.findOne({ key: `outcome:${c._id}` })).status,
    "cancelled"
  );
});
