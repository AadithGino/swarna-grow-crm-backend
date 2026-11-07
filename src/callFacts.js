// Android Telecom facts. REMOTE before ACTIVE does not prove a customer rejected.
export function callFacts(c) {
  const events = c.events || [];
  const connected = !!c.answeredAt || events.some((e) => e.type === "ACTIVE");
  const ended = !!c.endedAt && events.some((e) => e.type === "DISCONNECTED");
  const code = Number(c.disconnectCode);
  const local =
    !!c.localEndRequested ||
    events.some((e) =>
      [
        "AGENT_END_REQUEST",
        "AGENT_REJECT_REQUEST",
        "LOCAL_END_REQUEST",
      ].includes(e.type)
    );
  let technicalResult = connected ? "connected" : "pending";
  let autoOutcome = null;
  if (ended && !connected) {
    technicalResult = "unknown";
    if (c.direction === "outgoing" && !local && code === 3) {
      technicalResult = "not_answered";
      autoOutcome = "no_answer";
    } else if (c.direction === "outgoing" && !local && code === 7) {
      technicalResult = "line_busy";
      autoOutcome = "no_answer";
    } else if (local || code === 2 || code === 4)
      technicalResult = "local_cancelled";
    else if (c.direction === "incoming" && code === 5)
      technicalResult = "missed_incoming";
    else if (c.direction === "incoming" && code === 6)
      technicalResult = "declined_incoming";
    else if (code === 1 || code === 8) technicalResult = "connection_failed";
  }
  return {
    connected,
    technicalResult,
    autoOutcome,
    endedBy: local
      ? "agent_requested"
      : connected && code === 3
      ? "remote_reported"
      : code === 2
      ? "local_reported"
      : "unknown",
  };
}
