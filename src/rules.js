import { parsePhoneNumberFromString } from "libphonenumber-js";
export function phone(value) {
  const p = parsePhoneNumberFromString(String(value || ""), "IN");
  if (!p?.isValid())
    throw new Error("Enter a valid phone number with country code");
  return p.number;
}
export function workSlot(date = new Date(), exact = false) {
  let d = new Date(date);
  if (!Number.isFinite(+d)) throw new Error("Invalid date");
  if (exact) return d;
  // Business hours 09:30–18:00 Asia/Kolkata, Monday–Saturday. Stored in UTC.
  for (let n = 0; n < 10; n++) {
    let local = new Date(+d + 330 * 60000);
    let minutes = local.getUTCHours() * 60 + local.getUTCMinutes();
    if (local.getUTCDay() === 0 || minutes >= 1080) {
      local.setUTCDate(local.getUTCDate() + 1);
      local.setUTCHours(9, 30, 0, 0);
    } else if (minutes < 570) local.setUTCHours(9, 30, 0, 0);
    else return d;
    d = new Date(+local - 330 * 60000);
  }
  return d;
}
export function nextStep(outcome, { at, now = new Date(), attempts = 0 } = {}) {
  if (["not_interested", "wrong_number", "do_not_contact"].includes(outcome))
    return null;
  if (["callback", "not_now", "meeting_pending"].includes(outcome)) {
    if (!at || +new Date(at) <= +now)
      throw new Error("A future customer-requested time is required");
    return {
      title:
        outcome === "meeting_pending"
          ? "Confirm meeting time"
          : "Customer-requested callback",
      kind: outcome === "meeting_pending" ? "confirm_meeting" : "call",
      dueAt: workSlot(at, true),
      fixed: true,
    };
  }
  if (outcome === "no_answer" || outcome === "unreachable") {
    if (attempts >= 4)
      return {
        title: "Review unanswered lead",
        kind: "internal",
        dueAt: workSlot(+now + 86400000),
      };
    return { title: "Retry unanswered call", dueAt: workSlot(+now + 7200000) };
  }
  if (outcome === "busy") {
    let d = new Date(+now);
    d.setUTCHours(11, 30, 0, 0);
    return {
      title: "Callback after busy call",
      dueAt: workSlot(+d > +now ? d : +now + 7200000),
    };
  }
  if (outcome === "meeting_booked") return null;
  if (outcome === "interested")
    return {
      title: "Send requested details",
      kind: "send_details",
      dueAt: workSlot(now),
    };
  if (outcome === "partner")
    return {
      title: "Follow up on partner discussion",
      dueAt: workSlot(+now + 86400000),
    };
  return {
    title: "Agree next customer action",
    dueAt: workSlot(+now + 86400000),
  };
}
export const activeLead = (l) =>
  !l.doNotContact && !["Won", "Lost", "Nurture"].includes(l.stage);
export function callMetrics(calls) {
  const connected = calls.filter((c) => c.answeredAt);
  const outbound = calls.filter((c) => c.direction === "outgoing");
  const inbound = calls.filter((c) => c.direction === "incoming");
  const rate = (rows) => rows.length
    ? Math.round(100 * rows.filter((c) => c.answeredAt).length / rows.length)
    : 0;
  return {
    attempts: calls.length,
    outboundPickupRate: rate(outbound),
    inboundAnswerRate: rate(inbound),
    uniqueLeadsReached: new Set(connected.filter((c) => c.lead).map((c) => String(c.lead))).size,
    connected: connected.length,
    pickupRate: calls.length
      ? Math.round((connected.length / calls.length) * 100)
      : 0,
    averageConnectedSeconds: connected.length
      ? Math.round(
          connected.reduce((s, c) => s + (c.activeMs || 0), 0) /
            connected.length /
            1000
        )
      : 0,
    agentEndRequests: calls.filter((c) => c.localEndRequested).length,
    localReportedEnds: calls.filter((c) => c.endedBy === "local_reported")
      .length,
    remoteReportedEnds: calls.filter((c) => c.endedBy === "remote_reported")
      .length,
    unknownEnds: calls.filter((c) => !c.endedBy || c.endedBy === "unknown")
      .length,
  };
}
