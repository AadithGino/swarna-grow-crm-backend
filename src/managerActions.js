import express from "express";
import mongoose from "mongoose";
import { Activity, Call, CoachingAction, Demo, Exception, Lead, Meeting, Proposal, Task, User } from "./models.js";
import { changeTask } from "./taskChanges.js";
import { completeMeetingOutcome } from "./salesOutcome.js";
import { pitchSteps } from "./pitchRubric.js";
import { notify } from "./notifications.js";

const router = express.Router();
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
const fail = (message, status = 422) => Object.assign(Error(message), { status });
const manager = (req, res, next) => req.user.role === "manager" ? next() : res.sendStatus(403);
const leadFields = "name stage doNotContact owner";
const salesLead = lead => lead && !lead.doNotContact && !["Won", "Lost"].includes(lead.stage);

export async function actionQueue(now = new Date(), horizon = now) {
  const [tasks, meetings, demos, exceptions] = await Promise.all([
    Task.find({ status: "open", $or: [
      { demo: { $ne: null }, dueAt: { $lte: now } },
      { kind: "internal", title: "Review unanswered lead" },
      { dueAt: { $lte: horizon }, kind: { $in: ["call", "confirm_meeting", "confirmation", "proposal_follow", "proposal", "send_proposal", "demo_response", "send_demo"] } },
      { key: /^(meeting-confirm:|meeting-next:|meeting-place:|retry-review:|demo-response-next:|demo-send:)/ },
    ] }).populate("owner", "name").populate("lead", leadFields).lean(),
    Meeting.find({ status: "scheduled", $or: [{ confirmed: { $ne: true } }, { end: { $lte: now } }] })
      .populate("lead", leadFields).lean(),
    Demo.find({ walkthroughCompletedAt: { $ne: null }, status: "responded" })
      .select("lead owner walkthroughCompletedAt updatedAt").populate("lead", leadFields).lean(),
    Exception.find({ status: "open", key: /^(meeting-coverage|unlinked-missed|nurture-date|recording-upload):/ })
      .populate("lead", leadFields).populate("owner", "name").lean(),
  ]);
  const items = tasks.filter(task => salesLead(task.lead)).map(task => ({
    id: String(task._id), type: "task", lead: task.lead, owner: task.owner,
    title: task.title, dueAt: task.dueAt, fixed: task.fixed, taskKey: task.key, revision: task.updatedAt,
  }));
  const calls = new Map((await Call.find({ _id: { $in: exceptions.filter(item => item.key.startsWith("unlinked-missed:")).map(item => item.call) },
    lead: null }).select("number").lean()).map(call => [String(call._id), call.number]));
  for (const item of exceptions) {
    const number = calls.get(String(item.call));
    if (item.key.startsWith("unlinked-missed:") && !number) continue;
    items.push({ id: String(item._id), type: "exception",
    lead: item.lead, owner: item.owner, title: item.title, detail: item.detail, dueAt: item.createdAt,
    meeting: item.meeting, call: item.call, number });
  }
  const taskByKey = new Map(items.map(item => [item.taskKey, item]));
  for (const meeting of meetings.filter(row => salesLead(row.lead))) {
    if (meeting.end <= now) {
      items.push({ id: String(meeting._id), type: "meeting", lead: meeting.lead,
        owner: { _id: meeting.bookedBy || meeting.lead.owner }, title: "Meeting outcome missing", dueAt: meeting.end, revision: meeting.updatedAt });
    } else {
      const key = `meeting-confirm:${meeting._id}`;
      if (taskByKey.has(key)) continue;
      items.push({ id: String(meeting._id), type: "confirmation", lead: meeting.lead,
        owner: { _id: meeting.lead.owner }, title: "Confirm upcoming meeting", dueAt: meeting.start, revision: meeting.updatedAt });
    }
  }
  const demoKeys = demos.map(demo => `demo-response-next:${demo._id}`);
  const settled = new Set(await Task.find({ key: { $in: demoKeys }, status: "done" }).distinct("key"));
  for (const demo of demos.filter(row => salesLead(row.lead))) {
    const key = `demo-response-next:${demo._id}`;
    if (taskByKey.has(key) || settled.has(key)) continue;
    items.push({ id: String(demo._id), type: "demo", lead: demo.lead, owner: { _id: demo.owner },
      title: "Completed demo needs a follow-up", dueAt: demo.walkthroughCompletedAt, revision: demo.updatedAt });
  }
  const ownerIds = [...new Set(items.filter(item => item.owner?._id && !item.owner.name).map(item => String(item.owner._id)))];
  const owners = new Map((await User.find({ _id: { $in: ownerIds } }).select("name")).map(user => [user.id, user.name]));
  for (const item of items) if (item.owner && !item.owner.name) item.owner.name = owners.get(String(item.owner._id));
  return items.sort((a, b) => +a.dueAt - +b.dueAt);
}

router.get("/management/action-queue", manager, wrap(async (req, res) => {
  res.json(await actionQueue());
}));
async function missingFollowUps() {
  const withoutTask = prefix => [
    { $lookup: { from: "tasks", let: { key: { $concat: [prefix, { $toString: "$_id" }] } }, pipeline: [
      { $match: { status: { $ne: "cancelled" }, $expr: { $eq: ["$key", "$$key"] } } }, { $limit: 1 },
    ], as: "followUp" } },
    { $match: { "followUp.0": { $exists: false } } },
  ];
  const [missed, proposals] = await Promise.all([
    Meeting.aggregate([
      { $match: { status: "no_show" } }, { $sort: { end: -1, _id: -1 } },
      { $group: { _id: "$lead", meeting: { $first: "$$ROOT" } } }, { $replaceWith: "$meeting" },
      ...withoutTask("meeting-next:"),
      { $lookup: { from: "meetings", let: { lead: "$lead", ended: "$end" }, pipeline: [
        { $match: { status: { $in: ["scheduled", "completed"] },
          $expr: { $and: [{ $eq: ["$lead", "$$lead"] }, { $gt: ["$start", "$$ended"] }] } } }, { $limit: 1 },
      ], as: "rebooked" } }, { $match: { "rebooked.0": { $exists: false } } },
      { $project: { lead: 1, end: 1 } },
    ]),
    Proposal.aggregate([
      { $match: { status: "sent", sentAt: { $ne: null } } }, { $sort: { sentAt: -1, _id: -1 } },
      { $group: { _id: "$lead", proposal: { $first: "$$ROOT" } } }, { $replaceWith: "$proposal" },
      ...withoutTask("proposal-follow:"),
      { $project: { lead: 1, sentAt: 1 } },
    ]),
  ]);
  const candidates = [
    ...missed.map(row => ({ ...row, title: "Missed meeting needs a rebooking action", dueAt: row.end, meeting: row._id })),
    ...proposals.map(row => ({ ...row, title: "Sent proposal needs a follow-up", dueAt: row.sentAt })),
  ];
  const leads = await Lead.find({ _id: { $in: candidates.map(row => row.lead) } }).select(leadFields).populate("owner", "name").lean();
  const active = new Map(leads.filter(salesLead).map(lead => [String(lead._id), lead]));
  const followUps = await Task.find({ lead: { $in: [...active.keys()] }, key: /^manager-follow:/, status: { $ne: "cancelled" } })
    .select("lead createdAt").lean();
  const lastManagerFollow = new Map();
  for (const task of followUps) lastManagerFollow.set(String(task.lead), Math.max(+task.createdAt, lastManagerFollow.get(String(task.lead)) || 0));
  return candidates.flatMap(row => {
    const lead = active.get(String(row.lead));
    return lead && !(lastManagerFollow.get(String(row.lead)) >= +row.dueAt) ? [{
      id: String(row._id), type: "exception", category: "customer_next", title: row.title,
      dueAt: row.dueAt, lead, owner: lead.owner, meeting: row.meeting,
    }] : [];
  });
}

router.get("/management/leakage-queue", manager, wrap(async (req, res) => {
  const [queue, exceptions, missing] = await Promise.all([
    actionQueue(),
    
    Exception.find({ status: "open" }).populate("lead", leadFields).populate("owner", "name").lean(),
    missingFollowUps(),
  ]);
  const rows = new Map(queue.map(row => [row.type + ":" + row.id, row]));
  for (const exception of exceptions) {
    const id = String(exception._id);
    const task = exception.task && rows.get("task:" + exception.task);
    const existing = rows.get("exception:" + id);
    const target = task || existing;
    if (target) {
      target.severity = exception.severity;
      target.category = exception.type;
      target.detail = exception.detail;
      continue;
    }
    rows.set("exception:" + id, {
      id, type: "exception", lead: exception.lead, owner: exception.owner,
      title: exception.title, detail: exception.detail, severity: exception.severity,
      category: exception.type, task: exception.task, call: exception.call,
      meeting: exception.meeting, sourceImport: exception.sourceImport, dueAt: exception.createdAt,
    });
  }
  res.json([...rows.values(), ...missing].sort((a,b) => Number(b.severity === "critical") - Number(a.severity === "critical") ||
    new Date(a.dueAt) - new Date(b.dueAt)));
}));
router.get("/management/action-queue/:type/:id", manager, wrap(async (req, res) => {
  const { type, id } = req.params;
  if (!mongoose.isValidObjectId(id)) throw fail("Invalid record");
  let record, owner, dueAt;
  if (type === "task") {
    record = await Task.findById(id);
    owner = record?.owner;
    dueAt = record?.dueAt;
  } else if (type === "meeting" || type === "confirmation") {
    record = await Meeting.findById(id).populate("lead", "owner");
    owner = (type === "meeting" && record?.bookedBy) || record?.lead?.owner;
    dueAt = type === "meeting" ? record?.end : record?.start;
  } else if (type === "demo") {
    record = await Demo.findById(id);
    owner = record?.owner;
    dueAt = record?.walkthroughCompletedAt;
  }
  if (!record) throw fail("Action no longer exists", 404);
  const assignee = owner && await User.findById(owner).select("name");
  res.json({ owner: assignee?.name, dueAt, status: record.status });
}));
router.get("/management/assignees", manager, wrap(async (req, res) => {
  res.json(await User.find({ active: true }).select("name role").sort("name"));
}));
router.post("/management/action-queue/:type/:id", manager, wrap(async (req, res) => {
  const { type, id } = req.params;
  if (!mongoose.isValidObjectId(id)) throw fail("Invalid record");
  const { action, owner, dueAt, reason, customerReconfirmed } = req.body;
  if (req.body.expectedOwner && !mongoose.isValidObjectId(req.body.expectedOwner)) throw fail("Invalid previous owner");
  const snapshot = { owner: req.body.expectedOwner, dueAt: req.body.expectedDueAt, revision: req.body.revision };
  if (!snapshot.dueAt || !snapshot.revision ||
      !Number.isFinite(+new Date(snapshot.dueAt)) || !Number.isFinite(+new Date(snapshot.revision)))
    throw fail("Refresh the queue before changing this action", 409);
  const matches = (currentOwner, currentDue, revision) =>
    String(currentOwner || "") === String(snapshot.owner || "") &&
    +currentDue === +new Date(snapshot.dueAt) && +revision === +new Date(snapshot.revision);
  const changed = () => fail("Action changed. Refresh to see the current owner and deadline.", 409);

  if ((type === "meeting" && ["no_show", "attended", "cancelled"].includes(action)) ||
      (["task", "confirmation"].includes(type) && action === "cancelled")) {
    const task = type === "task" && await Task.findOne({ _id: id, status: "open", key: /^meeting-confirm:/ });
    if (type === "task" && (!task || !matches(task.owner, task.dueAt, task.updatedAt))) throw changed();
    const meetingId = task ? task.key.slice("meeting-confirm:".length) : id;
    const meeting = await Meeting.findById(meetingId).populate("lead", leadFields);
    const isConfirmation = type === "confirmation";
    if (!meeting || !salesLead(meeting.lead) || (!task && !matches(
      isConfirmation ? meeting.lead.owner : meeting.bookedBy || meeting.lead.owner,
      isConfirmation ? meeting.start : meeting.end, meeting.updatedAt,
    ))) throw changed();
    if (!owner && !["not_interested", "do_not_contact"].includes(req.body.salesOutcome?.outcome)) throw fail("Select a follow-up owner");
    if (action !== "no_show" && !String(reason || "").trim()) throw fail("Record what happened");
    const status = action === "attended" ? "completed" : action;
    const result = await completeMeetingOutcome(meetingId, req.user, {
      status, expectedRevision: meeting.updatedAt,
      ...(task ? { expectedTask: { id: task.id, ...snapshot } } : {}),
      salesOutcome: {
        ...(req.body.salesOutcome || { outcome: "callback", nextAt: dueAt }),
        nextOwner: owner,
        notes: [action === "no_show" ? (req.body.salesOutcome && req.body.salesOutcome.outcome !== "callback" ? "No-show." : "No-show. Call to rebook.") : "", String(reason || "").slice(0, 500)]
          .filter(Boolean).join(" "),
      },
    });
    return res.json(result);
  }

  if (action === "confirm") {
    const session = await mongoose.startSession();
    let meeting;
    try {
      await session.withTransaction(async () => {
        const task = type === "task" && await Task.findOne({ _id: id, status: "open", key: /^meeting-confirm:/ }).session(session);
        if (type === "task" && (!task || !matches(task.owner, task.dueAt, task.updatedAt))) throw changed();
        if (!task && type !== "confirmation") throw fail("Choose a meeting confirmation");
        const meetingId = task ? task.key.slice("meeting-confirm:".length) : id;
        meeting = await Meeting.findOne({ _id: meetingId, status: "scheduled", confirmed: { $ne: true }, start: { $gt: new Date() } }).session(session);
        if (!meeting) throw changed();
        const lead = await Lead.findById(meeting.lead).session(session);
        if (!salesLead(lead) || (!task && !matches(lead.owner, meeting.start, meeting.updatedAt))) throw changed();
        meeting.confirmed = true;
        await meeting.save({ session });
        await Task.updateOne({ key: `meeting-confirm:${meeting.id}`, status: "open" },
          { $set: { status: "done", doneAt: new Date() } }, { session });
        await Activity.create([{ lead: lead.id, actor: req.user.id, type: "meeting_updated",
          text: "Meeting confirmed", data: { meeting: meeting.id } }], { session });
      });
    } finally { await session.endSession(); }
    return res.json(meeting);
  }
  if (!["claim", "assign", "reschedule", "complete"].includes(action)) throw fail("Choose an action");
  const nextOwner = action === "claim" ? req.user.id : owner;
  if (action === "assign" && !nextOwner) throw fail("Select an owner");
  if (nextOwner && (!mongoose.isValidObjectId(nextOwner) || !(await User.exists({ _id: nextOwner, active: true }))))
    throw fail("Choose an active owner");
  if (type === "task") {
    const task = await Task.findOne({ _id: id, status: "open" });
    if (!task || !matches(task.owner, task.dueAt, task.updatedAt)) throw changed();
    if (action === "complete") return res.json(await changeTask(id, req.user, {
      complete: true, note: reason, nextAction: "call", nextAt: dueAt, queueSnapshot: snapshot,
    }));
    if (action === "reschedule") {
      if (!dueAt) throw fail("Choose a new deadline");
      if (/^meeting-(confirm|place):/.test(task.key || "")) {
        const confirmation = task.key.startsWith("meeting-confirm:");
        const meeting = await Meeting.findById(task.key.split(":")[1]);
        if (!meeting || meeting.status !== "scheduled" || (confirmation && meeting.confirmed) || +new Date(dueAt) >= +meeting.start)
          throw fail("This task must be due before the scheduled meeting");
      }
      return res.json(await changeTask(id, req.user, { dueAt, reason, customerReconfirmed, approveSnooze: true, queueSnapshot: snapshot }));
    }
    const expectedOwner = req.body.expectedOwner || null;
    const result = await Task.findOneAndUpdate(
      { _id: id, status: "open", owner: expectedOwner, dueAt: new Date(snapshot.dueAt), updatedAt: new Date(snapshot.revision) },
      { $set: { owner: nextOwner } }, { new: true },
    );
    if (!result) throw fail("Ownership changed. Refresh the queue.", 409);
    await Activity.create({ lead: result.lead, actor: req.user.id, type: "task_assignment",
      text: action === "claim" ? "Task claimed" : "Task reassigned", data: { task: id, from: expectedOwner, to: nextOwner } });
    await notify(nextOwner, `assignment:${result.id}:${+result.updatedAt}`, "Action assigned", result.title, { category: "task", lead: result.lead, task: result.id });
    return res.json(result);
  }
  const when = new Date(dueAt);
  if (!Number.isFinite(+when) || when <= new Date()) throw fail("Choose a future deadline");
  const session = await mongoose.startSession();
  let created, assignee;
  try {
    await session.withTransaction(async () => {
      let record, key, title, kind;
      if (type === "demo") {
        record = await Demo.findOne({ _id: id, status: "responded", walkthroughCompletedAt: { $ne: null } }).session(session);
        key = `demo-response-next:${id}`; title = "Follow up after completed demo"; kind = "call";
      } else if (type === "confirmation") {
        record = await Meeting.findOne({ _id: id, status: "scheduled", confirmed: { $ne: true }, start: { $gt: when } }).session(session);
        key = `meeting-confirm:${id}`; title = "Confirm meeting with customer"; kind = "confirmation";
      } else throw fail("Unknown action record");
      const lead = record && await Lead.findById(record.lead).session(session);
      if (!salesLead(lead) || !matches(type === "demo" ? record.owner : lead.owner,
          type === "demo" ? record.walkthroughCompletedAt : record.start, record.updatedAt)) throw changed();
      assignee = nextOwner || (type === "demo" ? record.owner : lead.owner);
      if (!assignee || !(await User.exists({ _id: assignee, active: true }).session(session)))
        throw fail("Select an active owner");
      if (await Task.exists({ key }).session(session)) throw changed();
      record.updatedAt = new Date(Math.max(Date.now(), +record.updatedAt + 1));
      await record.save({ session, timestamps: false });
      [created] = await Task.create([{
        key, title, kind, owner: assignee, lead: record.lead, dueAt: when, originalDueAt: when, customerFacing: true,
        ...(type === "confirmation" ? { meeting: record._id } : { demo: record._id }),
      }], { session });
    });
  } catch (error) {
    if (error.code === 11000) throw changed();
    throw error;
  } finally { await session.endSession(); }
  await notify(assignee, `assignment:${created.id}:${+created.createdAt}`, "Action assigned", created.title,
    { category: "task", lead: created.lead, task: created.id });
  res.json(created);
}));

const stepLabel = new Map(pitchSteps.map(([key, label]) => [key, label]));
router.post("/management/coaching", manager, wrap(async (req, res) => {
  const { callId, step, excerpt, improvement } = req.body;
  if (!mongoose.isValidObjectId(callId) || !stepLabel.has(step)) throw fail("Select a call and pitch step");
  if (typeof excerpt !== "string" || !excerpt.trim() || excerpt.length > 1000 ||
      typeof improvement !== "string" || !improvement.trim() || improvement.length > 1000)
    throw fail("Add a call excerpt and one specific improvement");
  const call = await Call.findOne({ _id: callId, answeredAt: { $ne: null } }).select("agent startedAt");
  if (!call?.agent) throw fail("Connected call not found", 404);
  const item = await CoachingAction.findOneAndUpdate({ call: call.id, step }, { $setOnInsert: {
    call: call.id, agent: call.agent, manager: req.user.id, step, excerpt: excerpt.trim(), improvement: improvement.trim(),
  } }, { upsert: true, new: true });
  if (item.excerpt !== excerpt.trim() || item.improvement !== improvement.trim())
    throw fail("Feedback already exists for this call and pitch point. Open Coaching follow-through to view it.", 409);
  await notify(item.agent, `coaching:${item.id}`, "Coaching: " + stepLabel.get(step), item.improvement, { category: "coaching" });
  res.json(item);
}));

router.get("/coaching-actions", wrap(async (req, res) => {
  const filter = req.user.role === "manager" ? {} : { agent: req.user.id };
  if (req.user.role === "manager" && req.query.agent) {
    if (!mongoose.isValidObjectId(req.query.agent)) throw fail("Invalid employee");
    filter.agent = req.query.agent;
  }
  const items = await CoachingAction.find(filter).sort({ createdAt: -1 }).limit(60).lean();
  res.json(await coachingProgress(items));
}));

export async function coachingProgress(items) {
  return Promise.all(items.map(async item => {
    const candidates = await Call.find({ agent: item.agent, startedAt: { $gt: item.createdAt }, $or: [
      { ["coachingReview.checks." + item.step]: { $in: ["done", "partial", "missed"] } },
      { "ai.scriptAssessment.steps": { $elemMatch: { key: item.step, status: { $in: ["covered", "partial", "missed"] } } } },
    ] }).select("startedAt ai.scriptAssessment coachingReview.checks").sort({ startedAt: 1 }).limit(3).lean();
    return { ...item, label: stepLabel.get(item.step), progress: candidates.map(call => {
      const review = call.coachingReview?.checks?.[item.step];
      const human = ["done", "partial", "missed"].includes(review);
      return { call: call._id, startedAt: call.startedAt, source: human ? "Manager" : "AI",
        status: human ? (review === "done" ? "covered" : review) : call.ai?.scriptAssessment?.steps?.find(step => step.key === item.step && ["covered", "partial", "missed"].includes(step.status))?.status || "unassessable" };
    }) };
  }));
}

export async function sourceFunnel(period, agent) {
  const leads = await Lead.find({ createdAt: period, ...(agent ? { owner: agent } : {}) })
    .select("source stage firstConnectedAt").lean();
  const ids = leads.map(lead => lead._id);
  const [connected, completed, quotes] = await Promise.all([
    Call.find({ lead: { $in: ids }, answeredAt: { $ne: null } }).distinct("lead"),
    Demo.find({ lead: { $in: ids }, walkthroughCompletedAt: { $ne: null } }).distinct("lead"),
    Proposal.find({ lead: { $in: ids }, sentAt: { $ne: null } }).sort({ sentAt: -1, _id: -1 }).select("lead amount setupFee monthlyFee").lean(),
  ]);
  const calls = new Set(connected.map(String)), demos = new Set(completed.map(String)), latest = new Map();
  for (const quote of quotes) if (!latest.has(String(quote.lead))) latest.set(String(quote.lead), quote);
  const sources = new Map();
  for (const lead of leads) {
    const label = lead.source?.trim() || "Unknown";
    if (!sources.has(label)) sources.set(label, { label, leads: 0, connected: 0, demoCompleted: 0, quoted: 0, won: 0,
      setupQuoted: 0, monthlyQuoted: 0, setupWon: 0, monthlyWon: 0, wonWithoutQuote: 0, legacyQuotes: 0 });
    const row = sources.get(label), id = String(lead._id), quote = latest.get(id);
    row.leads++;
    if (lead.firstConnectedAt || calls.has(id)) row.connected++;
    if (demos.has(id)) row.demoCompleted++;
    if (lead.stage === "Won") row.won++;
    if (!quote) {
      if (lead.stage === "Won") row.wonWithoutQuote++;
      continue;
    }
    row.quoted++;
    const setup = quote.setupFee ?? 0, monthly = quote.monthlyFee ?? 0;
    if (quote.setupFee == null && quote.monthlyFee == null) row.legacyQuotes++;
    row.setupQuoted += setup; row.monthlyQuoted += monthly;
    if (lead.stage === "Won") { row.setupWon += setup; row.monthlyWon += monthly; }
  }
  return [...sources.values()].sort((a,b) => b.leads - a.leads);
}
export default router;
