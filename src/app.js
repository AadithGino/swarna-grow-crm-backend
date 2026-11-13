import { byContactNumber, contactFields, extraContacts, leadStatusStages } from "./leadContacts.js";
import managerWorkspace from "./managerWorkspace.js";
import callReview from "./callReview.js";
import managerActions from "./managerActions.js";
import management from "./management.js";
import { fileURLToPath } from "node:url";
import { pitchSteps, pitchVersion } from "./pitchRubric.js";
import { managerMonitoring } from "./managerMonitoring.js";
import {
  prepareSalesOutcome,
  applySalesOutcome,
  completeMeetingOutcome,
} from "./salesOutcome.js";
import operationsRoutes from "./operationsRoutes.js";
import { initializeLead, replaceMeetingRep } from "./coverage.js";
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
import { phone, workSlot, callMetrics, activeLead } from "./rules.js";
import {
  buildCallIntelligence,
  buildEmployeeIntelligence,
} from "./callInsights.js";
import { deepTranscriptInsights } from "./transcriptAnalysis.js";
import { localLeadOverview, synthesizeLeadOverview } from "./leadOverview.js";
import { task, log, sweep } from "./workflow.js";
import { presign, completeUpload, playback } from "./storage.js";
import { policy, addWorkMinutes } from "./policy.js";
import { ingestMeta, ingestMetaLead } from "./meta.js";
export const app = express();
app.use(helmet({ contentSecurityPolicy: false }));
app.use(
  cors({
    origin: process.env.CORS_ORIGIN?.split(",").map((o) => o.trim()).filter(Boolean) || true,
    credentials: true,
  })
);
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
app.use("/portal", express.static(fileURLToPath(new URL("../public/portal/", import.meta.url))));
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
        if (c.field === "leadgen") {
          const leadgenId = c.value?.leadgen_id;
          if (!leadgenId) continue;
          await Import.updateOne(
            { externalId: leadgenId },
            {
              $setOnInsert: { status: "pending", payload: c.value },
              $set: {
                webhookAt: new Date(),
                ...(c.value.form_id ? { formId: c.value.form_id } : {}),
              },
            },
            { upsert: true }
          );
          try {
            await ingestMetaLead(leadgenId);
          } catch (err) {
            console.error(`Meta webhook ingest failed for ${leadgenId}:`, err.message);
          }
        }
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
app.use(management);
app.use(managerActions);
app.use(callReview);
app.use(managerWorkspace);
async function leadFor(q, leadId, { write = false } = {}) {
  if (!id(leadId)) throw fail("Invalid lead");
  const l = await Lead.findById(leadId);
  if (!l) throw fail("Lead not found", 404);
  if (
    q.user.role !== "manager" &&
    String(l.owner) !== q.user.id &&
    !(await Task.exists({ lead: l.id, owner: q.user.id, ...(write ? { status: "open" } : {}) })) &&
    !(await Meeting.exists({ lead: l.id, reps: q.user.id, ...(write ? { status: "scheduled" } : {}) }))
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
              ...contactFields.map(field => ({ [field]: { $regex: escaped } })),
            ],
          },
        ],
      };
    }
    const page = Number(q.query.page);
    const paged = Number.isInteger(page) && page >= 1;
    const pageSize = Math.min(50, Math.max(10, Number(q.query.pageSize) || 20));
    // Cast the existing access scope before running the aggregation.
    const scoped = Lead.find(filter);
    const pipeline = [{ $match: scoped.cast(Lead) }, ...leadStatusStages(q.query.lastStatus),
      { $sort: { ultra: -1, updatedAt: -1, _id: -1 } }];
    const pagination = paged ? [{ $skip: (page - 1) * pageSize }, { $limit: pageSize }] : [{ $limit: 500 }];
    const [result] = await Lead.aggregate([...pipeline, { $facet: { total: [{ $count: "n" }], items: pagination } }]);
    const total = result.total[0]?.n || 0;
    const leads = await Lead.populate(result.items, { path: "owner", select: "name" });
    const tasks = await Task.find({ lead: { $in: leads.map(lead => lead._id) }, status: "open" })
      .select("lead title dueAt")
      .sort({ dueAt: 1 })
      .lean();
    const nextByLead = new Map();
    for (const task of tasks)
      if (!nextByLead.has(String(task.lead))) nextByLead.set(String(task.lead), task);
    const items = leads.map(lead => ({ ...lead, nextTask: nextByLead.get(String(lead._id)) }));
    s.json(paged ? { items, total, page, pageSize } : items);
  })
);
app.post(
  "/leads",
  wrap(async (q, s) => {
    const { name, source, location } = q.body;
    if (typeof name !== "string" || !name.trim()) throw fail("Shop/contact name required");
    const p = phone(q.body.phone);
    const contacts = extraContacts(q.body);
    if (q.body.requestId != null && !/^[\w-]{1,128}$/.test(q.body.requestId))
      throw fail("Invalid enquiry request ID", 422);
    const now = new Date();
    const dueAt = addWorkMinutes(now, (await policy()).firstContactMinutes);
    const externalId = `manual:${q.user.id}:${q.body.requestId || crypto.randomUUID()}`;
    const session = await mongoose.startSession();
    let enquiry, lead, created;
    try {
      await session.withTransaction(async () => {
        created = false;
        enquiry = await Import.findOne({ externalId }).session(session);
        if (enquiry) {
          if (enquiry.payload?.phone !== p) throw fail("This request was used for another lead", 409);
          lead = await Lead.findById(enquiry.lead).session(session);
          return;
        }
        lead = await Lead.findOne(byContactNumber(p)).session(session);
        if (!lead) {
          const owner = q.user.role === "manager" && id(q.body.owner) ? q.body.owner : q.user.id;
          if (!(await User.exists({ _id: owner, active: true }).session(session))) throw fail("Assign an active lead owner");
          if (await Lead.exists({ $or: Object.values(contacts).filter(Boolean).map(byContactNumber).concat([{ phone: p }]) }).session(session))
            throw fail("A contact number already belongs to another lead", 409);
          [lead] = await Lead.create([{ name: name.trim(), phone: p, ...contacts, source: source || "Manual", location, owner,
            firstContactDueAt: dueAt }], { session });
          created = true;
        } else {
          await Lead.updateOne({ _id: lead.id }, { $inc: { workflowRevision: 1 } }, { session });
        }
        const review = lead.doNotContact || ["Lost", "Won"].includes(lead.stage) || !lead.owner;
        [enquiry] = await Import.create([{ externalId, source: "manual", sourceCreatedAt: now, lead: lead.id,
          status: review ? "needs_review" : "done", payload: { name, source: source || "Manual", location, phone: p } }], { session });
        if (!review) await Task.create([{ key: `enquiry:${enquiry.id}`, lead: lead.id, owner: lead.owner,
          kind: "call", title: created ? "First contact" : "Contact repeat enquiry",
          dueAt, originalDueAt: dueAt, customerFacing: true }], { session });
        if (created) await Activity.create([{ lead: lead.id, actor: q.user.id, type: "created", text: "Lead created" }], { session });
      });
    } finally { await session.endSession(); }
    const canView = lead && (q.user.role === "manager" || String(lead.owner) === q.user.id);
    s.status(created ? 201 : 200).json({ ...(canView ? lead.toObject() : {}),
      ...(!created ? { duplicate: true } : {}), enquiry: enquiry.id, needsReview: enquiry.status === "needs_review" });
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
          byContactNumber(p),
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
    const l = await leadFor(q, q.params.id, { write: true });
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
    const nurtureChange = q.body.stage === "Nurture" && (l.stage !== "Nurture" || !l.pauseUntil ||
      (q.body.pauseUntil !== undefined && +new Date(q.body.pauseUntil) !== +l.pauseUntil));
    const nurtureAt = nurtureChange ? new Date(q.body.pauseUntil) : null;
    if (nurtureChange && (!q.body.pauseUntil || !Number.isFinite(+nurtureAt) || nurtureAt <= new Date()))
      throw fail("Choose a future Nurture callback date", 422);
    if (nurtureChange) l.pauseUntil = nurtureAt;
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
    if (q.body.expectedRevision && +new Date(q.body.expectedRevision) !== +l.updatedAt)
      throw fail("Lead changed. Refresh before saving", 409);
    const contacts = extraContacts(q.body);
    l.set(contacts);
    const from = l.owner;
    const transferring = q.body.owner && q.user.role === "manager" && String(from) !== String(q.body.owner);
    if (transferring && (!id(q.body.owner) || !["transfer", "retain"].includes(q.body.taskTransfer)))
      throw fail("Choose an active owner and whether to transfer open work");
    if (transferring && q.body.meetingTransfer === "replace" && from)
      await ensureCalendarLocks({ reps: [String(from), q.body.owner] });
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        const current = await Lead.findById(l.id).session(session);
        if (!current || +current.updatedAt !== +l.updatedAt)
          throw fail("Lead changed. Refresh before saving", 409);
        if (transferring) {
          const target = await User.findOne({ _id: q.body.owner, active: true }).session(session);
          if (!target) throw fail("Owner not found");
          const meetings = from && await Meeting.exists({
            lead: l.id, reps: from, status: "scheduled", end: { $gt: new Date() },
          }).session(session);
          if (meetings && !["keep", "replace"].includes(q.body.meetingTransfer))
            throw fail("Choose who will attend the scheduled meetings", 422);
          if (meetings && q.body.meetingTransfer === "replace") {
            await replaceMeetingRep(l.id, from, target.id, target, session);
            await Task.updateMany({ lead: l.id, owner: from, status: "open", key: /^meeting-(prep|place):/ },
              { $set: { owner: target.id } }, { session });
          }
          l.owner = target.id;
          l.workflowRevision = current.workflowRevision + 1;
          if (q.body.taskTransfer === "transfer") {
            await Task.updateMany({ lead: l.id, owner: from || null, status: "open", key: { $not: /^meeting-(prep|place):/ } },
              { $set: { owner: target.id } }, { session });
            await Demo.updateMany({ lead: l.id, owner: from || null, status: { $nin: ["responded", "cancelled"] } },
              { $set: { owner: target.id } }, { session });
          }
        }
        const numbers = Object.values(contacts).filter(Boolean);
        if (numbers.length && await Lead.exists({ _id: { $ne: l.id }, $or: numbers.map(byContactNumber) }).session(session))
          throw fail("A contact number already belongs to another lead", 409);
        // Use a fresh document on each transaction retry.
        current.set(l.getChanges().$set || {});
        for (const field of Object.keys(l.getChanges().$unset || {})) current.set(field, undefined);
        await current.save({ session });
        await Activity.create([{ lead: current.id, actor: q.user.id, type: "updated", text: "Lead updated",
          data: transferring ? { from, to: current.owner, taskTransfer: q.body.taskTransfer, meetingTransfer: q.body.meetingTransfer } : q.body }], { session });
        if (nurtureChange && !current.doNotContact) {
          const key = `nurture:${current.id}:${+nurtureAt}`;
          await Task.updateMany({ lead: current.id, status: "open", key: { $regex: /^nurture:/, $ne: key } },
            { $set: { status: "cancelled" } }, { session });
          await Task.updateOne({ key }, { $set: { lead: current.id, owner: current.owner, title: "Nurture callback",
            kind: "call", status: "open", dueAt: nurtureAt, originalDueAt: nurtureAt, fixed: true, customerFacing: true } },
            { session, upsert: true });
        }
        if (l.doNotContact || ["Won", "Lost"].includes(l.stage)) {
          await Task.updateMany({ lead: l.id, status: "open" }, { $set: { status: "cancelled" } }, { session });
          await Meeting.updateMany({ lead: l.id, status: "scheduled" }, { $set: { status: "cancelled" } }, { session });
        }
      });
    } finally { await session.endSession(); }
    if (!l.doNotContact && activeLead(l) && !(await Task.exists({ lead: l.id, status: "open" })))
      await task(l, l.stage === "New" ? "First contact" : "Follow up", workSlot(new Date()),
        `reopen:${l.id}:${l.stage}`, { kind: "call" });
    if (l.stage === "Won")
      await task(l, "Onboard customer", workSlot(new Date()), `onboard:${l.id}`, { kind: "onboarding" });
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
      const lead = await Lead.findOne({ $and: [byContactNumber(normalized), leadScope(q)] });
      const allowed = {
        ...(!existing && lead?.owner ? { leadOwnerAtCall: lead.owner } : {}),
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

app.get(
  "/calls/client/:clientId",
  wrap(async (q, s) => {
    const c = await Call.findOne({
      clientId: q.params.clientId,
      agent: q.user.id,
    }).populate("lead", "name phone");
    if (!c) throw fail("Call is still syncing", 404);
    s.json(c);
  })
);
app.get(
  "/calls/:id",
  wrap(async (q, s) => {
    const call = await callFor(q, q.params.id);
    await call.populate("lead", "name phone");
    s.json(call);
  })
);
app.get("/reports/pitch-rubric", manager, (q, s) => s.json({ version: pitchVersion, steps: pitchSteps }));
const legacyPitchChecks = ["introduction", "qualification", "relevantPitch", "objectionHandling", "nextCommitment"];
app.patch(
  "/calls/:id/coaching-review",
  manager,
  wrap(async (q, s) => {
    const call = await callFor(q, q.params.id);
    if (!call.answeredAt) throw fail("Review connected calls only", 422);
    const newRubric = q.body.rubric === pitchVersion;
    const pitchChecks = newRubric ? pitchSteps.map(([key]) => key) : legacyPitchChecks;
    if (newRubric && !["in_order", "out_of_order", "unassessable"].includes(q.body.order))
      throw fail("Rate the sequence of the pitch", 422);
    const checks = Object.fromEntries(pitchChecks.map((key) => [key, q.body.checks?.[key]]));
    if (Object.values(checks).some((value) =>
      !["done", "partial", "missed", "not_applicable", "unassessable"].includes(value)))
      throw fail("Rate each script step", 422);
    const evidence = String(q.body.evidence || "").trim();
    if (!evidence || evidence.length > 3000) throw fail("Add review evidence (up to 3000 characters)", 422);
    call.coachingReview = {
      rubric: newRubric ? pitchVersion : "first-pitch-v1", checks, evidence,
      ...(newRubric ? { order: q.body.order } : {}),
      objectionResult: String(q.body.objectionResult || "").slice(0, 300),
      reviewer: q.user.id, reviewedAt: new Date(),
    };
    await call.save();
    s.json(call.coachingReview);
  })
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
    await leadFor(q, c.lead, { write: true });
    const prepared = await prepareSalesOutcome(q.body);
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
        const l = await Lead.findById(call.lead).session(dbSession);
        if (!l) throw fail("Lead missing", 404);
        await applySalesOutcome({
          lead: l,
          source: `outcome:${call.id}`,
          actor: q.user,
          session: dbSession,
          prepared,
          sourceCall: call,
        });
        call.outcomeSource = "agent";
        call.outcomeSaved = true;
        call.outcome = prepared.b.outcome;
        call.nextAction = prepared.b.nextAction;
        call.actionNote = prepared.b.actionNote;
        call.nextAt = prepared.b.nextAt;
        call.channel = prepared.b.channel;
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
    const l = await leadFor(q, q.body.lead, { write: true });
    if (!contactFields.some(field => l[field] === c.number)) throw fail("Lead phone does not match call");
    if (c.lead && String(c.lead) !== l.id) throw fail("Call already belongs to another lead", 409);
    c.lead = l.id;
    await c.save();
    s.json((await applyAutomaticOutcome(c.id)) || c);
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
  wrap(async (q, s) => {
    const scope = q.user.role === "manager" ? {} : {
      $or: [
        { reps: q.user.id },
        { lead: { $in: await Lead.find({ owner: q.user.id }).distinct("_id") } },
      ],
    };
    const now = new Date();
    const calendar = (filter) => Meeting.find({ ...scope, ...filter })
      .populate("lead", "name phone")
      .populate("reps", "name");
    const [upcoming, history] = await Promise.all([
      calendar({ status: "scheduled", end: { $gte: now } }).sort({ start: 1 }),
      calendar({ $nor: [{ status: "scheduled", end: { $gte: now } }] })
        .sort({ start: -1 }).limit(300),
    ]);
    s.json([...upcoming, ...history]);
  })
);

app.post(
  "/meetings",
  wrap(async (q, s) => {
    const l = await leadFor(q, q.body.lead, { write: true }),
      b = await meetingInput(q.body);
    await ensureCalendarLocks(b);
    const session = await mongoose.startSession();
    let meeting;
    try {
      await session.withTransaction(async () => {
        const current = await Lead.findById(l.id).session(session);
        meeting = await bookMeeting(current, b, session, undefined, q.user.id);
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
    const lead = await leadFor(q, old.lead, { write: true });
    if (q.body.salesOutcome)
      return s.json(await completeMeetingOutcome(old.id, q.user, q.body));
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
        }
        if (b.placeSent === true) {
          if (m.placePending || !m.place) throw fail("Add the link or venue before marking it sent");
          await Task.updateOne(
            { key: `meeting-place:${m.id}`, status: "open" },
            { $set: { status: "done", doneAt: new Date() } },
            { session }
          );
        }
        if (b.status) {
          if (m.resultSaved || m.status !== "scheduled")
            throw fail("This meeting is no longer scheduled", 409);
          if (["completed", "no_show"].includes(b.status) && m.end > new Date())
            throw fail("Log attendance after the meeting ends", 422);
          m.resultSaved = true;
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
app.get("/demo-generator", (q, s) => {
  const url = process.env.DEMO_GENERATOR_URL || "";
  s.json({ url: /^https?:\/\//i.test(url) ? url : null });
});
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
    const l = await leadFor(q, q.body.lead, { write: true });
    const shopName = String(q.body.shopName ?? l.name).trim();
    if (!shopName) throw fail("Enter the shop name", 422);
    const logoUrl = String(q.body.logoUrl || "").trim();
    const logoNote = String(q.body.logoNote || "").trim();
    const d = await Demo.create({
      lead: l.id,
      shopName,
      selfServe: true,
      logoUrl,
      logoNote,
      status: logoUrl || logoNote ? "logo_received" : "requested",
      owner: q.user.role === "manager" && id(q.body.owner) ? q.body.owner : q.user.id,
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
    await leadFor(q, d.lead, { write: true });
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
    const hasSplit = q.body.setupFee != null || q.body.monthlyFee != null;
    const setupFee = Number(q.body.setupFee ?? 0), monthlyFee = Number(q.body.monthlyFee ?? 0);
    const amount = hasSplit ? setupFee + monthlyFee : Number(q.body.amount);
    if (!Number.isFinite(amount) || amount <= 0 || (hasSplit && (setupFee < 0 || monthlyFee < 0)))
      throw fail("Enter valid setup and monthly fees");
    const demoQuoteTask = { lead: l.id, status: "open", kind: "send_proposal", key: /^demo-response-next:/ };
    if (q.body.sourceTask && !id(q.body.sourceTask)) throw fail("Invalid demo quote task", 422);
    const candidates = await Task.find(q.body.sourceTask
      ? { ...demoQuoteTask, _id: q.body.sourceTask } : demoQuoteTask).limit(2);
    if ((q.body.sourceTask && !candidates.length) || candidates.length > 1)
      throw fail("Open the specific demo quote task before creating the quote", 409);
    const session = await mongoose.startSession();
    let p;
    try {
      await session.withTransaction(async () => {
        const sourceTask = candidates[0] && await Task.findOne({ ...demoQuoteTask, _id: candidates[0].id }).session(session);
        if (candidates.length && !sourceTask) throw fail("Demo quote task changed. Refresh and retry.", 409);
        if (sourceTask) {
          await Task.updateOne({ _id: sourceTask.id }, { $set: { updatedAt: new Date() } }, { session });
          p = await Proposal.findOne({ sourceTask: sourceTask.id, sentAt: null }).session(session);
          if (p) return;
        }
        [p] = await Proposal.create([{
          lead: l.id, owner: q.user.id, amount, ...(hasSplit ? { setupFee, monthlyFee } : {}),
          url: q.body.url, sourceTask: sourceTask?._id,
          version: (await Proposal.countDocuments({ lead: l.id }).session(session)) + 1,
        }], { session });
        await Task.create([{
          lead: l.id, owner: sourceTask?.owner || l.owner, title: "Send proposal", kind: "proposal",
          key: `proposal-send:${p.id}`, dueAt: sourceTask?.dueAt || workSlot(new Date()),
        }], { session });
      });
    } finally { await session.endSession(); }
    s.json(p);
  })
);
app.post(
  "/proposals/:id/sent",
  wrap(async (q, s) => {
    const old = await Proposal.findById(q.params.id);
    if (!old) throw fail("Not found", 404);
    await leadFor(q, old.lead);
    const dueAt = new Date(q.body.nextAt);
    if (!Number.isFinite(+dueAt) || dueAt <= new Date())
      throw fail("Choose a future decision conversation time");
    const session = await mongoose.startSession();
    let proposal;
    try {
      await session.withTransaction(async () => {
        proposal = await Proposal.findById(old.id).session(session);
        const lead = await Lead.findById(proposal.lead).session(session);
        if (lead.doNotContact || ["Won", "Lost"].includes(lead.stage))
          throw fail("Reopen the lead before following up");
        if (proposal.status === "sent" &&
            await Task.exists({ key: `proposal-follow:${proposal.id}` }).session(session))
          return;
        // Old drafts can be linked at send time when there is exactly one outstanding demo quote.
        const sourceQuery = { lead: lead.id, kind: "send_proposal", key: /^demo-response-next:/, status: "open" };
        const sources = await Task.find(proposal.sourceTask
          ? { ...sourceQuery, _id: proposal.sourceTask } : sourceQuery).limit(2).session(session);
        if (sources.length > 1) throw fail("Create the quote from the specific demo task", 409);
        if (proposal.sourceTask && !sources.length && proposal.status !== "sent")
          throw fail("The originating demo task is no longer open", 409);
        const source = sources[0];
        if (source) proposal.sourceTask = source._id;
        const sentAt = proposal.sentAt || new Date();
        await Task.updateOne(
          { key: `proposal-follow:${proposal.id}` },
          { $setOnInsert: {
            lead: lead.id, owner: source?.owner || lead.owner, title: "Discuss proposal decision",
            kind: "call", dueAt, originalDueAt: dueAt, customerFacing: true, fixed: true,
          } },
          { upsert: true, session }
        );
        await Task.updateMany(
          { $or: [{ key: `proposal-send:${proposal.id}` }, ...(source ? [{ _id: source.id }] : [])], status: "open" },
          { $set: { status: "done", doneAt: sentAt } }, { session }
        );
        proposal.status = "sent";
        proposal.sentAt = sentAt;
        lead.stage = "Decision";
        await proposal.save({ session });
        await lead.save({ session });
      });
    } finally {
      await session.endSession();
    }
    s.json(proposal);
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
    const monitoring = await managerMonitoring(since, until, overdue, leads);
    s.json({
      attention: monitoring.attention,
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
        monitoring: monitoring.byEmployee.get(u.id) || {},
        overdueCount: overdue.filter(
          (t) => String(t.owner?._id || t.owner) === u.id
        ).length,
        callRecords: calls.filter(c => String(c.agent) === u.id).map(c => ({
          _id: c.id, lead: c.lead, number: c.number, direction: c.direction,
          startedAt: c.startedAt, answeredAt: c.answeredAt, activeMs: c.activeMs,
          recordingStatus: c.recordingStatus,
          ai: c.ai?.scriptAssessment ? { scriptAssessment: c.ai.scriptAssessment } : undefined,
          coachingReview: c.coachingReview,
        })),
        assessedCalls: calls.filter((c) => String(c.agent) === u.id && c.ai?.scriptAssessment).length,
        callsReviewed: calls.filter((c) => String(c.agent) === u.id && c.coachingReview).length,
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
