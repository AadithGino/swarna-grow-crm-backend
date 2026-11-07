import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import request from "supertest";
import bcrypt from "bcryptjs";
process.env.JWT_SECRET = "test-only-secret-32-characters-long-enough";
process.env.PUBLIC_URL = "http://localhost:4000";
const { app } = await import("../src/app.js");
const { User, Lead, Task, Call, Activity, Meeting, Demo, Job } = await import(
  "../src/models.js"
);
const { sweep } = await import("../src/workflow.js");
let db, manager, agent, rep, lead, token, agentToken;
const auth = (r, t = token) => r.set("Authorization", "Bearer " + t);
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
  manager = await User.create({
    name: "Owner",
    email: "owner@test.local",
    role: "manager",
    passwordHash: await bcrypt.hash("password-test-123", 4),
  });
  agent = await User.create({
    name: "Agent",
    email: "agent@test.local",
    role: "agent",
    passwordHash: await bcrypt.hash("password-test-123", 4),
  });
  rep = await User.create({
    name: "Rep",
    email: "rep@test.local",
    role: "rep",
  });
  token = (
    await request(app)
      .post("/auth/login")
      .send({ email: manager.email, password: "password-test-123" })
  ).body.token;
  agentToken = (
    await request(app)
      .post("/auth/login")
      .send({ email: agent.email, password: "password-test-123" })
  ).body.token;
});
after(async () => {
  await mongoose.disconnect();
  await db?.stop();
});
test("unauthenticated reads blocked", async () =>
  assert.equal((await request(app).get("/leads")).status, 401));
test("lead capture deduplicates and creates one accountable first action", async () => {
  let r = await auth(request(app).post("/leads")).send({
    name: "Kairali",
    phone: "9876543210",
    owner: agent.id,
    source: "Referral",
  });
  assert.equal(r.status, 201);
  lead = r.body;
  let dupe = await auth(request(app).post("/leads")).send({
    name: "Duplicate",
    phone: "+919876543210",
  });
  assert.equal(dupe.body.duplicate, true);
  assert.equal(await Lead.countDocuments(), 1);
  assert.equal(await Task.countDocuments({ lead: lead._id }), 1);
});
test("employee cannot access manager-only reports or unassigned leads", async () => {
  assert.equal(
    (await auth(request(app).get("/reports"), agentToken)).status,
    403
  );
  const privateLead = await Lead.create({
    name: "Private",
    phone: "+919876543211",
    owner: manager.id,
  });
  assert.equal(
    (await auth(request(app).get("/leads/" + privateLead.id), agentToken))
      .status,
    403
  );
});
test("call journal retries do not duplicate or trust client-supplied agent", async () => {
  let body = {
    calls: [
      {
        clientId: "device-call-1",
        deviceId: "phone1",
        agent: manager.id,
        number: "9876543210",
        direction: "outgoing",
        startedAt: new Date(Date.now() - 120000),
        answeredAt: new Date(Date.now() - 100000),
        endedAt: new Date(),
        activeMs: 100000,
        disconnectCode: 3,
        events: [],
      },
    ],
  };
  let a = await auth(request(app).post("/calls/sync"), agentToken).send(body);
  assert.equal(a.status, 200);
  await auth(request(app).post("/calls/sync"), agentToken).send(body);
  assert.equal(await Call.countDocuments({ clientId: "device-call-1" }), 1);
  assert.equal(a.body[0].agent, agent.id);
  assert.equal(a.body[0].endedBy, "remote_reported");
});
test("invalid callback rolls back; concurrent outcome submissions create one next task", async () => {
  const c = await Call.findOne({ clientId: "device-call-1" });
  let bad = await auth(
    request(app).post(`/calls/${c.id}/outcome`),
    agentToken
  ).send({ outcome: "callback" });
  assert.equal(bad.status, 400);
  assert.equal((await Call.findById(c.id)).outcomeSaved, false);
  let out = await Promise.all(
    [1, 2].map(() =>
      auth(request(app).post(`/calls/${c.id}/outcome`), agentToken).send({
        outcome: "callback",
        nextAt: new Date(Date.now() + 86400000),
        notes: "Asked for tomorrow",
      })
    )
  );
  assert.deepEqual(
    out.map((r) => r.status),
    [200, 200]
  );
  assert.equal(await Task.countDocuments({ key: `outcome:${c.id}` }), 1);
  assert.equal(await Activity.countDocuments({ type: "call_outcome" }), 1);
});
test("AI summary does not mutate saved agent outcome", async () => {
  const c = await Call.findOne({ clientId: "device-call-1" });
  await Call.updateOne(
    { _id: c.id },
    { $set: { ai: { summary: "Interested" }, aiStatus: "ready" } }
  );
  assert.equal((await Call.findById(c.id)).outcome, "callback");
});
test("daily priority sweep is idempotent and honours exact callback pause", async () => {
  await Lead.updateOne(
    { _id: lead._id },
    {
      $set: {
        ultra: true,
        priorityReason: "Ready to buy",
        pauseUntil: new Date(Date.now() + 3 * 86400000),
      },
    }
  );
  await sweep();
  await sweep();
  assert.ok(
    (await Task.countDocuments({ lead: lead._id, key: /^ultra:/ })) <= 1
  );
  const t = await Task.findOne({ lead: lead._id, key: /^ultra:/ });
  if (t) assert.equal(t.kind, "internal");
});
test("meeting rep conflict is rejected including travel buffer", async () => {
  let start = new Date(Date.now() + 5 * 86400000),
    end = new Date(+start + 3600000);
  let body = {
    lead: lead._id,
    reps: [rep.id],
    type: "physical",
    place: "Kochi",
    start,
    end,
    travelMinutes: 30,
  };
  assert.equal(
    (await auth(request(app).post("/meetings")).send(body)).status,
    201
  );
  assert.equal(
    (
      await auth(request(app).post("/meetings")).send({
        ...body,
        start: new Date(+end + 10 * 60000),
        end: new Date(+end + 70 * 60000),
      })
    ).status,
    409
  );
});
test("demo ready requires URL; generating URL never counts as sent", async () => {
  let d = await auth(request(app).post("/demos")).send({ lead: lead._id });
  assert.equal(d.status, 201);
  assert.equal(
    (
      await auth(request(app).patch("/demos/" + d.body._id)).send({
        status: "ready",
      })
    ).status,
    422
  );
  await auth(request(app).patch("/demos/" + d.body._id)).send({
    status: "logo_received",
    logoNote: "Logo received in customer chat",
  });
  await auth(request(app).patch("/demos/" + d.body._id)).send({
    status: "preparing",
  });
  let r = await auth(request(app).patch("/demos/" + d.body._id)).send({
    status: "ready",
    url: "https://example.com/demo",
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.sentAt, undefined);
  assert.equal(
    (
      await auth(request(app).patch("/demos/" + d.body._id)).send({
        status: "sent",
      })
    ).status,
    422
  );
  assert.equal(
    (
      await auth(request(app).patch("/demos/" + d.body._id)).send({
        status: "sent",
        confirmSent: true,
        channel: "WhatsApp",
      })
    ).status,
    200
  );
});
test("Won requires evidence flags; closure cancels tasks and scheduled meetings", async () => {
  assert.equal(
    (
      await auth(request(app).patch("/leads/" + lead._id)).send({
        stage: "Won",
      })
    ).status,
    400
  );
  assert.equal(
    (
      await auth(request(app).patch("/leads/" + lead._id)).send({
        stage: "Lost",
        closeReason: "No budget",
      })
    ).status,
    200
  );
  assert.equal(
    await Task.countDocuments({ lead: lead._id, status: "open" }),
    0
  );
  assert.equal(
    await Meeting.countDocuments({ lead: lead._id, status: "scheduled" }),
    0
  );
});
test("rep can see assigned meeting lead while unrelated lead stays hidden", async () => {
  const jwt = (await import("jsonwebtoken")).default;
  const repToken = jwt.sign({ sub: rep.id }, process.env.JWT_SECRET);
  const r = await auth(request(app).get("/leads"), repToken);
  assert.ok(r.body.some((l) => l._id === lead._id));
  assert.ok(r.body.every((l) => l.name !== "Private"));
});
test("non-overlapping later meeting succeeds, simultaneous bookings serialize", async () => {
  const l = await Lead.findById(lead._id);
  l.stage = "Qualified";
  await l.save();
  const start = new Date(Date.now() + 8 * 86400000),
    end = new Date(+start + 3600000);
  const body = {
    lead: lead._id,
    reps: [rep.id],
    type: "online",
    place: "https://meet.example.com",
    start,
    end,
  };
  const r = await Promise.all(
    [1, 2].map(() => auth(request(app).post("/meetings")).send(body))
  );
  assert.deepEqual(r.map((x) => x.status).sort(), [201, 409]);
  assert.equal(
    (
      await auth(request(app).post("/meetings")).send({
        ...body,
        start: new Date(+end + 3600000),
        end: new Date(+end + 7200000),
      })
    ).status,
    201
  );
});
test("S3 verification queues one AI job; worker adds summary without changing agent outcome", async () => {
  const { s3 } = await import("../src/storage.js");
  const { processJob } = await import("../src/worker.js");
  const oldSend = s3.send,
    oldFetch = global.fetch;
  process.env.S3_BUCKET = "test-private-bucket";
  process.env.GROQ_API_KEY = "test-groq";
  process.env.SARVAM_API_KEY = "test-sarvam";
  try {
    const c = await Call.findOne({ clientId: "device-call-1" });
    c.recordingKey = `calls/${agent.id}/${c.id}/original`;
    c.recordingBytes = 6;
    c.recordingStatus = "uploading";
    c.transcript = undefined;
    await c.save();
    s3.send = async (command) =>
      command.constructor.name === "HeadObjectCommand"
        ? { ContentLength: 6 }
        : {
            ContentType: "audio/ogg",
            Body: {
              transformToByteArray: async () =>
                new Uint8Array([1, 2, 3, 4, 5, 6]),
            },
          };
    assert.equal(
      (
        await auth(
          request(app).post(`/calls/${c.id}/upload-complete`),
          agentToken
        ).send({})
      ).status,
      200
    );
    await auth(
      request(app).post(`/calls/${c.id}/upload-complete`),
      agentToken
    ).send({});
    assert.equal(await Job.countDocuments({ call: c.id }), 1);
    global.fetch = async (url) =>
      new Response(
        JSON.stringify(
          String(url).includes("groq")
            ? { text: "നാളെ call ചെയ്യൂ. I will discuss with my partner." }
            : {
                choices: [
                  {
                    message: {
                      content: JSON.stringify({
                        summary:
                          "Customer requested a callback after discussing with partner.",
                        requirements: [],
                        objections: [],
                        commitments: ["I will discuss with my partner"],
                        suggestedOutcome: "partner",
                        nextAction: "Confirm a callback time",
                        followUpPhrase: "നാളെ",
                        uncertainties: [],
                      }),
                    },
                  },
                ],
              }
        ),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    await processJob();
    const saved = await Call.findById(c.id);
    assert.equal(saved.aiStatus, "ready");
    assert.equal(saved.outcome, "callback");
    assert.ok(saved.transcript.includes("partner"));
    assert.equal((await Job.findOne({ call: c.id })).status, "done");
  } finally {
    s3.send = oldSend;
    global.fetch = oldFetch;
  }
});
test("fresh priority lead paused by customer gets one internal daily task", async () => {
  const l = await Lead.create({
    name: "Priority pause",
    phone: "+919876543213",
    owner: agent.id,
    ultra: true,
    priorityReason: "Decision pending",
    pauseUntil: new Date(Date.now() + 4 * 86400000),
  });
  await sweep();
  await sweep();
  const t = await Task.find({ lead: l.id, key: /^ultra:/ });
  assert.equal(t.length, 1);
  assert.equal(t[0].kind, "internal");
});
