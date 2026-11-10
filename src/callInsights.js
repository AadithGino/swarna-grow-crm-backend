import { callMetrics } from "./rules.js";

function normObjection(o) {
  return String(o || "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 160);
}

function tally(list, key = (x) => x) {
  const m = new Map();
  for (const x of list) {
    const k = key(x);
    if (!k) continue;
    m.set(k, (m.get(k) || 0) + 1);
  }
  return [...m.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([text, count]) => ({ text, count }));
}

export function buildCallIntelligence(calls) {
  const metrics = callMetrics(calls);
  const answered = calls.filter((c) => c.answeredAt);
  const withRecording = calls.filter((c) => c.recordingStatus === "uploaded");
  const withAi = calls.filter((c) => c.aiStatus === "ready" && c.ai?.summary);
  const withTranscript = calls.filter((c) => c.transcript?.length > 20);

  const objections = [];
  const requirements = [];
  const uncertainties = [];
  const outcomes = [];
  const nextActions = [];

  for (const c of withAi) {
    for (const o of c.ai.objections || []) objections.push(normObjection(o));
    for (const r of c.ai.requirements || []) requirements.push(normObjection(r));
    for (const u of c.ai.uncertainties || []) uncertainties.push(normObjection(u));
    if (c.ai.suggestedOutcome) outcomes.push(c.ai.suggestedOutcome);
    if (c.ai.nextAction) nextActions.push(String(c.ai.nextAction).trim().slice(0, 200));
  }

  const topObjections = tally(objections);
  const topRequirements = tally(requirements).slice(0, 8);
  const topUncertainties = tally(uncertainties).slice(0, 6);
  const outcomeMix = tally(outcomes);

  const talkTimes = answered.map((c) => (c.activeMs || 0) / 1000).sort((a, b) => a - b);
  const medianTalkSec = talkTimes.length
    ? (talkTimes[Math.floor((talkTimes.length - 1) / 2)] + talkTimes[Math.floor(talkTimes.length / 2)]) / 2
    : 0;

  const recordingRate = answered.length
    ? Math.round((withRecording.length / answered.length) * 100)
    : 0;
  const aiCoverage = withRecording.length
    ? Math.round((withAi.length / withRecording.length) * 100)
    : 0;

  const coaching = [];
  if (metrics.pickupRate < 35 && metrics.attempts >= 5)
    coaching.push(
      `Pickup is ${metrics.pickupRate}% (${metrics.connected}/${metrics.attempts}). Try new time slots, callback windows, and verifying numbers before dialing.`
    );
  if (recordingRate < 50 && answered.length >= 3)
    coaching.push(
      `Only ${recordingRate}% of answered calls have recordings. Confirm JemRec auto-record, SwarnaGrow as default dialer, and folder sync.`
    );
  if (topObjections[0])
    coaching.push(
      `Most repeated objection: “${topObjections[0].text}” (${topObjections[0].count}×). Prepare a short rebuttal and a pricing one-pager before the next batch of calls.`
    );
  if (topObjections[1])
    coaching.push(
      `Second theme: “${topObjections[1].text}”. Pair an agent who handled it well on a joint call if possible.`
    );
  if (metrics.averageConnectedSeconds > 0 && metrics.averageConnectedSeconds < 45 && metrics.connected >= 5)
    coaching.push(
      `Average talk time is only ${metrics.averageConnectedSeconds}s. After intro, ask one qualifying question and propose a concrete next step (demo, callback time, or send proposal).`
    );
  if (metrics.averageConnectedSeconds > 300)
    coaching.push(
      `Long conversations (${talk(metrics.averageConnectedSeconds)} avg). End with a clear commitment and log outcome while the call is fresh.`
    );
  if (topUncertainties[0])
    coaching.push(
      `AI often flagged uncertainty: “${topUncertainties[0].text}”. Clarify this in your pitch or FAQ sheet.`
    );
  if (!coaching.length && withAi.length)
    coaching.push(
      "Keep recording answered calls; objections and coaching themes appear as more AI briefs complete."
    );

  return {
    metrics: {
      ...metrics,
      medianTalkSec,
      recordingRate,
      aiCoverage,
      recordingsUploaded: withRecording.length,
      aiBriefsReady: withAi.length,
      transcripts: withTranscript.length,
      aiFailed: calls.filter((c) => c.aiStatus === "failed").length,
      aiRetrying: calls.filter((c) =>
        ["retrying", "queued", "transcribing", "summarising", "waiting"].includes(
          c.aiStatus
        )
      ).length,
    },
    topObjections,
    topRequirements,
    topUncertainties,
    outcomeMix,
    sampleNextActions: tally(nextActions).slice(0, 6),
    coaching,
  };
}

function talk(seconds) {
  if (seconds >= 60) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${seconds}s`;
}

export function buildEmployeeIntelligence(calls, userId) {
  const mine = calls.filter((c) => String(c.agent) === String(userId));
  return buildCallIntelligence(mine);
}
