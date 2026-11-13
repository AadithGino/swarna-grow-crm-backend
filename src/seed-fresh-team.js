/**
 * Wipe CRM operational data and create a small team of users.
 *
 *   CONFIRM_DB_RESET=1 node src/seed-fresh-team.js
 *
 * Optional: TEAM_SEED_PASSWORD (defaults to SEED_PASSWORD)
 */
import "dotenv/config";
import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import {
  User,
  Lead,
  Task,
  Call,
  Meeting,
  Demo,
  Proposal,
  Import,
  Activity,
  Notification,
  Exception,
  Handover,
  Attendance,
  CoachingAction,
  Device,
  Job,
} from "./models.js";

if (process.env.CONFIRM_DB_RESET !== "1") {
  throw Error("Refusing to run without CONFIRM_DB_RESET=1");
}
if (!process.env.MONGODB_URI) throw Error("MONGODB_URI is required");

const password = process.env.TEAM_SEED_PASSWORD || process.env.SEED_PASSWORD;
if (!password?.length) throw Error("Set TEAM_SEED_PASSWORD or SEED_PASSWORD");

const team = [
  { name: "Aswathy", email: "aswathy@swarna.local", role: "agent" },
  { name: "Aadith", email: "aadith@swarna.local", role: "manager" },
  { name: "Sachu", email: "sachu@swarna.local", role: "manager" },
  { name: "Srijin", email: "srijin@swarna.local", role: "manager" },
];

await mongoose.connect(process.env.MONGODB_URI);

const wipe = async (Model, label) => {
  const { deletedCount } = await Model.deleteMany({});
  console.log(`Cleared ${label}: ${deletedCount}`);
};

await wipe(Notification, "notifications");
await wipe(CoachingAction, "coaching actions");
await wipe(Handover, "handovers");
await wipe(Exception, "exceptions");
await wipe(Activity, "activities");
await wipe(Task, "tasks");
await wipe(Call, "calls");
await wipe(Meeting, "meetings");
await wipe(Demo, "demos");
await wipe(Proposal, "proposals");
await wipe(Import, "imports");
await wipe(Attendance, "attendance");
await wipe(Job, "jobs");
await wipe(Device, "devices");
await wipe(Lead, "leads");
await wipe(User, "users");

const passwordHash = await bcrypt.hash(password, 12);
for (const u of team) {
  const email = u.email.toLowerCase();
  await User.create({
    name: u.name,
    email,
    role: u.role,
    active: true,
    passwordHash,
  });
  console.log(`Created ${u.role}: ${u.name} (${email})`);
}

await mongoose.disconnect();
console.log("Fresh team seed complete (Setting documents left unchanged).");
