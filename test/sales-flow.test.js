import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import request from "supertest";
import jwt from "jsonwebtoken";
process.env.JWT_SECRET = "sales-flow-test-secret-at-least-32-characters";
const { app } = await import("../src/app.js");
const { User, Lead, Call, Task, Meeting, Activity } = await import(
  "../src/models.js"
);
let db,
  agent,
  rep,
  token,
  otherToken,
  seq = 0;
const auth = (r) => r.set("Authorization", "Bearer " + token);
const at = (hours) => new Date(Date.now() + hours * 3600000).toISOString();
before(async () => {
  db = await MongoMemoryReplSet.create({
    replSet: {
      count: 1,
      args: [
        "--nounixsocket",
        "--setParameter",
        "diagnosticDataCollectionEnabled=false",
      ],
    },
    binary: { version: "7.0.14" },
  });
  await mongoose.connect(db.getUri());
  await Promise.all(Object.values(mongoose.models).map((m) => m.init()));
  agent = await User.create({
    name: "Caller",
    email: "caller@flow.test",
    role: "agent",
  });
  rep = await User.create({ name: "Rep", email: "rep@flow.test", role: "rep" });
  token = jwt.sign({ sub: agent.id }, process.env.JWT_SECRET);
  otherToken = jwt.sign({ sub: rep.id }, process.env.JWT_SECRET);
});
after(async () => {
  await mongoose.disconnect();
  await db?.stop();
});
async function fixture() {
  const lead = await Lead.create({
    name: "Shop " + ++seq,
    phone: "+91987654" + String(seq).padStart(4, "0"),
    owner: agent.id,
  });
  const call = await Call.create({
    clientId: "flow-call-" + seq,
    lead: lead.id,
    agent: agent.id,
    startedAt: new Date(),
    answeredAt: new Date(),
    endedAt: new Date(),
  });
  return { lead, call };
}
const booking = (hours) => ({
  start: at(hours),
  end: at(hours + 0.5),
  type: "online",
  reps: [rep.id],
  place: "https://meet.example.com/demo",
  confirmed: true,
});
test("interested cannot save without a selected next action or required details", async () => {
  const { call } = await fixture();
  for (const body of [
    { outcome: "interested" },
    { outcome: "interested", nextAction: "call", nextAt: at(1) },
    { outcome: "interested", nextAction: "meeting" },
  ]) {
    const r = await auth(request(app).post(`/calls/${call.id}/outcome`)).send(
      body
    );
    assert.equal(r.status, 422);
    assert.equal((await Call.findById(call.id)).outcomeSaved, false);
  }
  assert.equal(await Task.countDocuments({ lead: call.lead }), 0);
});
test("interested with undecided meeting time creates an owned confirmation task only", async () => {
  const { call, lead } = await fixture();
  const r = await auth(request(app).post(`/calls/${call.id}/outcome`)).send({
    outcome: "interested",
    nextAction: "meeting",
    timeAgreed: false,
    nextAt: at(4),
    nextOwner: rep.id,
    notes: "Need to ask partner",
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.outcome, "meeting_pending");
  const t = await Task.findOne({ lead: lead.id, status: "open" });
  assert.equal(t.kind, "confirm_meeting");
  assert.equal(String(t.owner), rep.id);
  assert.equal(await Meeting.countDocuments({ lead: lead.id }), 0);
});
test("confirmation task books meeting and closes atomically; repeated submit is harmless", async () => {
  const { lead } = await fixture();
  const t = await Task.create({
    key: "pending-" + lead.id,
    lead: lead.id,
    owner: agent.id,
    kind: "confirm_meeting",
    dueAt: new Date(),
  });
  const body = {
    complete: true,
    outcome: "meeting_booked",
    meeting: booking(48),
    notes: "Customer agreed",
  };
  const r = await auth(request(app).patch("/tasks/" + t.id)).send(body);
  assert.equal(r.status, 200);
  assert.equal(r.body.status, "done");
  assert.ok(r.body.meeting);
  assert.equal(await Meeting.countDocuments({ lead: lead.id }), 1);
  assert.equal((await Lead.findById(lead.id)).stage, "Demo/Meeting");
  const again = await auth(request(app).patch("/tasks/" + t.id)).send(body);
  assert.equal(again.status, 200);
  assert.equal(await Meeting.countDocuments({ lead: lead.id }), 1);
});
test("booking conflict keeps the confirmation task open and creates no orphan", async () => {
  const { lead } = await fixture();
  const t = await Task.create({
    key: "conflict-" + lead.id,
    lead: lead.id,
    owner: agent.id,
    kind: "confirm_meeting",
    dueAt: new Date(),
  });
  const r = await auth(request(app).patch("/tasks/" + t.id)).send({
    complete: true,
    outcome: "meeting_booked",
    meeting: booking(48),
  });
  assert.equal(r.status, 409);
  assert.equal((await Task.findById(t.id)).status, "open");
  assert.equal(await Meeting.countDocuments({ lead: lead.id }), 0);
});
test("still undecided schedules a new confirmation task with the reason", async () => {
  const { lead } = await fixture();
  const t = await Task.create({
    key: "again-" + lead.id,
    lead: lead.id,
    owner: agent.id,
    kind: "confirm_meeting",
    dueAt: new Date(),
  });
  const r = await auth(request(app).patch("/tasks/" + t.id)).send({
    complete: true,
    outcome: "meeting_pending",
    nextAt: at(6),
    notes: "Partner unavailable",
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.status, "done");
  const n = await Task.findOne({ key: "after:" + t.id });
  assert.equal(n.kind, "confirm_meeting");
  assert.match(n.reason, /Partner unavailable/);
  assert.equal(await Meeting.countDocuments({ lead: lead.id }), 0);
});
test("details create sending and linked follow-up; a later call does not mark details sent", async () => {
  const { lead, call } = await fixture();
  let r = await auth(request(app).post(`/calls/${call.id}/outcome`)).send({
    outcome: "interested",
    nextAction: "send_details",
    actionNote: "Gold scheme brochure",
    channel: "whatsapp",
    sendAt: at(1),
    nextAt: at(3),
  });
  assert.equal(r.status, 200);
  const send = await Task.findOne({ lead: lead.id, kind: "send_details" });
  assert.ok(send.followUp);
  assert.equal(await Task.countDocuments({ lead: lead.id, status: "open" }), 2);
  send.dueAt = new Date(Date.now() - 60000);
  await send.save();
  const c2 = await Call.create({
    clientId: "later-" + lead.id,
    lead: lead.id,
    agent: agent.id,
    answeredAt: new Date(),
    endedAt: new Date(),
  });
  r = await auth(request(app).post(`/calls/${c2.id}/outcome`)).send({
    outcome: "callback",
    nextAt: at(5),
  });
  assert.equal(r.status, 200);
  assert.equal((await Task.findById(send.id)).status, "open");
  r = await auth(request(app).patch("/tasks/" + send.id)).send({
    complete: true,
    note: "Sent via WhatsApp",
    nextAction: "call",
    nextAt: at(4),
  });
  assert.equal(r.status, 200);
  assert.equal(await Task.countDocuments({ key: "after:" + send.id }), 0);
  assert.equal((await Task.findById(send.followUp)).status, "open");
});
test("sending must precede follow-up; proposal and partner keep specific context", async () => {
  const { call } = await fixture();
  const bad = await auth(request(app).post(`/calls/${call.id}/outcome`)).send({
    outcome: "interested",
    nextAction: "proposal",
    actionNote: "Two branches",
    channel: "email",
    sendAt: at(4),
    nextAt: at(2),
  });
  assert.equal(bad.status, 422);
  const r = await auth(request(app).post(`/calls/${call.id}/outcome`)).send({
    outcome: "interested",
    nextAction: "proposal",
    actionNote: "Two branches",
    channel: "email",
    sendAt: at(1),
    nextAt: at(2),
  });
  assert.equal(r.status, 200);
  assert.equal(
    (await Task.findOne({ key: "outcome:" + call.id })).kind,
    "send_proposal"
  );
  const next = await fixture();
  const partner = await auth(
    request(app).post(`/calls/${next.call.id}/outcome`)
  ).send({
    outcome: "interested",
    nextAction: "partner",
    actionNote: "Owner will discuss with brother",
    nextAt: at(4),
  });
  assert.equal(partner.status, 200);
  assert.match(
    (await Task.findOne({ key: "outcome:" + next.call.id })).reason,
    /brother/
  );
});
test("confirmed online time with missing link creates a real link responsibility", async () => {
  const { call } = await fixture();
  const r = await auth(request(app).post(`/calls/${call.id}/outcome`)).send({
    outcome: "interested",
    nextAction: "meeting",
    timeAgreed: true,
    meeting: { ...booking(72), place: "", placePending: true },
  });
  assert.equal(r.status, 200);
  assert.ok(r.body.meeting);
  assert.ok(
    await Task.exists({
      key: "meeting-place:" + r.body.meeting,
      owner: rep.id,
      status: "open",
    })
  );
});
test("exact post-call lookup is agent scoped and not limited to recent list results", async () => {
  const { call } = await fixture();
  const mine = await auth(request(app).get("/calls/client/" + call.clientId));
  assert.equal(mine.status, 200);
  assert.equal(mine.body._id, call.id);
  const other = await request(app)
    .get("/calls/client/" + call.clientId)
    .set("Authorization", "Bearer " + otherToken);
  assert.equal(other.status, 404);
});
test("meeting result can close the lead with no forced future follow-up", async () => {
  const { lead } = await fixture();
  const m = await Meeting.create({
    lead: lead.id,
    reps: [rep.id],
    start: at(-2),
    end: at(-1),
    status: "scheduled",
  });
  const t = await Task.create({
    lead: lead.id,
    owner: agent.id,
    key: "meeting-result:" + m.id,
    kind: "meeting_result",
    dueAt: new Date(),
  });
  const r = await auth(request(app).patch("/meetings/" + m.id)).send({
    status: "completed",
    salesOutcome: { outcome: "not_interested", notes: "Budget does not fit" },
  });
  assert.equal(r.status, 200);
  assert.equal((await Lead.findById(lead.id)).stage, "Lost");
  assert.equal((await Task.findById(t.id)).status, "cancelled");
  assert.equal(await Task.countDocuments({ lead: lead.id, status: "open" }), 0);
});
test("meeting result can schedule a confirmation action and saves once", async () => {
  const { lead } = await fixture();
  const m = await Meeting.create({
    lead: lead.id,
    reps: [rep.id],
    start: at(-2),
    end: at(-1),
    status: "scheduled",
  });
  const body = {
    status: "completed",
    salesOutcome: {
      outcome: "interested",
      nextAction: "meeting",
      timeAgreed: false,
      nextAt: at(2),
      notes: "Needs second walkthrough with partner",
    },
  };
  const replies = await Promise.all(
    [1, 2].map(() => auth(request(app).patch("/meetings/" + m.id)).send(body))
  );
  assert.deepEqual(
    replies.map((r) => r.status),
    [200, 200]
  );
  assert.equal(await Task.countDocuments({ key: "meeting-next:" + m.id }), 1);
  assert.equal(
    (await Task.findOne({ key: "meeting-next:" + m.id })).kind,
    "confirm_meeting"
  );
  assert.equal(
    await Activity.countDocuments({ lead: lead.id, type: "meeting_outcome" }),
    1
  );
});
test("send now schedules immediate work with a future follow-up", async () => {
  const { call } = await fixture();
  const before = Date.now();
  const r = await auth(request(app).post(`/calls/${call.id}/outcome`)).send({
    outcome: "interested",
    nextAction: "send_details",
    actionNote: "App walkthrough video",
    channel: "whatsapp",
    sendNow: true,
    nextAt: at(3),
  });
  assert.equal(r.status, 200);
  const sending = await Task.findOne({ key: "outcome:" + call.id });
  assert.ok(+sending.dueAt >= before && +sending.dueAt <= Date.now());
  assert.ok(sending.followUp);
});
test("an undecided confirmation cannot be completed without a reason", async () => {
  const { lead } = await fixture();
  const task = await Task.create({
    lead: lead.id,
    owner: agent.id,
    key: "reason-" + lead.id,
    kind: "confirm_meeting",
    dueAt: new Date(),
  });
  const bad = await auth(request(app).patch("/tasks/" + task.id)).send({
    complete: true,
    outcome: "meeting_pending",
    nextAt: at(3),
  });
  assert.equal(bad.status, 422);
  assert.equal((await Task.findById(task.id)).status, "open");
});

test("logging a callback preserves unrelated tasks and revives a provisional outcome key", async () => {
  const { lead, call } = await fixture();
  const base = { lead: lead.id, kind: "call", dueAt: at(-1), title: "Callback" };
  const unrelated = await Task.create({ ...base, owner: rep.id, key: "other:" + call.id });
  await Task.create({ ...base, owner: agent.id, key: "outcome:" + call.id, status: "cancelled" });
  const reply = await auth(request(app).post(`/calls/${call.id}/outcome`))
    .send({ outcome: "callback", nextAt: at(1) });
  assert.equal(reply.status, 200);
  assert.equal((await Task.findById(unrelated.id)).status, "open");
  const next = await Task.findOne({ key: "outcome:" + call.id });
  assert.equal(next.status, "open");
  assert.ok(next.dueAt > new Date());
});

test("personalized demo starts from call outcome once and creates owned logo task", async () => {
  const { call } = await fixture();
  const payload = {
    outcome: "interested", nextAction: "demo", actionNote: "Gold scheme",
    nextAt: at(2), nextOwner: rep.id,
  };
  for (let i = 0; i < 2; i++) {
    const reply = await auth(request(app).post(`/calls/${call.id}/outcome`)).send(payload);
    assert.equal(reply.status, 200);
  }
  const tasks = await Task.find({ lead: call.lead, title: "Request customer logo" });
  assert.equal(tasks.length, 1);
  assert.equal(String(tasks[0].owner), rep.id);
  assert.ok(tasks[0].demo);
});

test("only managers can record a first-pitch coaching review", async () => {
  const { call } = await fixture();
  const manager = await User.create({ name: "Coach", email: "coach@flow.test", role: "manager" });
  const coachToken = jwt.sign({ sub: manager.id }, process.env.JWT_SECRET);
  const url = `/calls/${call.id}/coaching-review`;
  const body = {
    checks: { introduction: "done", qualification: "missed", relevantPitch: "done",
      objectionHandling: "not_applicable", nextCommitment: "unassessable" },
    evidence: "00:05 stated the reason for the call",
  };
  assert.equal((await auth(request(app).patch(url)).send(body)).status, 403);
  const reviewed = await request(app).patch(url).set("Authorization", "Bearer " + coachToken).send(body);
  assert.equal(reviewed.status, 200);
  assert.equal(reviewed.body.rubric, "first-pitch-v1");
  assert.equal(String((await Call.findById(call.id)).coachingReview.reviewer), manager.id);
});
