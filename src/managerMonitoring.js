import { Activity, Call, Demo, Exception, Handover, Meeting, Task } from "./models.js";
import { customerTask } from "./policy.js";

export async function managerMonitoring(since, until, overdue, leads) {
  const range = { $gte: since, $lte: until };
  const [exceptions, handovers, missedMeetings, tasks, bookings, attendance, demos, wins, unmatched] =
    await Promise.all([
      Exception.find({ status: "open", type: { $in: ["first_contact", "demo_delay"] } }).populate("lead owner", "name").lean(),
      Handover.find({ status: "pending" }).populate("lead from to", "name").lean(),
      Meeting.find({ status: "scheduled", end: { $lt: until } }).populate("lead reps", "name").lean(),
      Task.find({ status: { $in: ["open", "done"] }, originalDueAt: range }).populate("lead", "name").lean(),
      Activity.find({ type: { $in: ["meeting_booked", "call_outcome", "task_completed", "meeting_outcome"] }, createdAt: range })
        .select("actor lead type data createdAt").populate("lead", "name").lean(),
      Meeting.find({ status: "completed", end: range }).select("lead reps end").populate("lead", "name").lean(),
      Demo.find({ sentAt: range }).select("lead owner sentBy sentAt").populate("lead", "name").lean(),
      Activity.find({ type: "updated", "data.stage": "Won", createdAt: range })
        .populate("lead", "name").lean(),
      Call.find({
        direction: "incoming", technicalResult: "missed_incoming", lead: null, endedAt: { $lte: until },
      }).select("number endedAt agent").populate("agent", "name").sort({ endedAt: -1 }).lean(),
    ]);

  const seenNumbers = new Set();
  const unmatchedPending = [];
  for (const call of unmatched) {
    if (!call.number || seenNumbers.has(call.number)) continue;
    seenNumbers.add(call.number);
    const returned = await Call.exists({
      number: call.number, startedAt: { $gte: call.endedAt },
      $or: [{ direction: "outgoing", "events.type": "DIALING" }, { answeredAt: { $gte: call.endedAt } }],
    });
    if (!returned) unmatchedPending.push({
      id: call._id, owner: call.agent, title: "Unmatched missed call", detail: call.number,
      at: call.endedAt, action: "Open calls",
    });
  }
  const leadById = new Map(leads.map(lead => [lead.id, lead]));
  const firstContactTasks = new Set(exceptions.map(item => String(item.task)));
  const attention = [
    ...unmatchedPending,
    ...exceptions.map(item => ({
      id: item._id, lead: item.lead, owner: item.owner, title: item.title,
      taskId: item.task, demoId: item.type === "demo_delay" ? item.key?.split(":")[1] : undefined,
      at: overdue.find(task => task.id === String(item.task))?.dueAt ||
        (item.type === "first_contact" && leadById.get(String(item.lead?._id))?.firstContactDueAt) || item.createdAt,
      action: item.type === "demo_delay" ? "Open demos" : "Open lead", detail: item.detail,
    })),
    ...overdue.filter(task => customerTask(task) && !firstContactTasks.has(task.id)).map(task => ({
      id: task.id, taskId: task.id, lead: task.lead, owner: task.owner, title: task.title,
      at: task.dueAt, action: "Open lead",
    })),
    ...missedMeetings.map(item => ({
      id: item._id, lead: item.lead, owner: item.reps[0], title: "Meeting needs a result",
      at: item.end, action: "Open meetings",
    })),
    ...handovers.map(item => ({
      id: item._id, lead: item.lead, owner: item.from, title: "Handover awaiting acceptance",
      at: item.expiresAt, action: "Open handovers", detail: item.to?.name,
    })),
  ].sort((a, b) => +new Date(a.at) - +new Date(b.at));

  const byEmployee = new Map();
  function record(owner, metric, item) {
    if (!owner) return;
    const key = String(owner);
    if (!byEmployee.has(key)) byEmployee.set(key, {});
    const employee = byEmployee.get(key);
    (employee[metric] ||= []).push(item);
  }
  for (const task of tasks.filter(customerTask)) {
    record(task.owner, "followUpsDue", task);
    if (task.status === "done" && task.doneAt && task.doneAt <= task.originalDueAt)
      record(task.owner, "followUpsOnTime", task);
  }
  for (const row of bookings) {
    if (row.type === "meeting_booked" || row.data?.outcome === "meeting_booked")
      record(row.actor, "bookings", row);
  }
  for (const row of attendance)
    for (const rep of row.reps) record(rep, "meetingsHeld", row);
  for (const row of demos) record(row.sentBy || row.owner, "demosSent", row);
  const seenWins = new Set();
  for (const row of wins.filter(row => leadById.get(String(row.lead?._id))?.stage === "Won").sort((a, b) => +b.createdAt - +a.createdAt)) {
    if (!row.lead || seenWins.has(String(row.lead._id))) continue;
    seenWins.add(String(row.lead._id));
    record(row.actor, "wins", row);
  }
  return { attention, byEmployee };
}
