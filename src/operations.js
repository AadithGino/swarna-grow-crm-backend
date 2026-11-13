import {
  Lead,
  Task,
  Call,
  Meeting,
  Demo,
  User,
  Notification,
  Exception,
  Handover,
  Import,
  Device,
  Setting,
} from "./models.js";
import { activeLead, workSlot } from "./rules.js";
import { policy, customerTask, unavailable } from "./policy.js";
import { initializeLead, suggestBackup, queueCoverage } from "./coverage.js";
import { notify, notifyManagers } from "./notifications.js";
import { task } from "./workflow.js";
export async function issue(
  key,
  type,
  title,
  detail,
  extra = {},
  now = new Date()
) {
  const prior = await Exception.findOne({ key });
  const generation =
    prior?.status === "resolved"
      ? (prior.generation || 1) + 1
      : prior?.generation || 1;
  const e = await Exception.findOneAndUpdate(
    { key },
    {
      $set: {
        type,
        title,
        detail,
        ...extra,
        generation,
        status: "open",
        lastSeenAt: now,
      },
      $unset: { resolvedAt: 1 },
    },
    { upsert: true, new: true }
  );
  await notifyManagers(`exception:${e.id}:${generation}`, title, detail, {
    ...extra,
    exception: e.id,
    category: type,
    severity: extra.severity || "warning",
  });
  return e;
}
export async function operationsSweep(now = new Date()) {
  const p = await policy(),
    start = new Date(now),
    owners = new Map((await User.find()).map((u) => [u.id, u]));
  const leads = await Lead.find({
    stage: { $nin: ["Won", "Lost"] },
    doNotContact: { $ne: true },
  });
  for (let l of leads) {
    l = await initializeLead(l, now);
    const owner = owners.get(String(l.owner));
    const attempt = await Call.findOne({
      lead: l.id,
      $or: [
        { direction: "outgoing", "events.type": "DIALING" },
        { answeredAt: { $ne: null } },
      ],
    }).sort({ startedAt: 1 });
    const connected = await Call.findOne({
      lead: l.id,
      answeredAt: { $ne: null },
    }).sort({ answeredAt: 1 });
    if (attempt && !l.firstAttemptAt) {
      l.firstAttemptAt = attempt.startedAt;
      await l.save();
    }
    if (connected && !l.firstConnectedAt) {
      l.firstConnectedAt = connected.answeredAt;
      await l.save();
    }
    if (!l.firstAttemptAt && l.firstContactDueAt <= now) {
      await issue(
        `first-contact:${l.id}`,
        "first_contact",
        "First contact overdue",
        `${l.name} has no logged contact attempt`,
        { lead: l.id, owner: l.owner, severity: "critical" },
        now
      );
    }
    if (!owner || unavailable(owner, now))
      await issue(
        `owner:${l.id}`,
        "coverage",
        "Lead needs backup coverage",
        `${l.name}: owner missing, inactive or away. A backup must accept.`,
        { lead: l.id, owner: l.owner, severity: "critical" },
        now
      );
    if (p.autoCoverage && (!owner || unavailable(owner, now))) {
      try {
        await queueCoverage(
          l.id,
          l.owner,
          `Automatic backup: ${l.name}'s owner is unavailable`,
          now
        );
      } catch (e) {
        await issue(
          `auto-coverage:${l.id}`,
          "coverage",
          "Automatic coverage needs manager review",
          e.message,
          { lead: l.id, owner: l.owner, severity: "critical" },
          now
        );
      }
    }
    if (l.stage === "Nurture" && !l.pauseUntil && !(await Task.exists({ lead: l.id, status: "open", kind: "call" })))
      await issue(`nurture-date:${l.id}`, "customer_next", "Nurture lead has no return date",
        `${l.name}: choose a dated callback or close the lead`, { lead: l.id, owner: l.owner, severity: "critical" }, now);
    const open = await Task.find({ lead: l.id, status: "open" });
    const promisedMeeting = await Meeting.exists({
      lead: l.id,
      status: "scheduled",
      end: { $gt: now },
    });
    const customerNext = open.some(customerTask);
    const retryReview = l.retryReviewAt || open.some(row => row.kind === "internal" && row.title === "Review unanswered lead");
    if (activeLead(l) && !retryReview && !customerNext && !promisedMeeting) {
      const due = workSlot(l.pauseUntil > now ? l.pauseUntil : now);
      const guardTask = await task(
        l,
        "Agree next customer contact",
        due,
        `customer-coverage:${l.id}:${now.toISOString().slice(0, 10)}`,
        { kind: "call", customerFacing: true }
      );
      open.push(guardTask);
      await issue(
        `customer-next:${l.id}`,
        "customer_next",
        "Missing customer-facing next step",
        `${l.name}: internal work does not cover customer contact`,
        { lead: l.id, owner: l.owner },
        now
      );
    }
    if (l.ultra && activeLead(l) && !retryReview) {
      const local = new Date(+now + 330 * 60000),
        day = local.toISOString().slice(0, 10),
        begin = new Date(day + "T00:00:00+05:30"),
        end = new Date(+begin + 86400000);
      const attemptedToday = await Call.exists({
        lead: l.id,
        endedAt: { $gte: begin, $lt: end },
        $or: [
          { direction: "outgoing", "events.type": "DIALING" },
          { answeredAt: { $ne: null } },
        ],
      });
      if (
        local.getUTCDay() !== 0 &&
        !attemptedToday &&
        !(l.pauseUntil > now) &&
        !promisedMeeting &&
        !open.some((t) => customerTask(t) && t.dueAt >= begin && t.dueAt < end)
      )
        await task(
          l,
          "Daily priority customer follow-up",
          workSlot(now),
          `priority-customer:${l.id}:${day}`,
          { kind: "call", customerFacing: true }
        );
    }
  }
  for (const meeting of await Meeting.find({ status: "scheduled", end: { $gt: now } }).populate("lead", "name owner")) {
    if (!meeting.lead) continue;
    const unavailableReps = meeting.reps.filter(rep => unavailable(owners.get(String(rep)), meeting.start));
    if (!meeting.reps.length || unavailableReps.length) {
      await issue(`meeting-coverage:${meeting.id}`, "coverage", "Scheduled meeting needs coverage",
        `${meeting.lead.name}: check attendees for the ${meeting.start?.toISOString() || "scheduled"} meeting`,
        { lead: meeting.lead.id, meeting: meeting.id, owner: unavailableReps[0] || meeting.lead.owner, severity: "critical" }, now);
      if (p.autoCoverage) for (const rep of unavailableReps) {
        try { await queueCoverage(meeting.lead.id, rep, "Scheduled meeting needs an available attendee", now); }
        catch (error) { await issue(`meeting-backup:${meeting.id}:${rep}`, "coverage",
          "Choose a meeting replacement", error.message, { lead: meeting.lead.id, meeting: meeting.id, owner: rep }, now); }
      }
    }
  }
  for (const call of await Call.find({ technicalResult: "missed_incoming", lead: null, endedAt: { $ne: null } })) {
    const returned = await Call.exists({ number: call.number, startedAt: { $gte: call.endedAt }, $or: [
      { direction: "outgoing", "events.type": "DIALING" }, { answeredAt: { $gte: call.endedAt } },
    ] });
    if (!returned) await issue(`unlinked-missed:${call.id}`, "customer_next", "Unlinked missed inbound call",
      `Match the inbound call from ${call.number} to a lead or return the call.`, { owner: call.agent, call: call.id }, now);
  }
  for (const call of await Call.find({ recordingStatus: "uploading", endedAt: { $lte: new Date(+now - 30 * 60000) } })) {
    await issue(`recording-upload:${call.id}`, "delivery", "Call recording upload incomplete",
      `Check recording sync on the phone for call ending ${call.endedAt.toISOString()}.`,
      { owner: call.agent, call: call.id, lead: call.lead }, now);
  }
  for (const t of await Task.find({ status: "open" }).populate("lead")) {
    if (
      !t.lead ||
      t.lead.doNotContact ||
      ["Won", "Lost"].includes(t.lead.stage)
    )
      continue;
    const owner = owners.get(String(t.owner));
    if (!owner || unavailable(owner, now))
      await issue(
        `task-owner:${t.id}`,
        "coverage",
        "Uncovered commitment",
        `${t.title}: assigned employee is unavailable`,
        { lead: t.lead.id, task: t.id, owner: t.owner, severity: "critical" },
        now
      );
    if (p.autoCoverage && (!owner || unavailable(owner, now))) {
      try {
        await queueCoverage(
          t.lead.id,
          t.owner,
          `Automatic backup for ${t.title}`,
          now
        );
      } catch (e) {
        await issue(
          `auto-task-coverage:${t.id}`,
          "coverage",
          "Commitment needs manager coverage",
          e.message,
          { lead: t.lead.id, task: t.id, owner: t.owner, severity: "critical" },
          now
        );
      }
    }
    const due = +t.dueAt;
    if (!Number.isFinite(due)) {
      await issue(
        `bad-date:${t.id}`,
        "customer_next",
        "Task has no valid deadline",
        t.title,
        { lead: t.lead.id, task: t.id, owner: t.owner },
        now
      );
      continue;
    }
    const key = `task:${t.id}:${due}`;
    if (+now >= due - p.remindBeforeMinutes * 60000 && +now < due)
      await notify(
        t.owner,
        key + ":before",
        "Upcoming: " + t.title,
        t.lead.name,
        { lead: t.lead.id, task: t.id, category: "reminder", dueAt: t.dueAt }
      );
    if (+now >= due)
      await notify(t.owner, key + ":due", "Due now: " + t.title, t.lead.name, {
        lead: t.lead.id,
        task: t.id,
        category: "reminder",
        dueAt: t.dueAt,
        severity: "warning",
      });
    const age = (+now - due) / 60000;
    if (age >= p.managerEscalationMinutes)
      await issue(
        `overdue:${t.id}`,
        "overdue",
        "Overdue commitment",
        `${t.lead.name}: ${t.title} is ${Math.floor(age)} minutes overdue${
          t.originalDueAt
            ? "; original deadline " +
              t.originalDueAt.toLocaleString("en-IN", {
                timeZone: "Asia/Kolkata",
                day: "numeric",
                month: "short",
                hour: "numeric",
                minute: "2-digit",
              })
            : ""
        }`,
        {
          lead: t.lead.id,
          task: t.id,
          owner: t.owner,
          severity: age >= p.criticalEscalationMinutes ? "critical" : "warning",
        },
        now
      );
    if (age >= p.criticalEscalationMinutes)
      await notifyManagers(
        key + ":critical",
        "Critical: commitment still unfinished",
        t.title,
        {
          lead: t.lead.id,
          task: t.id,
          category: "overdue",
          severity: "critical",
        }
      );
    if ((t.snoozes || 0) > 0 && t.originalDueAt && t.originalDueAt < now)
      await issue(
        `original-late:${t.id}`,
        "snooze",
        "Original commitment was missed",
        `${t.title}: original ${t.originalDueAt.toLocaleString("en-IN", {
          timeZone: "Asia/Kolkata",
          day: "numeric",
          month: "short",
          hour: "numeric",
          minute: "2-digit",
        })}, current ${t.dueAt.toLocaleString("en-IN", {
          timeZone: "Asia/Kolkata",
          day: "numeric",
          month: "short",
          hour: "numeric",
          minute: "2-digit",
        })}`,
        { lead: t.lead.id, task: t.id, owner: t.owner },
        now
      );
    if ((t.snoozes || 0) >= p.snoozeLimit || t.snoozeApprovalRequestedAt)
      await issue(
        `snooze:${t.id}`,
        "snooze",
        "Repeatedly postponed commitment",
        `${t.title} postponed ${t.snoozes} times`,
        { lead: t.lead.id, task: t.id, owner: t.owner },
        now
      );
  }
  for (const u of owners.values()) {
    if (!u.active) continue;
    const load = await Task.countDocuments({
      owner: u.id,
      status: "open",
      dueAt: { $lt: new Date(+now + 86400000) },
    });
    if (load >= u.capacity)
      await issue(
        `capacity:${u.id}`,
        "capacity",
        "Employee is at capacity",
        `${u.name}: ${load} commitments against capacity ${u.capacity}`,
        { owner: u.id },
        now
      );
  }
  if (p.autoCoverage)
    for (const u of owners.values()) {
      if (!u.active || unavailable(u, now)) continue;
      const load = await Task.countDocuments({
        owner: u.id,
        status: "open",
        dueAt: { $lt: new Date(+now + 86400000) },
      });
      if (load <= u.capacity) continue;
      let reserved = 0;
      for (const h of await Handover.find({ from: u.id, status: "pending" }))
        reserved += await Task.countDocuments({
          lead: h.lead,
          owner: u.id,
          status: "open",
          dueAt: { $lt: new Date(+now + 86400000) },
        });
      const oldest = await Task.find({
        owner: u.id,
        status: "open",
        dueAt: { $lt: new Date(+now + 86400000) },
      }).sort({ dueAt: 1 });
      const seen = new Set();
      for (const t of oldest) {
        if (load - reserved <= u.capacity) break;
        if (seen.has(String(t.lead))) continue;
        seen.add(String(t.lead));
        try {
          const h = await queueCoverage(
            t.lead,
            u.id,
            "Automatic backup: primary employee is over capacity",
            now
          );
          if (h)
            reserved += await Task.countDocuments({
              lead: t.lead,
              owner: u.id,
              status: "open",
              dueAt: { $lt: new Date(+now + 86400000) },
            });
        } catch (e) {
          await issue(
            `overload-coverage:${u.id}`,
            "coverage",
            "Overloaded employee needs manager help",
            e.message,
            { owner: u.id },
            now
          );
        }
      }
    }
  for (const d of await Demo.find({
    status: { $nin: ["responded", "cancelled"] },
  })) {
    const lead = await Lead.findById(d.lead);
    if (!lead || !activeLead(lead)) continue;
    if (!d.stageDueAt) continue;
    if (d.stageDueAt <= now)
      await issue(
        `demo:${d.id}`,
        "demo_delay",
        "Demo stage overdue",
        `${lead.name}: ${d.status} deadline passed`,
        {
          lead: lead.id,
          owner: d.selfServe ? d.owner : [
            "requested",
            "logo_requested",
            "ready",
            "sent",
            "explored",
          ].includes(d.status)
            ? lead.owner
            : d.owner,
          severity: "critical",
        },
        now
      );
  }
  for (const h of await Handover.find({
    status: "pending",
    expiresAt: { $lte: now },
  })) {
    h.status = "expired";
    await h.save();
    await issue(
      `handover:${h.id}`,
      "handover",
      "Backup has not accepted",
      h.reason,
      { lead: h.lead, owner: h.from, severity: "critical" },
      now
    );
  }
  for (const i of await Import.find({
    $or: [{ status: { $in: ["pending", "failed", "needs_review", "processing"] } }, { status: "reviewed", reviewDecision: null }],
  })) {
    if (
      i.status === "failed" ||
      i.status === "needs_review" || i.status === "reviewed" ||
      now - i.createdAt > 15 * 60000
    )
      await issue(
        `import:${i.id}`,
        "capture",
        "Lead capture needs attention",
        i.status === "needs_review"
          ? "Repeat enquiry is linked to a closed or do-not-contact lead. Review before outreach."
          : i.error || "Lead import has not completed",
        { severity: "critical", lead: i.lead, sourceImport: i.id },
        now
      );
  }
  for (const t of await Task.find({
    key: /^(meta|enquiry|import-review):/, status: "open", dueAt: { $lte: now },
  }).populate("lead", "name stage doNotContact")) {
    if (!t.lead || t.lead.doNotContact || ["Won", "Lost"].includes(t.lead.stage)) continue;
    const [kind, ref] = t.key.split(":", 2);
    const enquiry = kind === "meta" ? await Import.findOne({ externalId: t.key.slice(5), status: "done" })
      : /^[a-f0-9]{24}$/i.test(ref) && await Import.findById(ref);
    if (!enquiry?.sourceCreatedAt) continue;
    const attempted = await Call.exists({
      lead: t.lead.id,
      $or: [
        { direction: "outgoing", startedAt: { $gte: enquiry.sourceCreatedAt }, "events.type": "DIALING" },
        { answeredAt: { $gte: enquiry.sourceCreatedAt } },
      ],
    });
    if (!attempted) await issue(
      `enquiry-contact:${enquiry.id}`,
      "first_contact",
      "Enquiry response overdue",
      `${t.lead.name} has no logged contact attempt since this enquiry`,
      { lead: t.lead.id, task: t.id, owner: t.owner, sourceImport: enquiry.id, severity: "critical" },
      now
    );
  }
  const configured = !!process.env.META_PAGE_TOKEN;
  const meta = await Setting.findOne({ key: "metaCheck" });
  if (
    (process.env.META_FORM_IDS || process.env.META_PAGE_ID || configured) &&
    (!configured ||
      !meta?.value?.ok ||
      now - new Date(meta.value.at) > 30 * 60000)
  )
    await issue(
      "meta-stale",
      "capture",
      "Meta reconciliation is stale or failed",
      meta?.value?.missingForms?.length ? `Forms missing from reconciliation: ${meta.value.missingForms.join(", ")}` :
      meta?.value?.discoveryError || "Check capture health; source enquiries may not be reaching CRM",
      { severity: "critical" },
      now
    );
  for (const u of owners.values())
    if (
      u.active &&
      (await Task.exists({ owner: u.id, status: "open", dueAt: { $lte: now } }))
    ) {
      const d = await Device.findOne({ user: u.id, enabled: true }).sort({
        lastSeenAt: -1,
      });
      if (!d || now - d.lastSeenAt > p.staleDeviceMinutes * 60000)
        await issue(
          `device:${u.id}`,
          "delivery",
          "Employee device is not reachable",
          `${u.name}: no recent notification-enabled device check-in`,
          { owner: u.id },
          now
        );
    }
  for (const n of await Notification.find({
    resolvedAt: null,
    acknowledgedAt: null,
    receivedAt: null,
    attempts: { $gte: 3 },
    category: { $ne: "delivery" },
  }).limit(300))
    await issue(
      `delivery:${n.id}`,
      "delivery",
      "Reminder delivery not confirmed",
      n.error || "Push was accepted but the phone has not confirmed receipt",
      { owner: n.user, severity: "critical" },
      now
    );
  const types = [
    "first_contact",
    "coverage",
    "customer_next",
    "overdue",
    "snooze",
    "capacity",
    "demo_delay",
    "capture",
    "delivery",
  ];
  await Exception.updateMany(
    { status: "open", type: { $in: types }, lastSeenAt: { $lt: start } },
    { $set: { status: "resolved", resolvedAt: now } }
  );
  for (const n of await Notification.find({
    resolvedAt: null,
    task: { $ne: null },
  })) {
    const t = await Task.findById(n.task);
    if (
      !t ||
      t.status !== "open" ||
      (n.category === "reminder" && String(t.owner) !== String(n.user)) ||
      (n.dueAt && +n.dueAt !== +t.dueAt)
    )
      await Notification.updateOne(
        { _id: n.id },
        { $set: { resolvedAt: now } }
      );
  }
  for (const n of await Notification.find({
    resolvedAt: null,
    exception: { $ne: null },
  })) {
    const e = await Exception.findById(n.exception);
    if (!e || e.status === "resolved")
      await Notification.updateOne(
        { _id: n.id },
        { $set: { resolvedAt: now } }
      );
  }
  return {
    leads: leads.length,
    exceptions: await Exception.countDocuments({ status: "open" }),
  };
}
