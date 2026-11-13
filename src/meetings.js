import mongoose from "mongoose";
import { Meeting, User, Setting, Task, Lead } from "./models.js";
const reject = (message, status = 422) =>
  Object.assign(new Error(message), { status });
export async function meetingInput(input) {
  const b = input || {},
    start = new Date(b.start),
    end = new Date(b.end);
  if (
    !Number.isFinite(+start) ||
    !Number.isFinite(+end) ||
    start <= new Date() ||
    end <= start ||
    +end - +start > 8 * 3600000
  )
    throw reject(
      "Choose a future meeting date, time and duration (up to 8 hours)."
    );
  if (!["online", "physical"].includes(b.type))
    throw reject("Choose online or physical meeting.");
  if (
    !Array.isArray(b.reps) ||
    !b.reps.length ||
    !b.reps.every((x) => mongoose.isValidObjectId(x))
  )
    throw reject("Assign at least one meeting rep.");
  const reps = [...new Set(b.reps)];
  if (
    (await User.countDocuments({ _id: { $in: reps }, active: true })) !==
    reps.length
  )
    throw reject("One of the selected reps is unavailable.");
  const away = await User.exists({
    _id: { $in: reps },
    availability: "away",
    $or: [{ awayUntil: null }, { awayUntil: { $gt: start } }],
  });
  if (away)
    throw reject(
      "One of the reps is away at that meeting time. Select available coverage."
    );
  const pending = b.type === "online" && !!b.placePending,
    place = String(b.place || "").trim();
  if (!pending && !place)
    throw reject(
      b.type === "online"
        ? "Enter the meeting link, or select “Send link later”."
        : "Enter the meeting location."
    );
  if (b.type === "online" && !pending && !/^https?:\/\//i.test(place))
    throw reject("Enter a full meeting URL, or choose to send the link later.");
  const travel = Number(b.travelMinutes || 0);
  if (!Number.isFinite(travel) || travel < 0 || travel > 240)
    throw reject("Travel buffer must be 0–240 minutes.");
  return {
    start,
    end,
    type: b.type,
    reps,
    place: pending ? "To be confirmed" : place,
    placePending: pending,
    travelMinutes: b.type === "physical" ? travel : 0,
    confirmed: !!b.confirmed,
  };
}
export async function ensureCalendarLocks(b) {
  for (const rep of b.reps) {
    try {
      await Setting.updateOne(
        { key: `calendar:${rep}` },
        { $setOnInsert: { value: { version: 0 } } },
        { upsert: true }
      );
    } catch (e) {
      if (e.code !== 11000) throw e;
    }
  }
}
async function insertTask(
  lead,
  title,
  dueAt,
  key,
  kind,
  session,
  owner,
  fixed = false
) {
  await Task.updateOne(
    { key },
    {
      $setOnInsert: {
        lead: lead._id,
        owner: owner || lead.owner,
        title,
        dueAt,
        originalDueAt: dueAt,
        kind,
        fixed,
      },
    },
    { upsert: true, session }
  );
}
export async function bookMeeting(lead, b, session, sourceCall, bookedBy) {
  if (lead.doNotContact || ["Won", "Lost"].includes(lead.stage))
    throw reject("Reopen the lead before booking a meeting.");
  for (const rep of [...b.reps].sort())
    await Setting.updateOne(
      { key: `calendar:${rep}` },
      { $inc: { "value.version": 1 } },
      { session }
    );
  const conflict = await Meeting.exists({
    status: "scheduled",
    reps: { $in: b.reps },
    start: { $lt: new Date(+b.end + b.travelMinutes * 60000) },
    $expr: {
      $gt: [
        {
          $add: [
            "$end",
            { $multiply: [{ $ifNull: ["$travelMinutes", 0] }, 60000] },
          ],
        },
        new Date(+b.start - b.travelMinutes * 60000),
      ],
    },
  }).session(session);
  if (conflict)
    throw reject(
      "This rep already has a meeting or travel commitment at that time. Pick another time or rep.",
      409
    );
  const [m] = await Meeting.create(
    [{ lead: lead._id, ...b, bookedBy, ...(sourceCall ? { sourceCall } : {}) }],
    { session }
  );
  await Lead.updateOne(
    { _id: lead._id },
    { $set: { stage: "Demo/Meeting", pauseUntil: b.start } },
    { session }
  );
  const now = new Date(),
    prep = new Date(Math.max(+now, +b.start - (b.travelMinutes + 30) * 60000));
  await insertTask(
    lead,
    "Prepare for meeting",
    prep,
    `meeting-prep:${m.id}`,
    "meeting_prep",
    session,
    b.reps[0],
    true
  );
  if (!b.confirmed)
    await insertTask(
      lead,
      "Confirm meeting with customer",
      new Date(Math.max(+now, +b.start - 86400000)),
      `meeting-confirm:${m.id}`,
      "confirmation",
      session
    );
  if (b.placePending)
    await insertTask(
      lead,
      b.type === "online"
        ? "Create and send meeting link"
        : "Confirm meeting location",
      now,
      `meeting-place:${m.id}`,
      "meeting_prep",
      session,
      b.reps[0]
    );
  return m;
}
