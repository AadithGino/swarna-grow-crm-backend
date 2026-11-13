import crypto from "node:crypto";
import mongoose from "mongoose";
import { Import, Lead, User, Setting, Task } from "./models.js";
import { phone } from "./rules.js";
import { unavailable, policy, addWorkMinutes } from "./policy.js";
export async function graph(path) {
  const r = await fetch(
    `https://graph.facebook.com/${
      process.env.GRAPH_VERSION || "v23.0"
    }/${path}`,
    {
      headers: { Authorization: `Bearer ${process.env.META_PAGE_TOKEN}` },
      signal: AbortSignal.timeout(30000),
    }
  );
  if (!r.ok) throw Error(`Meta retrieval failed: ${r.status}`);
  return r.json();
}
export async function ingestMeta(fetchGraph = graph, now = new Date()) {
  if (!process.env.META_PAGE_TOKEN && fetchGraph === graph) return;
  const candidates = await User.find({
    active: true,
    role: { $in: ["agent", "manager"] },
  });
  let owner;
  for (const u of candidates) {
    if (unavailable(u, now)) continue;
    const count = await Lead.countDocuments({
      owner: u.id,
      stage: { $nin: ["Won", "Lost"] },
    });
    if (!owner || count < owner.load) owner = { id: u.id, load: count };
  }
  // Keep imports pending when nobody can own them. The operations sweep escalates it.
  if (!owner) return;
  const eligible = { source: { $nin: ["csv", "manual"] },
    status: { $in: ["pending", "failed", "processing"] },
    $or: [{ nextAttemptAt: null }, { nextAttemptAt: { $lte: now } }] };
  for (const candidate of await Import.find(eligible).sort({ nextAttemptAt: 1, createdAt: 1 }).limit(30)) {
    const processingToken = crypto.randomUUID();
    const item = await Import.findOneAndUpdate({ ...eligible, _id: candidate.id }, {
      $set: { status: "processing", processingToken, nextAttemptAt: new Date(Date.now() + 120000) },
      $inc: { attempts: 1 },
    }, { new: true });
    if (!item) continue;
    const claim = { _id: item.id, status: "processing", processingToken };
    try {
      const d = await fetchGraph(`${item.externalId}?fields=id,created_time,field_data,ad_id,form_id`);
      const fields = Object.fromEntries((d.field_data || []).map(x => [x.name, x.values?.[0]]));
      const p = phone(fields.phone_number);
      const sourceCreatedAt = new Date(d.created_time);
      const enquiryAt = Number.isFinite(+sourceCreatedAt) && sourceCreatedAt <= now ? sourceCreatedAt : now;
      const dueAt = addWorkMinutes(enquiryAt, (await policy()).firstContactMinutes);
      const session = await mongoose.startSession();
      try {
        await session.withTransaction(async () => {
          const current = await Import.findOne(claim).session(session);
          if (!current) return;
          const lead = await Lead.findOneAndUpdate({ phone: p }, {
            $setOnInsert: { name: fields.company_name || fields.full_name || p, phone: p, owner: owner.id,
              source: "Meta", firstContactDueAt: dueAt, attribution: { adId: d.ad_id, formId: d.form_id, externalId: item.externalId } },
          }, { upsert: true, new: true, session });
          await Lead.updateOne({ _id: lead.id }, { $inc: { workflowRevision: 1 } }, { session });
          const review = lead.doNotContact || ["Won", "Lost"].includes(lead.stage) || !lead.owner;
          if (!review) await Task.updateOne({ key: `meta:${item.externalId}` }, { $setOnInsert: {
            lead: lead.id, owner: lead.owner, title: "Contact Meta enquiry", dueAt, originalDueAt: dueAt,
            kind: "call", customerFacing: true,
          } }, { upsert: true, session });
          await Import.updateOne(claim, { $set: { lead: lead.id, formId: d.form_id || current.formId,
            sourceCreatedAt: enquiryAt, status: review ? "needs_review" : "done" },
            $unset: { processingToken: 1, nextAttemptAt: 1, error: 1 } }, { session });
        });
      } finally { await session.endSession(); }
    } catch (e) {
      await Import.updateOne(claim, { $set: { status: "failed", error: e.message,
        nextAttemptAt: new Date(+now + Math.min(1440, 2 ** Math.min(item.attempts - 1, 11)) * 60000) },
        $unset: { processingToken: 1 } });
    }
  }
}
export async function reconcileMeta(fetchGraph = graph, now = new Date()) {
  if (!process.env.META_PAGE_TOKEN && fetchGraph === graph) return;
  const forms = (process.env.META_FORM_IDS || "")
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean),
    results = [];
  for (const form of forms) {
    const key = `meta-form:${form}`,
      prior = await Setting.findOne({ key }),
      since = prior?.value?.lastSuccessAt
        ? new Date(+new Date(prior.value.lastSuccessAt) - 3600000)
        : new Date(process.env.META_INITIAL_SINCE || 0);
    const filter = encodeURIComponent(
      JSON.stringify([
        {
          field: "time_created",
          operator: "GREATER_THAN",
          value: Math.floor(+since / 1000),
        },
      ])
    );
    let after = "",
      seen = new Set(),
      complete = false;
    try {
      for (let page = 0; page < 100; page++) {
        const d = await fetchGraph(
          `${form}/leads?fields=id,created_time&limit=100&filtering=${filter}${
            after ? "&after=" + encodeURIComponent(after) : ""
          }`
        );
        for (const l of d.data || []) {
          seen.add(l.id);
          await Import.updateOne(
            { externalId: l.id },
            {
              $setOnInsert: {
                status: "pending",
                formId: form,
                sourceCreatedAt: l.created_time,
              },
            },
            { upsert: true }
          );
        }
        if (!d.paging?.next) {
          complete = true;
          break;
        }
        const next = d.paging?.cursors?.after;
        if (!next || next === after)
          throw Error("Meta pagination cursor missing or repeated");
        after = next;
      }
      if (!complete)
        throw Error(
          "Meta reconciliation exceeded page limit; checkpoint not advanced"
        );
      const captured = await Import.find({
        externalId: { $in: [...seen] },
      }).populate("lead", "_id");
      const linked = captured.filter(
          (i) => i.status === "done" && i.lead
        ).length,
        reviewed = captured.filter((i) => i.status === "reviewed" && i.reviewDecision).length,
        queued = seen.size - linked - reviewed;
      const value = {
        at: now,
        ok: true,
        lastSuccessAt: now,
        windowStart: since,
        sourceCount: seen.size,
        linkedCount: linked,
        reviewedCount: reviewed,
        pendingCount: queued,
      };
      await Setting.updateOne({ key }, { $set: { value } }, { upsert: true });
      results.push({ form, ...value });
    } catch (e) {
      const value = {
        ...prior?.value,
        at: now,
        ok: false,
        error: e.message,
        sourceCount: seen.size,
      };
      await Setting.updateOne({ key }, { $set: { value } }, { upsert: true });
      results.push({ form, ...value });
    }
  }
  const discovered = new Set(await Import.distinct("formId", {
    source: "meta", formId: { $type: "string" }, webhookAt: { $gte: new Date(+now - 30 * 86400000) },
  }));
  let discoveryError;
  if (process.env.META_PAGE_ID) {
    try {
      let after, complete = false;
      for (let page = 0; page < 100; page++) {
        const result = await fetchGraph(`${process.env.META_PAGE_ID}/leadgen_forms?fields=id,status&limit=100${after ? "&after=" + encodeURIComponent(after) : ""}`);
        for (const form of result.data || []) if (form.status === "ACTIVE") discovered.add(form.id);
        if (!result.paging?.next) { complete = true; break; }
        const next = result.paging?.cursors?.after;
        if (!next || next === after) throw Error("Meta form discovery cursor stalled");
        after = next;
      }
      if (!complete) throw Error("Meta form discovery did not finish");
    } catch (error) { discoveryError = error.message; }
  }
  const missingForms = [...discovered].filter(form => !forms.includes(form));
  for (const result of results) {
    const verified = await Import.findOne({ formId: result.form, status: "done", webhookAt: { $ne: null } })
      .select("webhookAt").sort({ webhookAt: -1 });
    result.lastVerifiedCaptureAt = verified?.webhookAt || null;
  }
  await Setting.updateOne(
    { key: "metaCheck" },
    {
      $set: {
        value: {
          at: now,
          ok: forms.length > 0 && !missingForms.length && !discoveryError && results.every((x) => x.ok),
          missingForms, discoveryError,
          forms: results,
        },
      },
    },
    { upsert: true }
  );
  return results;
}
