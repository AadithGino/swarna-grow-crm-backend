import test from "node:test";
import assert from "node:assert/strict";
import { phone, workSlot, nextStep, callMetrics } from "../src/rules.js";
test("Indian phone normalization and invalid numbers", () => {
  assert.equal(phone("9876543210"), "+919876543210");
  assert.equal(phone("+971545833113"), "+971545833113");
  assert.throws(() => phone("x"));
});
test("Sunday advances to Monday opening and fixed callback stays exact", () => {
  const sunday = new Date("2026-11-08T09:00:00Z");
  assert.equal(workSlot(sunday).toISOString(), "2026-11-09T04:00:00.000Z");
  assert.equal(workSlot(sunday, true).toISOString(), sunday.toISOString());
});
test("four unanswered attempts stop the repeated call chain", () => {
  assert.equal(nextStep("no_answer", { attempts: 4 }).kind, "internal");
});
test("a specific callback cannot silently use a default time", () => {
  assert.throws(() => nextStep("callback"));
  assert.throws(() => nextStep("callback", { at: "2020-01-01" }));
  const d = "2026-12-01T10:00:00Z";
  assert.equal(
    nextStep("callback", { at: d }).dueAt.toISOString(),
    new Date(d).toISOString()
  );
});
test("calls count answered conversations separately and preserve unknown endings", () => {
  assert.deepEqual(
    callMetrics([
      { answeredAt: new Date(), activeMs: 20000, localEndRequested: true },
      { activeMs: 0 },
      { answeredAt: new Date(), activeMs: 40000, endedBy: "remote_reported" },
    ]),
    {
      attempts: 3,
      outboundPickupRate: 0,
      inboundAnswerRate: 0,
      uniqueLeadsReached: 0,
      connected: 2,
      pickupRate: 67,
      averageConnectedSeconds: 30,
      agentEndRequests: 1,
    localReportedEnds: 0,
      remoteReportedEnds: 1,
      unknownEnds: 2,
    }
  );
});
