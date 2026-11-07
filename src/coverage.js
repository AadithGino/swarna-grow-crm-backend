import mongoose from "mongoose";
import {
  Lead,
  Task,
  User,
  Meeting,
  Handover,
  Activity,
  Setting,
  Exception,
  Demo,
} from "./models.js";
import { policy, addWorkMinutes, unavailable } from "./policy.js";
import { notify, notifyManagers } from "./notifications.js";
import { ensureCalendarLocks } from "./meetings.js";
const fail = (m, status = 422) => Object.assign(Error(m), { status });
export async function initializeLead(l, now = new Date()) {
  const p = await policy();
  if (!l.firstContactDueAt) {
    await Lead.updateOne(
      { _id: l.id, firstContactDueAt: null },
      {
        $set: {
          firstContactDueAt: addWorkMinutes(
            l.createdAt || now,
            p.firstContactMinutes
          ),
        },
      }
    );
    l = await Lead.findById(l.id);
  }
  return l;
}
export async function requestHandover({
  lead,
  from,
  to,
  actor,
  reason,
  now = new Date(),
}) {
  if (!reason?.trim()) throw fail("Explain the handover");
  const target = await User.findById(to);
  if (
    unavailable(target, now) ||
    !["agent", "rep", "manager", "operator"].includes(target.role)
  )
    throw fail("Choose an available backup");
  if (String(from) === String(to))
    throw fail("Backup must be a different employee");
  const l = await Lead.findById(lead);
  if (!l) throw fail("Lead not found", 404);
  from = from || l.owner;
  const existing = await Handover.findOne({ lead, from, status: "pending" });
  if (existing) throw fail("A handover is already waiting for acceptance", 409);
  const load = await reservedLoad(to, now);
  if (load >= target.capacity) throw fail("Backup is at capacity");
  const p = await policy();
  const h = await Handover.create({
    key: `handover:${lead}:${from}:${Date.now()}`,
    lead,
    from,
    to,
    requestedBy: actor,
    reason,
    status: "pending",
    expiresAt: new Date(+now + p.handoverMinutes * 60000),
  });
  await notify(to, `handover:${h.id}`, "Accept a backup handover", reason, {
    lead,
    category: "handover",
    severity: "warning",
  });
  return h;
}
export async function answerHandover(id, user, body) {
  if (!["accept", "reject"].includes(body.action))
    throw fail("Choose accept or reject");
  const before = await Handover.findById(id);
  if (!before || String(before.to) !== String(user))
    throw fail("Handover not found", 404);
  if (before.status !== "pending") return before;
  if (body.action === "reject") {
    if (!body.reason?.trim()) throw fail("Give a rejection reason");
    const h = await Handover.findOneAndUpdate(
      { _id: id, status: "pending" },
      {
        $set: {
          status: "rejected",
          rejectedAt: new Date(),
          rejectionReason: body.reason,
        },
      },
      { new: true }
    );
    await notifyManagers(
      `handover-rejected:${id}`,
      "Backup declined a handover",
      body.reason,
      { lead: before.lead, category: "handover", severity: "critical" }
    );
    return h || before;
  }
  const target = await User.findById(user);
  if (unavailable(target))
    throw fail("Set yourself available before accepting");
  const meetings = await Meeting.find({
    lead: before.lead,
    reps: before.from,
    status: "scheduled",
    end: { $gt: new Date() },
  });
  if (meetings.length && !body.includeMeetings)
    throw fail(
      "This handover includes scheduled meetings. Confirm that you will attend them."
    );
  await ensureCalendarLocks({ reps: [String(user), String(before.from)] });
  const session = await mongoose.startSession();
  let result;
  try {
    await session.withTransaction(async () => {
      const h = await Handover.findById(id).session(session);
      if (h.status !== "pending") {
        result = h;
        return;
      }
      if (h.expiresAt <= new Date())
        throw fail("Handover expired. Ask the manager to assign it again", 409);
      const l = await Lead.findById(h.lead).session(session);
      if (!l) throw fail("Lead missing", 404);
      const currentTarget = await User.findById(user).session(session);
      if (unavailable(currentTarget))
        throw fail("Backup is no longer available");
      const load = await Task.countDocuments({
        owner: user,
        status: "open",
        dueAt: { $lt: new Date(Date.now() + 86400000) },
      }).session(session);
      if (load >= currentTarget.capacity)
        throw fail("Backup is now at capacity", 409);
      const tasks = await Task.find({
        lead: l.id,
        owner: h.from,
        status: "open",
      }).session(session);
      const incomingDue = tasks.filter(
        (t) => t.dueAt < new Date(Date.now() + 86400000)
      ).length;
      if (load + incomingDue > currentTarget.capacity)
        throw fail("This handover would exceed the backup capacity", 409);
      if (String(l.owner) !== String(h.from) && !tasks.length)
        throw fail("Assignment changed. Ask the manager to review", 409);
      await Setting.updateOne(
        { key: `calendar:${user}` },
        { $inc: { "value.version": 1 } },
        { session }
      );
      await Setting.updateOne(
        { key: `calendar:${h.from}` },
        { $inc: { "value.version": 1 } },
        { session }
      );
      for (const m of await Meeting.find({
        lead: l.id,
        reps: h.from,
        status: "scheduled",
        end: { $gt: new Date() },
      }).session(session)) {
        if (!body.includeMeetings) throw fail("Confirm meeting attendance");
        const start = new Date(+m.start - (m.travelMinutes || 0) * 60000),
          end = new Date(+m.end + (m.travelMinutes || 0) * 60000);
        const conflict = await Meeting.findOne({
          _id: { $ne: m.id },
          status: "scheduled",
          reps: user,
          start: { $lt: end },
          $expr: {
            $gt: [
              {
                $add: [
                  "$end",
                  { $multiply: [{ $ifNull: ["$travelMinutes", 0] }, 60000] },
                ],
              },
              start,
            ],
          },
        }).session(session);
        if (conflict)
          throw fail(
            "Backup has a meeting/travel conflict. Reschedule or select another person",
            409
          );
        m.reps = [
          ...new Set(
            m.reps.map((x) =>
              String(x) === String(h.from) ? String(user) : String(x)
            )
          ),
        ];
        await m.save({ session });
      }
      if (String(l.owner) === String(h.from)) {
        l.owner = user;
        l.workflowRevision++;
        await l.save({ session });
      }
      await Task.updateMany(
        { lead: l.id, owner: h.from, status: "open" },
        { $set: { owner: user } },
        { session }
      );
      await Demo.updateMany(
        {
          lead: l.id,
          owner: h.from,
          status: { $nin: ["responded", "cancelled"] },
        },
        { $set: { owner: user } },
        { session }
      );
      h.status = "accepted";
      h.acceptedAt = new Date();
      await h.save({ session });
      await Activity.create(
        [
          {
            lead: l.id,
            actor: user,
            type: "handover_accepted",
            text: h.reason,
            data: { from: h.from, to: user, handover: h.id },
          },
        ],
        { session }
      );
      result = h;
    });
  } finally {
    await session.endSession();
  }
  await Exception.updateMany(
    { lead: before.lead, type: "handover", status: "open" },
    { $set: { status: "resolved", resolvedAt: new Date() } }
  );
  await notifyManagers(
    `handover-accepted:${id}`,
    "Backup accepted the commitments",
    before.reason,
    { lead: before.lead, category: "handover" }
  );
  return result;
}
export async function suggestBackup(owner, now = new Date()) {
  const users = await User.find({
    active: true,
    role: { $in: ["agent", "rep", "manager"] },
    _id: { $ne: owner?._id },
  });
  const available = [];
  for (const u of users) {
    if (unavailable(u, now)) continue;
    const load = await Task.countDocuments({
      owner: u.id,
      status: "open",
      dueAt: { $lt: new Date(+now + 86400000) },
    });
    if (load < u.capacity) available.push({ user: u, load });
  }
  available.sort(
    (a, b) =>
      (String(a.user.id) === String(owner?.backup) ? -1 : 0) -
        (String(b.user.id) === String(owner?.backup) ? -1 : 0) ||
      a.load - b.load
  );
  return available[0]?.user;
}
// Pending handovers reserve capacity without changing the original assignment.
export async function reservedLoad(user, now = new Date()) {
  let total = await Task.countDocuments({
    owner: user,
    status: "open",
    dueAt: { $lt: new Date(+now + 86400000) },
  });
  for (const h of await Handover.find({ to: user, status: "pending" }))
    total += Math.max(
      1,
      await Task.countDocuments({
        lead: h.lead,
        owner: h.from,
        status: "open",
        dueAt: { $lt: new Date(+now + 86400000) },
      })
    );
  return total;
}
export async function queueCoverage(lead, from, reason, now = new Date()) {
  if (
    await Task.exists({
      lead,
      owner: from,
      status: "open",
      kind: { $in: ["technical", "demo_build"] },
    })
  )
    return; // Manager selects a capable technical backup explicitly.
  if (await Handover.exists({ lead, from, status: "pending" })) return;
  const owner = await User.findById(from),
    past = await Handover.find({
      lead,
      from,
      status: { $in: ["expired", "rejected"] },
      createdAt: { $gte: new Date(+now - 86400000) },
    }).distinct("to");
  const rejected = new Set(past.map(String));
  const users = await User.find({
    active: true,
    role: { $in: ["agent", "rep", "manager"] },
    _id: { $ne: from },
  });
  const candidates = [];
  for (const u of users) {
    if (unavailable(u, now) || rejected.has(u.id)) continue;
    const load = await reservedLoad(u.id, now),
      incoming = Math.max(
        1,
        await Task.countDocuments({
          lead,
          owner: from,
          status: "open",
          dueAt: { $lt: new Date(+now + 86400000) },
        })
      );
    if (load + incoming <= u.capacity) candidates.push({ u, load });
  }
  candidates.sort(
    (a, b) =>
      (String(a.u.id) === String(owner?.backup) ? -1 : 0) -
        (String(b.u.id) === String(owner?.backup) ? -1 : 0) || a.load - b.load
  );
  if (candidates[0])
    return requestHandover({ lead, from, to: candidates[0].u.id, reason, now });
}
