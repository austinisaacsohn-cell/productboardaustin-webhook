/**
 * Productboard Webhook Service
 *
 * Goal: Whenever a Feature is created/updated/moved, look up its parent Product
 * and write the Product name into a Feature custom field (either Text or Single-select).
 *
 * Runtime: Node.js 18+
 * Dependencies: express, node-fetch (v3), pino
 *
 * ENV VARS (required):
 *   PB_TOKEN                 → Productboard personal access token or service token
 *   PB_CUSTOM_FIELD_ID       → your target Feature custom field ID
 *   FIELD_MODE               → "text" or "singleSelect"
 *   SINGLE_SELECT_MATCH_MODE → "case-insensitive" (recommended)
 *
 * Webhook subscription:
 *   Subscribe to: feature.created, feature.updated, feature.moved
 *   URL: https://your-render-app.onrender.com/pb-webhook
 */

import express from "express";
import fetch from "node-fetch";
import pino from "pino";

const log = pino({ level: process.env.LOG_LEVEL || "info" });

const PB_BASE = process.env.PB_BASE || "https://api.productboard.com";
const PB_TOKEN = process.env.PB_TOKEN;
const PB_CF_ID = process.env.PB_CUSTOM_FIELD_ID;
const FIELD_MODE = process.env.FIELD_MODE || "text";
const MATCH_MODE = process.env.SINGLE_SELECT_MATCH_MODE || "case-insensitive";
const PORT = process.env.PORT || 3000;

if (!PB_TOKEN || !PB_CF_ID) {
  throw new Error("PB_TOKEN and PB_CUSTOM_FIELD_ID are required env vars.");
}

const app = express();
app.use(express.json({ limit: "1mb" }));

async function pbFetch(path, init = {}) {
  const res = await fetch(`${PB_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${PB_TOKEN}`,
      "Content-Type": "application/json",
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

async function getFeature(id) {
  return pbFetch(`/features/${id}`);
}

async function getProduct(id) {
  return pbFetch(`/products/${id}`);
}

async function getCustomFieldDefinition(cfId) {
  return pbFetch(`/custom-fields/${cfId}`);
}

async function setCustomFieldValue({ entityId, customFieldId, value }) {
  const body = {
    hierarchyEntity: { type: "feature", id: entityId },
    customField: { id: customFieldId },
    value,
  };
  return pbFetch(`/hierarchy-entities/custom-fields-values/value`, {
    method: "PUT",
    body: JSON.stringify(body),
  });
}

function normalizeLabel(s) {
  return (s || "").trim().toLowerCase();
}

async function resolveSingleSelectOptionId(cfId, productName) {
  const def = await getCustomFieldDefinition(cfId);
  const options = def?.options || [];
  const target = normalizeLabel(productName);

  const match = options.find((opt) => normalizeLabel(opt.label) === target);
  if (!match) {
    throw new Error(
      `No single-select option on ${cfId} matches product name "${productName}".`
    );
  }
  return match.id;
}

async function handleFeatureEvent(featureId) {
  const feature = await getFeature(featureId);
  const productId = feature?.product?.id || feature?.parent?.product?.id;

  if (!productId) {
    log.warn({ featureId }, "No product found — skipping.");
    return;
  }

  const product = await getProduct(productId);
  const productName = product?.name;
  if (!productName) return;

  if (FIELD_MODE === "text") {
    await setCustomFieldValue({
      entityId: featureId,
      customFieldId: PB_CF_ID,
      value: productName,
    });
    log.info({ featureId, productName }, "Updated text field.");
  } else if (FIELD_MODE === "singleSelect") {
    const optionId = await resolveSingleSelectOptionId(PB_CF_ID, productName);
    await setCustomFieldValue({
      entityId: featureId,
      customFieldId: PB_CF_ID,
      value: { optionId },
    });
    log.info({ featureId, productName, optionId }, "Updated single-select field.");
  }
}

app.post("/pb-webhook", async (req, res) => {
  try {
    const event = req.body;
    const featureId = event?.entity?.id || event?.entityId;
    if (!featureId) {
      log.warn({ body: event }, "No feature ID found in webhook payload.");
      return res.status(200).send("ignored");
    }
    await handleFeatureEvent(featureId);
    res.status(200).send("ok");
  } catch (err) {
    log.error({ err: String(err) }, "Webhook error");
    res.status(200).send("handled");
  }
});

// --- Auto-register webhook on startup ---
async function ensureWebhook() {
  try {
    log.info("Checking Productboard webhook registration...");
    const res = await pbFetch("/webhooks");
    const existing = res?.data?.find(
      (w) => w.notification?.url === "https://productboardaustin-webhook.onrender.com/pb-webhook"
    );

    if (existing) {
      log.info({ id: existing.id }, "Webhook already registered ✅");
      return;
    }

    log.info("Webhook not found, creating new one...");
    const body = {
      data: {
        name: "Auto: Product field updater",
        enabled: true,
        events: [
          { eventType: "feature.created" },
          { eventType: "feature.updated" },
          { eventType: "feature.moved" }
        ],
        notification: {
          url: "https://productboardaustin-webhook.onrender.com/pb-webhook",
          method: "POST"
        }
      }
    };

    const create = await pbFetch("/webhooks", {
      method: "POST",
      body: JSON.stringify(body),
    });

    log.info({ id: create?.data?.id }, "Webhook created successfully 🎉");
  } catch (err) {
    log.error({ err: String(err) }, "Error ensuring webhook");
  }
}

// Call the function during startup
ensureWebhook().then(() => {
  app.listen(PORT, () => log.info(`Listening on port ${PORT}`));
});


app.listen(PORT, () => log.info(`Listening on port ${PORT}`));
