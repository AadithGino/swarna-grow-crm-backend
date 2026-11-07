import { Setting } from "./models.js";
import { workSlot } from "./rules.js";
export const defaults = {
  autoCoverage: 1,
  firstContactMinutes: 15,
  remindBeforeMinutes: 10,
  managerEscalationMinutes: 30,
  criticalEscalationMinutes: 120,
  snoozeLimit: 3,
  staleDeviceMinutes: 45,
  handoverMinutes: 30,
  logoMinutes: 240,
  prepareMinutes: 510,
  shareMinutes: 30,
  responseMinutes: 510,
};
export async function policy() {
  return {
    ...defaults,
    ...(await Setting.findOne({ key: "operations-policy" }))?.value,
  };
}
export function addWorkMinutes(at, minutes) {
  let d = workSlot(at),
    left = minutes;
  for (let i = 0; i < 366 && left > 0; i++) {
    const local = new Date(+d + 330 * 60000),
      end = new Date(local);
    end.setUTCHours(18, 0, 0, 0);
    const available = (+end - 330 * 60000 - +d) / 60000;
    if (left <= available) return new Date(+d + left * 60000);
    left -= available;
    d = workSlot(+end - 330 * 60000 + 1000);
  }
  if (left) throw Error("Working time outside supported range");
  return d;
}
export const customerKinds = [
  "call",
  "send_details",
  "send_demo",
  "confirm_meeting",
  "confirmation",
  "proposal_follow",
  "demo_response",
];
export function customerTask(task) {
  return (
    task.customerFacing === true ||
    (task.customerFacing !== false && customerKinds.includes(task.kind))
  );
}
export const unavailable = (u, now = new Date()) =>
  !u?.active ||
  (u.availability === "away" && (!u.awayUntil || u.awayUntil > now));
