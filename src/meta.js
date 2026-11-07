import { Import, Lead, User, Setting } from "./models.js";
import { phone, workSlot } from "./rules.js";
import { task } from "./workflow.js";
import { initializeLead } from "./coverage.js";
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
  for (const item of await Import.find({
    source: { $ne: "csv" },
    status: { $in: ["pending", "failed"] },
    $or: [{ nextAttemptAt: null }, { nextAttemptAt: { $lte: now } }],
  })
    .sort({ nextAttemptAt: 1, createdAt: 1 })
    .limit(30)) {
    try {
      const d = await fetchGraph(
          `${item.externalId}?fields=id,created_time,field_data,ad_id,form_id`
        ),
        fields = Object.fromEntries(
          (d.field_data || []).map((x) => [x.name, x.values?.[0]])
        ),
        p = phone(fields.phone_number);
      const l = await Lead.findOneAndUpdate(
        { phone: p },
        {
          $setOnInsert: {
            name: fields.company_name || fields.full_name || p,
            phone: p,
            owner: owner.id,
            source: "Meta",
            firstContactDueAt: addWorkMinutes(
              new Date(
                Math.min(
                  +now,
                  Number.isFinite(+new Date(d.created_time))
                    ? +new Date(d.created_time)
                    : +now
                )
              ),
              (
                await policy()
              ).firstContactMinutes
            ),
            attribution: { adId: d.ad_id, formId: d.form_id, externalId: d.id },
          },
        },
        { upsert: true, new: true }
      );
      await initializeLead(l, now);
      if (!l.doNotContact && !["Won", "Lost"].includes(l.stage))
        await task(
          l,
          ["Won", "Lost"].includes(l.stage)
            ? "Review repeat enquiry from existing customer"
            : "Contact Meta enquiry",
          workSlot(now),
          `meta:${d.id}`,
          { kind: "call", customerFacing: true }
        );
      item.lead = l.id;
      item.formId = d.form_id;
      item.sourceCreatedAt = d.created_time;
      item.status =
        l.doNotContact || ["Won", "Lost"].includes(l.stage)
          ? "needs_review"
          : "done";
      item.error = undefined;
      item.nextAttemptAt = undefined;
    } catch (e) {
      item.status = "failed";
      item.error = e.message;
      item.nextAttemptAt = new Date(
        +now + Math.min(1440, 2 ** Math.min(item.attempts || 0, 11)) * 60000
      );
    }
    item.attempts = (item.attempts || 0) + 1;
    await item.save();
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
        reviewed = captured.filter((i) => i.status === "reviewed").length,
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
  await Setting.updateOne(
    { key: "metaCheck" },
    {
      $set: {
        value: {
          at: now,
          ok: forms.length > 0 && results.every((x) => x.ok),
          forms: results,
        },
      },
    },
    { upsert: true }
  );
  return results;
}
