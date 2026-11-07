/**
 * Rich demo fixtures: leads, calls, tasks, meetings, demos, proposals, imports,
 * handover, notifications — assigned to users that already exist in the DB.
 * Does not create users or change passwords.
 *
 * Re-running is safe: upserts by stable keys (phone, clientId, tokens, etc.).
 *
 * Optional: SEED_DEMO_RESET=1 removes prior demo rows (same phones / demo keys)
 * then re-seeds. Does not delete or modify User documents.
 *
 * Usage:
 *   SEED_DEMO=1 node src/seed-demo.js
 *   SEED_DEMO=1 SEED_DEMO_RESET=1 npm run seed:demo
 */
import "dotenv/config";
import mongoose from "mongoose";
import {
  User,
  Lead,
  Task,
  Call,
  Meeting,
  Demo,
  Proposal,
  Import,
  Handover,
  Activity,
  Notification,
  Exception,
} from "./models.js";
import { phone } from "./rules.js";
import { sweep } from "./workflow.js";
import { operationsSweep } from "./operations.js";
import { initializeDemo } from "./demoFlow.js";
import { notify } from "./notifications.js";

const DEMO_TAG = "[demo-seed]";

if (process.env.SEED_DEMO !== "1")
  throw Error("Set SEED_DEMO=1 to load demo fixtures (refuses accidental runs).");

if (!process.env.MONGODB_URI) throw Error("MONGODB_URI is required.");

function e164(i) {
  return phone(`+9198000${String(100 + i).padStart(5, "0")}`);
}

/** Phones used for the 8 demo leads — used for optional reset */
function demoPhoneList() {
  return [1, 2, 3, 4, 5, 6, 7, 8].map((i) => e164(i));
}

function daysAgo(n) {
  return new Date(Date.now() - n * 86400000);
}

function hoursFromNow(h) {
  return new Date(Date.now() + h * 3600000);
}

function hoursAgo(h) {
  return new Date(Date.now() - h * 3600000);
}

function eventsConnected() {
  return [
    { type: "DIALING", at: new Date() },
    { type: "ACTIVE", at: new Date() },
    { type: "DISCONNECTED", at: new Date() },
  ];
}

function eventsNoAnswer() {
  return [
    { type: "DIALING", at: new Date() },
    { type: "DISCONNECTED", at: new Date() },
  ];
}

async function resolveStaff() {
  const managers = await User.find({ active: true, role: "manager" })
    .sort({ email: 1 })
    .limit(5);
  const agents = await User.find({
    active: true,
    role: { $in: ["agent", "rep"] },
  })
    .sort({ email: 1 })
    .limit(20);
  if (!managers.length)
    throw Error(
      "Demo seed needs at least one active manager user. Create one (e.g. npm run seed) or add a manager in the DB."
    );
  const mgr = managers[0];
  let agent1;
  let agent2;
  let rep1;

  if (agents.length >= 2) {
    agent1 = agents[0];
    agent2 = agents[1];
    rep1 = agents.find((u) => u.role === "rep") || agents[1];
  } else if (agents.length === 1) {
    agent1 = agents[0];
    agent2 =
      String(mgr.id) !== String(agent1.id)
        ? mgr
        : await User.findOne({ active: true, _id: { $ne: agent1._id } }).sort({
            email: 1,
          });
    if (!agent2)
      throw Error(
        "Demo seed needs a second active user when only one agent/rep exists (add another employee or a manager account)."
      );
    rep1 =
      agent1.role === "rep"
        ? agent1
        : agent2.role === "rep"
          ? agent2
          : agent1;
  } else {
    // Only a manager (or single account): assign all demo work to that user.
    agent1 = mgr;
    agent2 = mgr;
    rep1 = mgr;
  }

  return { mgr, agent1, agent2, rep1 };
}

function uniqUserIds(...ids) {
  const seen = new Set();
  const out = [];
  for (const id of ids) {
    const s = String(id);
    if (!seen.has(s)) {
      seen.add(s);
      out.push(id);
    }
  }
  return out;
}

async function removePriorDemoData() {
  const phones = demoPhoneList();
  const leads = await Lead.find({ phone: { $in: phones } }).select("_id");
  const leadIds = leads.map((l) => l._id);
  if (!leadIds.length) return;

  await Notification.deleteMany({
    $or: [
      { lead: { $in: leadIds } },
      { key: { $regex: "^demo-seed:" } },
    ],
  });
  await Exception.deleteMany({ lead: { $in: leadIds } });
  await Handover.deleteMany({
    $or: [{ lead: { $in: leadIds } }, { key: "demo-handover-pending-1" }],
  });
  await Activity.deleteMany({ lead: { $in: leadIds } });
  await Task.deleteMany({
    $or: [
      { lead: { $in: leadIds } },
      { key: { $regex: "^demo-seed" } },
    ],
  });
  await Call.deleteMany({
    $or: [
      { lead: { $in: leadIds } },
      { clientId: { $regex: "^demo-seed-" } },
    ],
  });
  await Meeting.deleteMany({ lead: { $in: leadIds } });
  await Demo.deleteMany({
    $or: [
      { lead: { $in: leadIds } },
      { token: { $in: ["demoseed-ready-royal", "demoseed-req-silver"] } },
    ],
  });
  await Proposal.deleteMany({ lead: { $in: leadIds } });
  await Import.deleteMany({ externalId: "demo-meta-row-001" });
  await Lead.deleteMany({ _id: { $in: leadIds } });
}

await mongoose.connect(process.env.MONGODB_URI);

if (process.env.SEED_DEMO_RESET === "1") {
  await removePriorDemoData();
  console.log(`${DEMO_TAG} Removed previous demo leads and linked rows (users unchanged).`);
}

const { mgr, agent1, agent2, rep1 } = await resolveStaff();

const leadDefs = [
  {
    slug: "acme",
    name: "ACME Jewellers — MG Road",
    source: "Meta Lead Form",
    stage: "Qualified",
    ultra: true,
    owner: agent1,
    needs: "Inventory sync, hallmark compliance",
    idx: 1,
  },
  {
    slug: "nakshatra",
    name: "Nakshatra Gold House",
    source: "Referral",
    stage: "Demo/Meeting",
    ultra: true,
    priorityReason: "Opening second showroom next month",
    owner: agent2,
    needs: "POS + customer loyalty",
    idx: 2,
  },
  {
    slug: "silverline",
    name: "Silverline Boutique",
    source: "IndiaMart",
    stage: "Contacting",
    ultra: false,
    owner: agent1,
    needs: "Lightweight billing",
    idx: 3,
  },
  {
    slug: "royal",
    name: "Royal Ornaments Pvt Ltd",
    source: "Walk-in",
    stage: "Decision",
    ultra: true,
    owner: agent2,
    needs: "Enterprise rollout, multi-branch",
    idx: 4,
  },
  {
    slug: "temple",
    name: "Temple Trust Jewellery Counter",
    source: "Website",
    stage: "New",
    ultra: false,
    owner: rep1,
    needs: "Donation receipts + inventory",
    idx: 5,
  },
  {
    slug: "lost-cold",
    name: "Cold Prospector (closed)",
    source: "Cold call list",
    stage: "Lost",
    owner: agent1,
    closeReason: "not_interested",
    doNotContact: false,
    idx: 6,
  },
  {
    slug: "dnc",
    name: "Do Not Call Sample",
    source: "CSV import",
    stage: "Lost",
    owner: agent2,
    closeReason: "do_not_contact",
    doNotContact: true,
    idx: 7,
  },
  {
    slug: "nurture",
    name: "Budget 2026 — nurture",
    source: "Webinar",
    stage: "Nurture",
    pauseUntil: daysAgo(2),
    owner: agent1,
    idx: 8,
  },
];

const leadsBySlug = {};
for (const d of leadDefs) {
  const ph = e164(d.idx);
  const firstDue = daysAgo(20 - d.idx);
  const l = await Lead.findOneAndUpdate(
    { phone: ph },
    {
      $setOnInsert: {
        name: d.name,
        phone: ph,
        source: d.source,
        owner: d.owner.id,
        stage: d.stage,
        ultra: !!d.ultra,
        needs: d.needs,
        firstContactDueAt: firstDue,
        firstAttemptAt: daysAgo(18),
        firstConnectedAt: daysAgo(15),
        lastContactAt: daysAgo(2),
      },
      $set: {
        ...(d.priorityReason ? { priorityReason: d.priorityReason } : {}),
        ...(d.closeReason ? { closeReason: d.closeReason } : {}),
        ...(d.doNotContact !== undefined ? { doNotContact: d.doNotContact } : {}),
        ...(d.pauseUntil ? { pauseUntil: d.pauseUntil } : {}),
      },
    },
    { upsert: true, new: true }
  );
  leadsBySlug[d.slug] = l;
}

const acme = leadsBySlug.acme;
const nakshatra = leadsBySlug.nakshatra;
const silverline = leadsBySlug.silverline;
const royal = leadsBySlug.royal;

const repForPair = (a, b) =>
  String(a.id) === String(b.id) ? (String(a.id) === String(agent1.id) ? agent2 : agent1) : b;

const callRows = [
  {
    key: "acme-1",
    agent: agent1,
    lead: acme,
    direction: "outgoing",
    days: 20,
    connected: true,
    activeSec: 340,
    outcome: "interested",
    outcomeSaved: true,
  },
  {
    key: "acme-2",
    agent: agent1,
    lead: acme,
    direction: "outgoing",
    days: 18,
    noAnswer: true,
  },
  {
    key: "acme-3",
    agent: agent1,
    lead: acme,
    direction: "outgoing",
    days: 12,
    connected: true,
    activeSec: 180,
    outcome: "callback",
    outcomeSaved: true,
  },
  {
    key: "nakshatra-1",
    agent: agent2,
    lead: nakshatra,
    direction: "outgoing",
    days: 8,
    connected: true,
    activeSec: 420,
    outcome: "meeting_booked",
    outcomeSaved: true,
  },
  {
    key: "silver-1",
    agent: agent1,
    lead: silverline,
    direction: "outgoing",
    days: 3,
    busy: true,
  },
  {
    key: "silver-2",
    agent: agent1,
    lead: silverline,
    direction: "outgoing",
    days: 2,
    noAnswer: true,
  },
  {
    key: "royal-1",
    agent: agent2,
    lead: royal,
    direction: "incoming",
    days: 5,
    connected: true,
    activeSec: 600,
    outcome: "partner",
    outcomeSaved: true,
    localEnd: true,
  },
  {
    key: "royal-2",
    agent: agent2,
    lead: royal,
    direction: "outgoing",
    days: 1,
    connected: true,
    activeSec: 120,
    outcome: "interested",
    outcomeSaved: true,
  },
];

for (const c of callRows) {
  const started = daysAgo(c.days);
  const clientId = `demo-seed-${c.key}`;
  let answeredAt;
  let endedAt;
  let activeMs = 0;
  let disconnectCode;
  let ev;
  let technicalResult = "pending";
  let endedBy = "unknown";
  let localEndRequested = false;

  if (c.connected) {
    answeredAt = new Date(+started + 4000);
    endedAt = new Date(+answeredAt + (c.activeSec || 60) * 1000);
    activeMs = +endedAt - +answeredAt;
    disconnectCode = c.localEnd ? 2 : 3;
    ev = eventsConnected();
    technicalResult = "connected";
    endedBy = c.localEnd ? "local_reported" : "remote_reported";
    localEndRequested = !!c.localEnd;
  } else if (c.noAnswer) {
    endedAt = new Date(+started + 25000);
    disconnectCode = 3;
    ev = eventsNoAnswer();
    technicalResult = "not_answered";
    endedBy = "unknown";
  } else if (c.busy) {
    endedAt = new Date(+started + 8000);
    disconnectCode = 7;
    ev = eventsNoAnswer();
    technicalResult = "not_answered";
    endedBy = "unknown";
  }

  await Call.findOneAndUpdate(
    { clientId },
    {
      $set: {
        agent: c.agent.id,
        lead: c.lead.id,
        deviceId: `demo-device-${c.agent.id}`,
        number: c.lead.phone,
        direction: c.direction,
        startedAt: started,
        answeredAt,
        endedAt,
        activeMs,
        preAnswerMs: answeredAt ? 4000 : undefined,
        disconnectCode,
        localEndRequested,
        endedBy,
        events: ev,
        technicalResult,
        outcome: c.outcome,
        outcomeSaved: !!c.outcomeSaved,
        notes: c.outcome ? `${DEMO_TAG} ${c.outcome}` : "",
      },
    },
    { upsert: true }
  );
}

await Task.findOneAndUpdate(
  { key: "demo-seed-task-overdue-details" },
  {
    $setOnInsert: {
      lead: acme.id,
      owner: agent1.id,
      title: "Send rate card and GST summary",
      kind: "send_details",
      status: "open",
      dueAt: hoursAgo(30),
      originalDueAt: hoursAgo(30),
      customerFacing: true,
    },
  },
  { upsert: true }
);

await Task.findOneAndUpdate(
  { key: "demo-seed-task-callback-fixed" },
  {
    $setOnInsert: {
      lead: silverline.id,
      owner: agent1.id,
      title: "Customer-requested callback",
      kind: "call",
      status: "open",
      fixed: true,
      dueAt: hoursFromNow(2),
      originalDueAt: hoursFromNow(2),
    },
  },
  { upsert: true }
);

await Task.findOneAndUpdate(
  { key: "demo-seed-task-proposal-follow" },
  {
    $setOnInsert: {
      lead: royal.id,
      owner: agent2.id,
      title: "Discuss proposal decision",
      kind: "call",
      status: "open",
      dueAt: hoursFromNow(6),
      originalDueAt: hoursFromNow(6),
    },
  },
  { upsert: true }
);

await Task.findOneAndUpdate(
  { key: "demo-seed-task-done" },
  {
    $setOnInsert: {
      lead: acme.id,
      owner: agent1.id,
      title: "Log discovery call notes",
      kind: "internal",
      status: "done",
      dueAt: daysAgo(10),
      originalDueAt: daysAgo(10),
      doneAt: daysAgo(9),
    },
  },
  { upsert: true }
);

const futureStart = hoursFromNow(72);
const futureEnd = new Date(+futureStart + 45 * 60000);
await Meeting.findOneAndUpdate(
  {
    lead: acme.id,
    type: "online",
    place: "https://meet.example.com/acme-demo",
  },
  {
    $set: {
      lead: acme.id,
      reps: uniqUserIds(agent1.id, repForPair(agent1, rep1).id),
      start: futureStart,
      end: futureEnd,
      placePending: false,
      confirmed: true,
      status: "scheduled",
    },
  },
  { upsert: true, setDefaultsOnInsert: true }
);

const pastNoOutcomeStart = hoursAgo(48);
const pastNoOutcomeEnd = hoursAgo(47);
await Meeting.findOneAndUpdate(
  {
    lead: nakshatra.id,
    type: "online",
    place: "https://zoom.us/j/demo-nakshatra",
  },
  {
    $set: {
      lead: nakshatra.id,
      reps: [agent2.id],
      start: pastNoOutcomeStart,
      end: pastNoOutcomeEnd,
      confirmed: true,
      status: "scheduled",
      outcome: null,
    },
  },
  { upsert: true, setDefaultsOnInsert: true }
);

const doneMeetStart = daysAgo(14);
const doneMeetEnd = new Date(+doneMeetStart + 3600000);
await Meeting.findOneAndUpdate(
  {
    lead: royal.id,
    type: "physical",
    place: "Royal Ornaments HQ, Kochi",
    status: "done",
  },
  {
    $set: {
      lead: royal.id,
      reps: uniqUserIds(agent2.id, repForPair(agent2, rep1).id),
      start: doneMeetStart,
      end: doneMeetEnd,
      travelMinutes: 30,
      confirmed: true,
      outcome: "positive",
    },
  },
  { upsert: true, setDefaultsOnInsert: true }
);

const demoTokReady = "demoseed-ready-royal";
let demoReady = await Demo.findOne({ token: demoTokReady });
if (!demoReady) {
  demoReady = await Demo.create({
    lead: royal.id,
    owner: agent2.id,
    shopName: royal.name,
    modules: "POS, inventory, loyalty",
    token: demoTokReady,
    status: "ready",
    url: "https://demo.example.com/royal-preview",
    expiresAt: new Date(Date.now() + 10 * 86400000),
    logoUrl: "https://example.com/logo-placeholder.png",
  });
  await initializeDemo(demoReady.id);
}

const demoTokRequested = "demoseed-req-silver";
let demoReq = await Demo.findOne({ token: demoTokRequested });
if (!demoReq) {
  demoReq = await Demo.create({
    lead: silverline.id,
    owner: agent1.id,
    shopName: silverline.name,
    modules: "Billing only",
    token: demoTokRequested,
    status: "requested",
    expiresAt: new Date(Date.now() + 14 * 86400000),
  });
  await initializeDemo(demoReq.id);
}

const prop = await Proposal.findOneAndUpdate(
  { lead: royal.id, version: 1 },
  {
    $setOnInsert: {
      lead: royal.id,
      owner: agent2.id,
      version: 1,
      amount: 285000,
      status: "sent",
      sentAt: daysAgo(3),
      url: "https://files.example.com/proposals/royal-v1.pdf",
    },
  },
  { upsert: true, new: true }
);

await Task.findOneAndUpdate(
  { key: `proposal-follow:${prop.id}` },
  {
    $setOnInsert: {
      lead: royal.id,
      owner: agent2.id,
      title: "Discuss proposal decision",
      kind: "call",
      status: "open",
      dueAt: hoursFromNow(6),
      originalDueAt: hoursFromNow(6),
    },
  },
  { upsert: true }
);

await Import.findOneAndUpdate(
  { externalId: "demo-meta-row-001" },
  {
    $set: {
      source: "meta",
      status: "failed",
      error: "Phone normalisation failed",
      payload: { demo: true, field_data: [] },
    },
  },
  { upsert: true }
);

if (String(agent1.id) !== String(agent2.id)) {
  await Handover.findOneAndUpdate(
    { key: "demo-handover-pending-1" },
    {
      $setOnInsert: {
        lead: silverline.id,
        from: agent1.id,
        to: agent2.id,
        requestedBy: mgr.id,
        reason: `${DEMO_TAG} Agent1 overloaded — please cover Silverline callbacks.`,
        status: "pending",
        expiresAt: hoursFromNow(24),
      },
    },
    { upsert: true }
  );
}

const recent = await Activity.countDocuments({ lead: acme.id });
if (recent === 0) {
  await Activity.create([
    {
      lead: acme.id,
      actor: agent1.id,
      type: "note",
      text: `${DEMO_TAG} Customer asked about GST reporting for B2B.`,
    },
    {
      lead: nakshatra.id,
      actor: agent2.id,
      type: "note",
      text: `${DEMO_TAG} Second branch launch — decision maker is CFO.`,
    },
  ]);
}

await notify(
  mgr.id,
  `demo-seed:manager-reminder:${acme.id}`,
  "Review: ACME priority lead",
  `${DEMO_TAG} Check today queue and confirm meeting prep.`,
  { category: "reminder", lead: acme.id, severity: "info" }
);

await notify(
  agent1.id,
  `demo-seed:agent-task:${nakshatra.id}`,
  "Nakshatra — book recap call",
  `${DEMO_TAG} Past meeting still shows scheduled; update outcome in app.`,
  { category: "reminder", lead: nakshatra.id, severity: "warning" }
);

await sweep();
await operationsSweep();

await mongoose.disconnect();

console.log(`${DEMO_TAG} Demo fixtures applied using existing users (no accounts created).`);
const staffEmails = [...new Set([mgr, agent1, agent2, rep1].map((u) => u.email))].join(", ");
console.log(`${DEMO_TAG} Users: ${staffEmails}`);
console.log(
  `${DEMO_TAG} To replace demo data only: SEED_DEMO_RESET=1 SEED_DEMO=1 npm run seed:demo`
);
