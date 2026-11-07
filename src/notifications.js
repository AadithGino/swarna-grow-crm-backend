import crypto from "node:crypto";
import { Notification, Device, User } from "./models.js";
export async function notify(user, key, title, body, extra = {}) {
  if (!user) return;
  return Notification.findOneAndUpdate(
    { key: `${key}:${user}` },
    {
      $setOnInsert: { user, title, body, ...extra, nextAttemptAt: new Date() },
    },
    { upsert: true, new: true }
  );
}
export async function notifyManagers(key, title, body, extra = {}) {
  for (const u of await User.find({ role: "manager", active: true }))
    await notify(u.id, key, title, body, extra);
}
let messaging;
async function sender() {
  if (messaging) return messaging;
  if (!process.env.FIREBASE_SERVICE_ACCOUNT_JSON)
    throw Error("Push not configured: FIREBASE_SERVICE_ACCOUNT_JSON");
  const { initializeApp, cert, getApps } = await import("firebase-admin/app");
  const { getMessaging } = await import("firebase-admin/messaging");
  const app =
    getApps().find((a) => a.name === "crm-push") ||
    initializeApp(
      {
        credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)),
      },
      "crm-push"
    );
  return (messaging = getMessaging(app));
}
export async function deliverOne(send) {
  const now = new Date(),
    leaseToken = crypto.randomUUID();
  const n = await Notification.findOneAndUpdate(
    {
      resolvedAt: null,
      acknowledgedAt: null,
      receivedAt: null,
      nextAttemptAt: { $lte: now },
      $or: [{ lockedUntil: null }, { lockedUntil: { $lt: now } }],
    },
    {
      $set: { lockedUntil: new Date(+now + 90000), leaseToken },
      $inc: { attempts: 1 },
    },
    { new: true, sort: { nextAttemptAt: 1 } }
  );
  if (!n) return false;
  try {
    const devices = await Device.find({
      user: n.user,
      enabled: true,
      token: { $nin: ["", null] },
    });
    if (!devices.length)
      throw Error("No registered notification-enabled device");
    const user = await User.findById(n.user);
    if (!user?.active) throw Error("Recipient inactive");
    let accepted = false,
      lastError;
    for (const d of devices) {
      try {
        await (
          send ||
          (async (message) => {
            let timer;
            try {
              return await Promise.race([
                (await sender()).send(message),
                new Promise((_, reject) => {
                  timer = setTimeout(
                    () => reject(Error("Push send timed out")),
                    20000
                  );
                }),
              ]);
            } finally {
              clearTimeout(timer);
            }
          })
        )({
          token: d.token,
          data: {
            notificationId: n.id,
            userId: String(n.user),
            title: n.title,
            body: n.body,
          },
          android: { priority: "high", ttl: 3600000 },
        });
        accepted = true;
      } catch (e) {
        if (
          [
            "messaging/registration-token-not-registered",
            "messaging/invalid-registration-token",
          ].includes(e.code)
        )
          await Device.updateOne({ _id: d.id }, { $set: { enabled: false } });
        else lastError = e;
      }
    }
    if (!accepted) throw lastError || Error("No valid push token");
    await Notification.updateOne(
      { _id: n.id, leaseToken },
      {
        $set: {
          acceptedAt: now,
          nextAttemptAt: new Date(+now + 15 * 60000),
          error: null,
        },
        $unset: { lockedUntil: 1, leaseToken: 1 },
      }
    );
  } catch (e) {
    await Notification.updateOne(
      { _id: n.id, leaseToken },
      {
        $set: {
          error: e.message,
          nextAttemptAt: new Date(
            +now + Math.min(30, 2 ** Math.min(n.attempts, 5)) * 60000
          ),
        },
        $unset: { lockedUntil: 1, leaseToken: 1 },
      }
    );
  }
  return true;
}
