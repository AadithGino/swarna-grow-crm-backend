import test from "node:test";
import assert from "node:assert/strict";
import { validatePitchEvidence } from "../src/pitchRubric.js";

test("pitch evidence verifies coverage and flags steps presented out of order", () => {
  const pricing = "Setup is thirty thousand";
  const intro = "Calling from SwarnaGrow";
  const result = validatePitchEvidence([
    { key: "introduction", status: "covered", quote: intro },
    { key: "discovery", status: "covered", quote: "This quote was invented" },
    { key: "pricing", status: "partial", quote: pricing, missing: ["Monthly price"] },
  ], pricing + ". " + intro);
  assert.equal(result.order, "out_of_order");
  assert.equal(result.steps[1].status, "unassessable");
  assert.deepEqual(result.steps[4].missing, ["Monthly price"]);
});
