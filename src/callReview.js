import { leadStatusStages } from "./leadContacts.js";
import express from "express";
import mongoose from "mongoose";
import { Activity, Call, Lead, Task, User } from "./models.js";
import { workSlot } from "./rules.js";

const router = express.Router();
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
const fail = (message, status = 422) => Object.assign(Error(message), { status });
const manager = (req, res, next) => req.user.role === "manager" ? next() : next(fail("Manager access required", 403));
const day = date => new Date(+date + 330 * 60000).toISOString().slice(0, 10);
const start = key => new Date(key + "T00:00:00+05:30");
const filters = ["attention", "all", "flagged", "mismatch", "unlinked", "wrong_agent", "no_recording", "no_transcript", "do_not_contact", "reviewed", "unreviewed", "evidence"];

export const reviewFlags = {
  $filter: {
    input: [
      { $cond: [{ $not: ["$lead._id"] }, "unlinked", null] },
      { $cond: [{ $and: [{ $ifNull: ["$leadOwnerAtCall", false] }, { $ne: ["$agent._id", "$leadOwnerAtCall"] }] }, "wrong_agent", null] },
      { $cond: [{ $and: [{ $ifNull: ["$answeredAt", false] }, { $ne: ["$recordingStatus", "uploaded"] }] }, "no_recording", null] },
      { $cond: [{ $and: [{ $eq: ["$recordingStatus", "uploaded"] }, { $lt: [{ $strLenCP: { $ifNull: ["$transcript", ""] } }, 20] }] }, "no_transcript", null] },
      { $cond: [{ $in: ["unassessable", { $ifNull: ["$ai.scriptAssessment.steps.status", []] }] }, "mismatch", null] },
      { $cond: [{ $gt: [{ $size: { $filter: { input: { $ifNull: ["$ai.scriptAssessment.steps", []] }, as: "step", cond: { $in: ["$$step.status", ["missed", "partial"]] } } } }, 0] }, "flagged", null] },
      { $cond: [{ $eq: ["$lead.doNotContact", true] }, "do_not_contact", null] },
    ],
    as: "flag",
    cond: { $ne: ["$$flag", null] },
  },
};

router.get("/management/call-review", manager, wrap(async (req, res) => {
  const { agent, from, to, filter = "attention", lead, direction, outcome, q, media, signal } = req.query;
  const page = Math.min(100000, Math.max(1, Math.trunc(Number(req.query.page)) || 1));
  const pageSize = Math.min(50, Math.max(5, Math.trunc(Number(req.query.pageSize)) || 25));
  if (!filters.includes(filter)) throw fail("Unknown review filter");
  if (agent && !mongoose.isValidObjectId(agent)) throw fail("Unknown employee");
  const dated = from || to;
  if (dated && (!/^\d{4}-\d{2}-\d{2}$/.test(from || "") || !/^\d{4}-\d{2}-\d{2}$/.test(to || "") || from > to))
    throw fail("Choose a valid date range");
  const match = {};
  if (req.query.exclude) {
    if (!mongoose.isValidObjectId(req.query.exclude)) throw fail("Invalid call to skip");
    match._id = { $ne: new mongoose.Types.ObjectId(req.query.exclude) };
  }
  if (agent) match.agent = new mongoose.Types.ObjectId(agent);
  if (dated) match.startedAt = { $gte: start(from), $lt: new Date(+start(to) + 86400000) };
  if (lead) {
    if (!mongoose.isValidObjectId(lead)) throw fail("Unknown lead");
    match.lead = new mongoose.Types.ObjectId(lead);
  }
  if (req.query.connected === "yes") match.answeredAt = { $exists: true, $ne: null };
  if (direction) match.direction = String(direction);
  if (outcome) match.outcome = String(outcome);
  if (media === "audio") match.recordingStatus = "uploaded";
  if (media === "missing") match.recordingStatus = { $ne: "uploaded" };
  if (req.query.assessment === "yes") match["ai.scriptAssessment"] = { $ne: null };
  const search = q ? new RegExp(String(q).slice(0, 100).split("").map(c => ".*+?^$${}()|[]\\".includes(c) ? "\\" + c : c).join(""), "i") : null;
  const reviewed = { $or: [{ "managementReview.reviewedAt": { $exists: true } }, { "coachingReview.reviewedAt": { $exists: true } }] };
  const unreviewed = { $nor: [reviewed] };
  const attention = { ...unreviewed, "flags.0": { $exists: true } };
  const filterMatch = filter === "all" ? {} : filter === "attention" ? attention : filter === "reviewed" ? reviewed : filter === "unreviewed" ? unreviewed : filter === "evidence" ? { flags: { $in: ["no_recording", "no_transcript", "mismatch"] } } : { flags: filter };
  const [result] = await Call.aggregate([
    { $match: match },
    { $lookup: { from: "leads", localField: "lead", foreignField: "_id", as: "lead" } },
    { $unwind: { path: "$lead", preserveNullAndEmptyArrays: true } },
    { $lookup: { from: "users", localField: "agent", foreignField: "_id", as: "agent" } },
    { $unwind: { path: "$agent", preserveNullAndEmptyArrays: true } },
    { $lookup: { from: "users", localField: "lead.owner", foreignField: "_id", as: "ownerUser" } },
    { $unwind: { path: "$ownerUser", preserveNullAndEmptyArrays: true } },
    ...(search ? [{ $match: { $or: [{ number: search }, { "lead.name": search }, { "agent.name": search }] } }] : []),
    ...(signal ? [{ $match: (() => {
      const value = new RegExp("^" + String(signal).slice(0, 100).split("").map(c => ".*+?^${}()|[]\\".includes(c) ? "\\" + c : c).join("") + "$", "i");
      const fields = { objections: { "ai.objections": value }, questions: { "ai.salesSignals.questions.topic": value },
        missed: { "ai.scriptAssessment.steps": { $elemMatch: { label: value, status: { $in: ["missed", "partial"] } } } },
        doubts: { "ai.salesSignals.doubts.section": value }, interruptions: { "ai.salesSignals.interruptions.section": value },
        interest: { "ai.salesSignals.interest": value } };
      return fields[req.query.signalType] || { $or: Object.values(fields) };
    })() }] : []),
    { $addFields: { flags: reviewFlags } },
    { $facet: {
      counts: [{ $unwind: "$flags" }, { $group: { _id: "$flags", n: { $sum: 1 } } }],
      attention: [{ $match: attention }, { $count: "n" }],
      reviewed: [{ $match: reviewed }, { $count: "n" }],
      unreviewed: [{ $match: unreviewed }, { $count: "n" }],
      all: [{ $count: "n" }],
      total: [{ $match: filterMatch }, { $count: "n" }],
      calls: [
        { $match: filterMatch },
        { $sort: { startedAt: -1, _id: -1 } },
        { $skip: (page - 1) * pageSize },
        { $limit: pageSize },
        { $project: {
          startedAt: 1, direction: 1, outcome: 1, answeredAt: 1, activeMs: 1, number: 1,
          recordingStatus: 1, aiStatus: 1, managementReview: 1, coachingReview: 1, flags: 1,
          steps: "$ai.scriptAssessment.steps", summary: "$ai.summary",
          agent: { _id: "$agent._id", name: "$agent.name" },
          lead: { $cond: ["$lead._id", {
            _id: "$lead._id", name: "$lead.name", stage: "$lead.stage", phone: "$lead.phone",
            doNotContact: "$lead.doNotContact", updatedAt: "$lead.updatedAt",
            owner: { _id: "$ownerUser._id", name: "$ownerUser.name" },
          }, null] },
        } },
      ],
    } },
  ]);
  const counts = Object.fromEntries((result?.counts || []).map(row => [row._id, row.n]));
  counts.attention = result?.attention?.[0]?.n || 0;
  counts.all = result?.all?.[0]?.n || 0;
  counts.unreviewed = result?.unreviewed?.[0]?.n || 0;
  counts.reviewed = result?.reviewed?.[0]?.n || 0;
  res.json({
    page, pageSize, filter,
    total: result?.total?.[0]?.n || 0,
    counts,
    calls: result?.calls || [],
  });
}));

router.get("/management/lead-risks", manager, wrap(async (req, res) => {
  const page = Math.min(100000, Math.max(1, Math.trunc(Number(req.query.page)) || 1));
  const pageSize = Number(req.query.pageSize) === 50 ? 50 : 25;
  const now = new Date();
  const [result] = await Lead.aggregate([
    { $match: { doNotContact: { $ne: true }, stage: { $nin: ["Won", "Lost"] } } },
    { $lookup: { from: "users", localField: "owner", foreignField: "_id", as: "person" } },
    { $set: { owner: { $first: "$person" } } },
    { $lookup: { from: "tasks", localField: "_id", foreignField: "lead", pipeline: [
      { $match: { status: "open", $or: [{ customerFacing: true }, { customerFacing: { $ne: false }, kind: { $in: ["call", "send_details", "send_proposal", "send_demo", "confirm_meeting", "confirmation", "demo_response"] } }] } }, { $limit: 1 },
    ], as: "coverage" } },
    { $lookup: { from: "meetings", localField: "_id", foreignField: "lead", pipeline: [
      { $match: { status: "scheduled", end: { $gte: now } } }, { $limit: 1 },
    ], as: "commitment" } },
    { $set: { reasons: { $concatArrays: [
      { $cond: [{ $ne: [{ $ifNull: ["$owner.active", false] }, true] }, ["No active owner"], []] },
      { $cond: [{ $and: [{ $eq: [{ $size: "$coverage" }, 0] }, { $eq: [{ $size: "$commitment" }, 0] }] }, ["No customer follow-up or upcoming meeting"], []] },
    ] } } },
    { $match: { "reasons.0": { $exists: true } } },
    ...leadStatusStages(req.query.lastStatus),
    { $sort: { updatedAt: -1, _id: -1 } },
    { $facet: { count: [{ $count: "n" }], items: [{ $skip: (page - 1) * pageSize }, { $limit: pageSize },
      { $project: { name: 1, stage: 1, phone: 1, updatedAt: 1, lastStatus: 1, reasons: 1, owner: { _id: "$owner._id", name: "$owner.name" } } }] } },
  ]);
  res.json({ page, pageSize, total: result?.count?.[0]?.n || 0, items: result?.items || [] });
}));

router.post("/management/leads/:id/follow-up", manager, wrap(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) throw fail("Invalid lead");
  const lead = await Lead.findById(req.params.id);
  if (!lead) throw fail("Lead not found", 404);
  if (!lead.owner) throw fail("Assign an owner before creating a follow-up");
  if (lead.doNotContact || ["Won", "Lost"].includes(lead.stage)) throw fail("This lead is closed");
  const dueAt = req.body.dueAt ? new Date(req.body.dueAt) : workSlot(new Date());
  if (!Number.isFinite(+dueAt) || (req.body.dueAt && dueAt <= new Date())) throw fail("Choose a future follow-up time");
  const owner = req.body.owner || lead.owner;
  if (!mongoose.isValidObjectId(owner) || !(await User.exists({ _id: owner, active: true }))) throw fail("Choose an active owner");
  const requestId = req.body.requestId;
  if (requestId != null && !/^[\w-]{1,128}$/.test(requestId)) throw fail("Invalid follow-up request");
  const key = `manager-follow:${lead.id}:${requestId || day(new Date())}`;
  const session = await mongoose.startSession();
  let row;
  try {
    await session.withTransaction(async () => {
      const live = await Lead.findOneAndUpdate({ _id: lead.id, doNotContact: { $ne: true }, stage: { $nin: ["Won", "Lost"] } },
        { $inc: { workflowRevision: 1 } }, { session, new: true });
      if (!live) throw fail("This lead is closed");
      row = await Task.findOne({ key }).session(session);
      if (row) return;
      [row] = await Task.create([{ key, lead: live.id, owner, title: "Manager follow-up", dueAt, originalDueAt: dueAt,
        kind: "call", customerFacing: true, reason: String(req.body.reason || "").slice(0, 1000) }], { session });
      await Activity.create([{ lead: live.id, actor: req.user.id, type: "follow_up",
        text: row.reason || "Manager opened a follow-up", data: { task: row.id } }], { session });
    });
  } finally { await session.endSession(); }
  res.json({ _id: row.id, title: row.title, dueAt: row.dueAt, owner: row.owner });
}));

export default router;
