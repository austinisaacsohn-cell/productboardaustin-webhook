/**
 * Productboard Webhook Service
 * - On feature events, write the parent Product name into a Feature custom field
 * - FIELD_MODE: "singleSelect" (recommended) or "text"
 * - Auto-registers its own webhook on startup
 * - Backfill all features: `node server.js backfill`
 */

import express from "express";
import fetch from "node-fetch";
import pino from "pino";

// ---------- Config ----------
const log = pino({ level: process.env.LOG_LEVEL || "info" });

const PB_BASE = process.env.PB_BASE || "https://api.productboard.com";
const PB_TOKEN = process.env.PB_TOKEN; // required
const PB_CF_ID = process.env.PB_CUSTOM_FIELD_ID; // required (your custom field id)
const FIELD_MODE = process.env.FIELD_MODE || "singleSelect"; // "singleSelect" | "text"
const PB_API_VERSION = process.env.PB_API_VERSION || "1";
const WEBHOOK_URL =
  process.env.WEBHOOK_URL ||
  "https://productboardaustin-webhook.onrender.com/pb-webhook";
const SHARED_SECRET = process.env.WEBHOOK_SHARED_SECRET || null;
const PORT = process.env.PORT || 3000;

if (!PB_TOKEN || !PB_CF_ID) {
  throw new Error("PB_TOKEN and PB_CUSTOM_FIELD_ID env vars are required.");
}

// ---------- HTTP helper for Productboard API ----------
async function pbFetch(path, init = {}) {
  const res = await fetch(`${PB_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${PB_TOKEN}`,
      "Content-Type": "application/json",
      "X-Version": PB_API_VERSION, // required by PB API
      ...(init.headers || {}),
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`PB ${init.method || "GET"} ${path} → ${res.status}: ${text}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

// ---------- PB entity helpers ----------
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

// ---------- Single-select resolver ----------
function norm(s) {
  return (s || "").trim().toLowerCase();
}
async function resolveSingleSelectOptionId(cfId, productName) {
  const def = await getCustomFieldDefinition(cfId);
  const opts = def?.options || [];
  const target = norm(productName);
  const hit = opts.find((o) => norm(o.label) === target);
  if (!hit) {
    throw new Error(
      `No single-select option on ${cfId} matches product "${productName}".`
    );
  }
  return hit.id;
}

// ---------- Core handler ----------
async function handleFeatureEvent(featureId) {
  try {
    const feature = await getFeature(featureId);
    const productId = feature?.product?.id || feature?.parent?.product?.id;
    if (!productId) {
      log.warn({ featureId }, "Feature has no product — skipping.");
      return;
    }

    const product = await getProduct(productId);
    const productName = product?.name;
    if (!productName) return;

    if (FIELD_MODE === "text") {
      await setCustomFieldValue({
        featureId,
        customFieldId: PB_CF_ID,
        value: productName,
      });
      log.info({ featureId, productName }, "Updated TEXT custom field");
    } else {
      const optionId = await resolveSingleSelectOptionId(PB_CF_ID, productName);
      await setCustomFieldValue({
        featureId,
        customFieldId: PB_CF_ID,
        value: { optionId },
      });
      log.info({ featureId, productName, optionId }, "Updated SINGLE-SELECT field");
    }
  } catch (err) {
    log.error({ featureId, err: String(err) }, "Error handling feature event");
  }
}

// ---------- Extract featureId from various payload shapes ----------
function extractFeatureId(evt) {
  if (evt?.entity?.type === "feature" && evt?.entity?.id) return evt.entity.id;
  if (evt?.entityId && ((evt?.type || "").startsWith("feature.") || evt?.entityType === "feature"))
    return evt.entityId;
  if (evt?.data?.entity?.type === "feature" && evt?.data?.entity?.id) return evt.data.entity.id;
  if (evt?.data?.id && (evt?.type || "").startsWith("feature.")) return evt.data.id;

  // Deep walk as a fallback
  let found = null;
  (function walk(o) {
    if (!o || found) return;
    if (Array.isArray(o)) return o.forEach(walk);
    if (typeof o === "object") {
      if ((o.type === "feature" || o.entityType === "feature") && typeof o.id === "string") {
        found = o.id;
        return;
      }
      for (const k of Object.keys(o)) walk(o[k]);
    }
  })(evt);

  return found;
}

// ---------- Express app ----------
const app = express();
app.use(express.json({ limit: "1mb" }));

app.post("/pb-webhook", async (req, res) => {
  try {
    if (SHARED_SECRET) {
      const incoming = req.headers["x-shared-secret"];
      if (incoming !== SHARED_SECRET) return res.status(401).send("unauthorized");
    }

    const event = req.body;
    const featureId = extractFeatureId(event);

    if (!featureId) {
      log.warn(
        { type: event?.type, topLevelKeys: Object.keys(event || {}) },
        "⚠️ Ignored webhook with no featureId"
      );
      return res.status(200).send("ignored");
    }

    await handleFeatureEvent(featureId);
    res.status(200).send("ok");
  } catch (err) {
    log.error({ err: String(err) }, "Webhook error");
    res.status(200).send("handled");
  }
});

// ---------- Auto-register webhook on startup ----------
async function ensureWebhook() {
  try {
    log.info("🔍 Checking Productboard webhook registration...");
    const list = await pbFetch("/webhooks");
    const existing = list?.data?.find((w) => w.notification?.url === WEBHOOK_URL);

    if (existing) {
