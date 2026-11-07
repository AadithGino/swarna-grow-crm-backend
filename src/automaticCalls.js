import mongoose from "mongoose";
import { Call, Lead, Task, Activity } from "./models.js";
import { callFacts } from "./callFacts.js";
import { nextStep, activeLead } from "./rules.js";
export async function applyAutomaticOutcome(id) {
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const c = await Call.findById(id).session(session);
      if (!c || !c.lead) return;
      const facts = callFacts(c);
      // A later, more complete journal can supply ACTIVE after a provisional no-answer sync.
      if (c.outcomeSaved && c.outcomeSource === "events" && facts.connected) {
        await Task.updateOne(
          { key: `outcome:${c.id}`, status: "open" },
          { $set: { status: "cancelled" } },
          { session }
        );
        c.outcomeSaved = false;
        c.outcome = undefined;
        c.outcomeSource = undefined;
        c.autoNextAt = undefined;
        await c.save({ session });
        return;
      }
      if (c.outcomeSaved) return;
      if (!facts.autoOutcome) return;
      const lead = await Lead.findById(c.lead).session(session);
      if (!lead || !activeLead(lead)) return;
      // Serialize outcomes for one lead. Concurrent sync retries cannot duplicate a task.
      await Lead.updateOne(
        { _id: lead.id },
        { $inc: { workflowRevision: 1 } },
        { session }
      );
      const now = new Date();
      const attempts = await Call.countDocuments({
        lead: lead.id,
        outcome: { $in: ["no_answer", "unreachable"] },
        startedAt: { $gt: new Date(+now - 7 * 86400000) },
      }).session(session);
      const next = nextStep("no_answer", { now, attempts: attempts + 1 });
      // Keep an existing customer promise, priority follow-up or booked appointment.
      const protectedTask = await Task.findOne({
        lead: lead.id,
        status: "open",
        fixed: true,
      })
        .sort({ dueAt: 1 })
        .session(session);
      const meeting = await mongoose.models.Meeting.findOne({
        lead: lead.id,
        status: "scheduled",
        end: { $gt: now },
      }).session(session);
      if (protectedTask) c.autoNextAt = protectedTask.dueAt;
      else if (!meeting) {
        const existing = await Task.findOne({
          lead: lead.id,
          status: "open",
          kind: "call",
          dueAt: { $gt: now },
        })
          .sort({ dueAt: 1 })
          .session(session);
        if (existing) c.autoNextAt = existing.dueAt;
        else {
          await Task.updateOne(
            { key: `outcome:${c.id}` },
            {
              $setOnInsert: {
                lead: lead.id,
                owner: lead.owner,
                title: next.title,
                kind: next.kind || "call",
                dueAt: next.dueAt,
                originalDueAt: next.dueAt,
                fixed: false,
              },
            },
            { upsert: true, session }
          );
          c.autoNextAt = next.dueAt;
        }
      }
      await Task.updateMany(
        {
          lead: lead.id,
          status: "open",
          kind: "call",
          fixed: { $ne: true },
          dueAt: { $lte: now },
        },
        { $set: { status: "done", doneAt: now } },
        { session }
      );
      c.outcome = "no_answer";
      c.outcomeSaved = true;
      c.outcomeSource = "events";
      await c.save({ session });
      await Activity.create(
        [
          {
            lead: lead.id,
            actor: c.agent,
            type: "call_outcome",
            text: "Automatically logged from call events",
            data: {
              call: c.id,
              outcome: c.outcome,
              technicalResult: facts.technicalResult,
            },
          },
        ],
        { session }
      );
    });
  } finally {
    await session.endSession();
  }
  return Call.findById(id);
}
