import { actionQueue, sourceFunnel } from "./managerActions.js";
import express from "express";
import mongoose from "mongoose";
import { Attendance, Call, Demo, Lead, Meeting, Notification, Task, User } from "./models.js";
import { customerTask } from "./policy.js";
import { notify, notifyManagers } from "./notifications.js";

const offset = 330 * 60000;
const day = date => new Date(+date + offset).toISOString().slice(0, 10);
const start = key => new Date(key + "T00:00:00+05:30");
const dayMs = 86400000;
const router = express.Router();
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);

router.get("/attendance", wrap(async (req, res) => {
  res.json(await Attendance.findOne({ agent: req.user.id, day: day(new Date()) }));
}));

router.post("/attendance/:action", wrap(async (req, res) => {
  const now = new Date();
  const key = { agent: req.user.id, day: day(now) };
  if (req.params.action === "in") {
    await Attendance.updateOne(key, { $setOnInsert: { ...key, checkedInAt: now } }, { upsert: true });
  } else if (req.params.action === "out") {
    const row = await Attendance.findOneAndUpdate(
      { ...key, checkedOutAt: null }, { $set: { checkedOutAt: now } }, { new: true },
    );
    if (!row && !(await Attendance.exists(key))) return res.status(409).json({ error: "Check in first" });
  } else return res.status(404).json({ error: "Unknown attendance action" });
  res.json(await Attendance.findOne(key));
}));

const outbound = call => call.direction === "outgoing";
const tally = values => {
  const counts = new Map();
  for (const value of values) {
    if (typeof value !== "string" || !value.trim()) continue;
    const label = value.trim().toLowerCase();
    counts.set(label, (counts.get(label) || 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([label, count]) => ({ label, count }));
};
export function summarizeCalls(calls) {
  const attempts = calls.filter(outbound);
  const answered = attempts.filter(call => call.answeredAt);
  const slots = new Map();
  const dates = new Map();
  for (const call of attempts) {
    const local = new Date(+new Date(call.startedAt) + offset);
    const slot = `${["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][local.getUTCDay()]} ${String(local.getUTCHours()).padStart(2,"0")}:00`;
    for (const [map, key] of [[slots, slot], [dates, day(new Date(call.startedAt))]]) {
      if (!map.has(key)) map.set(key, { label: key, attempts: 0, answered: 0 });
      const item = map.get(key);
      item.attempts++;
      if (call.answeredAt) item.answered++;
    }
  }
  return {
    attempts: attempts.length, answered: answered.length,
    averageSeconds: answered.length ? Math.round(answered.reduce((sum, call) => sum + (call.activeMs || 0), 0) / answered.length / 1000) : 0,
    slots: [...slots.values()].sort((a, b) => b.answered - a.answered),
    dates: [...dates.values()].sort((a, b) => a.label.localeCompare(b.label)),
    outcomes: tally(answered.map(call => call.outcome || "unclassified")),
  };
}
export function activityDays(calls, attendance) {
  const rows = new Map(attendance.map(row => [row.day, { day: row.day, checkedInAt: row.checkedInAt, checkedOutAt: row.checkedOutAt, calls: [] }]));
  for (const call of calls.filter(outbound)) {
    const key = day(call.startedAt);
    if (!rows.has(key)) rows.set(key, { day: key, calls: [] });
    rows.get(key).calls.push(call);
  }
  return [...rows.values()].sort((a,b) => b.day.localeCompare(a.day)).map(({ calls: list, ...row }) => {
    list.sort((a,b) => +a.startedAt - +b.startedAt);
    let gap = null;
    let lastEnd = null;
    for (const call of list) {
      if (lastEnd && +call.startedAt > +lastEnd && (!gap || +call.startedAt - +lastEnd > gap.ms))
        gap = { from: lastEnd, to: call.startedAt, ms: +call.startedAt - +lastEnd };
      if (!call.endedAt) lastEnd = null;
      else if (!lastEnd || call.endedAt > lastEnd) lastEnd = call.endedAt;
    }
    return { ...row, calls: list.length, firstCall: list[0]?.startedAt, lastCall: list.at(-1)?.startedAt, gap };
  });
}
export async function tomorrowCommitments(now) {
  const from = new Date(+start(day(now)) + dayMs);
  const period = { $gte: from, $lt: new Date(+from + dayMs) };
  const [meetings, tasks] = await Promise.all([
    Meeting.find({ status: "scheduled", start: period }).populate("lead", "name owner stage doNotContact")
      .populate("reps", "name").lean(),
    Task.find({ status: "open", dueAt: period }).populate("lead", "name owner stage doNotContact")
      .populate("owner", "name").lean(),
  ]);
  const active = row => row.lead && !row.lead.doNotContact && !["Won", "Lost"].includes(row.lead.stage);
  const meetingRows = meetings.filter(active);
  const overlaps = (a, b) => a.reps.some(rep => b.reps.some(other => String(other._id) === String(rep._id))) &&
    +a.start - (a.travelMinutes || 0) * 60000 < +b.end + (b.travelMinutes || 0) * 60000 &&
    +b.start - (b.travelMinutes || 0) * 60000 < +a.end + (a.travelMinutes || 0) * 60000;
  return [
    ...meetingRows.map(row => ({ id: row._id, type: "meeting", lead: row.lead,
      title: row.confirmed ? "Confirmed meeting" : "Meeting awaiting confirmation", dueAt: row.start,
      owner: { _id: row.reps[0]?._id, name: row.reps.map(rep => rep.name).join(", ") },
      staff: [row.bookedBy, ...row.reps.map(rep => rep._id)], conflict: meetingRows.some(other => other !== row && overlaps(row, other)), priority: 0 })),
    ...tasks.filter(row => active(row) && (customerTask(row) || row.key?.startsWith("meeting-place:")))
      .map(row => ({ id: row._id, type: "task", lead: row.lead, title: row.title,
        dueAt: row.dueAt, owner: row.owner, priority: row.fixed || row.key?.startsWith("meeting-") ? 0 : 1 })),
  ].sort((a, b) => a.priority - b.priority || +a.dueAt - +b.dueAt);
}
router.get("/management/tomorrow", wrap(async (req, res) => {
  if (req.user.role !== "manager") return res.sendStatus(403);
  res.json(await tomorrowCommitments(new Date()));
}));

export async function managementReport(agent, from, to) {
  const period = { $gte: start(from), $lt: new Date(+start(to) + dayMs) };
  const callMeetings = await Call.find({ agent, meeting: { $ne: null, $exists: true } }).distinct("meeting");
  const [calls, attendance, leads, meetings, demos, tasks, demoTasks, upcomingMeetings, liveDemos] = await Promise.all([
    Call.find({ agent, startedAt: period }).select("-transcript -events -recordingKey -aiError").populate("lead", "name source").sort({ startedAt: -1 }).lean(),
    Attendance.find({ agent, day: { $gte: from, $lte: to } }).lean(),
    Lead.find({ owner: agent, createdAt: period }).select("name source stage createdAt").lean(),
    Meeting.find({ $or: [{ bookedBy: agent }, { reps: agent }, { _id: { $in: callMeetings } }], $and: [{ $or: [{ createdAt: period }, { start: period }] }] }).populate("lead", "name").sort("start").lean(),
    Demo.find({ $and: [{ $or: [{ owner: agent }, { sentBy: agent }] }, { $or: [{ sentAt: period }, { firstExploredAt: period }, { walkthroughCompletedAt: period }] }] }).select("lead shopName status sentAt firstExploredAt walkthroughCompletedAt customerResponse stageDueAt").populate("lead", "name").lean(),
    Task.find({ owner: agent, status: "open", dueAt: { $lte: new Date() } }).select("title dueAt lead").populate("lead", "name").sort("dueAt").lean(),
    Task.find({ owner: agent, status: "open", $or: [{ demo: { $exists: true } }, { key: /^demo-response-next:/ }] }).select("demo key dueAt").lean(),
    Meeting.find({ status: "scheduled", start: { $gte: new Date() }, $or: [{ bookedBy: agent }, { reps: agent }] })
      .populate("lead", "name").sort("start").lean(),
    Demo.find({ $or: [{ owner: agent }, { sentBy: agent }], status: { $in: ["sent", "explored", "responded"] } })
      .select("lead shopName status sentAt firstExploredAt walkthroughCompletedAt customerResponse")
      .populate("lead", "name").lean(),
  ]);
  for (const demo of liveDemos) {
    const related = demoTasks.filter(task => String(task.demo) === String(demo._id) || task.key === `demo-response-next:${demo._id}`);
    demo.followUpAt = related.sort((a, b) => a.dueAt - b.dueAt)[0]?.dueAt;
  }
  const assessed = calls.filter(call => call.ai?.scriptAssessment);
  const pitchPoints = new Map(), versions = new Map();
  const completedAtByLead = new Map();
  for (const demo of demos) {
    if (!demo.lead || !demo.walkthroughCompletedAt) continue;
    const id = String(demo.lead._id);
    completedAtByLead.set(id, Math.max(completedAtByLead.get(id) || 0, +demo.walkthroughCompletedAt));
  }
  for (const call of assessed) {
    const rubric = call.ai.scriptAssessment.rubric || "Unversioned";
    const source = call.lead?.source || "Unknown";
    const versionKey = JSON.stringify([rubric, source]);
    const version = versions.get(versionKey) || { rubric, source, calls: 0, assessedSteps: 0, covered: 0, objections: [], leads: new Set(), demos: new Set() };
    if (call.lead) {
      const id = String(call.lead._id);
      version.leads.add(id);
      if (completedAtByLead.get(id) > +call.startedAt) version.demos.add(id);
    }
    version.calls++;
    version.objections.push(...(call.ai.objections || []));
    versions.set(versionKey, version);
    for (const step of call.ai.scriptAssessment.steps || []) {
      const point = pitchPoints.get(step.key) || { key: step.key, label: step.label || step.key, covered: 0, partial: 0, missed: 0, unassessable: 0 };
      if (!Object.hasOwn(point, step.status) || !["covered", "partial", "missed", "unassessable"].includes(step.status)) continue;
      point[step.status]++;
      pitchPoints.set(step.key, point);
      if (step.status !== "unassessable") version.assessedSteps++;
      if (step.status === "covered") version.covered++;
    }
  }
  const signals = calls.map(call => call.ai?.salesSignals || {});
  const missed = assessed.flatMap(call => (call.ai.scriptAssessment.steps || []).filter(step => ["partial", "missed"].includes(step.status)).map(step => step.label));
  return {
    from, to, stats: summarizeCalls(calls), attendance: activityDays(calls, attendance),
    leads, leadSources: tally(leads.map(lead => lead.source || "Unknown")),
    leadStages: tally(leads.map(lead => lead.stage)), meetings, demos, calls, live: { overdueTasks: tasks, upcomingMeetings, demos: liveDemos },
    coaching: {
      assessed: assessed.length, signalCalls: signals.filter(signal => signal.questions).length,
      objections: tally(calls.flatMap(call => call.ai?.objections || [])),
      questions: tally(signals.flatMap(signal => signal.questions || []).map(item => item.topic)),
      interest: tally(signals.map(signal => signal.interest || "unknown")),
      doubts: tally(signals.flatMap(signal => signal.doubts || []).map(item => item.section)),
      interruptions: tally(signals.flatMap(signal => signal.interruptions || []).map(item => item.section)),
      missed: tally(missed),
      pitchPoints: [...pitchPoints.values()].sort((a, b) => b.missed + b.partial - a.missed - a.partial),
      versions: [...versions.values()].map(({ leads, demos, ...row }) => ({
        ...row, linkedLeads: leads.size, laterDemoLeads: demos.size, objections: tally(row.objections).slice(0, 3),
      })),

    },
  };
}

router.get("/management/staff", wrap(async (req, res) => {
  if (req.user.role !== "manager") return res.sendStatus(403);
  res.json(await User.find({ active: true, role: { $ne: "manager" } }).select("name role").sort("name"));
}));

router.get("/management/report", wrap(async (req, res) => {
  if (req.user.role !== "manager") return res.sendStatus(403);
  const { agent, from = day(new Date()), to = from } = req.query;
  const valid = key => typeof key === "string" && /^\d{4}-\d{2}-\d{2}$/.test(key) &&
    Number.isFinite(+start(key)) && day(start(key)) === key;
  if (!mongoose.isValidObjectId(agent) || !valid(from) || !valid(to) || from > to || start(to) - start(from) > 365 * dayMs)
    return res.status(422).json({ error: "Select an employee and a date range of up to 366 days" });
  const report = await managementReport(agent, from, to);
  report.funnel = await sourceFunnel({ $gte: start(from), $lt: new Date(+start(to) + dayMs) }, agent);
  if (req.query.summary === "1") delete report.calls;
  res.json(report);
}));

router.get("/management/daily-reports", wrap(async (req, res) => {
  if (req.user.role !== "manager") return res.sendStatus(403);
  res.json(await Notification.find({ user: req.user.id, category: "daily_report" })
    .select("title body createdAt").sort({ createdAt: -1 }).limit(31).lean());
}));

export async function managementReminders(now = new Date()) {
  const date = day(now);
  const local = new Date(+now + offset);
  const configured = Number(process.env.DAILY_REPORT_HOUR_IST || 19);
  const close = Number.isInteger(configured) && configured >= 0 && configured <= 23 ? configured : 19;
  const upcoming = await Meeting.find({
    status: "scheduled", start: { $gt: now, $lte: new Date(+now + 30 * 60000) },
  }).populate("lead", "name").lean();
  for (const meeting of upcoming) {
    const key = `meeting-reminder:${meeting._id}:${+meeting.start}`;
    const title = "Meeting in the next 30 minutes";
    const body = `${meeting.lead?.name || "Client meeting"} · ${meeting.start.toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" })} IST`;
    const extra = { category: "meeting", lead: meeting.lead?._id };
    for (const recipient of new Set([...meeting.reps, meeting.bookedBy].filter(Boolean).map(String)))
      await notify(recipient, key, title, body, extra);
    await notifyManagers(key, title, body, extra);
  }
  if (local.getUTCHours() < close) return;
  const [queue, tomorrow] = await Promise.all([actionQueue(now), tomorrowCommitments(now)]);
  const managers = await User.find({ active: true, role: "manager" }).distinct("_id");
  for (const agent of await User.find({ active: true, role: "agent" }).select("name").lean()) {
    const key = `daily-report:${date}:${agent._id}`;
    if (!managers.length || await Notification.countDocuments({
      key: { $in: managers.map(id => `${key}:${id}`) },
    }) === managers.length) continue;
    const report = await managementReport(agent._id, date, date);
    const attendance = report.attendance.find(row => row.day === date);
    const belongs = item => [item.owner?._id, item.lead?.owner, ...(item.staff || [])]
      .some(id => String(id) === String(agent._id));
    const commitments = tomorrow.filter(belongs);
    const backlog = queue.filter(item => belongs(item) && +new Date(item.dueAt) <= +now);
    if (!attendance && !report.stats.attempts && !report.leads.length && !commitments.length && !backlog.length) continue;
    const { attempts, answered, averageSeconds } = report.stats;
    const format = at => at ? new Date(at).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" }) : "not recorded";
    const meetingsBooked = report.meetings.filter(row => row.bookedBy?.equals(agent._id) && day(row.createdAt) === date).length;
    const demoFollowUps = report.live.demos.filter(row => row.followUpAt && (row.walkthroughCompletedAt || row.firstExploredAt || row.status === "responded")).length;
    const objection = report.coaching.objections[0]?.label;
    const lines = items => items.slice(0, 8).map(item =>
      `${item.title} · ${item.lead?.name || "Lead"} · ${item.owner?.name || "Unassigned"} · ${day(new Date(item.dueAt))} ${format(item.dueAt)} IST`
    ).join("\n") || "None";
    const priorityText = `Tomorrow’s commitments (${commitments.length}) · Open Live tomorrow in the manager portal\n${lines(commitments)}\n\nOverdue backlog (${backlog.length})\n${lines(backlog)}\n\n`;
    const body = priorityText + `${attempts} outbound, ${answered} connected, ${averageSeconds}s average connected. ${report.leads.length} new leads, ${report.live.overdueTasks.length} overdue actions. ${meetingsBooked} meetings booked, ${demoFollowUps} engaged demo follow-ups open, ${report.coaching.assessed} calls assessed.${objection ? " Top objection: " + objection + "." : ""} In ${format(attendance?.checkedInAt)}, out ${format(attendance?.checkedOutAt)}. First call ${format(attendance?.firstCall)}, last ${format(attendance?.lastCall)}. Longest observed gap ${attendance?.gap ? Math.round(attendance.gap.ms / 60000) + " min" : "unavailable"}.`;
    const entries = rows => rows.map(item => ({
      id: item.id, type: item.type, title: item.title, leadId: item.lead?._id,
      lead: item.lead?.name, owner: item.owner?.name, dueAt: item.dueAt,
    }));
    const snapshot = { agent: String(agent._id), date, attempts, answered, averageSeconds,
      newLeads: report.leads.length, overdue: report.live.overdueTasks.length,
      meetingsBooked, demoFollowUps, assessed: report.coaching.assessed, objection,
      attendance: attendance ? { checkedInAt: attendance.checkedInAt, checkedOutAt: attendance.checkedOutAt,
        firstCall: attendance.firstCall, lastCall: attendance.lastCall, gap: attendance.gap } : null,
      commitments: entries(commitments), backlog: entries(backlog), commitmentCount: commitments.length, backlogCount: backlog.length,
    };
    await notifyManagers(key, `${agent.name} · ${date}`, body, { category: "daily_report", snapshot });
    if (attendance?.checkedInAt && !attendance.checkedOutAt)
      await notify(agent._id, `checkout:${date}`, "Remember to check out", "Open Attendance when you finish.", { category: "attendance" });
  }
}

export default router;
