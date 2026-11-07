import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import request from "supertest";
import jwt from "jsonwebtoken";
process.env.JWT_SECRET = "meeting-test-secret-32-characters-long-enough";
const { app } = await import("../src/app.js");
const { User, Lead, Call, Task, Meeting } = await import("../src/models.js");
let db, agent, rep, token, lead;
const auth = (r) => r.set("Authorization", "Bearer " + token);
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
    role: "agent",
    email: "caller@tests.local",
  });
  rep = await User.create({
    name: "Arjun",
    role: "rep",
    email: "arjun@tests.local",
  });
  token = jwt.sign({ sub: agent.id }, process.env.JWT_SECRET);
  lead = await Lead.create({
    name: "Meeting lead",
    phone: "+919876543210",
    owner: agent.id,
  });
});
after(async () => {
  await mongoose.disconnect();
  await db?.stop();
});
async function call(name) {
  return Call.create({
    clientId: name,
    agent: agent.id,
    lead: lead.id,
    startedAt: new Date(),
    endedAt: new Date(),
    answeredAt: new Date(),
    events: [],
  });
}
const future = (days = 2) => new Date(Date.now() + days * 86400000);
function booking(days = 2) {
  return {
    start: future(days),
    end: new Date(+future(days) + 1800000),
    type: "physical",
    place: "Kochi showroom",
    reps: [rep.id],
    travelMinutes: 20,
    confirmed: true,
  };
}
test("meeting outcome cannot be saved without booking details", async () => {
  const c = await call("missing");
  const r = await auth(request(app).post(`/calls/${c.id}/outcome`)).send({
    outcome: "meeting_booked",
  });
  assert.equal(r.status, 422);
  assert.equal((await Call.findById(c.id)).outcomeSaved, false);
  assert.equal(await Meeting.countDocuments(), 0);
});
test("meeting call outcome, calendar booking and preparation task save atomically", async () => {
  const c = await call("booked");
  const r = await auth(request(app).post(`/calls/${c.id}/outcome`)).send({
    outcome: "meeting_booked",
    notes: "Wants scheme demo",
    meeting: booking(),
  });
  assert.equal(r.status, 200);
  assert.ok(r.body.meeting);
  const m = await Meeting.findById(r.body.meeting);
  assert.equal(String(m.sourceCall), c.id);
  assert.equal(m.place, "Kochi showroom");
  assert.equal((await Lead.findById(lead.id)).stage, "Demo/Meeting");
  assert.equal(
    await Task.countDocuments({ key: `meeting-prep:${m.id}`, status: "open" }),
    1
  );
});
test("repeated save returns existing booking instead of duplicating it", async () => {
  const c = await Call.findOne({ clientId: "booked" });
  await auth(request(app).post(`/calls/${c.id}/outcome`)).send({
    outcome: "meeting_booked",
    meeting: booking(),
  });
  assert.equal(await Meeting.countDocuments({ sourceCall: c.id }), 1);
});
test("conflicting rep booking rolls back outcome and leaves no orphan meeting/task", async () => {
  const c = await call("conflict");
  const before = await Task.countDocuments();
  const r = await auth(request(app).post(`/calls/${c.id}/outcome`)).send({
    outcome: "meeting_booked",
    meeting: booking(),
  });
  assert.equal(r.status, 409);
  assert.equal((await Call.findById(c.id)).outcomeSaved, false);
  assert.equal(await Meeting.countDocuments({ sourceCall: c.id }), 0);
  assert.equal(await Task.countDocuments(), before);
});
test("time not agreed creates an exact confirmation callback and no fake meeting", async () => {
  const c = await call("pending"),
    nextAt = future(1);
  const r = await auth(request(app).post(`/calls/${c.id}/outcome`)).send({
    outcome: "meeting_pending",
    nextAt,
  });
  assert.equal(r.status, 200);
  assert.equal(await Meeting.countDocuments({ sourceCall: c.id }), 0);
  const t = await Task.findOne({ key: `outcome:${c.id}` });
  assert.equal(t.kind, "confirm_meeting");
  assert.equal(+t.dueAt, +nextAt);
  assert.equal(t.fixed, true);
});
test("online link can be pending, with a real task assigned to the rep", async () => {
  const c = await call("online");
  const r = await auth(request(app).post(`/calls/${c.id}/outcome`)).send({
    outcome: "meeting_booked",
    meeting: {
      ...booking(4),
      type: "online",
      place: "",
      placePending: true,
      confirmed: false,
    },
  });
  assert.equal(r.status, 200);
  const m = await Meeting.findById(r.body.meeting);
  assert.equal(m.placePending, true);
  assert.ok(
    await Task.exists({
      key: `meeting-place:${m.id}`,
      owner: rep.id,
      status: "open",
    })
  );
  assert.ok(
    await Task.exists({ key: `meeting-confirm:${m.id}`, status: "open" })
  );
});
test("legacy falsely booked call can be repaired without a second call record", async () => {
  const c = await call("legacy");
  c.outcome = "meeting_booked";
  c.outcomeSaved = true;
  await c.save();
  await Task.create({
    lead: lead.id,
    owner: agent.id,
    key: `outcome:${c.id}`,
    title: "Confirm meeting time / booking",
    kind: "confirm_meeting",
    dueAt: new Date(),
  });
  const r = await auth(request(app).post(`/calls/${c.id}/outcome`)).send({
    outcome: "meeting_booked",
    meeting: booking(6),
  });
  assert.equal(r.status, 200);
  assert.ok(r.body.meeting);
  assert.equal(
    (await Task.findOne({ key: `outcome:${c.id}` })).status,
    "cancelled"
  );
});
test("closure requires a reason and cancels scheduled appointments", async () => {
  const c = await call("closed");
  const bad = await auth(request(app).post(`/calls/${c.id}/outcome`)).send({
    outcome: "do_not_contact",
  });
  assert.equal(bad.status, 422);
  const r = await auth(request(app).post(`/calls/${c.id}/outcome`)).send({
    outcome: "do_not_contact",
    notes: "Customer explicitly asked us to stop",
  });
  assert.equal(r.status, 200);
  assert.equal(await Task.countDocuments({ lead: lead.id, status: "open" }), 0);
  assert.equal(
    await Meeting.countDocuments({ lead: lead.id, status: "scheduled" }),
    0
  );
});
test("legacy booking can instead become a real confirmation callback", async () => {
  const l = await Lead.create({
    name: "Legacy pending",
    phone: "+919876543214",
    owner: agent.id,
  });
  const c = await Call.create({
    clientId: "legacy-pending",
    agent: agent.id,
    lead: l.id,
    outcome: "meeting_booked",
    outcomeSaved: true,
    startedAt: new Date(),
    endedAt: new Date(),
  });
  await Task.create({
    lead: l.id,
    owner: agent.id,
    key: `outcome:${c.id}`,
    title: "Confirm meeting time / booking",
    kind: "confirm_meeting",
    dueAt: new Date(),
  });
  const nextAt = future(5);
  const r = await auth(request(app).post(`/calls/${c.id}/outcome`)).send({
    outcome: "meeting_pending",
    nextAt,
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.outcome, "meeting_pending");
  const t = await Task.findOne({ key: `outcome:${c.id}` });
  assert.equal(+t.dueAt, +nextAt);
  assert.equal(t.title, "Confirm meeting time");
  assert.equal(await Meeting.countDocuments({ sourceCall: c.id }), 0);
});
test("adding a link and confirming an appointment closes its corresponding tasks", async () => {
  const l = await Lead.create({
    name: "Later link",
    phone: "+919876543215",
    owner: agent.id,
  });
  const r = await auth(request(app).post("/meetings")).send({
    ...booking(12),
    lead: l.id,
    type: "online",
    place: "",
    placePending: true,
    confirmed: false,
  });
  assert.equal(r.status, 201);
  const m = r.body;
  assert.ok(
    await Task.exists({ key: `meeting-place:${m._id}`, status: "open" })
  );
  const update = await auth(request(app).patch("/meetings/" + m._id)).send({
    place: "https://meet.example.com/abc",
    confirmed: true,
  });
  assert.equal(update.status, 200);
  assert.equal(update.body.placePending, false);
  assert.ok(
    await Task.exists({ key: `meeting-place:${m._id}`, status: "done" })
  );
  assert.ok(
    await Task.exists({ key: `meeting-confirm:${m._id}`, status: "done" })
  );
  const count = await Task.countDocuments({ lead: l.id, status: "open" });
  const bad = await auth(request(app).patch("/meetings/" + m._id)).send({
    status: "completed",
    outcome: "Interested",
    nextAt: "invalid",
  });
  assert.equal(bad.status, 422);
  assert.equal((await Meeting.findById(m._id)).status, "scheduled");
  assert.equal(
    await Task.countDocuments({ lead: l.id, status: "open" }),
    count
  );
});
