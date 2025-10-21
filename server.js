/**
 * Productboard Webhook Service
 *
 * - Listens for feature events (created, updated, moved)
 * - Looks up each feature's parent product
 * - Updates a custom field (Text or Single Select) with the product name
 * - Auto-registers its own Productboard webhook at startup
 */

import express from "express";
import fetch from "node-fetch";
import pino from "pino";

const log = pino({ level: process.env.LOG_LEVEL || "info" });

// --- CONFIG ---
const PB_BASE = process.env.PB_BASE || "https://api.productboard.com";
const PB_TOKEN = process.env.PB_TOKEN;
const PB_CF_ID = process.env.PB_CUSTOM_FIELD_ID;
const FIELD_MODE = process.env.FIELD_MODE || "text";
const MATCH_MODE = process.env.SINGLE_SELECT_MATCH_MODE || "case-insensitive";
const PB_API_VERSION = process.env.PB_API_VERSION || "1";
const WEBHOOK_URL = process.env.WEBHOOK_URL || "https://productboardaustin-webhook.onrender.com/pb-webhook";
const PORT = process.env.PORT || 3000;

// --- VALIDATION ---
if (!PB_TOKEN || !PB_CF_ID) {
  throw new Error("❌ Missing required env vars: PB_TOKEN or PB_CUSTOM_FIELD_ID");
}

// --- EXPRESS APP ---
const app = express();
app.use(express.json({ limit: "1mb" }));

// --- PRODUCTBOARD API HELPER ---
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

  if (res.status === 204) return null;
  return res.json();
}

// --- HELPERS ---
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
  try {
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
      log.info({ featureId, productName }, "✅ Updated text field");
    } else if (FIELD_MODE === "singleSelect") {
      const optionId = await resolveSingleSelectOptionId(PB_CF_ID, productName);
      await setCustomFieldValue({
        entityId: featureId,
        customFieldId: PB_CF_ID,
        value: { optionId },
      });
      log.info({ featureId, productName, optionId }, "✅ Updated single-select field");
    }
  } catch (err) {
    log.error({ featureId, err: String(err) }, "❌ Error handling feature event");
  }
}

// --- WEBHOOK ROUTE ---
app.post("/pb-webhook", async (req, res) => {
  try {
    const event = req.body;
    const featureId = event?.entity?.id || event?.entityId;
    if (!featureId) {
      log.warn("⚠️ Ignored webhook with no featureId");
      return res.status(200).send("ignored");
    }
    await handleFeatureEvent(featureId);
    res.status(200).send("ok");
  } catch (err) {
    log.error({ err: String(err) }, "❌ Webhook error");
    res.status(200).send("handled");
  }
});

// --- AUTO REGISTER WEBHOOK ---
async function ensureWebhook() {
  try {
    log.info("🔍 Checking Productboard webhook registration...");
    const res = await pbFetch("/webhooks");
    const existing = res?.data?.find((w) => w.notification?.url === WEBHOOK_URL);

    if (existing) {
      log.info({ id: existing.id }, "✅ Webhook already registered");
      return;
    }

    log.info("🪄 Webhook not found — creating new one...");
    const create = await pbFetch("/webhooks", {
      method: "POST",
      body: JSON.stringify({
        data: {
          name: "Auto: Product field updater",
          enabled: true,
          events: [
            { eventType: "feature.created" },
            { eventType: "feature.updated" },
            { eventType: "feature.moved" }
          ],
          notification: { url: WEBHOOK_URL, method: "POST" }
        },
      }),
    });

    log.info({ id: create?.data?.id }, "🎉 Webhook created successfully");
  } catch (err) {
    log.error({ err: String(err) }, "❌ Error ensuring webhook");
  }
}

// --- STARTUP ---
ensureWebhook().finally(() => {
  app.listen(PORT, () => log.info(`🚀 Listening on port ${PORT}`));
});
