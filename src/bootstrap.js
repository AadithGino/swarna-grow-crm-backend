import "dotenv/config";
import mongoose from "mongoose";
import "./models.js";
export async function connect() {
  if (!process.env.MONGODB_URI) throw Error("Set MONGODB_URI");
  await mongoose.connect(process.env.MONGODB_URI);
  await Promise.all(Object.values(mongoose.models).map((m) => m.init()));
}
export function loop(fn, ms) {
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      await fn();
    } catch (e) {
      console.error(e.message);
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(tick, ms);
  tick();
  return timer;
}
