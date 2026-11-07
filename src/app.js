import operationsRoutes from "./operationsRoutes.js";
import { initializeLead } from "./coverage.js";
import { initializeDemo, advanceDemo } from "./demoFlow.js";
import { changeTask } from "./taskChanges.js";
import { healthSnapshot } from "./health.js";
import { selectedAction } from "./nextActions.js";
import { callFacts } from "./callFacts.js";
import { applyAutomaticOutcome } from "./automaticCalls.js";
import { meetingInput, ensureCalendarLocks, bookMeeting } from "./meetings.js";
import express from "express";
import helmet from "helmet";
import cors from "cors";
import rateLimit from "express-rate-limit";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import mongoose from "mongoose";
import { parse } from "csv-parse/sync";
import {
  User,
  Lead,
  Task,
  Call,
  Activity,
  Meeting,
  Demo,
  Proposal,
  Job,
  Import,
  Setting,
} from "./models.js";
import { phone, workSlot, nextStep, callMetrics, activeLead } from "./rules.js";
import {
  buildCallIntelligence,
  buildEmployeeIntelligence,
} from "./callInsights.js";
import { deepTranscriptInsights } from "./transcriptAnalysis.js";
import { localLeadOverview, synthesizeLeadOverview } from "./leadOverview.js";
import { task, log, sweep } from "./workflow.js";
import { presign, completeUpload, playback } from "./storage.js";
import { ingestMeta } from "./meta.js";
export const app = express();
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: process.env.CORS_ORIGIN?.split(",") || false }));
app.use(
  express.json({
    limit: "2mb",
    verify: (req, res, b) => {
      req.rawBody = b;
    },
  })
);
app.use(rateLimit({ windowMs: 60000, limit: 300 }));
const wrap = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);
const fail = (m, status = 400) => Object.assign(new Error(m), { status });
const id = (v) => mongoose.isValidObjectId(v);
app.get("/health", (q, s) =>
  s.json({ ok: true, database: mongoose.connection.readyState === 1 })
);
app.post(
  "/auth/login",
  rateLimit({ windowMs: 900000, limit: 20 }),
  wrap(async (q, s) => {
    const u = await User.findOne({
      email: String(q.body.email).toLowerCase(),
      active: true,
    }).select("+passwordHash");
    if (!u || !(await bcrypt.compare(q.body.password || "", u.passwordHash)))
      throw fail("Invalid login", 401);
    s.json({
      token: jwt.sign({ sub: u.id }, process.env.JWT_SECRET, {
        expiresIn: "7d",
      }),
      user: { _id: u.id, name: u.name, role: u.role },
    });
  })
);
app.get(
  "/health/automation",
  wrap(async (q, s) => {
    const expected = process.env.WATCHDOG_TOKEN || "",
      actual = q.get("x-watchdog-token") || "";
    if (
      expected.length < 32 ||
      actual.length !== expected.length ||
      !crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(expected))
    )
      throw fail("Unauthorized", 401);
    const snapshot = await healthSnapshot();
    s.status(snapshot.ok ? 200 : 503).json(snapshot);
  })
);
app.get("/webhooks/meta", (q, s) =>
  q.query["hub.verify_token"] === process.env.META_VERIFY_TOKEN &&
  process.env.META_VERIFY_TOKEN
    ? s.send(q.query["hub.challenge"])
    : s.sendStatus(403)
);
app.post(
  "/webhooks/meta",
  wrap(async (q, s) => {
    const secret = process.env.META_APP_SECRET;
    if (!secret) throw fail("Meta is not configured", 503);
    const expected =
      "sha256=" +
      crypto.createHmac("sha256", secret).update(q.rawBody).digest("hex");
    const actual = q.get("x-hub-signature-256") || "";
    if (
      actual.length !== expected.length ||
      !crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(expected))
    )
      throw fail("Invalid signature", 403);
    for (const e of q.body.entry || [])
      for (const c of e.changes || [])
        if (c.field === "leadgen")
          await Import.updateOne(
            { externalId: c.value.leadgen_id },
            { $setOnInsert: { status: "pending", payload: c.value } },
            { upsert: true }
          );
    s.sendStatus(200);
  })
);
app.get(
  "/demo/:token",
  wrap(async (q, s) => {
    const d = await Demo.findOne({ token: q.params.token });
    if (!d || d.expiresAt < new Date())
      return s
        .status(410)
        .send("Demo expired. Please contact your salesperson.");
    const safe = (x) =>
      String(x || "").replace(
        /[&<>"']/g,
        (c) =>
          ({
            "&": "&amp;",
            "<": "&lt;",
            ">": "&gt;",
            '"': "&quot;",
            "'": "&#39;",
          }[c])
      );
    s.type("html").send(
      `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>${safe(
        d.shopName
      )} · SwarnaGrow</title><style>body{background:#101a19;color:#fff;font:18px system-ui;max-width:600px;margin:12vh auto;padding:24px}button{background:#c7ee91;padding:18px;border:0;border-radius:14px;font:inherit}small{color:#aabdb5}</style><small>YOUR PERSONAL SWARNAGROW DEMO</small><h1>${safe(
        d.shopName
      )}</h1><p>${safe(
        d.modules
      )}</p><p>Your jewellery business, connected.</p><form method="post" action="/demo/${
        d.token
      }/enter"><button>Open my demo →</button></form>`
    );
  })
);
app.post(
  "/demo/:token/enter",
  wrap(async (q, s) => {
    const d = await Demo.findOne({
      token: q.params.token,
      status: { $in: ["sent", "explored"] },
      expiresAt: { $gt: new Date() },
    });
    if (!d || !d.url)
      return s
        .status(409)
        .send("Your salesperson has not shared this demo yet.");
    await advanceDemo(d.id, { status: "explored" }, null, {
      trustedEntry: true,
    });
    s.redirect(303, d.url);
  })
);
app.use(
  wrap(async (q, s, next) => {
    try {
      q.user = await User.findById(
        jwt.verify(
          (q.get("authorization") || "").replace(/^Bearer /, ""),
          process.env.JWT_SECRET
        ).sub
      );
      if (!q.user?.active) throw Error();
    } catch {
      throw fail("Please sign in", 401);
    }
    if (q.user.role !== "manager") {
      const [tasks, meetings] = await Promise.all([
        Task.find({ owner: q.user.id }).distinct("lead"),
        Meeting.find({ reps: q.user.id }).distinct("lead"),
      ]);
      q.sharedLeadIds = [...tasks, ...meetings];
    }
    next();
  })
);
const manager = (q, s, next) =>
  q.user.role === "manager"
    ? next()
    : next(fail("Manager access required", 403));
app.use(operationsRoutes);
async function leadFor(q, leadId) {
  if (!id(leadId)) throw fail("Invalid lead");
  const l = await Lead.findById(leadId);
  if (!l) throw fail("Lead not found", 404);
  if (
    q.user.role !== "manager" &&
    String(l.owner) !== q.user.id &&
    !(await Task.exists({ lead: l.id, owner: q.user.id })) &&
    !(await Meeting.exists({ lead: l.id, reps: q.user.id }))
  )
    throw fail("Lead not assigned to you", 403);
  return l;
}
async function callFor(q, callId) {
  const c = await Call.findById(callId);
  if (!c || (q.user.role !== "manager" && String(c.agent) !== q.user.id))
    throw fail("Call not found", 404);
  return c;
}
const leadScope = (q) =>
  q.user.role === "manager"
    ? {}
    : { $or: [{ owner: q.user.id }, { _id: { $in: q.sharedLeadIds || [] } }] };
app.get("/me", (q, s) => s.json(q.user));
app.get(
  "/users",
  wrap(async (q, s) =>
    s.json(await User.find({ active: true }).select("name email role"))
  )
);
app.post(
  "/users",
  manager,
  wrap(async (q, s) => {
    const { name, email, password, role } = q.body;
    if (
      !name ||
      !email ||
      String(password).length < 12 ||
      !["manager", "agent", "rep", "operator"].includes(role)
    )
      throw fail("Name, email, role and password of 12+ characters required");
    const u = await User.create({
      name,
      email,
      role,
      passwordHash: await bcrypt.hash(password, 12),
    });
    s.status(201).json({
      _id: u.id,
      name: u.name,
      email: u.email,
      role: u.role,
    });
  })
);

app.patch(
  "/users/:id",
  manager,
  wrap(async (q, s) => {
    if (q.params.id === q.user.id && q.body.active === false)
      throw fail("Cannot deactivate your own account");
    const u = await User.findById(q.params.id);
    if (!u) throw fail("Employee not found", 404);
    if (q.body.active !== undefined) u.active = !!q.body.active;
    if (q.body.name) u.name = q.body.name;
    await u.save();
    s.json({ _id: u.id, name: u.name, role: u.role, active: u.active });
  })
);
app.get(
  "/leads",
  wrap(async (q, s) => {
    let filter = leadScope(q);
    if (q.query.q) {
      const escaped = String(q.query.q)
        .slice(0, 100)
        .replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      filter = {
        $and: [
          filter,
          {
            $or: [
              { name: { $regex: escaped, $options: "i" } },
              { phone: { $regex: escaped } },
            ],
          },
        ],
      };
    }
    s.json(
      await Lead.find(filter)
        .populate("owner", "name")
        .sort({ ultra: -1, updatedAt: -1 })
        .limit(500)
    );
  })
);
app.post(
  "/leads",
  wrap(async (q, s) => {
    const { name, source, location } = q.body;
    if (!name) throw fail("Shop/contact name required");
    const p = phone(q.body.phone);
    let existing = await Lead.findOne({ phone: p });
    if (existing) {
      if (q.user.role !== "manager" && String(existing.owner) !== q.user.id)
        throw fail(
          "This phone already belongs to another assigned lead; ask your manager",
          409
        );
      return s.status(200).json({ ...existing.toObject(), duplicate: true });
    }
    const owner =
      q.user.role === "manager" && id(q.body.owner) ? q.body.owner : q.user.id;
    if (!(await User.exists({ _id: owner, active: true })))
      throw fail("Assign an active lead owner");
    const l = await Lead.create({
      name,
      phone: p,
      source: source || "Manual",
      location,
      owner,
    });
    await initializeLead(l);
    await task(l, "First contact", workSlot(new Date()), `first:${l.id}`, {
      kind: "call",
    });
    await log(l, q.user.id, "created", "Lead created");
    s.status(201).json(await Lead.findById(l.id));
  })
);
app.post(
  "/imports/csv",
  manager,
  wrap(async (q, s) => {
    const rows = parse(q.body.csv, {
      columns: true,
      skip_empty_lines: true,
      bom: true,
    });
    if (rows.length > 1000) throw fail("Maximum 1000 rows");
    const result = [];
    for (const r of rows) {
      try {
        const p = phone(r.phone);
        if (r.owner && !(await User.exists({ _id: r.owner, active: true })))
          throw fail("CSV owner is not an active employee");
        const l = await Lead.findOneAndUpdate(
          { phone: p },
          {
            $setOnInsert: {
              name: r.name || p,
              phone: p,
              owner: id(r.owner) ? r.owner : q.user.id,
              source: r.source || "CSV",
            },
          },
          { upsert: true, new: true }
        );
        await initializeLead(l);
        await task(
          l,
          "Review imported lead",
          workSlot(new Date()),
          `import:${l.id}`,
          { kind: "call" }
        );
        result.push({ phone: p, status: "imported or existing" });
      } catch (e) {
        await Import.create({
          externalId: "csv:" + crypto.randomUUID(),
          source: "csv",
          status: "failed",
          payload: r,
          error: e.message,
        });
        result.push({ phone: r.phone, error: e.message });
      }
    }
    s.json(result);
  })
);
app.get(
  "/leads/:id",
  wrap(async (q, s) => {
    const l = await leadFor(q, q.params.id);
    const calls = await Call.find({ lead: l.id })
      .sort({ startedAt: -1 })
      .limit(100);
    s.json({
      lead: l,
      tasks: await Task.find({ lead: l.id }).sort({ dueAt: 1 }),
      calls,
      conversationOverview: localLeadOverview(calls),
      activities: await Activity.find({ lead: l.id })
        .sort({ createdAt: -1 })
        .limit(100),
      demos: await Demo.find({ lead: l.id }),
      proposals: await Proposal.find({ lead: l.id }),
      meetings: await Meeting.find({ lead: l.id }).populate("reps", "name"),
    });
  })
);
app.get(
  "/leads/:id/conversation-overview",
  wrap(async (q, s) => {
    const l = await leadFor(q, q.params.id);
    const calls = await Call.find({ lead: l.id, aiStatus: "ready" }).sort({
      startedAt: -1,
    });
    s.json(await synthesizeLeadOverview(calls));
  })
);
app.patch(
  "/leads/:id",
  wrap(async (q, s) => {
    const l = await leadFor(q, q.params.id);
    for (const k of [
      "name",
      "location",
      "decisionMaker",
      "needs",
      "software",
      "timeframe",
      "objections",
      "notes",
      "priorityReason",
    ])
      if (q.body[k] !== undefined) l[k] = q.body[k];
    if (q.body.ultra !== undefined) {
      if (q.body.ultra && !q.body.priorityReason && !l.priorityReason)
        throw fail("Give a priority reason");
      l.ultra = !!q.body.ultra;
    }
    if (q.body.stage) {
      if (
        q.body.stage === "Won" &&
        !(q.body.agreementAccepted && q.body.advanceReceived)
      )
        throw fail("Won requires accepted agreement and advance received");
      l.stage = q.body.stage;
      l.closeReason = q.body.closeReason;
      l.agreementAccepted = !!q.body.agreementAccepted;
      l.advanceReceived = !!q.body.advanceReceived;
    }
    if (q.body.doNotContact !== undefined)
      l.doNotContact = !!q.body.doNotContact;
    if (q.body.owner && q.user.role === "manager") {
      if (!["transfer", "retain"].includes(q.body.taskTransfer))
        throw fail("Choose transfer or retain unfinished tasks");
      if (!(await User.exists({ _id: q.body.owner, active: true })))
        throw fail("Owner not found");
      l.owner = q.body.owner;
      if (q.body.taskTransfer === "transfer")
        await Task.updateMany(
          { lead: l.id, status: "open" },
          { $set: { owner: l.owner } }
        );
    }
    await l.save();
    if (!activeLead(l)) {
      await Task.updateMany(
        { lead: l.id, status: "open" },
        { $set: { status: "cancelled" } }
      );
      await Meeting.updateMany(
        { lead: l.id, status: "scheduled" },
        { $set: { status: "cancelled" } }
      );
    } else if (!(await Task.exists({ lead: l.id, status: "open" })))
      await task(
        l,
        l.stage === "New" ? "First contact" : "Follow up",
        workSlot(new Date()),
        `reopen:${l.id}:${l.stage}`,
        { kind: "call" }
      );
    if (l.stage === "Won")
      await task(
        l,
        "Onboard customer",
        workSlot(new Date()),
        `onboard:${l.id}`,
        { kind: "onboarding" }
      );
    await log(l, q.user.id, "updated", "Lead updated", q.body);
    await sweep();
    s.json(l);
  })
);
app.get(
  "/today",
  wrap(async (q, s) => {
    const localDay = new Date(Date.now() + 330 * 60000)
      .toISOString()
      .slice(0, 10);
    const endOfDay = new Date(
      +new Date(localDay + "T00:00:00+05:30") + 86400000
    );
    const tasks = await Task.find({
      status: "open",
      dueAt: { $lt: endOfDay },
      ...(q.user.role === "manager" ? {} : { owner: q.user.id }),
    })
      .populate("lead")
      .populate("owner", "name")
      .sort({ dueAt: 1 })
      .limit(1000);
    s.json(
      tasks
        .filter((t) => t.lead)
        .sort((a, b) => {
          const rank = (t) =>
            t.fixed && t.dueAt <= new Date() ? 0 : t.lead.ultra ? 1 : 2;
          return rank(a) - rank(b) || a.dueAt - b.dueAt;
        })
    );
  })
);
app.patch(
  "/tasks/:id",
  wrap(async (q, s) => s.json(await changeTask(q.params.id, q.user, q.body)))
);
app.post(
  "/calls/sync",
  wrap(async (q, s) => {
    if (!Array.isArray(q.body.calls) || q.body.calls.length > 100)
      throw fail("Send up to 100 call journals");
    const saved = [];
    for (const x of q.body.calls) {
      if (!x.clientId || !x.deviceId || !x.startedAt)
        throw fail("Call id, device and start required");
      const existing = await Call.findOne({ clientId: x.clientId });
      if (existing && String(existing.agent) !== q.user.id)
        throw fail("Call identity conflict", 409);
      let normalized;
      try {
        normalized = phone(x.number);
      } catch {
        normalized = String(x.number || "unknown");
      }
      const lead = await Lead.findOne({ phone: normalized, ...leadScope(q) });
      const allowed = {
        agent: q.user.id,
        lead: existing?.lead || lead?._id,
        number: normalized,
        deviceId: x.deviceId,
        direction: x.direction,
        startedAt: x.startedAt,
        answeredAt:
          existing?.answeredAt ||
          x.answeredAt ||
          (x.events || []).find((e) => e.type === "ACTIVE")?.at,
        endedAt: x.endedAt,
        activeMs: Math.max(0, Number(x.activeMs) || 0),
        preAnswerMs: Math.max(0, Number(x.preAnswerMs) || 0),
        localEndRequested: !!x.localEndRequested,
        disconnectCode: x.disconnectCode,
        events: (x.events || []).slice(0, 1000),
      };
      const journal = await Call.findOneAndUpdate(
        { clientId: x.clientId },
        { $set: allowed, $setOnInsert: { clientId: x.clientId } },
        { upsert: true, new: true }
      );
      const facts = callFacts(journal);
      journal.technicalResult = facts.technicalResult;
      journal.endedBy = facts.endedBy;
      await journal.save();
      saved.push((await applyAutomaticOutcome(journal.id)) || journal);
    }
    s.json(saved);
  })
);
app.get(
  "/calls",
  wrap(async (q, s) =>
    s.json(
      await Call.find(q.user.role === "manager" ? {} : { agent: q.user.id })
        .populate("lead", "name")
        .sort({ startedAt: -1 })
        .limit(200)
    )
  )
);

app.post(
  "/calls/:id/outcome",
  wrap(async (q, s) => {
    const c = await callFor(q, q.params.id);
    if (
      c.outcomeSaved &&
      !(
        c.outcome === "meeting_booked" &&
        !c.meeting &&
        ["meeting_booked", "meeting_pending"].includes(q.body.outcome)
      )
    )
      return s.json(c);
    if (!c.lead) throw fail("Create or assign a lead first");
    await leadFor(q, c.lead);
    const outcomes = [
      "no_answer",
      "unreachable",
      "busy",
      "callback",
      "interested",
      "partner",
      "meeting_booked",
      "meeting_pending",
      "not_now",
      "not_interested",
      "wrong_number",
      "do_not_contact",
    ];
    if (!outcomes.includes(q.body.outcome)) throw fail("Choose an outcome");
    const booking =
      q.body.outcome === "meeting_booked"
        ? await meetingInput(q.body.meeting)
        : null;
    if (booking) await ensureCalendarLocks(booking);
    if (
      ["not_interested", "wrong_number", "do_not_contact"].includes(
        q.body.outcome
      ) &&
      !String(q.body.notes || "").trim()
    )
      throw fail("Record the reason before closing this lead.", 422);
    const dbSession = await mongoose.startSession();
    let saved;
    try {
      await dbSession.withTransaction(async () => {
        const call = await Call.findById(c.id).session(dbSession);
        if (
          call.outcomeSaved &&
          !(
            call.outcome === "meeting_booked" &&
            !call.meeting &&
            ["meeting_booked", "meeting_pending"].includes(q.body.outcome)
          )
        ) {
          saved = call;
          return;
        }
        const repairLegacy =
          call.outcomeSaved &&
          call.outcome === "meeting_booked" &&
          !call.meeting;
        const l = await Lead.findById(call.lead).session(dbSession);
        const attempts = await Call.countDocuments({
          lead: l.id,
          outcome: { $in: ["no_answer", "unreachable"] },
          startedAt: { $gt: new Date(Date.now() - 7 * 86400000) },
        }).session(dbSession);
        const next = nextStep(q.body.outcome, {
          at: q.body.nextAt,
          attempts: attempts + 1,
        });
        if (booking) {
          const meeting = await bookMeeting(l, booking, dbSession, call._id);
          call.meeting = meeting._id;
          l.stage = "Demo/Meeting";
          l.pauseUntil = booking.start;
          await Task.updateMany(
            { key: `outcome:${c.id}`, status: "open" },
            { $set: { status: "cancelled" } },
            { session: dbSession }
          );
        }
        if (repairLegacy && next)
          await Task.updateOne(
            { key: `outcome:${c.id}` },
            {
              $set: {
                title: next.title,
                dueAt: next.dueAt,
                kind: next.kind || "call",
                fixed: !!next.fixed,
                status: "open",
              },
            },
            { session: dbSession }
          );
        if (next)
          await Task.updateOne(
            { key: `outcome:${c.id}` },
            {
              $setOnInsert: {
                lead: l.id,
                owner: l.owner,
                title: q.body.nextTitle || next.title,
                dueAt: next.dueAt,
                originalDueAt: next.dueAt,
                kind: next.kind || "call",
                fixed: !!next.fixed,
                reason: q.body.notes,
              },
            },
            { upsert: true, session: dbSession }
          );
        if (q.body.outcome === "interested" && q.body.nextAt) {
          const followAt = new Date(q.body.nextAt);
          if (!Number.isFinite(+followAt) || followAt <= new Date())
            throw fail("Choose a future follow-up time", 422);
          await Task.updateOne(
            { key: `details-follow:${c.id}` },
            {
              $setOnInsert: {
                lead: l.id,
                owner: l.owner,
                title: "Follow up after sending details",
                dueAt: followAt,
                originalDueAt: followAt,
                kind: "call",
              },
            },
            { upsert: true, session: dbSession }
          );
        }
        if (call.answeredAt) l.lastContactAt = call.answeredAt;
        if (["callback", "not_now", "meeting_pending"].includes(q.body.outcome))
          l.pauseUntil = new Date(q.body.nextAt);
        if (["interested", "meeting_pending"].includes(q.body.outcome))
          l.stage = "Qualified";
        if (q.body.outcome === "not_now") l.stage = "Nurture";
        if (
          ["not_interested", "wrong_number", "do_not_contact"].includes(
            q.body.outcome
          )
        ) {
          l.stage = "Lost";
          l.closeReason = q.body.outcome;
          l.doNotContact = q.body.outcome === "do_not_contact";
        }
        await l.save({ session: dbSession });
        // Complete only due call tasks. Future customer promises remain intact.
        await Task.updateMany(
          {
            lead: l.id,
            status: "open",
            kind: { $in: ["call", "send_details", "confirm_meeting"] },
            dueAt: { $lte: new Date() },
            key: { $ne: `outcome:${c.id}` },
          },
          { $set: { status: "done", doneAt: new Date() } },
          { session: dbSession }
        );
        if (!next && !booking) {
          await Meeting.updateMany(
            { lead: l.id, status: "scheduled" },
            { $set: { status: "cancelled" } },
            { session: dbSession }
          );
          await Task.updateMany(
            { lead: l.id, status: "open" },
            { $set: { status: "cancelled" } },
            { session: dbSession }
          );
        }
        await Activity.create(
          [
            {
              lead: l.id,
              actor: q.user.id,
              type: "call_outcome",
              text: q.body.notes || q.body.outcome,
              data: { call: c.id, outcome: q.body.outcome },
            },
          ],
          { session: dbSession }
        );
        call.outcomeSource = "agent";
        call.outcomeSaved = true;
        call.outcome = q.body.outcome;
        call.notes = q.body.notes || "";
        await call.save({ session: dbSession });
        saved = call;
      });
    } finally {
      await dbSession.endSession();
    }
    s.json(saved);
  })
);
app.post(
  "/calls/:id/lead",
  wrap(async (q, s) => {
    const c = await callFor(q, q.params.id);
    const l = await leadFor(q, q.body.lead);
    if (l.phone !== c.number) throw fail("Lead phone does not match call");
    c.lead = l.id;
    await c.save();
    s.json(c);
  })
);
app.post(
  "/calls/:id/upload",
  wrap(async (q, s) =>
    s.json(await presign(await callFor(q, q.params.id), q.body))
  )
);
app.post(
  "/calls/:id/upload-complete",
  wrap(async (q, s) =>
    s.json(await completeUpload(await callFor(q, q.params.id)))
  )
);
app.get(
  "/calls/:id/recording",
  wrap(async (q, s) =>
    s.json({ url: await playback(await callFor(q, q.params.id)) })
  )
);
app.post(
  "/calls/:id/ai/retry",
  wrap(async (q, s) => {
    const c = await callFor(q, q.params.id);
    if (!c.recordingKey) throw fail("No recording");
    await Job.updateOne(
      { key: `ai:${c.id}` },
      {
        $set: {
          call: c.id,
          status: "pending",
          nextAt: new Date(),
          attempts: 0,
        },
      },
      { upsert: true }
    );
    c.aiStatus = "queued";
    await c.save();
    s.json(c);
  })
);
app.get(
  "/meetings",
  wrap(async (q, s) =>
    s.json(
      await Meeting.find(
        q.user.role === "manager"
          ? {}
          : {
              $or: [
                { reps: q.user.id },
                {
                  lead: {
                    $in: await Lead.find({ owner: q.user.id }).distinct("_id"),
                  },
                },
              ],
            }
      )
        .populate("lead", "name phone")
        .populate("reps", "name")
        .sort({ start: 1 })
        .limit(300)
    )
  )
);

app.post(
  "/meetings",
  wrap(async (q, s) => {
    const l = await leadFor(q, q.body.lead),
      b = await meetingInput(q.body);
    await ensureCalendarLocks(b);
    const session = await mongoose.startSession();
    let meeting;
    try {
      await session.withTransaction(async () => {
        meeting = await bookMeeting(l, b, session);
      });
    } finally {
      await session.endSession();
    }
    await log(l, q.user.id, "meeting_booked", `${b.type} meeting booked`, {
      meeting: meeting.id,
    });
    s.status(201).json(meeting);
  })
);
app.patch(
  "/meetings/:id",
  wrap(async (q, s) => {
    const old = await Meeting.findById(q.params.id);
    if (!old) throw fail("Meeting not found", 404);
    const lead = await leadFor(q, old.lead);
    const b = q.body;
    const nextAction = selectedAction(b, "after_meeting");
    let place;
    if (b.place !== undefined) {
      place = String(b.place).trim();
      if (!place || (old.type === "online" && !/^https?:\/\//i.test(place)))
        throw fail("Enter a valid meeting link or location", 422);
    }
    if (b.status) {
      if (
        !["completed", "no_show", "cancelled", "rep_unavailable"].includes(
          b.status
        )
      )
        throw fail("Invalid meeting status");
      if (
        !b.outcome ||
        !b.nextAt ||
        !Number.isFinite(+new Date(b.nextAt)) ||
        new Date(b.nextAt) <= new Date()
      )
        throw fail(
          "Record the result and choose a future next action time",
          422
        );
    }
    const session = await mongoose.startSession();
    let result;
    try {
      await session.withTransaction(async () => {
        const m = await Meeting.findById(old.id).session(session);
        if (b.confirmed !== undefined) {
          m.confirmed = !!b.confirmed;
          if (m.confirmed)
            await Task.updateOne(
              { key: `meeting-confirm:${m.id}`, status: "open" },
              { $set: { status: "done", doneAt: new Date() } },
              { session }
            );
        }
        if (place !== undefined) {
          m.place = place;
          m.placePending = false;
          await Task.updateOne(
            { key: `meeting-place:${m.id}`, status: "open" },
            { $set: { status: "done", doneAt: new Date() } },
            { session }
          );
        }
        if (b.status) {
          m.status = b.status;
          m.outcome = b.outcome;
          await Task.updateMany(
            {
              key: {
                $in: [
                  `meeting-confirm:${m.id}`,
                  `meeting-prep:${m.id}`,
                  `meeting-result:${m.id}`,
                  `meeting-place:${m.id}`,
                ],
              },
              status: "open",
            },
            { $set: { status: "cancelled" } },
            { session }
          );
          const dueAt = new Date(b.nextAt);
          await Task.updateOne(
            { key: `meeting-next:${m.id}` },
            {
              $setOnInsert: {
                lead: lead.id,
                owner: lead.owner,
                title: nextAction.title,
                dueAt,
                originalDueAt: dueAt,
                kind: nextAction.kind,
                fixed: true,
              },
            },
            { upsert: true, session }
          );
        }
        await m.save({ session });
        await Activity.create(
          [
            {
              lead: lead.id,
              actor: q.user.id,
              type: "meeting_updated",
              text: b.status
                ? `Meeting ${b.status}: ${b.outcome}`
                : place
                ? "Meeting link/location updated"
                : "Meeting confirmation updated",
              data: { meeting: m.id },
            },
          ],
          { session }
        );
        result = m;
      });
    } finally {
      await session.endSession();
    }
    s.json(result);
  })
);
app.get(
  "/demos",
  wrap(async (q, s) =>
    s.json(
      await Demo.find(
        q.user.role === "manager"
          ? {}
          : { lead: { $in: await Lead.find(leadScope(q)).distinct("_id") } }
      )
        .populate("lead", "name")
        .populate("owner", "name")
        .sort({ updatedAt: -1 })
    )
  )
);
app.post(
  "/demos",
  wrap(async (q, s) => {
    const l = await leadFor(q, q.body.lead);
    const d = await Demo.create({
      lead: l.id,
      shopName: l.name,
      owner: id(q.body.owner) ? q.body.owner : l.owner,
      modules: q.body.modules || l.needs,
      token: crypto.randomBytes(24).toString("hex"),
      expiresAt: new Date(Date.now() + 14 * 86400000),
    });
    await initializeDemo(d.id);
    s.status(201).json(await Demo.findById(d.id));
  })
);
app.patch(
  "/demos/:id",
  wrap(async (q, s) => {
    const d = await Demo.findById(q.params.id);
    if (!d) throw fail("Demo not found", 404);
    await leadFor(q, d.lead);
    const updated = await advanceDemo(d.id, q.body, q.user.id);
    s.json({
      ...updated.toObject(),
      shareUrl: `${process.env.PUBLIC_URL}/demo/${updated.token}`,
    });
  })
);
app.post(
  "/proposals",
  wrap(async (q, s) => {
    const l = await leadFor(q, q.body.lead);
    if (!(Number(q.body.amount) > 0))
      throw fail("Positive proposal amount required");
    const p = await Proposal.create({
      lead: l.id,
      owner: q.user.id,
      amount: q.body.amount,
      url: q.body.url,
      version: (await Proposal.countDocuments({ lead: l.id })) + 1,
    });
    await task(
      l,
      "Send proposal",
      workSlot(new Date()),
      `proposal-send:${p.id}`,
      { kind: "proposal" }
    );
    s.json(p);
  })
);
app.post(
  "/proposals/:id/sent",
  wrap(async (q, s) => {
    const p = await Proposal.findById(q.params.id);
    if (!p) throw fail("Not found", 404);
    const l = await leadFor(q, p.lead);
    if (!q.body.nextAt) throw fail("Decision conversation time required");
    p.status = "sent";
    p.sentAt = new Date();
    await p.save();
    await Task.updateOne(
      { key: `proposal-send:${p.id}` },
      { $set: { status: "done" } }
    );
    await task(
      l,
      "Discuss proposal decision",
      q.body.nextAt,
      `proposal-follow:${p.id}`,
      { kind: "call" }
    );
    l.stage = "Decision";
    await l.save();
    s.json(p);
  })
);
app.get(
  "/reports",
  manager,
  wrap(async (q, s) => {
    const since = new Date(
      q.query.since || new Date(Date.now() - 30 * 86400000)
    );
    const until = new Date();
    if (!Number.isFinite(+since) || since > until)
      throw fail("Choose a valid reporting period", 422);
    const calls = await Call.find({ startedAt: { $gte: since, $lte: until } });
    const users = await User.find({ active: true });
    const leads = await Lead.find();
    const overdue = await Task.find({
      status: "open",
      dueAt: { $lt: new Date() },
    })
      .populate("lead", "name")
      .populate("owner", "name");
    const intelligence = buildCallIntelligence(calls);
    s.json({
      period: { since, until },
      metrics: {
        ...intelligence.metrics,
        outgoing: calls.filter((c) => c.direction === "outgoing").length,
        incoming: calls.filter((c) => c.direction === "incoming").length,
      },
      callIntelligence: intelligence,
      employees: users.map((u) => ({
        id: u.id,
        name: u.name,
        role: u.role,
        overdueCount: overdue.filter(
          (t) => String(t.owner?._id || t.owner) === u.id
        ).length,
        meetingsBooked: calls.filter(
          (c) => String(c.agent) === u.id && !!c.meeting
        ).length,
        outgoing: calls.filter(
          (c) => String(c.agent) === u.id && c.direction === "outgoing"
        ).length,
        incoming: calls.filter(
          (c) => String(c.agent) === u.id && c.direction === "incoming"
        ).length,
        ...callMetrics(calls.filter((c) => String(c.agent) === u.id)),
        callIntelligence: buildEmployeeIntelligence(calls, u.id),
      })),
      priority: leads.filter((l) => l.ultra && activeLead(l)),
      pipeline: leads.reduce(
        (a, l) => ((a[l.stage] = (a[l.stage] || 0) + 1), a),
        {}
      ),
      overdue,
      meetingsWithoutOutcome: await Meeting.countDocuments({
        status: "scheduled",
        end: { $lt: new Date() },
      }),
      readyDemosUnsent: await Demo.countDocuments({ status: "ready" }),
      failedImports: await Import.countDocuments({ status: "failed" }),
      sources: leads.reduce(
        (a, l) => (
          (a[l.source || "Unknown"] = (a[l.source || "Unknown"] || 0) + 1), a
        ),
        {}
      ),
    });
  })
);
app.post(
  "/reports/coaching-brief",
  manager,
  wrap(async (q, s) => {
    const since = new Date(
      q.body.since || new Date(Date.now() - 30 * 86400000)
    );
    const until = new Date();
    const calls = await Call.find({ startedAt: { $gte: since, $lte: until } });
    const users = await User.find({ active: true });
    s.json(await deepTranscriptInsights({ calls, users, since, until }));
  })
);
app.post(
  "/reports/deep-insights",
  manager,
  wrap(async (q, s) => {
    const since = new Date(
      q.body.since || new Date(Date.now() - 30 * 86400000)
    );
    const until = new Date();
    const calls = await Call.find({ startedAt: { $gte: since, $lte: until } });
    const users = await User.find({ active: true });
    s.json(await deepTranscriptInsights({ calls, users, since, until }));
  })
);
app.get(
  "/integrations",
  manager,
  wrap(async (q, s) =>
    s.json({
      s3: !!(process.env.S3_BUCKET || process.env.AWS_S3_BUCKET),
      transcription: !!process.env.GROQ_API_KEY,
      summaries: !!process.env.SARVAM_API_KEY,
      meta: !!process.env.META_PAGE_TOKEN,
      imports: await Import.find({ status: "failed" }).limit(50),
      lastCheck: await Setting.findOne({ key: "metaCheck" }),
    })
  )
);
app.post(
  "/maintenance/sweep",
  manager,
  wrap(async (q, s) => {
    await sweep();
    s.json({ ok: true });
  })
);
app.use((e, q, s, n) => {
  console.error(e.message);
  s.status(e.status || (e.code === 11000 ? 409 : 400)).json({
    error: e.code === 11000 ? "Duplicate record" : e.message,
  });
});
