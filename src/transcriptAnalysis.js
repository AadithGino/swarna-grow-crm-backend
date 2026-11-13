import { buildCallIntelligence } from "./callInsights.js";

function parseAiJson(raw) {
  const text = String(raw || "").trim();
  if (!text) throw Error("AI returned empty analysis");
  const stripped = text.replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
  try {
    return JSON.parse(stripped);
  } catch {
    const match = stripped.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    throw Error("Could not parse AI analysis JSON");
  }
}

export function prepareTranscriptCorpus(calls, users, limit = 24) {
  const byId = Object.fromEntries(users.map((u) => [String(u.id), u.name]));
  const scored = calls
    .filter((c) => c.transcript?.length > 30 || c.ai?.summary)
    .map((c) => ({
      call: c,
      score:
        (c.transcript?.length || 0) +
        (c.ai?.summary ? 200 : 0) +
        (c.activeMs || 0) / 1000,
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return scored.map(({ call: c }) => ({
    id: c.id,
    agent: byId[String(c.agent)] || "Agent",
    number: c.number,
    direction: c.direction,
    startedAt: c.startedAt,
    talkSec: Math.round((c.activeMs || 0) / 1000),
    answered: !!c.answeredAt,
    outcome: c.outcome || c.ai?.suggestedOutcome || "",
    priorSummary: c.ai?.summary || "",
    priorObjections: c.ai?.objections || [],
    transcript: (c.transcript || c.ai?.summary || "").slice(0, 3500),
  }));
}

export async function deepTranscriptInsights({ calls, users, since, until }) {
  if (!process.env.SARVAM_API_KEY) throw Error("Configure SARVAM_API_KEY");
  const corpus = prepareTranscriptCorpus(calls, users);
  if (!corpus.length)
    throw Error("No transcripts yet — finish recorded calls with AI briefs first");

  const stats = buildCallIntelligence(calls);

  const r = await fetch("https://api.sarvam.ai/v1/chat/completions", {
    method: "POST",
    headers: {
      "api-subscription-key": process.env.SARVAM_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "sarvam-105b-conversations",
      temperature: 0.25,
      messages: [
        {
          role: "system",
          content: `You are a senior revenue coach for SwarnaGrow / GroQuik — jewellery stores, gold savings schemes, digital gold, AMS/ecommerce.
Study EVERY call in the user payload (transcripts + summaries). Transcripts may mix English, Malayalam, Hindi; analyse in English output.
Return JSON ONLY with this exact shape:
{
  "headline": "one punchy line for the sales manager",
  "executiveSummary": "2-3 sentences on how the team is really selling right now",
  "scorecard": {
    "pickupVerdict": "",
    "conversationDepthVerdict": "",
    "recordingCoverageVerdict": ""
  },
  "topObjections": [
    { "theme": "", "countEstimate": 0, "verbatimQuote": "", "whyItMatters": "", "battleCard": "what rep should say next time" }
  ],
  "brightSpots": ["things reps did well, cite behaviour not fluff"],
  "criticalGaps": ["specific skill gaps with evidence from calls"],
  "repNotes": [
    { "agentName": "", "strength": "", "fixNext": "", "priority": "high|medium|low" }
  ],
  "winSignals": ["phrases or moments that predict interest"],
  "stallSignals": ["phrases that predict delay or loss"],
  "callScripts": [
    { "title": "", "whenToUse": "", "opening": "", "transition": "", "close": "" }
  ],
  "sevenDayPlan": ["day-by-day focus for the team, max 7 bullets"]
}
Rules: use real quotes from transcripts when possible; countEstimate is your best count across corpus; no fabricated prices unless heard; empty arrays only if truly none.`,
        },
        {
          role: "user",
          content: JSON.stringify({
            period: { since, until },
            teamStats: stats.metrics,
            ruleCoaching: stats.coaching,
            objectionTally: stats.topObjections.slice(0, 12),
            calls: corpus,
          }),
        },
      ],
    }),
    signal: AbortSignal.timeout(180000),
  });

  if (!r.ok)
    throw Error(
      `Deep analysis failed (${r.status}): ${(await r.text()).slice(0, 400)}`
    );
  const body = await r.json();
  const raw = body.choices?.[0]?.message?.content;
  const insights = parseAiJson(raw);
  return {
    generatedAt: new Date(),
    analyzedCalls: corpus.length,
    totalCallsInPeriod: calls.length,
    insights,
    stats: stats.metrics,
  };
}
