/**
 * Productboard → Webhook: set Feature custom field to parent Product name
 * FIELD_MODE: "singleSelect" | "text"
 * Backfill: `node server.js backfill`
 */

import express from "express";
import fetch from "node-fetch";

// ================== Config ==================
const PB_BASE = process.env.PB_BASE || "https://api.productboard.com";
const PB_TOKEN = process.env.PB_TOKEN;                         // required
const PB_CF_ID = process.env.PB_CUSTOM_FIELD_ID;               // required
const FIELD_MODE = process.env.FIELD_MODE || "singleSelect";   // or "text"
const PB_API_VERSION = process.env.PB_API_VERSION || "1";
const WEBHOOK_URL =
  process.env.WEBHOOK_URL ||
  "https://productboardaustin-webhook.onrender.com/pb-webhook";
const SHARED_SECRET = process.env.WEBHOOK_SHARED_SECRET || null;
const SAFE_DEBUG = process.env.SAFE_DEBUG === "1";
const PORT = process.env.PORT || 3000;

if (!PB_TOKEN || !PB_CF_ID) {
  throw new Error("PB_TOKEN and PB_CUSTOM_FIELD_ID env vars are required.");
}

// =============== Express app FIRST ===============
const app = express();
app.use(express.json({ limit: "1mb" }));

// =============== PB HTTP helper =================
async function pbFetch(path, init = {}) {
  const res = await fetch(`${PB_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${PB_TOKEN}`,
      "Content-Type": "application/json",
      "X-Version": PB_API_VERSION,
      ...(init.headers || {}),
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`PB ${init.method || "GET"} ${path} → ${res.status}: ${text}`);
  }
  return res.status === 204 ? null : res.json();
}

// =============== PB helpers =====================
const norm = (s) => (s || "").trim().toLowerCase();

async function getFeature(id) {
  return pbFetch(`/features/${id}`);
}
async function getProduct(id) {
  return pbFetch(`/products/${id}`);
}
async function getCustomFieldDefinition(cfId) {
  return pbFetch(`/custom-fields/${cfId}`);
}
async function setCustomFieldValue({ featureId, customFieldId, value }) {
  const body = {
    hierarchyEntity: { type: "feature", id: featureId },
    customField: { id: customFieldId },
    value,
  };
  return pbFetch(`/hierarchy-entities/custom-fields-values/value`, {
    method: "PUT",
    body: JSON.stringify(body),
  });
}
async function resolveSingleSelectOptionId(cfId, productName) {
  const def = await getCustomFieldDefinition(cfId);
  const hit = (def?.options || []).find((o) => norm(o.label) === norm(productName));
  if (!hit) throw new Error(`No single-select option on ${cfId} for "${productName}".`);
  return hit.id;
}

async function handleFeatureEvent(featureId) {
  try {
    const feature = await getFeature(featureId);
    const productId = feature?.product?.id || feature?.parent?.product?.id;
    if (!productId) return;

    const product = await getProduct(productId);
    const productName = product?.name;
    if (!productName) return;

    if (FIELD_MODE === "text") {
      await setCustomFieldValue({ featureId, customFieldId: PB_CF_ID, value: productName });
      console.log("Updated TEXT field", { featureId, productName });
    } else {
      const optionId = await resolveSingleSelectOptionId(PB_CF_ID, productName);
      await setCustomFieldValue({ featureId, customFieldId: PB_CF_ID, value: { optionId } });
      console.log("Updated SINGLE-SELECT field", { featureId, productName, optionId });
    }
  } catch (e) {
    console.error("Error handling feature event", featureId, String(e));
  }
}

// ========== Feature ID extraction & normalization ==========
function extractFeatureIdFromEvent(e) {
  if (!e) return null;
  const t = e.eventType || e.type || "";

  // New: direct id on feature.* events
  if (typeof e.id === "string" && t.startsWith("feature.")) return e.id;

  // New: parse from links.target .../features/{id}
  const target = e?.links?.target || e?.data?.links?.target;
  if (typeof target === "string") {
    const m = target.match(/\/features\/([0-9a-f-]{20,})$/i);
    if (m) return m[1];
  }

  // Common shapes
  if (e?.entity?.type === "feature" && e?.entity?.id) return e.entity.id;
  if (e?.entityId && (t.startsWith("feature.") || e?.entityType === "feature")) return e.entityId;
  if (e?.data?.entity?.type === "feature" && e?.data?.entity?.id) return e.data.entity.id;
  if (e?.data?.id && t.startsWith("feature.")) return e.data.id;
  if (e?.entity?.entity?.type === "feature" && e?.entity?.entity?.id) return e.entity.entity.id;

  // Deep fallback
  let found = null;
  (function walk(o) {
    if (!o || found) return;
    if (Array.isArray(o)) return o.forEach(walk);
    if (typeof o === "object") {
      const maybeId = o.id || o.entityId;
      const maybeType = o.type || o.entityType;
      if (maybeType === "feature" && typeof maybeId === "string") {
        found = maybeId;
        return;
      }
      for (const k of Object.keys(o)) walk(o[k]);
    }
  })(e);
  return found;
}


function normalizeEvents(body) {
  if (!body) return [];
  if (Array.isArray(body.data)) return body.data;              // { data: [ ... ] }
  if (Array.isArray(body?.data?.events)) return body.data.events; // { data: { events: [...] } }
  if (body?.data && typeof body.data === "object") return [body.data]; // { data: { ... } }
  return [body];                                               // single event
}

// ================== Webhook route ==================
app.post("/pb-webhook", async (req, res) => {
  try {
    if (SHARED_SECRET) {
      const incoming = req.headers["x-shared-secret"];
      if (incoming !== SHARED_SECRET) return res.status(401).send("unauthorized");
    }

    const events = normalizeEvents(req.body);
    let handled = 0, ignored = 0;

    for (const evt of events) {
      const et = evt?.eventType || evt?.type || "";
      const fid = extractFeatureIdFromEvent(evt);
      if (fid && et.startsWith("feature.")) {
        await handleFeatureEvent(fid);
        handled++;
      } else {
        ignored++;
      }
    }

    if (handled === 0) {
      const first = events[0];
      const preview = first ? JSON.stringify(first).slice(0, 500) : "";
      console.warn(
        {
          topLevelKeys: Object.keys(req.body || {}),
          dataType: Array.isArray(req.body?.data) ? "array" : typeof req.body?.data,
          firstEventKeys: first ? Object.keys(first) : [],
          firstEventType: first?.eventType || first?.type,
          preview: SAFE_DEBUG ? preview : "(set SAFE_DEBUG=1 to print preview)"
        },
        "No featureId extracted"
      );
    } else {
      console.log("Processed webhook events", { handled, ignored });
    }

    res.status(200).send("ok");
  } catch (err) {
    console.error("Webhook error", String(err));
    res.status(200).send("handled");
  }
});

// ================== Auto-register webhook ==================
async function ensureWebhook() {
  try {
    console.log("Checking Productboard webhook registration...");
    const list = await pbFetch("/webhooks");
    const existing = list?.data?.find((w) => w.notification?.url === WEBHOOK_URL);
    if (existing) {
      console.log("Webhook already registered", { id: existing.id });
      return;
    }
    console.log("Creating webhook...");
    const created = await pbFetch("/webhooks", {
      method: "POST",
      body: JSON.stringify({
        data: {
          name: "Auto: Product field updater",
          events: [{ eventType: "feature.created" }, { eventType: "feature.updated" }],
          notification: { url: WEBHOOK_URL, version: 1 }
        }
      })
    });
    console.log("Webhook created", { id: created?.data?.id });
  } catch (e) {
    console.error("Error ensuring webhook", String(e));
  }
}

// ================== Backfill CLI ==================
async function listFeaturesPage(limit = 200, cursor = null) {
  const qs = new URLSearchParams();
  qs.set("limit", String(limit));
  if (cursor) qs.set("cursor", cursor);
  return pbFetch(`/features?${qs.toString()}`);
}
async function backfillAllFeatures() {
  console.log("Starting backfill…");
  let cursor = null, processed = 0;
  do {
    const page = await listFeaturesPage(200, cursor);
    const items = page.items || page.data || page;
    for (const f of items) {
      if (!f?.id) continue;
      await handleFeatureEvent(f.id);
      processed++;
    }
    cursor = page.nextCursor || page?.meta?.nextCursor || null;
  } while (cursor);
  console.log("Backfill complete", { processed });
}

// ================== Start ==================
if (process.argv[2] === "backfill") {
  backfillAllFeatures().catch((e) => {
    console.error(e);
    process.exit(1);
  });
} else {
  await ensureWebhook();                // ensure before listening
  app.listen(PORT, () => console.log(`Listening on port ${PORT}`));
}

