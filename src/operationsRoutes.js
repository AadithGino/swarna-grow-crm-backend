import { notify } from "./notifications.js";
import mongoose from "mongoose";
import express from "express";
import {
  User,
  Notification,
  Device,
  Exception,
  Handover,
  Lead,
  Task,
  Setting,
  Import,
} from "./models.js";
import { policy, defaults, addWorkMinutes } from "./policy.js";
import { requestHandover, answerHandover, suggestBackup } from "./coverage.js";
import { healthSnapshot } from "./health.js";
const router = express.Router(),
  wrap = (fn) => (q, s, next) => Promise.resolve(fn(q, s, next)).catch(next);
const fail = (m, status = 422) => Object.assign(Error(m), { status });
const manager = (q, s, next) =>
  q.user.role === "manager"
    ? next()
    : next(fail("Manager access required", 403));
router.post(
  "/notifications/test",
  wrap(async (q, s) =>
    s
      .status(201)
      .json(
        await notify(
          q.user.id,
          "test:" + Date.now(),
          "Test CRM reminder",
          "Open the inbox and acknowledge this test to verify the complete delivery chain",
          { category: "test" }
        )
      )
  )
);
router.get(
  "/notifications",
  wrap(async (q, s) => {
    const query = {
      user: q.user.id,
      ...(q.query.all === "true"
        ? {}
        : { resolvedAt: null, acknowledgedAt: null }),
    };
    if (q.query.before) {
      if (!/^[a-f0-9]{24}$/i.test(q.query.before)) throw fail("Invalid cursor");
      query._id = { $lt: q.query.before };
    }
    const limit = 50,
      rows = await Notification.find(query)
        .populate("lead", "name")
        .sort({ _id: -1 })
        .limit(limit + 1);
    s.json({
      items: rows.slice(0, limit),
      nextCursor: rows.length > limit ? rows[limit - 1].id : null,
    });
  })
);
router.get(
  "/notifications/pending",
  wrap(async (q, s) =>
    s.json(
      await Notification.find({
        user: q.user.id,
        resolvedAt: null,
        acknowledgedAt: null,
        receivedAt: null,
      })
        .sort({ createdAt: 1 })
        .limit(100)
    )
  )
);
router.post(
  "/notifications/:id/receipt",
  wrap(async (q, s) => {
    const n = await Notification.findOne({ _id: q.params.id, user: q.user.id });
    if (!n) throw fail("Notification not found", 404);
    const d = await Device.findOne({
      deviceId: q.body.deviceId,
      user: q.user.id,
    });
    if (!d) throw fail("Register this device before receipt");
    const at = new Date();
    n.receivedAt ||= at;
    if (q.body.presented) n.presentedAt ||= at;
    if (!n.receipts.some((r) => r.deviceId === d.deviceId))
      n.receipts.push({
        deviceId: d.deviceId,
        at,
        presented: !!q.body.presented,
      });
    await n.save();
    s.json(n);
  })
);
router.post(
  "/notifications/:id/acknowledge",
  wrap(async (q, s) => {
    const n = await Notification.findOneAndUpdate(
      { _id: q.params.id, user: q.user.id },
      { $set: { acknowledgedAt: new Date() } },
      { new: true }
    );
    if (!n) throw fail("Notification not found", 404);
    s.json(n);
  })
);
router.post(
  "/devices",
  wrap(async (q, s) => {
    if (!q.body.deviceId || String(q.body.deviceId).length > 200)
      throw fail("Device identity required");
    const values = {
      user: q.user.id,
      lastSeenAt: new Date(),
      enabled: !!q.body.enabled,
      ...(q.body.token ? { token: String(q.body.token) } : {}),
    };
    // One physical device belongs to the current login. Never deliver old-account reminders after switching.
    const d = await Device.findOneAndUpdate(
      { deviceId: q.body.deviceId },
      { $set: values },
      { upsert: true, new: true }
    );
    s.json({ id: d.id, registered: true });
  })
);
router.post(
  "/devices/unregister",
  wrap(async (q, s) => {
    await Device.updateOne(
      { deviceId: q.body.deviceId, user: q.user.id },
      { $set: { enabled: false, disabledAt: new Date() }, $unset: { token: 1 } }
    );
    s.json({ ok: true });
  })
);
router.get(
  "/availability",
  wrap(async (q, s) =>
    s.json(
      await User.findById(q.user.id).select(
        "name availability awayUntil capacity backup"
      )
    )
  )
);
router.patch(
  "/availability/:id",
  wrap(async (q, s) => {
    if (q.user.role !== "manager" && q.params.id !== q.user.id)
      throw fail("Not your availability", 403);
    const u = await User.findById(q.params.id);
    if (!u) throw fail("Employee not found", 404);
    if (
      q.body.availability &&
      !["available", "away"].includes(q.body.availability)
    )
      throw fail("Choose available or away");
    if (
      q.body.awayUntil &&
      (!Number.isFinite(+new Date(q.body.awayUntil)) ||
        new Date(q.body.awayUntil) <= new Date())
    )
      throw fail("Choose a future return time");
    if (q.body.backup) {
      const b = await User.findOne({ _id: q.body.backup, active: true });
      if (!b || b.id === u.id)
        throw fail("Choose another active employee as backup");
      u.backup = b.id;
    }
    if (q.body.capacity !== undefined) {
      if (q.user.role !== "manager") throw fail("Manager sets capacity", 403);
      const n = Number(q.body.capacity);
      if (!Number.isInteger(n) || n < 1 || n > 500)
        throw fail("Capacity must be 1–500");
      u.capacity = n;
    }
    if (q.body.availability) u.availability = q.body.availability;
    u.awayUntil =
      q.body.availability === "available"
        ? undefined
        : q.body.awayUntil
        ? new Date(q.body.awayUntil)
        : undefined;
    await u.save();
    s.json(u);
  })
);
router.get(
  "/handovers",
  wrap(async (q, s) =>
    s.json(
      await Handover.find(
        q.user.role === "manager"
          ? {}
          : { $or: [{ to: q.user.id }, { from: q.user.id }] }
      )
        .populate("lead", "name")
        .populate("from to", "name")
        .sort({ createdAt: -1 })
        .limit(100)
    )
  )
);
router.post(
  "/handovers",
  manager,
  wrap(async (q, s) =>
    s.status(201).json(await requestHandover({ ...q.body, actor: q.user.id }))
  )
);
router.post(
  "/handovers/:id/respond",
  wrap(async (q, s) =>
    s.json(await answerHandover(q.params.id, q.user.id, q.body))
  )
);
router.get(
  "/operations",
  manager,
  wrap(async (q, s) => {
    const query = { status: "open" };
    if (q.query.filter === "critical") query.severity = "critical";
    else if (q.query.filter && q.query.filter !== "all")
      query.type = q.query.filter;
    if (q.query.before) {
      if (!/^[a-f0-9]{24}$/i.test(q.query.before)) throw fail("Invalid cursor");
      query._id = { $lt: q.query.before };
    }
    const rows = await Exception.find(query)
      .populate("lead", "name")
      .populate("owner", "name")
      .populate("task")
      .populate("sourceImport", "status externalId error")
      .sort({ _id: -1 })
      .limit(51);
    const users = await User.find().select(
      "name role active availability awayUntil capacity backup"
    );
    const staff = [];
    for (const u of users) {
      const open = await Task.countDocuments({
        owner: u.id,
        status: "open",
        dueAt: { $lt: new Date(Date.now() + 86400000) },
      });
      const backup = await suggestBackup(u);
      staff.push({
        ...u.toObject(),
        load: open,
        suggestedBackup: backup ? { _id: backup.id, name: backup.name } : null,
      });
    }
    s.json({
      items: rows.slice(0, 50),
      nextCursor: rows.length > 50 ? rows[49].id : null,
      total: await Exception.countDocuments({ status: "open" }),
      staff,
      health: await healthSnapshot(),
      policy: await policy(),
      capture: (await Setting.findOne({ key: "metaCheck" }))?.value || null,
      failedImports: await Import.find({
        $or: [{ status: { $in: ["failed", "needs_review"] } }, { status: "reviewed", reviewDecision: null }],
      })
        .sort({ updatedAt: -1 })
        .limit(10),
      pendingImports: await Import.countDocuments({
        $or: [{ status: { $in: ["pending", "failed", "needs_review"] } }, { status: "reviewed", reviewDecision: null }],
      }),
    });
  })
);
router.patch(
  "/operations/policy",
  manager,
  wrap(async (q, s) => {
    const values = {};
    for (const [key, value] of Object.entries(q.body)) {
      if (!Object.hasOwn(defaults, key)) throw fail("Unknown policy field");
      const n = Number(value);
      if (
        !Number.isInteger(n) ||
        n < (key === "autoCoverage" ? 0 : 1) ||
        n > (key === "autoCoverage" ? 1 : 10080)
      )
        throw fail("Policy minutes/counts must be 1–10080");
      values[key] = n;
    }
    await Setting.updateOne(
      { key: "operations-policy" },
      { $set: { value: { ...(await policy()), ...values } } },
      { upsert: true }
    );
    s.json(await policy());
  })
);
router.get("/imports/:id/review", manager, wrap(async (q, s) => {
  const item = await Import.findById(q.params.id);
  if (!item) throw fail("Import not found", 404);
  const p = await policy();
  s.json({ dueAt: addWorkMinutes(item.sourceCreatedAt || item.createdAt, p.firstContactMinutes) });
}));
router.post(
  "/imports/:id/review",
  manager,
  wrap(async (q, s) => {
    const { decision, lead: leadId, reason } = q.body;
    if (!["link_existing", "invalid", "do_not_contact"].includes(decision) || !String(reason || "").trim())
      throw fail("Choose a review decision and record the reason");
    const p = await policy();
    const session = await mongoose.startSession();
    let i, commitment;
    try {
      await session.withTransaction(async () => {
        i = await Import.findById(q.params.id).session(session);
        if (!i) throw fail("Import not found", 404);
        if (!["failed", "needs_review", "reviewed"].includes(i.status) || (i.status === "reviewed" && i.reviewDecision))
          throw fail("This import has already changed. Refresh before reviewing.", 409);
        if (decision === "link_existing") {
          if (!mongoose.isValidObjectId(leadId)) throw fail("Choose the existing lead");
          const lead = await Lead.findById(leadId).populate("owner", "name active").session(session);
          if (!lead || !lead.owner?.active || lead.doNotContact || ["Won", "Lost"].includes(lead.stage))
            throw fail("Choose an open lead with an active owner and permission to contact");
          await Lead.updateOne({ _id: lead.id }, { $inc: { workflowRevision: 1 } }, { session });
          const dueAt = addWorkMinutes(i.sourceCreatedAt || i.createdAt, p.firstContactMinutes);
          const key = `import-review:${i.id}`;
          await Task.updateOne({ key }, { $setOnInsert: { lead: lead.id, owner: lead.owner.id,
            key, title: "Contact reviewed enquiry", dueAt, originalDueAt: dueAt, kind: "call", customerFacing: true } },
            { upsert: true, session });
          i.lead = lead.id;
          commitment = { owner: lead.owner.name, dueAt };
        }
        i.status = "reviewed";
        i.reviewDecision = decision;
        i.reviewedAt = new Date();
        i.reviewedBy = q.user.id;
        i.reviewReason = String(reason).trim().slice(0, 1000);
        await i.save({ session });
      });
    } finally { await session.endSession(); }
    s.json({ ...i.toObject(), commitment });
  })
);
router.post(
  "/imports/:id/retry",
  manager,
  wrap(async (q, s) => {
    const i = await Import.findById(q.params.id);
    if (!i) throw fail("Import not found", 404);
    if (["csv", "manual"].includes(i.source))
      throw fail(
        "Correct the enquiry details and record a review decision"
      );
    const updated = await Import.findOneAndUpdate({ _id: i.id,
      $or: [{ status: { $in: ["failed", "needs_review"] } }, { status: "reviewed", reviewDecision: null }] },
      { $set: { status: "pending", nextAttemptAt: new Date() } }, { new: true });
    if (!updated) throw fail("This import is already handled or queued", 409);
    s.json(updated);
  })
);
export default router;
