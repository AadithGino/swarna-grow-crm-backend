import mongoose from "mongoose";
import { Lead, Task, Call, Meeting, Activity, User } from "./models.js";
import { requestDemoFromOutcome } from "./demoFlow.js";
import { nextStep } from "./rules.js";
import { meetingInput, ensureCalendarLocks, bookMeeting } from "./meetings.js";
const fail = (message) => Object.assign(Error(message), { status: 422 });
const closed = ["not_interested", "wrong_number", "do_not_contact"];
const supported = [
  "interested",
  "callback",
  "meeting_booked",
  "meeting_pending",
  "partner",
  "busy",
  "no_answer",
  "unreachable",
  "not_now",
  ...closed,
];
const actions = ["meeting", "send_details", "call", "partner", "proposal", "demo"];
const future = (at, label) => {
  const d = new Date(at);
  if (!at || !Number.isFinite(+d) || d <= new Date()) throw fail(label);
  return d;
};
export async function prepareSalesOutcome(body) {
  const b = { ...body, notes: String(body.notes || body.note || "").trim() };
  if (!supported.includes(b.outcome)) throw fail("Choose what happened.");
  if (b.outcome === "interested") {
    if (!actions.includes(b.nextAction))
      throw fail("Choose what the customer agreed to next.");
    if (
      !String(b.actionNote || "").trim() &&
      ["send_details", "call", "partner", "proposal", "demo"].includes(b.nextAction)
    )
      throw fail("Record the purpose or requirements for the next action.");
    if (b.nextAction === "meeting") {
      if (typeof b.timeAgreed !== "boolean")
        throw fail("Has the customer agreed a meeting time?");
      b.outcome = b.timeAgreed ? "meeting_booked" : "meeting_pending";
    } else {
      b.nextAt = future(b.nextAt, "Choose a future next action time.");
      if (["send_details", "proposal"].includes(b.nextAction)) {
        b.sendAt = b.sendNow
          ? new Date()
          : future(b.sendAt, "Choose when to send it.");
        if (+b.nextAt <= +b.sendAt)
          throw fail("Follow-up must be after the sending time.");
        if (!["whatsapp", "email", "other"].includes(b.channel))
          throw fail("Choose how to send it.");
      }
    }
  }
  if (
    b.nextOwner &&
    (!mongoose.isValidObjectId(b.nextOwner) ||
      !(await User.exists({ _id: b.nextOwner, active: true })))
  )
    throw fail("Choose an active person responsible for the next action.");
  if (closed.includes(b.outcome) && !b.notes)
    throw fail("Record the reason before closing this lead.");
  if (["callback", "not_now", "meeting_pending"].includes(b.outcome))
    b.nextAt = future(b.nextAt, "Choose a future callback time.");
  if (b.nextAt) b.nextAt = future(b.nextAt, "Choose a future follow-up time.");
  const booking =
    b.outcome === "meeting_booked" ? await meetingInput(b.meeting) : null;
  if (booking) await ensureCalendarLocks(booking);
  return { b, booking };
}
// Call results and task results use this same transaction-scoped workflow.
export async function applySalesOutcome({
  lead,
  source,
  actor,
  session,
  prepared,
  sourceCall,
  sourceTask,
}) {
  const { b, booking } = prepared;
  const now = new Date();
  await Lead.updateOne(
    { _id: lead.id },
    { $inc: { workflowRevision: 1 } },
    { session }
  );
  if (closed.includes(b.outcome)) {
    lead.stage = "Lost";
    lead.closeReason = b.outcome;
    lead.doNotContact = b.outcome === "do_not_contact";
    lead.pauseUntil = undefined;
    await Task.updateMany(
      { lead: lead.id, status: "open" },
      { $set: { status: "cancelled" } },
      { session }
    );
    await Meeting.updateMany(
      { lead: lead.id, status: "scheduled" },
      { $set: { status: "cancelled" } },
      { session }
    );
  } else {
    if (lead.doNotContact || ["Won", "Lost"].includes(lead.stage))
      throw fail("Reopen the lead before scheduling sales work.");
    if (booking) {
      const m = await bookMeeting(lead, booking, session, sourceCall?._id);
      lead.stage = "Demo/Meeting";
      lead.pauseUntil = booking.start;
      if (sourceCall) {
        sourceCall.meeting = m._id;
        await Task.updateOne(
          { key: source, kind: "confirm_meeting", status: "open" },
          { $set: { status: "cancelled" } }, { session }
        );
      }
      if (sourceTask) sourceTask.meeting = m._id;

    } else {
      const add = async (key, title, kind, dueAt, fixed = false) => {
        const fields = {
          lead: lead.id,
          owner: b.nextOwner || lead.owner,
          title,
          kind,
          dueAt,
          originalDueAt: dueAt,
          fixed,
          reason: [b.actionNote, b.channel && `Channel: ${b.channel}`, b.notes]
            .filter(Boolean)
            .join("\n"),
          customerFacing: kind !== "internal",
          status: "open",
        };
        return Task.findOneAndUpdate(
          { key },
          sourceCall
            ? { $set: fields }
            : { $setOnInsert: fields },
          { upsert: true, new: true, session }
        );
      };
      if (b.outcome === "interested") {
        lead.stage =
          b.nextAction === "proposal" || b.nextAction === "partner"
            ? "Decision"
            : "Qualified";
        lead.pauseUntil = undefined;
        if (b.nextAction === "demo") {
          await requestDemoFromOutcome(lead, b, session, now);
        } else if (["send_details", "proposal"].includes(b.nextAction)) {
          const follow = await add(
            `${source}:follow`,
            b.nextAction === "proposal"
              ? "Follow up on proposal"
              : "Follow up after sending details",
            "call",
            b.nextAt,
            true
          );
          const send = await add(
            source,
            b.nextAction === "proposal"
              ? "Prepare and send proposal"
              : "Send requested details",
            b.nextAction === "proposal" ? "send_proposal" : "send_details",
            b.sendAt,
            false
          );
          send.followUp = follow._id;
          await send.save({ session });
        } else
          await add(
            source,
            b.nextAction === "partner"
              ? "Check partner decision"
              : "Customer-requested callback",
            "call",
            b.nextAt,
            true
          );
      } else {
        const attempts = await Call.countDocuments({
          lead: lead.id,
          outcome: { $in: ["no_answer", "unreachable"] },
          startedAt: { $gt: new Date(+now - 7 * 86400000) },
        }).session(session);
        const next = nextStep(b.outcome, {
          at: b.nextAt,
          now,
          attempts: attempts + 1,
        });
        if (next)
          await add(
            source,
            next.title,
            next.kind || "call",
            b.nextAt || next.dueAt,
            !!next.fixed || !!b.nextAt
          );
        if (["callback", "not_now", "meeting_pending"].includes(b.outcome))
          lead.pauseUntil = b.nextAt;
        if (b.outcome === "meeting_pending") lead.stage = "Qualified";
        if (b.outcome === "not_now") lead.stage = "Nurture";
      }
    }

  }
  if (sourceCall?.answeredAt) lead.lastContactAt = sourceCall.answeredAt;
  await lead.save({ session });
  await Activity.create(
    [
      {
        lead: lead.id,
        actor: actor.id,
        type: sourceCall
          ? "call_outcome"
          : sourceTask
          ? "task_completed"
          : "meeting_outcome",
        text: b.notes || b.actionNote || b.outcome,
        data: {
          call: sourceCall?.id,
          task: sourceTask?.id,
          outcome: b.outcome,
          nextAction: b.nextAction,
          nextAt: b.nextAt,
          channel: b.channel,
          sendAt: b.sendAt,
          actionNote: b.actionNote,
        },
      },
    ],
    { session }
  );
}
export async function completeSalesTask(id, user, body) {
  const old = await Task.findById(id);
  if (
    !old ||
    (user.role !== "manager" && String(old.owner) !== String(user.id))
  )
    throw Object.assign(Error("Action not assigned to you"), { status: 403 });
  if (old.status !== "open") return old;
  if (
    old.demo ||
    /^(meeting-result|meeting-confirm|meeting-prep|meeting-place):/.test(
      old.key || ""
    )
  )
    throw fail("Update this meeting or demo from its dedicated action.");
  const prepared = await prepareSalesOutcome(body);
  if (
    old.kind === "confirm_meeting" &&
    prepared.b.outcome === "meeting_pending" &&
    !prepared.b.notes
  )
    throw fail("Record why the meeting time is still pending.");
  const session = await mongoose.startSession();
  let result;
  try {
    await session.withTransaction(async () => {
      const t = await Task.findById(id).session(session);
      if (user.role !== "manager" && String(t.owner) !== String(user.id))
        throw Object.assign(Error("Assignment changed; refresh"), {
          status: 409,
        });
      if (t.status !== "open") {
        result = t;
        return;
      }
      if (await Task.exists({ followUp: t.id, status: { $ne: "done" } }).session(session))
        throw fail("Record the send before completing its follow-up.");
      const lead = await Lead.findById(t.lead).session(session);
      if (!lead) throw fail("Lead missing.");
      await applySalesOutcome({
        lead,
        source: `after:${t.id}`,
        actor: user,
        session,
        prepared,
        sourceTask: t,
      });
      t.status = "done";
      t.doneAt = new Date();
      await t.save({ session });
      result = t;
    });
  } finally {
    await session.endSession();
  }
  return result;
}

export async function completeMeetingOutcome(id, user, body) {
  const existing = await Meeting.findById(id);
  if (existing?.resultSaved) return existing;
  const prepared = await prepareSalesOutcome(body.salesOutcome);
  if (
    !["completed", "no_show", "cancelled", "rep_unavailable"].includes(
      body.status
    )
  )
    throw fail("Choose the meeting result.");
  if (!prepared.b.notes) throw fail("Record the meeting result or reason.");
  const session = await mongoose.startSession();
  let result;
  try {
    await session.withTransaction(async () => {
      const m = await Meeting.findById(id).session(session);
      if (!m) throw fail("Meeting not found.");
      if (m.resultSaved) {
        result = m;
        return;
      }
      if (m.status !== "scheduled") throw fail("This meeting is no longer scheduled.");
      if (["completed", "no_show"].includes(body.status) && m.end > new Date())
        throw fail("Log attendance after the meeting ends.");
      const lead = await Lead.findById(m.lead).session(session);
      if (!lead) throw fail("Lead missing.");
      m.status = body.status;
      m.outcome = prepared.b.notes;
      m.resultSaved = true;
      await m.save({ session });
      await Task.updateMany(
        {
          key: {
            $in: [
              "meeting-confirm:",
              "meeting-prep:",
              "meeting-place:",
              "meeting-result:",
            ].map((prefix) => prefix + m.id),
          },
          status: "open",
        },
        { $set: { status: "cancelled" } },
        { session }
      );
      await applySalesOutcome({
        lead,
        source: `meeting-next:${m.id}`,
        actor: user,
        session,
        prepared,
      });
      result = m;
    });
  } finally {
    await session.endSession();
  }
  return result;
}
