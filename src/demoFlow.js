import { randomBytes } from "node:crypto";
import mongoose from "mongoose";
import { Demo, Lead, Task, Activity } from "./models.js";
import { policy, addWorkMinutes } from "./policy.js";
const fail = (m) => Object.assign(Error(m), { status: 422 });
const transitions = {
  requested: ["ready", "logo_requested", "logo_received", "preparing", "problem"],
  logo_requested: ["ready", "logo_received", "problem"],
  logo_received: ["ready", "preparing", "problem"],
  preparing: ["ready", "problem"],
  ready: ["sent", "problem", "preparing"],
  sent: ["explored", "responded", "problem"],
  explored: ["responded", "problem"],
  problem: ["logo_requested", "logo_received", "preparing", "ready", "sent"],
  responded: [],
};
export async function demoStage(d, p, now = new Date()) {
  const config = {
    requested: ["Request customer logo", "call", p.logoMinutes],
    logo_requested: ["Collect customer logo", "call", p.logoMinutes],
    logo_received: ["Generate demo with shop name and logo", "demo_build", d.selfServe ? 15 : p.prepareMinutes],
    preparing: ["Finish generating demo", "demo_build", p.prepareMinutes],
    ready: ["Share ready demo", "send_demo", d.selfServe ? 15 : p.shareMinutes],
    sent: [
      "Check demo received and customer response",
      "demo_response",
      d.selfServe ? 120 : p.responseMinutes,
    ],
    explored: ["Ask for customer feedback", "demo_response", d.selfServe ? 120 : p.responseMinutes],
    problem: ["Resolve demo issue", "technical", 120],
  };
  return config[d.status] || null;
}
export async function requestDemoFromOutcome(lead, outcome, session, now) {
  const [demo] = await Demo.create([{
    lead: lead.id,
    owner: outcome.nextOwner || lead.owner,
    shopName: lead.name,
    selfServe: true,
    modules: outcome.actionNote,
    token: randomBytes(24).toString("hex"),
    expiresAt: new Date(+now + 14 * 86400000),
    stageStartedAt: now,
    stageDueAt: outcome.nextAt,
  }], { session });
  await stageTask(demo, ["Request customer logo", "call"], session, demo.owner);
  return demo;
}
export async function initializeDemo(id, now = new Date()) {
  const p = await policy(),
    session = await mongoose.startSession();
  let result;
  try {
    await session.withTransaction(async () => {
      const d = await Demo.findById(id).session(session);
      result = d;
      if (!d || d.stageDueAt || d.status === "responded") return;
      const stage = await demoStage(d, p, now);
      if (!stage) return;
      d.stageStartedAt = d.createdAt || now;
      d.stageDueAt = addWorkMinutes(d.stageStartedAt, stage[2]);
      await d.save({ session });
      await Task.updateMany(
        {
          key: {
            $in: [
              `demo-build:${d.id}`,
              `demo-send:${d.id}`,
              `demo-follow:${d.id}`,
              `demo-problem:${d.id}`,
            ],
          },
          status: "open",
        },
        {
          $set: {
            status: "cancelled",
            reason: "Replaced by stage-aware demo action",
          },
        },
        { session }
      );
      await stageTask(d, stage, session);
      result = d;
    });
  } finally {
    await session.endSession();
  }
  return result;
}
async function stageTask(d, stage, session, assignedOwner) {
  const l = await Lead.findById(d.lead).session(session || null);
  if (!l) return;
  await Task.updateOne(
    { key: `demo-stage:${d.id}:${d.stageRevision || 0}` },
    {
      $setOnInsert: {
        lead: d.lead,
        demo: d.id,
        owner: d.selfServe ? d.owner : ["call", "send_demo", "demo_response"].includes(stage[1])
          ? assignedOwner || l.owner
          : d.owner,
        title: stage[0],
        kind: stage[1],
        customerFacing: ["call", "send_demo", "demo_response"].includes(
          stage[1]
        ),
        dueAt: d.stageDueAt,
        originalDueAt: d.stageDueAt,
      },
    },
    { upsert: true, session }
  );
}
export async function advanceDemo(
  id,
  b,
  actor,
  { trustedEntry = false, now = new Date() } = {}
) {
  const old = await Demo.findById(id);
  if (!old) throw fail("Demo missing");
  if (b.expectedRevision != null && Number(b.expectedRevision) !== (old.stageRevision || 0))
    throw Object.assign(Error("Demo changed. Refresh before updating"), { status: 409 });
  const target = b.status || old.status;
  if (
    target !== old.status &&
    !(transitions[old.status] || []).includes(target)
  )
    throw fail("Complete the previous demo stage first");
  if (target === "explored" && !trustedEntry)
    throw fail("Demo entry is recorded by the customer link");
  const shopName = String(b.shopName ?? old.shopName ?? "").trim() ||
    (!b.shopName && (await Lead.findById(old.lead).select("name"))?.name) || "";
  const logo = b.logoUrl || old.logoUrl,
    logoNote = b.logoNote || old.logoNote;
  if (
    ["logo_received", "preparing"].includes(target) &&
    !logo &&
    !logoNote?.trim()
  )
    throw fail("Add the logo URL or note where the received logo is stored");
  let url = b.url || old.url;
  if (url && !/^https?:\/\//i.test(url)) throw fail("Enter a full demo URL");
  if (target === "ready" && !old.url && (!shopName || (!logo && !logoNote?.trim())))
    throw fail("Enter the shop name and add its logo");
  if (target === "ready" && !url)
    throw fail("Add a working personalised demo URL");
  if (target === "sent" && (!b.confirmSent || !b.channel))
    throw fail("Confirm actual sharing and select the channel");
  if (
    target === "responded" &&
    !["interested", "questions", "not_now", "not_interested"].includes(
      b.customerResponse
    )
  )
    throw fail("Select the actual customer response");
  const walkthroughActions = {
    send_quote: { title: "Send quote after demo", kind: "send_proposal" },
    decision_maker: { title: "Call the decision-maker after demo", kind: "call" },
    awaiting_decision: { title: "Check decision after demo", kind: "call" },
  };
  const walkthroughAction = b.walkthroughCompleted === true &&
    Object.hasOwn(walkthroughActions, b.walkthroughNextAction) && walkthroughActions[b.walkthroughNextAction];
  if (target === "responded" && b.walkthroughCompleted === true &&
      (!walkthroughAction || !b.nextAt || !Number.isFinite(+new Date(b.nextAt)) || new Date(b.nextAt) <= now))
    throw fail("Choose a next step and future deadline for the completed demo");
  if (target === "responded" && b.customerResponse === "not_now" && !b.nextAt)
    throw fail("Choose when the customer wants to hear from you");
  if (target === "problem" && !b.problem?.trim() && !old.problem)
    throw fail("Describe the demo issue");
  const p = await policy(),
    session = await mongoose.startSession();
  let saved;
  try {
    await session.withTransaction(async () => {
      const d = await Demo.findById(id).session(session);
      if (d.stageRevision !== old.stageRevision)
        throw Object.assign(Error("Demo changed. Refresh before updating"), {
          status: 409,
        });
      d.shopName = shopName;
      d.url = url;
      d.logoUrl = logo;
      d.logoNote = logoNote;
      if (target !== d.status) {
        d.status = target;
        d.stageRevision = (d.stageRevision || 0) + 1;
        d.stageStartedAt = now;
        const stage = await demoStage(d, p, now);
        const previousDeadline = d.stageDueAt;
        d.stageDueAt = stage ? addWorkMinutes(now, stage[2]) : undefined;
        if (d.selfServe && ["preparing", "ready"].includes(target) && ["logo_received", "preparing"].includes(old.status) && previousDeadline)
          d.stageDueAt = previousDeadline;
        if (d.selfServe && target === "explored" && previousDeadline)
          d.stageDueAt = previousDeadline;
        await Task.updateMany(
          {
            lead: d.lead,
            status: "open",
            key: {
              $in: [
                `demo-stage:${d.id}:${d.stageRevision - 1}`,
                `demo-build:${d.id}`,
                `demo-send:${d.id}`,
                `demo-follow:${d.id}`,
                `demo-problem:${d.id}`,
              ],
            },
          },
          { $set: { status: "done", doneAt: now } },
          { session }
        );
        if (stage) await stageTask(d, stage, session);
        if (target === "responded") {
          const due = b.nextAt
            ? new Date(b.nextAt)
            : addWorkMinutes(now, p.responseMinutes);
          if (!Number.isFinite(+due) || due <= now)
            throw fail("Choose a future customer follow-up time");
          const l = await Lead.findById(d.lead).session(session);
          await Task.updateOne(
            { key: `demo-response-next:${d.id}` },
            {
              $setOnInsert: {
                lead: d.lead,
                owner: d.selfServe ? d.owner : l.owner,
                title: walkthroughAction?.title || {
                  interested: "Agree a demo walkthrough time",
                  questions: "Answer customer’s demo questions",
                  not_now: "Call back about demo at agreed time",
                  not_interested: "Review demo decline and decide whether to close",
                }[b.customerResponse],
                kind: walkthroughAction?.kind || (b.customerResponse === "interested" ? "confirm_meeting"
                  : b.customerResponse === "not_interested" ? "internal" : "call"),
                customerFacing: !!walkthroughAction || b.customerResponse !== "not_interested",
                fixed: b.customerResponse === "not_now",
                dueAt: due,
                originalDueAt: due,
              },
            },
            { upsert: true, session }
          );
        }
      }
      if (target === "sent") {
        d.sentAt ||= now;
        d.sentBy ||= actor;
        d.channel = b.channel;
      }
      if (target === "explored" && trustedEntry) {
        d.firstExploredAt ||= now;
        d.visits++;
      }
      if (b.problem) d.problem = b.problem;
      if (target === "responded" && b.walkthroughCompleted === true) d.walkthroughCompletedAt ||= now;
      if (b.customerResponse) d.customerResponse = b.customerResponse;
      if (b.responseNote) d.responseNote = b.responseNote;
      await d.save({ session });
      await Activity.create(
        [
          {
            lead: d.lead,
            actor,
            type: "demo_stage",
            text: `Demo ${target}`,
            data: { demo: d.id, status: target },
          },
        ],
        { session }
      );
      saved = d;
    });
  } finally {
    await session.endSession();
  }
  return saved;
}
