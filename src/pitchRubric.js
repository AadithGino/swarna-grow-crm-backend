export const pitchVersion = "initial-outreach-v2";

export const pitchSteps = [
  ["introduction", "Warm introduction", "Identify caller and SwarnaGrow, mention the gold scheme app enquiry, and explain the reason for calling."],
  ["discovery", "Discovery", "Ask if the shop runs a gold scheme. If yes, ask how collections are handled today and allow the customer to respond."],
  ["solution", "Solution and credibility", "Connect the customer's manual work to the solution, mention the Kerala Startup Mission office in Kalamassery, and explain the branded app with their shop name and logo."],
  ["features", "Core features and admin", "Explain new enrolment and existing scheme payments, customer paid amount and gold balance, automatic payment capture in admin, collections and gold liability, outstanding cash, maturities and redemptions, and automated push reminders."],
  ["pricing", "Pricing", "Cover the custom-build comparison, ₹30,000 one-time setup and ₹5,000 monthly, including server, database, maintenance and reminders. The ₹1 example is optional."],
  ["demoClose", "Demo close", "Offer an app and admin demo, ask for shop name and logo, set an expectation of 10–15 minutes for the demo link and about two hours for feedback."],
];

export const pitchInstruction = `If this is initial outreach, assess the following six steps in order. Natural Malayalam, English and mixed phrasing all count. Mark each step covered, partial, missed, not_applicable or unassessable. A busy customer, refusal, broken audio or truncated call is not evidence of missing later steps. Identify the exact omitted points for partial steps. Attribute evidence to the agent only when supported. Return a scriptAssessment array of objects with key, status, quote (literal transcript evidence for covered or partial), and missing (short array). Use the first substantive evidence for each step. Return an empty array for other call types. Rubric: ${JSON.stringify(pitchSteps)}`;

export function validatePitchEvidence(rows, transcript) {
  if (!Array.isArray(rows) || !rows.length) return null;
  const statuses = ["covered", "partial", "missed", "not_applicable", "unassessable"];
  let previous = -1;
  let outOfOrder = false;
  let evidenced = 0;
  const steps = pitchSteps.map(([key, label]) => {
    const row = rows.find(item => item?.key === key);
    let status = statuses.includes(row?.status) ? row.status : "unassessable";
    const quote = typeof row?.quote === "string" ? row.quote.trim() : "";
    const position = quote.length >= 8 ? transcript.indexOf(quote) : -1;
    if (status === "covered" || status === "partial") {
      if (position < 0) status = "unassessable";
      else {
        if (position < previous) outOfOrder = true;
        previous = position;
        evidenced++;
      }
    }
    return {
      key, label, status,
      quote: position >= 0 ? quote : "",
      missing: Array.isArray(row?.missing)
        ? row.missing.filter(value => typeof value === "string").slice(0, 8)
        : [],
    };
  });
  return {
    rubric: pitchVersion, steps,
    order: outOfOrder ? "out_of_order" : evidenced >= 2 ? "observed_order" : "unassessable",
  };
}
