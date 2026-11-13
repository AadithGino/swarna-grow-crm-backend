import express from "express";
import mongoose from "mongoose";
import { Activity, Attendance, Call, CoachingAction, Demo, Exception, Lead, Meeting, Notification, Task, User } from "./models.js";
import { bookMeeting, ensureCalendarLocks, meetingInput } from "./meetings.js";
import { actionQueue, coachingProgress } from "./managerActions.js";
import { customerKinds } from "./policy.js";
import { reviewFlags } from "./callReview.js";
import { activityDays, summarizeCalls, tomorrowCommitments } from "./management.js";

const router = express.Router();
const fail = (message, status = 422) => Object.assign(Error(message), { status });
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
const manager = (req, res, next) => req.user.role === "manager" ? next() : next(fail("Manager access required", 403));
const dayMs = 86400000;
const today = () => new Date(Date.now() + 19800000).toISOString().slice(0, 10);
const start = day => new Date(day + "T00:00:00+05:30");
const objectId = value => {
  if (!mongoose.isValidObjectId(value)) throw fail("Choose a valid record");
  return new mongoose.Types.ObjectId(value);
};
const regex = value => new RegExp(String(value).slice(0, 100).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
const inRange = (from, to) => {
  const valid = date => /^\d{4}-\d{2}-\d{2}$/.test(date || "") &&
    Number.isFinite(+start(date)) && new Date(+start(date) + 19800000).toISOString().slice(0, 10) === date;
  if (!valid(from) || !valid(to) || from > to || +start(to) - +start(from) > 365 * dayMs)
    throw fail("Choose a valid date range of up to 366 days");
  return { $gte: start(from), $lt: new Date(+start(to) + dayMs) };
};
const customerAction = { $or: [{ customerFacing: true }, { customerFacing: { $ne: false }, kind: { $in: customerKinds } }] };
const openLead = { stage: { $nin: ["Won", "Lost"] }, doNotContact: { $ne: true } };

function pagination(query) {
  const page = Math.min(100000, Math.max(1, Math.trunc(Number(query.page)) || 1));
  const pageSize = Number(query.pageSize) === 50 ? 50 : 25;
  return { page, pageSize, skip: (page - 1) * pageSize };
}
async function list(model, filter, q, query) {
  const { page, pageSize, skip } = pagination(q);
  const [total, items] = await Promise.all([model.countDocuments(filter), query.skip(skip).limit(pageSize).lean()]);
  return { page, pageSize, total, items };
}
async function aggregateList(model, pipeline, q) {
  const { page, pageSize, skip } = pagination(q);
  const [result] = await model.aggregate([...pipeline, { $facet: {
    count: [{ $count: "total" }], items: [{ $skip: skip }, { $limit: pageSize }],
  } }]);
  return { page, pageSize, total: result?.count[0]?.total || 0, items: result?.items || [] };
}
const linkedLead = query => query.populate("lead", "name phone stage");
const callsProjection = "number startedAt direction answeredAt activeMs outcome recordingStatus aiStatus technicalResult agent lead managementReview ai.summary ai.objections ai.scriptAssessment";

router.get("/management/workspace/leads", manager, wrap(async (req, res) => {
  const q = req.query, filter = {};
  if (q.active === "yes") Object.assign(filter, openLead);
  if (q.owner) filter.owner = q.owner === "unassigned" ? null : objectId(q.owner);
  if (q.stage) filter.stage = String(q.stage);
  if (q.from && q.to) filter.createdAt = inRange(q.from, q.to);
  if (q.source === "Unknown") filter.source = { $in: [null, ""] };
  else if (q.source) filter.source = regex(q.source);
  if (q.priority === "high") filter.ultra = true;
  if (q.contact === "untouched") filter.firstAttemptAt = null;
  if (q.contact === "contacted") filter.firstAttemptAt = { $ne: null };
  if (q.contact === "stale") filter.lastContactAt = { $lt: new Date(Date.now() - 7 * dayMs) };
  if (q.touchedBy && q.day) {
    const actor = objectId(q.touchedBy), range = inRange(q.day, q.day);
    const [activity, calls] = await Promise.all([
      Activity.find({ actor, createdAt: range, lead: { $ne: null } }).distinct("lead"),
      Call.find({ agent: actor, startedAt: range, lead: { $ne: null } }).distinct("lead"),
    ]);
    filter._id = { $in: [...activity, ...calls] };
  }
  if (q.q) filter.$or = ["name", "phone"].map(field => ({ [field]: regex(q.q) }));
  const pipeline = [
    { $match: filter },
    { $lookup: { from: "users", localField: "owner", foreignField: "_id", pipeline: [{ $project: { name: 1, active: 1 } }], as: "person" } },
    { $lookup: { from: "tasks", localField: "_id", foreignField: "lead", pipeline: [
      { $match: { status: "open", ...customerAction } }, { $sort: { dueAt: 1, _id: 1 } }, { $limit: 1 }, { $project: { title: 1, dueAt: 1, owner: 1 } },
    ], as: "next" } },
    { $lookup: { from: "meetings", localField: "_id", foreignField: "lead", pipeline: [
      { $match: { status: "scheduled", end: { $gte: new Date() } } }, { $sort: { start: 1, _id: 1 } }, { $limit: 1 }, { $project: { start: 1 } },
    ], as: "appointment" } },
    { $set: { owner: { $first: "$person" }, nextTask: { $first: "$next" }, nextMeeting: { $first: "$appointment" } } },
  ];
  if (q.next === "missing") pipeline.push({ $match: { ...openLead, "next.0": { $exists: false }, "appointment.0": { $exists: false } } });
  if (q.next === "overdue") pipeline.push({ $match: { "nextTask.dueAt": { $lt: new Date() } } });
  if (q.next === "scheduled") pipeline.push({ $match: { $or: [{ "nextTask.dueAt": { $gte: new Date() } }, { "appointment.0": { $exists: true } }] } });
  pipeline.push({ $sort: q.sort === "name" ? { name: 1, _id: 1 } : q.sort === "newest" ? { createdAt: -1, _id: -1 } : { updatedAt: -1, _id: -1 } },
    { $project: { name: 1, phone: 1, owner: 1, stage: 1, ultra: 1, source: 1, firstAttemptAt: 1, lastContactAt: 1, nextTask: 1, nextMeeting: 1, updatedAt: 1 } });
  res.json(await aggregateList(Lead, pipeline, q));
}));

router.get("/management/workspace/leads/:id", manager, wrap(async (req, res) => {
  const id = objectId(req.params.id);
  const lead = await Lead.findById(id).populate("owner", "name active").lean();
  if (!lead) throw fail("Lead not found", 404);
  const [nextTask, nextMeeting] = await Promise.all([
    Task.findOne({ lead: id, status: "open", ...customerAction }).sort({ dueAt: 1, _id: 1 }).populate("owner", "name").lean(),
    Meeting.findOne({ lead: id, status: "scheduled", end: { $gte: new Date() } }).sort({ start: 1, _id: 1 }).lean(),
  ]);
  res.json({ lead, nextTask, nextMeeting });
}));

router.get("/management/workspace/leads/:id/:section", manager, wrap(async (req, res) => {
  const filter = { lead: objectId(req.params.id) };
  if (req.params.section === "calls" && req.query.pitch === "gaps") {
    filter["ai.scriptAssessment.steps.status"] = { $in: ["partial", "missed"] };
  }
  const sections = {
    timeline: [Activity, Activity.find(filter).populate("actor", "name").sort({ createdAt: -1, _id: -1 })],
    calls: [Call, Call.find(filter).select(callsProjection).populate("agent", "name").sort({ startedAt: -1, _id: -1 })],
    actions: [Task, Task.find(filter).populate("owner", "name").sort({ dueAt: -1, _id: -1 })],
    meetings: [Meeting, Meeting.find(filter).populate("reps", "name").sort({ start: -1, _id: -1 })],
    demos: [Demo, Demo.find(filter).populate("owner", "name").sort({ updatedAt: -1, _id: -1 })],
  };
  if (!Object.hasOwn(sections, req.params.section)) throw fail("Unknown section", 404);
  const [model, query] = sections[req.params.section];
  res.json(await list(model, filter, req.query, query));
}));

router.get("/management/workspace/calls/:id", manager, wrap(async (req, res) => {
  const id = objectId(req.params.id);
  const call = await Call.findById(id).select("-recordingKey -deviceId").populate("agent leadOwnerAtCall", "name").populate("lead", "name stage owner phone").lean();
  if (!call) throw fail("Call not found", 404);
  if (call.managementReview?.reviewer) {
    const reviewer = await User.findById(call.managementReview.reviewer).select("name").lean();
    if (reviewer) call.managementReview.reviewer = reviewer;
  }
  const nextTask = call.lead && await Task.findOne({ lead: call.lead._id, status: "open", ...customerAction })
    .sort({ dueAt: 1, _id: 1 }).populate("owner", "name").lean();
  res.json({ call, nextTask });
}));

router.post("/management/workspace/calls/:id/review", manager, wrap(async (req, res) => {
  const id = objectId(req.params.id);
  const { notes, revision } = req.body;
  if (typeof notes !== "string" || !notes.trim() || notes.length > 3000 || !Number.isFinite(+new Date(revision || "")))
    throw fail("Enter a review note and refresh the call before saving");
  const session = await mongoose.startSession();
  let review;
  try {
    await session.withTransaction(async () => {
      review = { reviewer: req.user.id, reviewedAt: new Date(), notes: notes.trim() };
      const call = await Call.findOneAndUpdate({ _id: id, updatedAt: new Date(revision) }, { $set: { managementReview: review } }, { session, new: true });
      if (!call) throw fail("This call changed. Refresh before saving.", 409);
      await Activity.create([{ lead: call.lead, actor: req.user.id, type: "manager_call_review",
        text: review.notes, data: { call: id, reviewedAt: review.reviewedAt } }], { session });
    });
  } finally { await session.endSession(); }
  res.json(review);
}));

router.get("/management/workspace/actions", manager, wrap(async (req, res) => {
  const q = req.query, filter = {};
  const tomorrow = new Date(+start(today()) + dayMs);
  if (q.owner) filter.owner = q.owner === "unassigned" ? null : objectId(q.owner);
  if (q.lead) filter.lead = objectId(q.lead);
  if (q.doneFrom && q.doneTo) filter.doneAt = inRange(q.doneFrom, q.doneTo);
  if (q.id) filter._id = objectId(q.id);
  const status = q.status || "open";
  if (status === "overdue") Object.assign(filter, { status: "open", dueAt: { $lt: new Date() } });
  else if (status === "today") Object.assign(filter, { status: "open", dueAt: { $gte: start(today()), $lt: tomorrow } });
  else if (status === "upcoming") Object.assign(filter, { status: "open", dueAt: { $gte: tomorrow } });
  else if (status === "blocked") filter.status = "open";
  else if (["open", "done", "cancelled"].includes(status)) filter.status = status;
  const pipeline = [{ $match: filter }];
  pipeline.push({ $lookup: { from: "leads", localField: "lead", foreignField: "_id", pipeline: [{ $project: { name: 1, phone: 1, stage: 1 } }], as: "shop" } },
    { $lookup: { from: "users", localField: "owner", foreignField: "_id", pipeline: [{ $project: { name: 1, active: 1 } }], as: "person" } },
    { $set: { lead: { $first: "$shop" }, owner: { $first: "$person" } } },
    { $unset: ["shop", "person"] });
  if (status === "blocked") pipeline.push({ $match: { $or: [{ "owner.active": { $ne: true } }, { snoozeApprovalRequestedAt: { $ne: null } }] } });
  if (q.q) pipeline.push({ $match: { $or: [{ title: regex(q.q) }, { "lead.name": regex(q.q) }] } });
  pipeline.push({ $sort: status === "done" ? { doneAt: -1, _id: -1 } : { dueAt: 1, _id: 1 } });
  res.json(await aggregateList(Task, pipeline, q));
}));

router.get("/management/workspace/commitments", manager, wrap(async (req, res) => {
  const q = req.query, filter = {};
  if (q.owner) {
    const id = objectId(q.owner);
    filter.$or = q.kind === "demo" ? [{ owner: id }, { sentBy: id }] : [{ bookedBy: id }, { reps: id }];
  }
  if (q.status) filter.status = String(q.status);
  if (q.q) filter.lead = { $in: await Lead.find({ name: regex(q.q) }).distinct("_id") };
  if (q.kind === "demo") {
    if (q.from && q.to) filter.updatedAt = inRange(q.from, q.to);
    return res.json(await list(Demo, filter, q, linkedLead(Demo.find(filter)).populate("owner", "name").sort({ updatedAt: -1, _id: -1 })));
  }
  if (q.from && q.to) filter.start = inRange(q.from, q.to);
  if (q.upcoming === "yes") { filter.status = "scheduled"; filter.end = { $gte: new Date() }; }
  res.json(await list(Meeting, filter, q, linkedLead(Meeting.find(filter)).populate("reps", "name").sort(q.upcoming === "yes" ? { start: 1, _id: 1 } : { start: -1, _id: -1 })));
}));

router.get("/management/workspace/commitments/:kind/:id", manager, wrap(async (req, res) => {
  const id = objectId(req.params.id);
  const kind = req.params.kind;
  if (!["meeting", "demo"].includes(kind)) throw fail("Unknown commitment type", 404);
  const model = kind === "meeting" ? Meeting : Demo;
  const row = await linkedLead(model.findById(id)).populate(kind === "meeting" ? "reps" : "owner", "name").select("-token").lean();
  if (!row) throw fail("Commitment not found", 404);
  const [tasks, queue] = await Promise.all([
    Task.find({ status: "open", $or: [{ [kind]: id }, { key: { $regex: ":" + id + "$" } }] }).sort({ dueAt: 1 }).populate("owner", "name").lean(),
    actionQueue(),
  ]);
  const actions = queue.filter(item => String(item.id) === String(id) || item.taskKey?.endsWith(":" + id));
  res.json({ row, tasks, actions });
}));

router.post("/management/workspace/commitments/meeting/:id/reschedule", manager, wrap(async (req, res) => {
  const id = objectId(req.params.id);
  const expected = new Date(req.body.revision);
  if (!Number.isFinite(+expected)) throw fail("Refresh the meeting before rescheduling");
  const old = await Meeting.findById(id).lean();
  if (!old) throw fail("Meeting not found", 404);
  const next = await meetingInput({ ...old, start: req.body.start, end: req.body.end, confirmed: req.body.confirmed === true, reps: old.reps.map(String) });
  await ensureCalendarLocks(next);
  const session = await mongoose.startSession();
  let replacement;
  try {
    await session.withTransaction(async () => {
      const meeting = await Meeting.findOneAndUpdate({ _id: id, status: "scheduled", updatedAt: expected, end: { $gt: new Date() } },
        { $set: { status: "cancelled", outcome: "Rescheduled", resultSaved: true } }, { session, new: true });
      if (!meeting) throw fail("This meeting changed or already ended. Refresh before rescheduling.", 409);
      const lead = await Lead.findById(meeting.lead).session(session);
      if (!lead) throw fail("Lead not found", 404);
      replacement = await bookMeeting(lead, next, session, undefined, req.user.id);
      await Task.updateMany({ status: "open", $or: [{ meeting: id }, { key: { $in: ["prep", "confirm", "place", "result"].map(kind => `meeting-${kind}:${id}`) } }] },
        { $set: { status: "cancelled" } }, { session });
      await Activity.create([{ lead: lead.id, actor: req.user.id, type: "meeting_updated",
        text: "Meeting rescheduled", data: { meeting: replacement.id, previousMeeting: meeting.id } }], { session });
    });
  } finally { await session.endSession(); }
  res.json(replacement);
}));

router.get("/management/workspace/employee", manager, wrap(async (req, res) => {
  const agent = objectId(req.query.agent);
  const day = req.query.day || today();
  const period = inRange(day, day);
  const [calls, attendance, leadIds, done, reviewed, overdue, meetings, demos] = await Promise.all([
    Call.find({ agent, startedAt: period }).select("direction startedAt endedAt answeredAt activeMs outcome lead").lean(),
    Attendance.findOne({ agent, day }).lean(),
    Activity.find({ actor: agent, createdAt: period, lead: { $ne: null } }).distinct("lead"),
    Task.countDocuments({ owner: agent, status: "done", doneAt: period }),
    Call.countDocuments({ agent, startedAt: period, $or: [{ "managementReview.reviewedAt": { $exists: true } }, { "coachingReview.reviewedAt": { $exists: true } }] }),
    Task.countDocuments({ owner: agent, status: "open", dueAt: { ...period, $lt: new Date(Math.min(+period.$lt, Date.now())) } }),
    Meeting.countDocuments({ start: period, $or: [{ bookedBy: agent }, { reps: agent }] }),
    Demo.countDocuments({ $or: [{ sentBy: agent, sentAt: period }, { owner: agent, walkthroughCompletedAt: period }] }),
  ]);
  const touched = new Set([...leadIds, ...calls.map(row => row.lead).filter(Boolean)].map(String));
  res.json({ day, attendance: activityDays(calls, attendance ? [attendance] : [])[0], stats: summarizeCalls(calls), touched: touched.size, done, reviewed, overdue, meetings, demos });
}));

router.get("/management/workspace/daily", manager, wrap(async (req, res) => {
  const q = req.query, filter = { user: req.user.id, category: "daily_report" };
  if (q.owner) {
    const owner = objectId(q.owner);
    const employee = await User.findById(owner).select("name").lean();
    filter.$or = [{ "snapshot.agent": String(owner) }, ...(employee ? [{ snapshot: null, title: regex(employee.name + " · ") }] : [])];
  }
  if (q.from && q.to) {
    inRange(q.from, q.to);
    filter.$and = [{ $or: [{ "snapshot.date": { $gte: q.from, $lte: q.to } },
      { snapshot: null, $expr: { $and: [
        { $gte: [{ $substrCP: ["$key", 13, 10] }, q.from] }, { $lte: [{ $substrCP: ["$key", 13, 10] }, q.to] },
      ] } }] }];
  }
  res.json(await list(Notification, filter, q, Notification.find(filter).select("title body createdAt snapshot").sort({ createdAt: -1, _id: -1 })));
}));

router.get("/management/workspace/coaching", manager, wrap(async (req, res) => {
  const agent = objectId(req.query.agent);
  const filter = { agent };
  const result = await list(CoachingAction, filter, req.query, CoachingAction.find(filter).sort({ createdAt: -1, _id: -1 }));
  res.json({ ...result, items: await coachingProgress(result.items) });
}));

router.get("/management/workspace/tomorrow", manager, wrap(async (req, res) => {
  const { page, pageSize, skip } = pagination(req.query);
  const owner = req.query.owner ? String(objectId(req.query.owner)) : null;
  const rows = (await tomorrowCommitments(new Date())).filter(row => !owner ||
    [row.owner?._id, ...(row.staff || [])].some(id => String(id) === owner))
    .sort((a, b) => +a.dueAt - +b.dueAt);
  res.json({ page, pageSize, total: rows.length, items: rows.slice(skip, skip + pageSize) });
}));

router.get("/management/workspace/exceptions", manager, wrap(async (req, res) => {
  const q = req.query, filter = { status: q.status === "resolved" ? "resolved" : "open" };
  if (q.type === "capture") filter.type = "capture";
  if (q.q) filter.$or = ["title", "detail", "type"].map(field => ({ [field]: regex(q.q) }));
  res.json(await list(Exception, filter, q, Exception.find(filter).populate("lead", "name").populate("owner", "name").sort(filter.status === "open" ? { severity: 1, createdAt: 1, _id: 1 } : { updatedAt: -1, _id: -1 })));
}));

router.get("/management/workspace/today", manager, wrap(async (req, res) => {
  const day = today(), period = inRange(day, day);
  const [untouched, overdue, meetings, exceptions, reviews, capture, critical, unconfirmed] = await Promise.all([
    Lead.countDocuments({ ...openLead, firstAttemptAt: null }),
    Task.countDocuments({ status: "open", dueAt: { $lt: new Date() } }),
    Meeting.countDocuments({ status: "scheduled", start: period }),
    Exception.countDocuments({ status: "open" }),
    Call.aggregate([
      { $match: { startedAt: period, "managementReview.reviewedAt": { $exists: false }, "coachingReview.reviewedAt": { $exists: false } } },
      { $lookup: { from: "leads", localField: "lead", foreignField: "_id", as: "lead" } },
      { $set: { lead: { $first: "$lead" }, agent: { _id: "$agent" } } },
      { $set: { flags: reviewFlags } }, { $match: { "flags.0": { $exists: true } } }, { $count: "total" },
    ]),
    Exception.findOne({ key: "meta-stale", status: "open" }).select("detail").lean(),
    Exception.find({ status: "open", severity: "critical", type: { $in: ["first_contact", "coverage", "customer_next", "capture"] } })
      .sort({ createdAt: 1, _id: 1 }).limit(5).populate("lead", "name").populate("owner", "name").lean(),
    Meeting.find({ status: "scheduled", confirmed: { $ne: true }, start: period, end: { $gt: new Date() } })
      .sort({ start: 1 }).limit(5).populate("lead", "name").populate("reps", "name").lean(),
  ]);
  res.json({ capture, critical, unconfirmed, untouched, overdue, meetings, exceptions, reviews: reviews[0]?.total || 0 });
}));

export default router;
