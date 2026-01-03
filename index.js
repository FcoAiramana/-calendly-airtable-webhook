require("dotenv").config();
const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 3000;

// ===== ENV =====
const {
  CALENDLY_PAT,
  CALENDLY_USER_URI,
  CALENDLY_POLL_INTERVAL_MINUTES = "5",
  CALENDLY_LOOKAHEAD_DAYS = "14",

  AIRTABLE_TOKEN,
  AIRTABLE_BASE_ID,
  AIRTABLE_TABLE_NAME,
  AIRTABLE_CALENDLY_ID_FIELD = "ID Calendly",

  TZ = "Europe/Madrid",
  LOG_LEVEL = "info",
  NODE_ENV = "development",
} = process.env;

// ===== Basic routes =====
app.get("/", (req, res) => res.status(200).send("Calendly → Airtable sync service running"));
app.get("/health", (req, res) => res.status(200).send("OK"));

// ===== Helpers =====
function toE164Spain(phoneRaw) {
  if (!phoneRaw) return null;
  let p = String(phoneRaw).trim();
  p = p.replace(/[^\d+]/g, "");
  if (p.startsWith("00")) p = "+" + p.slice(2);
  if (p.startsWith("+")) return p;
  if (/^\d{9}$/.test(p)) return "+34" + p;
  if (/^34\d{9}$/.test(p)) return "+" + p;
  return p;
}

function getAnswer(questionsAndAnswers, containsText) {
  if (!Array.isArray(questionsAndAnswers)) return null;
  const item = questionsAndAnswers.find(q =>
    (q.question || "").toLowerCase().includes(containsText.toLowerCase())
  );
  return item ? item.answer : null;
}

function isoNow() {
  return new Date().toISOString();
}

function isoDaysFromNow(days) {
  const d = new Date();
  d.setDate(d.getDate() + Number(days));
  return d.toISOString();
}

function log(...args) {
  if (LOG_LEVEL === "debug" || LOG_LEVEL === "info") console.log(...args);
}
function logDebug(...args) {
  if (LOG_LEVEL === "debug") console.log(...args);
}

function normalizeChannel(raw) {
  if (!raw) return "Whatsapp";
  const t = raw.toLowerCase();

  // Whatsapp (tal cual está en Airtable)
  if (t.includes("whatsapp")) return "Whatsapp";
  if (t.includes("por whatsapp")) return "Whatsapp";

  // Llamada Telefónica (tal cual está en Airtable)
  if (t.includes("llamada")) return "Llamada Telefónica";
  if (t.includes("teléfono") || t.includes("telefono")) return "Llamada Telefónica";

  return "Whatsapp";
}

// ===== Airtable API =====
const airtableBaseUrl = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(
  AIRTABLE_TABLE_NAME
)}`;

async function airtableFindByCalendlyId(calendlyId) {
  const formula = encodeURIComponent(`{${AIRTABLE_CALENDLY_ID_FIELD}}="${calendlyId}"`);
  const url = `${airtableBaseUrl}?filterByFormula=${formula}`;

  const res = await axios.get(url, {
    headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` },
  });

  return res.data.records?.[0] || null;
}

async function airtableCreate(fields) {
  const res = await axios.post(
    airtableBaseUrl,
    { records: [{ fields }] },
    {
      headers: {
        Authorization: `Bearer ${AIRTABLE_TOKEN}`,
        "Content-Type": "application/json",
      },
    }
  );
  return res.data.records?.[0];
}

async function airtableUpdate(recordId, fields) {
  const res = await axios.patch(
    airtableBaseUrl,
    { records: [{ id: recordId, fields }] },
    {
      headers: {
        Authorization: `Bearer ${AIRTABLE_TOKEN}`,
        "Content-Type": "application/json",
      },
    }
  );
  return res.data.records?.[0];
}

// ===== Calendly API =====
const calendly = axios.create({
  baseURL: "https://api.calendly.com",
  headers: {
    Authorization: `Bearer ${CALENDLY_PAT}`,
    "Content-Type": "application/json",
  },
});

async function fetchScheduledEvents() {
  const minStart = isoNow();
  const maxStart = isoDaysFromNow(CALENDLY_LOOKAHEAD_DAYS);

  logDebug(`[SYNC] Fetch scheduled events from ${minStart} to ${maxStart}`);

  const res = await calendly.get("/scheduled_events", {
    params: {
      user: CALENDLY_USER_URI,
      min_start_time: minStart,
      max_start_time: maxStart,
      sort: "start_time:asc",
      status: "active",
    },
  });

  return res.data.collection || [];
}

async function fetchInviteesForEvent(eventUri) {
  // eventUri es tipo: https://api.calendly.com/scheduled_events/XXXX
  // Aquí hay dos formas:
  // 1) pasar el ID (la última parte)
  // 2) usar el endpoint completo encodeando la URI
  // Calendly soporta: /scheduled_events/{uuid}/invitees
  // Pero eventUri suele ser URI completa, así que extraemos el "uuid":

  const parts = eventUri.split("/");
  const uuid = parts[parts.length - 1];

  const res = await calendly.get(`/scheduled_events/${uuid}/invitees`);
  return res.data.collection || [];
}

// ===== Sync Logic =====
async function syncCalendlyToAirtable() {
  try {
    if (!CALENDLY_PAT || !CALENDLY_USER_URI || !AIRTABLE_TOKEN || !AIRTABLE_BASE_ID || !AIRTABLE_TABLE_NAME) {
      console.log("[SYNC] Missing env vars. Skipping.");
      return;
    }

    console.log(`[SYNC] Running sync. Lookahead days=${CALENDLY_LOOKAHEAD_DAYS}`);

    const events = await fetchScheduledEvents();
    console.log(`[SYNC] Found ${events.length} events`);

    for (const ev of events) {
      const eventUri = ev.uri;           // URI completa
      const calendlyId = ev.uri;         // usamos la URI como ID estable (sirve perfecto)
      const startTime = ev.start_time;   // ISO (UTC)
      const endTime = ev.end_time;       // ISO (UTC)

      const invitees = await fetchInviteesForEvent(eventUri);
      const invitee = invitees[0];
      if (!invitee) continue;

      const name = invitee.name || "";
      const questions = invitee.questions_and_answers || [];

      const phoneRaw =
        getAnswer(questions, "teléfono") ||
        getAnswer(questions, "telefono") ||
        invitee.text_reminder_number ||
        null;

      const phoneE164 = toE164Spain(phoneRaw);

      // La pregunta del canal puede variar según el texto exacto
      const channelRaw =
      getAnswer(questions, "canal") ||
      getAnswer(questions, "contact") ||
      getAnswer(questions, "¿cómo prefieres") ||
      "WhatsApp";
    
    const channel = normalizeChannel(channelRaw);



      // Campos Airtable (ajusta si tus nombres son distintos)
      const fields = {
        [AIRTABLE_CALENDLY_ID_FIELD]: calendlyId,
        "Nombre": name,
        "Teléfono E164": phoneE164,
        "Fecha": startTime,
        "Canal": channel,
        "Status": "Programada",
      };

      const existing = await airtableFindByCalendlyId(calendlyId);

      if (existing) {
        await airtableUpdate(existing.id, fields);
        log(`[SYNC] Updated: ${name}`);
      } else {
        await airtableCreate(fields);
        log(`[SYNC] Created: ${name}`);
      }
    }

    console.log("[SYNC] Done.");
  } catch (err) {
    console.error("[SYNC] Error:", err?.response?.data || err.message);
  }
}

// ===== Start polling =====
const intervalMs = Number(CALENDLY_POLL_INTERVAL_MINUTES) * 60 * 1000;

// Ejecuta una vez al arrancar
syncCalendlyToAirtable();

// Repite cada X minutos
setInterval(syncCalendlyToAirtable, intervalMs);

// Endpoint por si en el futuro tienes Webhooks en Calendly
app.post("/webhooks/calendly", async (req, res) => {
  return res.status(200).json({ ok: true });
});

// ===== WhatsApp Cloud API (test sender) =====
const {
  WHATSAPP_ACCESS_TOKEN,
  WHATSAPP_PHONE_NUMBER_ID,
  META_GRAPH_VERSION = "v22.0",
} = process.env;

app.post("/whatsapp/send-test", async (req, res) => {
  try {
    const { to, text } = req.body;

    if (!WHATSAPP_ACCESS_TOKEN || !WHATSAPP_PHONE_NUMBER_ID) {
      return res.status(500).json({ ok: false, error: "Missing WhatsApp env vars" });
    }

    if (!to || !text) {
      return res.status(400).json({ ok: false, error: "Body must include { to, text }" });
    }

    // WhatsApp expects E.164 without spaces, e.g. +34600111222
    const toClean = String(to).replace(/\s/g, "");

    const url = `https://graph.facebook.com/${META_GRAPH_VERSION}/${WHATSAPP_PHONE_NUMBER_ID}/messages`;

    const payload = {
      messaging_product: "whatsapp",
      to: toClean,
      type: "text",
      text: { body: text },
    };

    const resp = await axios.post(url, payload, {
      headers: {
        Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
        "Content-Type": "application/json",
      },
    });

    return res.status(200).json({ ok: true, data: resp.data });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err?.response?.data || err.message,
    });
  }
});

app.listen(PORT, () => {
  console.log("Server running on port", PORT, "TZ=", TZ, "NODE_ENV=", NODE_ENV);
});