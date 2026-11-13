import "dotenv/config";
import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import { User } from "./models.js";
if (!process.env.SEED_EMAIL || !process.env.SEED_PASSWORD?.length)
  throw Error("Set SEED_EMAIL and SEED_PASSWORD");
await mongoose.connect(process.env.MONGODB_URI);
const email = process.env.SEED_EMAIL.toLowerCase();
const passwordHash = await bcrypt.hash(process.env.SEED_PASSWORD, 12);
const { modifiedCount, upsertedCount } = await User.updateOne(
  { email },
  {
    $set: {
      name: "Aadith",
      role: "manager",
      active: true,
      passwordHash,
    },
  },
  { upsert: true }
);
console.log(
  `Manager account ready (${email}, ${modifiedCount || upsertedCount ? "updated" : "unchanged"})`
);
await mongoose.disconnect();
