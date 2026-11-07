import crypto from "node:crypto";
import { Setting, Notification, Import, User } from "./models.js";
export async function heartbeat(name, ok, error) {
  await Setting.updateOne(
    { key: `health:${name}` },
    {
      $set: {
        "value.at": new Date(),
        "value.ok": ok,
        "value.error": error || null,
        ...(ok ? { "value.lastSuccessAt": new Date() } : {}),
      },
    },
    { upsert: true }
  );
}
export async function leased(name, run, leaseMs = 120000) {
  const now = new Date(),
    token = crypto.randomUUID();
  let lock;
  try {
    lock = await Setting.findOneAndUpdate(
      {
        key: `lease:${name}`,
        $or: [{ "value.until": { $lt: now } }, { "value.until": null }],
      },
      { $set: { value: { until: new Date(+now + leaseMs), token } } },
      { upsert: true, new: true }
    );
  } catch (e) {
    if (e.code === 11000) return false;
    throw e;
  }
  if (!lock) return false;
  try {
    await run();
    await heartbeat(name, true);
    return true;
  } catch (e) {
    await heartbeat(name, false, e.message);
    throw e;
  } finally {
    await Setting.updateOne(
      { key: `lease:${name}`, "value.token": token },
      { $set: { "value.until": new Date(0) } }
    );
  }
}
export async function healthSnapshot() {
  const rows = await Setting.find({ key: /^health:/ });
  const components = Object.fromEntries(
    rows.map((x) => [x.key.slice(7), x.value])
  );
  const expected = ["sales", "meta", "delivery", "ai"];
  const stale = expected.filter(
    (k) =>
      !components[k]?.ok ||
      Date.now() - +new Date(components[k]?.lastSuccessAt || 0) >
        (["meta", "ai"].includes(k) ? 20 * 60000 : 4 * 60000)
  );
  const capture = await Setting.findOne({ key: "metaCheck" });
  if (
    process.env.META_FORM_IDS &&
    (!process.env.META_PAGE_TOKEN ||
      !capture?.value?.ok ||
      Date.now() - +new Date(capture.value.at || 0) > 30 * 60000)
  )
    stale.push("capture_reconciliation");
  if (
    await Import.exists({
      status: { $in: ["pending", "failed", "needs_review"] },
      createdAt: { $lt: new Date(Date.now() - 15 * 60000) },
    })
  )
    stale.push("capture_backlog");
  if (
    await Notification.exists({
      resolvedAt: null,
      acknowledgedAt: null,
      receivedAt: null,
      attempts: { $gte: 3 },
    })
  )
    stale.push("delivery_unconfirmed");
  if (!(await User.exists({ role: "manager", active: true })))
    stale.push("no_active_manager");
  return {
    readiness: {
      pushConfigured: !!process.env.FIREBASE_SERVICE_ACCOUNT_JSON,
      metaConfigured:
        !!process.env.META_PAGE_TOKEN && !!process.env.META_FORM_IDS,
    },
    ok:
      stale.length === 0 &&
      (process.env.REQUIRE_PUSH !== "true" ||
        !!process.env.FIREBASE_SERVICE_ACCOUNT_JSON),
    at: new Date(),
    stale,
    components,
  };
}
