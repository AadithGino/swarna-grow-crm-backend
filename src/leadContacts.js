import { phone } from "./rules.js";

export const contactFields = ["phone", "alternatePhone", "whatsappPhone"];
export const byContactNumber = number => ({ $or: contactFields.map(field => ({ [field]: number })) });
export function extraContacts(body) {
  return Object.fromEntries(contactFields.slice(1).filter(field => body[field] !== undefined)
    .map(field => [field, String(body[field] ?? "").trim() ? phone(body[field]) : null]));
}

function latest(from, match, date, project, as) {
  return { $lookup: { from, localField: "_id", foreignField: "lead", pipeline: [
    { $match: match }, { $sort: { [date]: -1, _id: -1 } }, { $limit: 1 }, { $project: project },
  ], as } };
}

export function leadStatusStages(status) {
  return [
    latest("calls", { $or: [{ endedAt: { $type: "date" } }, { outcomeSaved: true }] }, "startedAt", {
      at: { $ifNull: ["$endedAt", "$startedAt"] }, status: { $ifNull: ["$outcome", { $ifNull: ["$technicalResult", "unknown"] }] },
    }, "lastCall"),
    latest("meetings", { status: { $in: ["completed", "no_show"] } }, "updatedAt", {
      at: "$updatedAt", status: { $cond: [{ $eq: ["$status", "completed"] }, "meeting_attended", "meeting_no_show"] },
    }, "lastMeeting"),
    latest("demos", { sentAt: { $type: "date" } }, "sentAt", { at: "$sentAt", status: { $literal: "demo_sent" } }, "lastDemo"),
    { $set: { latestInteraction: { $reduce: {
      input: { $concatArrays: ["$lastCall", "$lastMeeting", "$lastDemo"] }, initialValue: null,
      in: { $cond: [{ $gt: ["$$this.at", "$$value.at"] }, "$$this", "$$value"] },
    } } } },
    { $set: { lastStatus: { $switch: { branches: [
      { case: { $in: ["$latestInteraction.status", ["no_answer", "not_answered", "missed_incoming"]] }, then: "not_picked" },
      { case: { $in: ["$latestInteraction.status", ["callback", "not_now"]] }, then: "callback" },
      { case: { $in: ["$latestInteraction.status", ["busy", "line_busy"]] }, then: "busy" },
    ], default: { $ifNull: ["$latestInteraction.status", "no_activity"] } } } } },
    { $unset: ["lastCall", "lastMeeting", "lastDemo", "latestInteraction"] },
    ...(status ? [{ $match: { lastStatus: String(status) } }] : []),
  ];
}
