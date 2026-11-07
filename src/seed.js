import "dotenv/config";
import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import { User } from "./models.js";
if (!process.env.SEED_EMAIL || process.env.SEED_PASSWORD?.length < 12)
  throw Error("Set SEED_EMAIL and SEED_PASSWORD (12+ characters)");
await mongoose.connect(process.env.MONGODB_URI);
await User.updateOne(
  { email: process.env.SEED_EMAIL.toLowerCase() },
  {
    $setOnInsert: {
      name: "Aadith",
      role: "manager",
      active: true,
      passwordHash: await bcrypt.hash(process.env.SEED_PASSWORD, 12),
    },
  },
  { upsert: true }
);
console.log("Manager account ready");
await mongoose.disconnect();
