import { Task, Lead, Activity, Meeting, Demo, Call } from "./models.js";
import { workSlot, activeLead } from "./rules.js";
export async function task(lead, title, dueAt, key, extra = {}) {
  return Task.findOneAndUpdate(
    { key },
    {
      $setOnInsert: {
        lead: lead._id,
        owner: lead.owner,
        title,
        dueAt: new Date(dueAt),
        originalDueAt: new Date(dueAt),
        key,
        ...extra,
      },
    },
    { upsert: true, new: true }
  );
}
export async function log(lead, actor, type, text, data = {}) {
  return Activity.create({ lead: lead._id || lead, actor, type, text, data });
}
export async function sweep() {
  const now = new Date();
  await Lead.updateMany(
    {
      stage: "Nurture",
      pauseUntil: { $lte: now },
      doNotContact: { $ne: true },
    },
    { $set: { stage: "Qualified" } }
  );
  const today = new Date(+now + 330 * 60000).toISOString().slice(0, 10);
  const weekday = new Date(+now + 330 * 60000).getUTCDay();
  for (const l of await Lead.find({
    stage: { $nin: ["Won", "Lost", "Nurture"] },
    doNotContact: { $ne: true },
  })) {
    if (l.retryReviewAt) continue;
    const legacyReview = await Task.findOne({ lead: l.id, status: "open", kind: "internal", title: "Review unanswered lead" })
      .select("createdAt");
    if (legacyReview) {
      await Lead.updateOne({ _id: l.id, retryReviewAt: null }, { $set: { retryReviewAt: legacyReview.createdAt || now } });
      continue;
    }
    if (
      l.ultra &&
      weekday !== 0 &&
      !(await Call.exists({
        lead: l.id,
        outcomeSaved: true,
        endedAt: { $gte: new Date(today + "T00:00:00+05:30") },
      }))
    ) {
      const paused = l.pauseUntil && l.pauseUntil > now;
      const existing = await Task.findOne({
        lead: l._id,
        status: "open",
        dueAt: {
          $gte: new Date(today + "T00:00:00+05:30"),
          $lt: new Date(+new Date(today + "T00:00:00+05:30") + 86400000),
        },
      });
      if (!existing)
        await task(
          l,
          paused ? "Prepare for agreed callback" : "Daily priority follow-up",
          workSlot(now),
          `ultra:${l.id}:${today}`,
          { kind: paused ? "internal" : "call" }
        );
    }
    if (!(await Task.exists({
      lead: l._id, status: "open", customerFacing: { $ne: false },
      kind: { $in: ["call", "confirmation", "confirm_meeting", "send_details", "send_proposal", "send_demo", "demo_response"] },
    }))) {
      const upcoming = await Meeting.exists({
        lead: l._id,
        status: "scheduled",
        end: { $gte: now },
      });
      if (!upcoming) {
        const base = `safety:${l.id}:${today}`;
        const settled = await Task.countDocuments({
          lead: l.id, key: { $regex: `^${base}(?::[0-9]+)?$` },
          status: { $ne: "open" },
        });
        await task(
          l,
          "Agree next action",
          workSlot(l.pauseUntil > now ? l.pauseUntil : now),
          settled ? `${base}:${settled}` : base,
          { kind: "call", reason: "Active lead has no next action" }
        );
      }
    }
  }
  for (const m of await Meeting.find({ status: "scheduled" }).populate(
    "lead"
  )) {
    if (!m.lead || !activeLead(m.lead)) continue;
    let l = m.lead;
    if (m.end < now)
      await task(
        l,
        "Schedule next step after meeting",
        m.end,
        `meeting-result:${m.id}`,
        {
          owner: m.reps[0] || l.owner,
          kind: "meeting_result",
        }
      );
    else {
      if (!m.confirmed)
        await task(
          l,
          "Confirm meeting with customer",
          workSlot(+m.start - 86400000),
          `meeting-confirm:${m.id}`,
          { kind: "confirmation" }
        );
      await task(
        l,
        "Prepare for meeting",
        new Date(+m.start - (m.travelMinutes + 30) * 60000),
        `meeting-prep:${m.id}`,
        { owner: m.reps[0] || l.owner, kind: "meeting_prep", fixed: true }
      );
    }
  }
  for (const d of await Demo.find({
    status: { $in: ["ready", "sent", "explored"] },
  }).populate("lead")) {
    if (!d.lead || !activeLead(d.lead)) continue;
    if (d.status === "ready" && !d.stageDueAt)
      await task(d.lead, "Send ready demo", now, `demo-send:${d.id}`, {
        kind: "send_demo",
      });
    if (d.expiresAt && +d.expiresAt - 86400000 < +now)
      await task(d.lead, "Renew expiring demo", now, `demo-renew:${d.id}`, {
        kind: "internal",
      });
  }
}
