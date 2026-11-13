/**
 * Migrate leads (and related tasks, activities, meetings) from internal CRM MongoDB.
 *
 *   CONFIRM_MIGRATE=1 SOURCE_MONGO_URI='...' node src/migrate-internal-crm.js
 *
 * Optional:
 *   MIGRATE_SINCE=2026-10-25   (IST calendar date, default)
 *   MIGRATE_WIPE_LEADS=1       (default 1 — clears lead-related rows, keeps users)
 */
import "dotenv/config";
import mongoose from "mongoose";
import { parsePhoneNumberFromString } from "libphonenumber-js";
import {
  User,
  Lead,
  Task,
  Activity,
  Meeting,
  Call,
  Demo,
  Proposal,
  Import,
  Notification,
  Exception,
  Handover,
  Attendance,
  CoachingAction,
  Device,
  Job,
} from "./models.js";

const SOURCE_URI = process.env.SOURCE_MONGO_URI;
const TARGET_URI = process.env.MONGODB_URI;
const SINCE_IST = process.env.MIGRATE_SINCE || "2026-10-25";
const WIPE = process.env.MIGRATE_WIPE_LEADS !== "0";

if (process.env.CONFIRM_MIGRATE !== "1") throw Error("Set CONFIRM_MIGRATE=1");
if (!SOURCE_URI) throw Error("SOURCE_MONGO_URI is required");
if (!TARGET_URI) throw Error("MONGODB_URI is required");

const since = new Date(`${SINCE_IST}T00:00:00+05:30`);

function normalizePhone(raw) {
  const s = String(raw || "").trim();
  if (!s) return null;
  const p = parsePhoneNumberFromString(s.startsWith("+") ? s : `+91${s.replace(/\D/g, "")}`, "IN");
  return p?.isValid() ? p.number : null;
}

const STAGE_BY_STATUS = {
  NEW_LEAD: "New",
  FIRST_TOUCH_PENDING: "New",
  WHATSAPP_SENT: "Contacting",
  CALL_PENDING: "Contacting",
  CONTACTED: "Contacting",
  CALLBACK_SCHEDULED: "Contacting",
  FOLLOW_UP_PENDING: "Qualified",
  FOLLOW_UP_NOT_DONE: "Qualified",
  SLA_MISSED: "Contacting",
  MEETING_TIME_PENDING: "Demo/Meeting",
  MEETING_SCHEDULED: "Demo/Meeting",
  QUOTE_REQUIRED: "Decision",
  QUOTE_SENT: "Decision",
  REVISED_QUOTE_SENT: "Decision",
  MOCKUP_REQUIRED: "Demo/Meeting",
  MOCKUP_SHARED: "Demo/Meeting",
  ADVANCE_PENDING: "Decision",
  ADVANCE_RECEIVED: "Won",
  NOT_REACHABLE: "Nurture",
  COLD: "Nurture",
  INVALID: "Lost",
  LOST: "Lost",
  WON: "Won",
  PROJECT_CREATED: "Won",
  CLIENT: "Won",
};

const TASK_KIND = {
  SEND_WHATSAPP: "send_details",
  FIRST_CALL: "call",
  FOLLOW_UP_CALL: "call",
  CONFIRM_MEETING_TIME: "confirm_meeting",
  MEETING_REMINDER: "meeting_prep",
  MEETING_STATUS_UPDATE: "meeting_result",
  SEND_QUOTE: "send_proposal",
  SEND_REVISED_QUOTE: "send_proposal",
  CREATE_MOCKUP: "send_demo",
  SHARE_MOCKUP: "send_demo",
  SCHEDULE_MOCKUP_MEETING: "confirm_meeting",
  COLLECT_ADVANCE: "internal",
  PROJECT_HANDOFF: "onboarding",
};

const TASK_STATUS = {
  PENDING: "open",
  OVERDUE: "open",
  RESCHEDULED: "open",
  DONE: "done",
  CANCELLED: "cancelled",
  NOT_DONE: "cancelled",
};

const source = await mongoose.createConnection(SOURCE_URI).asPromise();
const target = await mongoose.connect(TARGET_URI);

async function wipeLeadData() {
  const order = [
    [Notification, "notifications"],
    [CoachingAction, "coaching"],
    [Handover, "handovers"],
    [Exception, "exceptions"],
    [Job, "jobs"],
    [Activity, "activities"],
    [Task, "tasks"],
    [Call, "calls"],
    [Meeting, "meetings"],
    [Demo, "demos"],
    [Proposal, "proposals"],
    [Import, "imports"],
    [Attendance, "attendance"],
    [Device, "devices"],
    [Lead, "leads"],
  ];
  for (const [Model, label] of order) {
    const { deletedCount } = await Model.deleteMany({});
    console.log(`Cleared ${label}: ${deletedCount}`);
  }
}

if (WIPE) await wipeLeadData();

const targetUsers = await User.find({ active: true });
const byEmail = Object.fromEntries(targetUsers.map((u) => [u.email, u]));
const defaultOwner =
  byEmail["aswathy@swarna.local"] || targetUsers.find((u) => u.role === "agent") || targetUsers[0];
const defaultManager =
  byEmail["aadith@swarna.local"] || targetUsers.find((u) => u.role === "manager") || defaultOwner;

const sourceUsers = await source.db.collection("users").find({}).toArray();
const sourceUserMap = new Map();
for (const u of sourceUsers) {
  const email = String(u.email || "").toLowerCase();
  if (email.includes("akhila")) sourceUserMap.set(String(u._id), defaultOwner);
  else if (email.includes("admin")) sourceUserMap.set(String(u._id), defaultManager);
  else sourceUserMap.set(String(u._id), defaultOwner);
}

const ownerRef = (sourceUserId) => {
  const user = sourceUserMap.get(String(sourceUserId)) || defaultOwner;
  return new mongoose.Types.ObjectId(user._id);
};

const rawLeads = await source.db
  .collection("leads")
  .find({ createdAt: { $gte: since } })
  .sort({ createdAt: 1 })
  .toArray();

/** When multiple legacy rows share a phone, keep the newest row and remap older leadIds to it. */
const byPhonePick = new Map();
const legacyCollapse = new Map();
for (const l of rawLeads) {
  const p = normalizePhone(l.callPhone || l.phone || l.whatsappPhone);
  if (!p) continue;
  const prev = byPhonePick.get(p);
  if (!prev || +new Date(l.createdAt) >= +new Date(prev.createdAt)) {
    if (prev) legacyCollapse.set(String(prev._id), String(l._id));
    byPhonePick.set(p, l);
  } else {
    legacyCollapse.set(String(l._id), String(prev._id));
  }
}

const leadIdMap = new Map();
let skipped = 0;
const deduped = new Set();

for (const l of rawLeads) {
  const p = normalizePhone(l.callPhone || l.phone || l.whatsappPhone);
  if (!p) {
    skipped++;
    console.warn(`Skip lead ${l._id} (${l.name || l.businessName}): invalid phone`);
    continue;
  }
  const canonical = byPhonePick.get(p);
  if (!canonical || String(canonical._id) !== String(l._id)) {
    skipped++;
    continue;
  }
  if (deduped.has(p)) continue;
  deduped.add(p);
  const displayName = (l.businessName || l.name || "Unknown shop").trim();
  const stage = STAGE_BY_STATUS[l.status] || "Contacting";
  const requirements = Array.isArray(l.requirements) ? l.requirements.join(", ") : "";
  const doc = {
    name: displayName,
    phone: p,
    source: l.source || "Imported",
    location: l.place || undefined,
    owner: ownerRef(l.assignedTo),
    stage,
    ultra: (l.interestScore || 0) >= 8,
    needs: requirements || undefined,
    notes: l.tags?.length ? `Tags: ${l.tags.join(", ")}` : undefined,
    closeReason: l.status === "LOST" ? l.lostReason || "imported_lost" : undefined,
    doNotContact: l.status === "INVALID",
    lastContactAt: l.lastActivityAt || undefined,
    firstContactDueAt: l.createdAt,
    attribution: {
      migratedFrom: "internal-crm",
      legacyLeadId: String(l._id),
      legacyStatus: l.status,
      interestScore: l.interestScore,
      campaignName: l.campaignName,
      metaLeadId: l.metaLeadId,
    },
    createdAt: l.createdAt,
    updatedAt: l.updatedAt,
  };
  const created = await Lead.collection.insertOne(doc);
  leadIdMap.set(String(l._id), created.insertedId);
}

console.log(`Imported ${leadIdMap.size} leads (skipped ${skipped}, since ${SINCE_IST} IST)`);

function resolveLegacyLeadId(legacyId) {
  let id = String(legacyId);
  const seen = new Set();
  while (legacyCollapse.has(id) && !seen.has(id)) {
    seen.add(id);
    id = legacyCollapse.get(id);
  }
  return leadIdMap.get(id);
}

const legacyLeadIds = [...leadIdMap.keys(), ...legacyCollapse.keys()].map(
  (id) => new mongoose.Types.ObjectId(id)
);

const rawActivities = await source.db
  .collection("activities")
  .find({ leadId: { $in: legacyLeadIds } })
  .sort({ createdAt: 1 })
  .toArray();

const activityOps = [];
for (const a of rawActivities) {
  const lead = resolveLegacyLeadId(a.leadId);
  if (!lead) continue;
  const text = [a.title, a.description].filter(Boolean).join("\n");
  activityOps.push({
    insertOne: {
      document: {
        lead,
        actor: ownerRef(a.userId),
        type: `legacy_${String(a.type || "event").toLowerCase()}`,
        text,
        data: {
          legacyActivityId: String(a._id),
          legacyType: a.type,
          metadata: a.metadata,
          legacyStatus: a.metadata?.status,
        },
        createdAt: a.createdAt,
        updatedAt: a.updatedAt,
      },
    },
  });
}
if (activityOps.length) {
  const r = await Activity.collection.bulkWrite(activityOps, { ordered: false });
  console.log(`Imported activities: ${r.insertedCount}`);
}

const rawTasks = await source.db
  .collection("tasks")
  .find({ leadId: { $in: legacyLeadIds } })
  .sort({ createdAt: 1 })
  .toArray();

let tasksOpen = 0;
let tasksDone = 0;
for (const t of rawTasks) {
  const lead = resolveLegacyLeadId(t.leadId);
  if (!lead) continue;
  const status = TASK_STATUS[t.status] || "open";
  if (status === "open") tasksOpen++;
  if (status === "done") tasksDone++;
  await Task.collection.insertOne({
    key: `migrate:task:${t._id}`,
    lead,
    owner: ownerRef(t.assignedTo),
    title: t.title || t.type || "Task",
    kind: TASK_KIND[t.type] || "internal",
    status,
    dueAt: t.dueAt,
    originalDueAt: t.dueAt,
    doneAt: t.completedAt,
    customerFacing: ["FIRST_CALL", "FOLLOW_UP_CALL", "SEND_WHATSAPP"].includes(t.type),
    reason: t.description,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  });
}
console.log(`Imported tasks: ${rawTasks.length} (open: ${tasksOpen}, done: ${tasksDone})`);

const rawMeetings = await source.db
  .collection("meetings")
  .find({ leadId: { $in: legacyLeadIds } })
  .toArray();

for (const m of rawMeetings) {
  const lead = resolveLegacyLeadId(m.leadId);
  if (!lead) continue;
  const start = m.meetingAt ? new Date(m.meetingAt) : m.createdAt;
  const end = new Date(+start + 45 * 60000);
  const type = String(m.mode || "").toLowerCase().includes("physical") ? "physical" : "online";
  await Meeting.collection.insertOne({
    lead,
    bookedBy: ownerRef(m.assignedTo),
    reps: [ownerRef(m.assignedTo)],
    start,
    end,
    type,
    place: m.location || m.note || `${m.mode || "meeting"}`,
    confirmed: !!m.timeConfirmed,
    status: m.status === "CANCELLED" ? "cancelled" : m.status === "DONE" ? "done" : "scheduled",
    outcome:
      m.status === "DONE"
        ? m.resultNote
          ? "positive"
          : "unknown"
        : undefined,
    resultSaved: m.status === "DONE",
    createdAt: m.createdAt,
    updatedAt: m.updatedAt,
  });
}
console.log(`Imported meetings: ${rawMeetings.length}`);

await source.close();
await mongoose.disconnect();
console.log("Migration complete.");
