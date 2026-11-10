import { completeSalesTask } from "./salesOutcome.js";
import mongoose from "mongoose";
import { Task, Lead, Activity, Demo } from "./models.js";
import { policy } from "./policy.js";
import { activeLead } from "./rules.js";
import { selectedAction } from "./nextActions.js";
import { issue } from "./operations.js";
const fail = (m, status = 422) => Object.assign(Error(m), { status });
export async function changeTask(id, user, b) {
  if (b.complete && b.dueAt) throw fail("Choose reschedule or complete");
  if (b.complete && b.outcome) return completeSalesTask(id, user, b);
  const old = await Task.findById(id);
  if (
    !old ||
    (user.role !== "manager" && String(old.owner) !== String(user.id))
  )
    throw fail("Action not assigned to you", 403);
  if (old.status !== "open") return old;
  if (
    b.complete &&
    (old.kind === "confirm_meeting" ||
      /^(meeting-result|meeting-confirm|meeting-place):/.test(old.key || ""))
  )
    throw fail("Use the dedicated meeting confirmation or result action.");
  if (b.complete && old.demo) {
    const demo = await Demo.findById(old.demo);
    if (demo && demo.status !== "responded")
      throw fail(
        "Update this demo stage from Demo handovers; its task closes automatically"
      );
  }
  if (b.dueAt && b.complete) throw fail("Choose reschedule or complete");
  const p = await policy();
  if (b.dueAt) {
    if (!b.reason?.trim()) throw fail("Reschedule reason required");
    if (!Number.isFinite(+new Date(b.dueAt)) || new Date(b.dueAt) <= new Date())
      throw fail("Choose a future time");
    if (old.fixed && !b.customerReconfirmed)
      throw fail("Confirm the customer agreed to move this promised time");
    if (
      (old.snoozes || 0) + 1 >= p.snoozeLimit &&
      !(user.role === "manager" && b.approveSnooze)
    ) {
      await Task.updateOne(
        { _id: old.id },
        {
          $set: {
            snoozeApprovalRequestedAt: new Date(),
            pendingSnoozeAt: new Date(b.dueAt),
            pendingSnoozeReason: b.reason,
          },
        }
      );
      await issue(
        `snooze:${old.id}`,
        "snooze",
        "Snooze approval required",
        b.reason,
        { lead: old.lead, task: old.id, owner: old.owner, severity: "critical" }
      );
      throw fail(
        "Repeated postponement needs manager approval. The original deadline is still active",
        409
      );
    }
  }
  if (b.complete && !b.note?.trim()) throw fail("Record what happened");
  const action = selectedAction(b);
  if (
    b.nextAt &&
    (!Number.isFinite(+new Date(b.nextAt)) || new Date(b.nextAt) <= new Date())
  )
    throw fail("Choose a future next action time");
  const session = await mongoose.startSession();
  let result;
  try {
    await session.withTransaction(async () => {
      const t = await Task.findById(id).session(session);
      if (t.status !== "open") {
        result = t;
        return;
      }
      if (user.role !== "manager" && String(t.owner) !== String(user.id))
        throw fail("Assignment changed", 409);
      const l = await Lead.findById(t.lead).session(session);
      if (!l) throw fail("Lead missing");
      const dependent = t.followUp && await Task.findById(t.followUp).session(session);
      if (b.dueAt && dependent?.status === "open" && +new Date(b.dueAt) >= +dependent.dueAt)
        throw fail("Move the follow-up after the new sending time first");
      if (b.complete && await Task.exists({
        followUp: t.id, status: { $ne: "done" },
      }).session(session))
        throw fail("Record the send before completing its follow-up", 409);
      if (b.dueAt) {
        if (t.snoozes !== old.snoozes || +t.dueAt !== +old.dueAt)
          throw fail("Action changed; refresh", 409);
        t.originalDueAt ||= t.dueAt;
        t.snoozeHistory.push({
          at: new Date(),
          from: t.dueAt,
          to: new Date(b.dueAt),
          reason: b.reason,
          actor: user.id,
          approved: !!b.approveSnooze,
        });
        t.snoozes++;
        t.snoozeApprovalRequestedAt = undefined;
        t.pendingSnoozeAt = undefined;
        t.pendingSnoozeReason = undefined;
        t.reason = b.reason;
        t.dueAt = new Date(b.dueAt);
      }
      if (b.complete) {
        if (
          !b.nextAt &&
          activeLead(l) &&
          ![
            "internal",
            "meeting_prep",
            "confirmation",
            "onboarding",
            "demo_build",
            "technical",
          ].includes(t.kind)
        )
          throw fail("Choose the next customer action time");
        if (b.nextAt && t.followUp) {
          const changed = await Task.updateOne(
            { _id: t.followUp, status: "open", lead: l.id },
            {
              $set: {
                dueAt: new Date(b.nextAt),
                title: action.title,
                kind: action.kind,
              },
            },
            { session }
          );
          if (!changed.matchedCount)
            throw fail("The follow-up changed; refresh before completing.");
        }
        if (b.nextAt && !t.followUp)
          await Task.updateOne(
            { key: `after:${t.id}` },
            {
              $setOnInsert: {
                lead: l.id,
                owner: l.owner,
                title: action.title,
                kind: action.kind,
                customerFacing: true,
                dueAt: new Date(b.nextAt),
                originalDueAt: new Date(b.nextAt),
                fixed: true,
              },
            },
            { upsert: true, session }
          );
        t.status = "done";
        t.doneAt = new Date();
      }
      await t.save({ session });
      await Activity.create(
        [
          {
            lead: l.id,
            actor: user.id,
            type: b.complete ? "task_completed" : "task_rescheduled",
            text: b.note || b.reason,
            data: {
              task: t.id,
              originalDueAt: t.originalDueAt,
              dueAt: t.dueAt,
              snoozes: t.snoozes,
            },
          },
        ],
        { session }
      );
      result = t;
    });
  } finally {
    await session.endSession();
  }
  return result;
}
