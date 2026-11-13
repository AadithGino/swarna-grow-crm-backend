import assert from "node:assert/strict";
import test from "node:test";
import { buildCallIntelligence } from "../src/callInsights.js";

test("aggregates objections and coaching from AI calls", () => {
  const intel = buildCallIntelligence([
    {
      answeredAt: new Date(),
      activeMs: 120000,
      recordingStatus: "uploaded",
      aiStatus: "ready",
      ai: {
        summary: "x",
        objections: ["Too expensive", "Too expensive", "Need partner"],
        requirements: ["Digital gold"],
        suggestedOutcome: "callback",
      },
    },
    { answeredAt: null, activeMs: 0 },
    {
      answeredAt: new Date(),
      activeMs: 60000,
      recordingStatus: "uploaded",
      aiStatus: "ready",
      ai: {
        summary: "y",
        objections: ["AMS fee high"],
        suggestedOutcome: "interested",
      },
    },
  ]);
  assert.equal(intel.topObjections[0].text, "Too expensive");
  assert.equal(intel.topObjections[0].count, 2);
  assert.equal(intel.metrics.connected, 2);
  assert.equal(intel.metrics.pickupRate, 67);
  assert.ok(intel.coaching.some((c) => c.includes("Too expensive")));
});
