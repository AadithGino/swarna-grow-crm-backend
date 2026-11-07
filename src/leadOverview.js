import { buildCallIntelligence } from "./callInsights.js";

function parseAiJson(raw) {
  const text = String(raw || "").trim();
  if (!text) throw Error("AI returned empty overview");
  const stripped = text.replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
  try {
    return JSON.parse(stripped);
  } catch {
    const match = stripped.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    throw Error("Could not parse lead overview JSON");
  }
}

export function localLeadOverview(calls) {
  const ready = calls.filter((c) => c.ai?.summary);
  if (!ready.length) return null;
  const intel = buildCallIntelligence(ready);
  return {
    source: "rollup",
    callCount: ready.length,
    lastCallAt: ready[0]?.startedAt,
    headline: ready[0].ai?.summary?.split(/[.!?]/)[0]?.trim() || "",
    needs: intel.topRequirements.map((x) => x.text).slice(0, 6),
    objections: intel.topObjections.map((x) => x.text).slice(0, 8),
    nextStep: ready[0].ai?.nextAction || "",
    suggestedOutcome: ready[0].ai?.suggestedOutcome || "",
    snippets: ready.slice(0, 4).map((c) => ({
      at: c.startedAt,
      summary: c.ai.summary,
    })),
  };
}

export async function synthesizeLeadOverview(calls) {
  const ready = calls.filter((c) => c.ai?.summary);
  if (!ready.length) return { source: "empty", callCount: 0 };
  const local = localLeadOverview(ready);
  if (!process.env.SARVAM_API_KEY) return { ...local, source: "rollup" };

  const r = await fetch("https://api.sarvam.ai/v1/chat/completions", {
    method: "POST",
    headers: {
      "api-subscription-key": process.env.SARVAM_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "sarvam-105b-conversations",
      temperature: 0.2,
      messages: [
        {
          role: "system",
          content:
            'Merge B2B sales call briefs about one jewellery lead. Return JSON only: {"whoTheyAre":"","whatTheyNeed":"","mainObjections":[],"dealTemperature":"hot|warm|cold|unknown","recommendedNextStep":"","oneLineBrief":""}. Use only evidence from calls; English output.',
        },
        {
          role: "user",
          content: JSON.stringify({
            calls: ready.slice(0, 12).map((c) => ({
              at: c.startedAt,
              summary: c.ai.summary,
              objections: c.ai.objections,
              requirements: c.ai.requirements,
              nextAction: c.ai.nextAction,
              outcome: c.outcome || c.ai.suggestedOutcome,
            })),
          }),
        },
      ],
    }),
    signal: AbortSignal.timeout(90000),
  });
  if (!r.ok)
    return { ...local, source: "rollup", aiError: (await r.text()).slice(0, 200) };
  const body = await r.json();
  const merged = parseAiJson(body.choices?.[0]?.message?.content);
  return {
    source: "ai",
    callCount: ready.length,
    lastCallAt: ready[0]?.startedAt,
    ...merged,
    objections: merged.mainObjections || local.objections,
    needs: local.needs,
    rollup: local,
  };
}
