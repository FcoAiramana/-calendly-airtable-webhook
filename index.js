require("dotenv").config();
const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 3000;

// ===== ENV =====
const {
  // Calendly
  CALENDLY_PAT,
  CALENDLY_USER_URI,
  CALENDLY_POLL_INTERVAL_MINUTES = "5",
  CALENDLY_LOOKAHEAD_DAYS = "14",

  // Airtable
  AIRTABLE_TOKEN,
  AIRTABLE_BASE_ID,
  AIRTABLE_TABLE_NAME,
  AIRTABLE_CALENDLY_ID_FIELD = "ID Calendly",

  // WhatsApp Conversations table (Airtable)
  AIRTABLE_CONVERSATIONS_TABLE_NAME = "Conversaciones WhatsApp",
  AIRTABLE_WA_ID_FIELD = "wa_id",
  AIRTABLE_WA_LAST_MESSAGE_FIELD = "Último mensaje",
  AIRTABLE_WA_LAST_MESSAGE_TIME_FIELD = "Fecha último mensaje",
  AIRTABLE_WA_PHONE_NUMBER_ID_FIELD = "Phone Number ID",
  AIRTABLE_WA_STATUS_FIELD = "Estado conversación",
  AIRTABLE_WA_LINK_FIELD = "Cita (link)",

  // WhatsApp Messages table (Airtable)
  AIRTABLE_MESSAGES_TABLE_NAME = "Mensajes WhatsApp",
  AIRTABLE_MSG_CONVERSATION_FIELD = "Conversación",

  // WhatsApp Cloud API
  WHATSAPP_ACCESS_TOKEN,
  WHATSAPP_PHONE_NUMBER_ID,
  WHATSAPP_VERIFY_TOKEN,
  META_GRAPH_VERSION = "v24.0",

  // Misc
  TZ = "Europe/Madrid",
  LOG_LEVEL = "info",
  NODE_ENV = "development",
} = process.env;

// ===== Basic routes =====
app.get("/", (req, res) =>
  res.status(200).send("Calendly → Airtable sync service running")
);
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
  const item = questionsAndAnswers.find((q) =>
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

  if (t.includes("whatsapp")) return "Whatsapp";
  if (t.includes("por whatsapp")) return "Whatsapp";

  if (t.includes("llamada")) return "Llamada Telefónica";
  if (t.includes("teléfono") || t.includes("telefono")) return "Llamada Telefónica";

  return "Whatsapp";
}

// ===== Airtable API: 1er Contacto =====
const airtableAppointmentsUrl = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(
  AIRTABLE_TABLE_NAME || ""
)}`;

async function airtableFindByCalendlyId(calendlyId) {
  const formula = encodeURIComponent(`{${AIRTABLE_CALENDLY_ID_FIELD}}="${calendlyId}"`);
  const url = `${airtableAppointmentsUrl}?filterByFormula=${formula}`;

  const res = await axios.get(url, {
    headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` },
  });

  return res.data.records?.[0] || null;
}

async function airtableCreateAppointment(fields) {
  const res = await axios.post(
    airtableAppointmentsUrl,
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

async function airtableUpdateAppointment(recordId, fields) {
  const res = await axios.patch(
    airtableAppointmentsUrl,
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

// Buscar cita por teléfono E164 en "1er Contacto"
async function airtableFindAppointmentByPhone(phoneE164) {
  const formula = encodeURIComponent(`{Teléfono E164}="${phoneE164}"`);
  const url = `${airtableAppointmentsUrl}?filterByFormula=${formula}`;

  const res = await axios.get(url, {
    headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` },
  });

  return res.data.records?.[0] || null;
}

// ===== Airtable: Conversations =====
const airtableConversationsUrl = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(
  AIRTABLE_CONVERSATIONS_TABLE_NAME
)}`;

async function airtableFindConversationByWaId(waId) {
  const formula = encodeURIComponent(`{${AIRTABLE_WA_ID_FIELD}}="${waId}"`);
  const url = `${airtableConversationsUrl}?filterByFormula=${formula}`;

  const res = await axios.get(url, {
    headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` },
  });

  return res.data.records?.[0] || null;
}

async function airtableCreateConversation(fields) {
  const res = await axios.post(
    airtableConversationsUrl,
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

async function airtableUpdateConversation(recordId, fields) {
  const res = await axios.patch(
    airtableConversationsUrl,
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

// ===== Airtable: Messages =====
const airtableMessagesUrl = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(
  AIRTABLE_MESSAGES_TABLE_NAME
)}`;

async function airtableCreateMessage(fields) {
  const res = await axios.post(
    airtableMessagesUrl,
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
  const parts = eventUri.split("/");
  const uuid = parts[parts.length - 1];
  const res = await calendly.get(`/scheduled_events/${uuid}/invitees`);
  return res.data.collection || [];
}

// ===== Sync Logic: Calendly → Airtable =====
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
      const calendlyId = ev.uri;
      const startTime = ev.start_time;

      const invitees = await fetchInviteesForEvent(ev.uri);
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

      const channelRaw =
        getAnswer(questions, "canal") ||
        getAnswer(questions, "contact") ||
        getAnswer(questions, "¿cómo prefieres") ||
        "WhatsApp";

      const channel = normalizeChannel(channelRaw);

      const fields = {
        [AIRTABLE_CALENDLY_ID_FIELD]: calendlyId,
        Nombre: name,
        "Teléfono E164": phoneE164,
        Fecha: startTime,
        Canal: channel,
        Status: "Programada",
      };

      const existing = await airtableFindByCalendlyId(calendlyId);

      if (existing) {
        await airtableUpdateAppointment(existing.id, fields);
        log(`[SYNC] Updated: ${name}`);
      } else {
        await airtableCreateAppointment(fields);
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
syncCalendlyToAirtable();
setInterval(syncCalendlyToAirtable, intervalMs);

// ===== WhatsApp Cloud API (test sender) =====
app.post("/whatsapp/send-test", async (req, res) => {
  try {
    const { to, text } = req.body;
    console.log("[WA-SEND] Using WHATSAPP_PHONE_NUMBER_ID =", WHATSAPP_PHONE_NUMBER_ID);

    if (!WHATSAPP_ACCESS_TOKEN || !WHATSAPP_PHONE_NUMBER_ID) {
      return res.status(500).json({ ok: false, error: "Missing WhatsApp env vars" });
    }

    if (!to || !text) {
      return res.status(400).json({ ok: false, error: "Body must include { to, text }" });
    }

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

// ===== WhatsApp Webhook: verification =====
app.get("/webhooks/whatsapp", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === WHATSAPP_VERIFY_TOKEN) {
    console.log("[WA-WEBHOOK] Verified ✅");
    return res.status(200).send(challenge);
  }

  console.log("[WA-WEBHOOK] Verify failed ❌", { mode, token });
  return res.sendStatus(403);
});

// ===== WhatsApp Webhook: incoming messages → Airtable (Conversations + Messages) =====
app.post("/webhooks/whatsapp", async (req, res) => {
  res.sendStatus(200);

  try {
    console.log("[WA-WEBHOOK] ✅ VERSION GUARDAR AIRTABLE ACTIVA");
    const body = req.body;
    console.log("[WA-WEBHOOK] BODY ✅", JSON.stringify(body).slice(0, 800));

    if (!body?.entry?.length) return;

    for (const entry of body.entry) {
      const changes = entry.changes || [];
      for (const change of changes) {
        const value = change.value || {};
        const messages = value.messages || [];
        const contacts = value.contacts || [];

        if (!messages.length) continue;

        const msg = messages[0];
        const waId = msg.from; // "346..."
        const text = msg?.text?.body || "(no-text)";
        const timestamp = msg.timestamp
          ? new Date(Number(msg.timestamp) * 1000).toISOString()
          : new Date().toISOString();

        const phoneNumberId = value?.metadata?.phone_number_id || null;
        const contactName = contacts?.[0]?.profile?.name || "";

        console.log("[WA] Incoming message:", { waId, contactName, text });

        // Convertimos waId en E164
        const phoneE164 = waId.startsWith("+") ? waId : `+${waId}`;

        // Buscar cita en 1er Contacto por teléfono
        const appointment = await airtableFindAppointmentByPhone(phoneE164);

        // Campos Conversaciones WhatsApp
        const convoFields = {
          [AIRTABLE_WA_ID_FIELD]: waId,
          Nombre: contactName,
          [AIRTABLE_WA_LAST_MESSAGE_FIELD]: text,
          [AIRTABLE_WA_LAST_MESSAGE_TIME_FIELD]: timestamp,
          [AIRTABLE_WA_PHONE_NUMBER_ID_FIELD]: phoneNumberId,
          [AIRTABLE_WA_STATUS_FIELD]: "Abierta",
        };

        if (appointment) {
          convoFields[AIRTABLE_WA_LINK_FIELD] = [appointment.id];
        }

        const existing = await airtableFindConversationByWaId(waId);
        let convoRecord = null;

        if (existing) {
          convoRecord = await airtableUpdateConversation(existing.id, convoFields);
          console.log("[WA] ✅ Updated conversation:", waId);
        } else {
          convoRecord = await airtableCreateConversation(convoFields);
          console.log("[WA] ✅ Created conversation:", waId);
        }

        // Guardar mensaje en tabla Mensajes WhatsApp
        if (convoRecord?.id) {
          await airtableCreateMessage({
            message_id: msg.id,
            direction: "IN",
            wa_id: waId,
            Texto: text,
            Fecha: timestamp,
            [AIRTABLE_MSG_CONVERSATION_FIELD]: [convoRecord.id],
          });

          console.log("[WA] ✅ Saved message:", msg.id);
        }
      }
    }
  } catch (e) {
    console.error("[WA-WEBHOOK] ❌ Error:", e?.response?.data || e.message);
  }
});

// ✅ LISTEN AL FINAL (Render detecta el puerto)
app.listen(PORT, () => {
  console.log("Server running on port", PORT, "TZ=", TZ, "NODE_ENV=", NODE_ENV);
});