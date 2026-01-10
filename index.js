require("dotenv").config();
const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json({ limit: "1mb" }));

// ===================================
// ✅ CORS (necesario para Portal + SSE)
// ===================================
const ALLOWED_ORIGINS = [
  "http://localhost:3000",
  // añade tu dominio final de Vercel cuando lo tengas:
  // "https://ace-project.vercel.app",
];

app.use((req, res, next) => {
  const origin = req.headers.origin;

  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  } else {
    // fallback útil para curl/postman
    res.setHeader("Access-Control-Allow-Origin", "*");
  }

  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-api-key");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Credentials", "true");

  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

const PORT = process.env.PORT || 3000;

// ===================================
// ENV
// ===================================
const {
  // Airtable
  AIRTABLE_TOKEN,
  AIRTABLE_BASE_ID,

  // Airtable (citas)
  AIRTABLE_TABLE_NAME,
  AIRTABLE_CALENDLY_ID_FIELD = "ID Calendly",

  // Airtable (conversaciones)
  AIRTABLE_CONVERSATIONS_TABLE_NAME = "Conversaciones WhatsApp",
  AIRTABLE_WA_ID_FIELD = "wa_id",
  AIRTABLE_WA_LAST_MESSAGE_FIELD = "Último mensaje",
  AIRTABLE_WA_LAST_MESSAGE_TIME_FIELD = "Fecha último mensaje",
  AIRTABLE_WA_PHONE_NUMBER_ID_FIELD = "Phone Number ID",
  AIRTABLE_WA_STATUS_FIELD = "Estado conversación",
  AIRTABLE_WA_LINK_FIELD = "Cita (link)",

  // Airtable (mensajes)
  AIRTABLE_MESSAGES_TABLE_NAME = "Mensajes WhatsApp",
  AIRTABLE_MSG_ID_FIELD = "message_id",
  AIRTABLE_MSG_DIRECTION_FIELD = "direction",
  AIRTABLE_MSG_WA_ID_FIELD = "wa_id",
  AIRTABLE_MSG_TEXT_FIELD = "Texto",
  AIRTABLE_MSG_DATE_FIELD = "Fecha",
  AIRTABLE_MSG_CONVO_LINK_FIELD = "Conversación",

  // WhatsApp Cloud API
  WHATSAPP_ACCESS_TOKEN,
  WHATSAPP_PHONE_NUMBER_ID,
  WHATSAPP_VERIFY_TOKEN,
  META_GRAPH_VERSION = "v24.0",

  // Seguridad portal
  PORTAL_API_KEY,

  TZ = "Europe/Madrid",
  LOG_LEVEL = "info",
  NODE_ENV = "development",
} = process.env;

// ===================================
// ✅ GUARD CLAUSE (NO ARRANCA SI FALTA ALGO CRÍTICO)
// ===================================
function assertEnv() {
  const required = [
    "AIRTABLE_TOKEN",
    "AIRTABLE_BASE_ID",
    "AIRTABLE_TABLE_NAME",
    "WHATSAPP_ACCESS_TOKEN",
    "WHATSAPP_PHONE_NUMBER_ID",
    "WHATSAPP_VERIFY_TOKEN",
    "PORTAL_API_KEY",
  ];

  const missing = required.filter((k) => !process.env[k] || String(process.env[k]).trim() === "");
  if (missing.length) {
    console.error("\n❌ [BOOT] Missing required ENV vars:", missing.join(", "));
    console.error("➡️  Fix your .env / Render env settings and redeploy.\n");
    process.exit(1);
  }

  console.log("✅ [BOOT] ENV OK — starting server");
}

assertEnv();

// ===================================
// Basic routes
// ===================================
app.get("/", (req, res) =>
  res.status(200).send("ACE backend: WhatsApp webhook + Airtable + SSE running")
);
app.get("/health", (req, res) => res.status(200).send("OK"));

// ✅ Mensaje automático cuando está cerrada
const CLOSED_AUTO_REPLY =
  "⛔ Esta conversación está cerrada.\n\nSi deseas volver a hablar con nosotros, por favor reserva otra cita en Calendly o escríbenos por correo.";

// ===================================
// Helpers
// ===================================
function isoNow() {
  return new Date().toISOString();
}

function logInfo(...args) {
  if (LOG_LEVEL === "debug" || LOG_LEVEL === "info") console.log(...args);
}

function logDebug(...args) {
  if (LOG_LEVEL === "debug") console.log(...args);
}

function logError(tag, e, extra = {}) {
  console.error(tag, {
    ...extra,
    error: e?.response?.data || e?.message || String(e),
  });
}

function toE164FromWaId(waId) {
  if (!waId) return null;
  return waId.startsWith("+") ? waId : `+${waId}`;
}

// ===================================
// Airtable helpers
// ===================================
function airtableHeaders() {
  return {
    Authorization: `Bearer ${AIRTABLE_TOKEN}`,
    "Content-Type": "application/json",
  };
}

const airtableCitasUrl = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(
  AIRTABLE_TABLE_NAME || ""
)}`;

const airtableConversationsUrl = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(
  AIRTABLE_CONVERSATIONS_TABLE_NAME
)}`;

const airtableMessagesUrl = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(
  AIRTABLE_MESSAGES_TABLE_NAME
)}`;

// ---- Citas: buscar por teléfono E164 ----
async function airtableFindAppointmentByPhone(phoneE164) {
  if (!phoneE164) return null;
  const formula = encodeURIComponent(`{Teléfono E164}="${phoneE164}"`);
  const url = `${airtableCitasUrl}?filterByFormula=${formula}`;
  const res = await axios.get(url, { headers: airtableHeaders() });
  return res.data.records?.[0] || null;
}

// ✅ Listar próximas citas desde Airtable (Fecha >= ahora)
async function airtableListUpcomingAppointments(limit = 50) {
  const DATE_FIELD = "Fecha"; // ✅ confirmado
  const now = new Date().toISOString();
  const formula = encodeURIComponent(`{${DATE_FIELD}}>="${now}"`);

  const url = `${airtableCitasUrl}?filterByFormula=${formula}&sort[0][field]=${encodeURIComponent(
    DATE_FIELD
  )}&sort[0][direction]=asc&pageSize=${Math.min(limit, 100)}`;

  const res = await axios.get(url, { headers: airtableHeaders() });
  return res.data.records || [];
}

// ---- Conversaciones: buscar por wa_id ----
async function airtableFindConversationByWaId(waId) {
  const formula = encodeURIComponent(`{${AIRTABLE_WA_ID_FIELD}}="${waId}"`);
  const url = `${airtableConversationsUrl}?filterByFormula=${formula}`;
  const res = await axios.get(url, { headers: airtableHeaders() });
  return res.data.records?.[0] || null;
}

async function airtableCreateConversation(fields) {
  const res = await axios.post(
    airtableConversationsUrl,
    { records: [{ fields }] },
    { headers: airtableHeaders() }
  );
  return res.data.records?.[0];
}

async function airtableUpdateConversation(recordId, fields) {
  const res = await axios.patch(
    airtableConversationsUrl,
    { records: [{ id: recordId, fields }] },
    { headers: airtableHeaders() }
  );
  return res.data.records?.[0];
}

// ---- Mensajes: crear siempre ----
async function airtableCreateMessage(fields) {
  const res = await axios.post(
    airtableMessagesUrl,
    { records: [{ fields }] },
    { headers: airtableHeaders() }
  );
  return res.data.records?.[0];
}

// ✅ Listar mensajes por wa_id (pageSize siempre 100)
async function airtableListMessagesByWaId(waId, limit = 100) {
  const pageSize = 100;
  const formula = encodeURIComponent(`{${AIRTABLE_MSG_WA_ID_FIELD}}="${waId}"`);
  const sort = `sort[0][field]=${encodeURIComponent(
    AIRTABLE_MSG_DATE_FIELD
  )}&sort[0][direction]=asc`;

  const url = `${airtableMessagesUrl}?filterByFormula=${formula}&pageSize=${pageSize}&${sort}`;
  const res = await axios.get(url, { headers: airtableHeaders() });

  return (res.data.records || []).slice(0, limit);
}

// ✅ Saber si un wa_id ya tiene mensajes (rápido: pageSize 1)
async function airtableHasMessages(waId) {
  const formula = encodeURIComponent(`{${AIRTABLE_MSG_WA_ID_FIELD}}="${waId}"`);
  const url = `${airtableMessagesUrl}?filterByFormula=${formula}&pageSize=1`;
  const res = await axios.get(url, { headers: airtableHeaders() });
  return (res.data.records || []).length > 0;
}

// ===================================
// SSE (tiempo real)
// ===================================
const sseClientsByWaId = new Map(); // wa_id -> Set(res)

function sseSend(waId, event) {
  const clients = sseClientsByWaId.get(waId);
  if (!clients || clients.size === 0) return;

  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of clients) {
    try {
      res.write(payload);
    } catch {}
  }
}

app.get("/sse", (req, res) => {
  const waId = String(req.query.wa_id || "").trim();
  if (!waId) return res.status(400).send("Missing wa_id");

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  if (!sseClientsByWaId.has(waId)) sseClientsByWaId.set(waId, new Set());
  sseClientsByWaId.get(waId).add(res);

  res.write(
    `data: ${JSON.stringify({ type: "connected", waId, ts: isoNow() })}\n\n`
  );

  req.on("close", () => {
    const set = sseClientsByWaId.get(waId);
    if (set) {
      set.delete(res);
      if (set.size === 0) sseClientsByWaId.delete(waId);
    }
  });
});

// ===================================
// WhatsApp Cloud API send helper
// ===================================
async function sendWhatsAppText(toWaIdOrPhone, text) {
  const toClean = String(toWaIdOrPhone).replace(/\s/g, "");
  const url = `https://graph.facebook.com/${META_GRAPH_VERSION}/${WHATSAPP_PHONE_NUMBER_ID}/messages`;

  const payload = {
    messaging_product: "whatsapp",
    to: toClean.startsWith("+") ? toClean.slice(1) : toClean,
    type: "text",
    text: { body: text },
  };

  const resp = await axios.post(url, payload, {
    headers: {
      Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
      "Content-Type": "application/json",
    },
  });

  return resp.data;
}

// ===================================
// Seguridad portal (API key)
// ===================================
function portalAuth(req, res, next) {
  const key = req.headers["x-api-key"];
  if (!key || key !== PORTAL_API_KEY) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }
  next();
}

// ===================================
// ✅ SYNC: crea conversaciones Programadas desde citas futuras
// ===================================
async function syncAppointmentsToConversations(limit = 50) {
  const appointments = await airtableListUpcomingAppointments(limit);
  let created = 0;

  for (const appt of appointments) {
    const phoneE164 = appt.fields?.["Teléfono E164"];
    if (!phoneE164) continue;

    const waId = String(phoneE164).replace("+", "").trim();
    if (!waId) continue;

    const existing = await airtableFindConversationByWaId(waId);
    if (existing) continue;

    await airtableCreateConversation({
      [AIRTABLE_WA_ID_FIELD]: waId,
      Nombre: appt.fields?.["Nombre"] || "",
      [AIRTABLE_WA_STATUS_FIELD]: "Programada",
      [AIRTABLE_WA_PHONE_NUMBER_ID_FIELD]: WHATSAPP_PHONE_NUMBER_ID,
      [AIRTABLE_WA_LAST_MESSAGE_FIELD]: "📅 Cita programada (sin mensajes aún)",
      [AIRTABLE_WA_LAST_MESSAGE_TIME_FIELD]: isoNow(),
      [AIRTABLE_WA_LINK_FIELD]: [appt.id],
    });

    created++;
    logInfo("[SYNC] ✅ Created scheduled convo:", waId);
  }

  if (created > 0) logInfo("[SYNC] ✅ Done. created:", created, "total:", appointments.length);
  else logDebug("[SYNC] No new scheduled convos. total:", appointments.length);

  return { created, total: appointments.length };
}

// Endpoint manual
app.post("/sync/appointments", portalAuth, async (req, res) => {
  try {
    const result = await syncAppointmentsToConversations(50);
    return res.json({ ok: true, ...result });
  } catch (e) {
    logError("[SYNC-APPOINTMENTS] ❌ Error", e);
    return res.status(500).json({ ok: false, error: e?.response?.data || e.message });
  }
});

// Auto sync cada 10 minutos
setInterval(async () => {
  try {
    await syncAppointmentsToConversations(50);
  } catch (e) {
    logError("[SYNC] ❌ Error", e);
  }
}, 10 * 60 * 1000);

// ===================================
// Portal → listar conversaciones (INBOX)
// ===================================
app.get("/portal/conversations", portalAuth, async (req, res) => {
  try {
    const formula = encodeURIComponent(`{${AIRTABLE_WA_STATUS_FIELD}}!="Cerrada"`);

    const url = `${airtableConversationsUrl}?filterByFormula=${formula}&sort[0][field]=${encodeURIComponent(
      AIRTABLE_WA_LAST_MESSAGE_TIME_FIELD
    )}&sort[0][direction]=desc&pageSize=50`;

    const r = await axios.get(url, { headers: airtableHeaders() });

    const items = (r.data.records || []).map((rec) => ({
      id: rec.id,
      wa_id: rec.fields?.[AIRTABLE_WA_ID_FIELD],
      nombre: rec.fields?.["Nombre"] || "",
      ultimo: rec.fields?.[AIRTABLE_WA_LAST_MESSAGE_FIELD] || "",
      fecha: rec.fields?.[AIRTABLE_WA_LAST_MESSAGE_TIME_FIELD] || "",
      estado: rec.fields?.[AIRTABLE_WA_STATUS_FIELD] || "",
    }));

    return res.json({ ok: true, items });
  } catch (e) {
    logError("[PORTAL-CONVERSATIONS] ❌ Error", e);
    return res.status(500).json({ ok: false, error: e?.response?.data || e.message });
  }
});

// ===================================
// Portal → historial de mensajes (chat)
// ===================================
app.get("/portal/messages", portalAuth, async (req, res) => {
  try {
    const waId = String(req.query.wa_id || "").trim();
    if (!waId) return res.status(400).json({ ok: false, error: "Missing wa_id" });

    const records = await airtableListMessagesByWaId(waId, 100);

    const items = records.map((rec) => ({
      message_id: rec.fields?.[AIRTABLE_MSG_ID_FIELD] || rec.id,
      direction: rec.fields?.[AIRTABLE_MSG_DIRECTION_FIELD] || "IN",
      wa_id: rec.fields?.[AIRTABLE_MSG_WA_ID_FIELD] || waId,
      text: rec.fields?.[AIRTABLE_MSG_TEXT_FIELD] || "",
      date: rec.fields?.[AIRTABLE_MSG_DATE_FIELD] || "",
    }));

    return res.json({ ok: true, items });
  } catch (e) {
    logError("[PORTAL-MESSAGES] ❌ Error", e);
    return res.status(500).json({ ok: false, error: e?.response?.data || e.message });
  }
});

// ===================================
// Portal → send message (OUT)
// ===================================
app.post("/portal/send", portalAuth, async (req, res) => {
  try {
    const { wa_id, text } = req.body;
    if (!wa_id || !text) {
      return res.status(400).json({ ok: false, error: "Body must include { wa_id, text }" });
    }

    const convo = await airtableFindConversationByWaId(wa_id);

    // 🔒 Si está cerrada, NO dejamos enviar
    if (convo && convo.fields?.[AIRTABLE_WA_STATUS_FIELD] === "Cerrada") {
      logInfo("[PORTAL-SEND] ❌ Attempt send to CLOSED convo:", wa_id);
      return res.status(403).json({
        ok: false,
        error: "Conversation is closed. Reopen manually if needed.",
      });
    }

    const data = await sendWhatsAppText(wa_id, text);

    let finalConvo = convo;

    if (!finalConvo) {
      finalConvo = await airtableCreateConversation({
        [AIRTABLE_WA_ID_FIELD]: wa_id,
        Nombre: "",
        [AIRTABLE_WA_LAST_MESSAGE_FIELD]: text,
        [AIRTABLE_WA_LAST_MESSAGE_TIME_FIELD]: isoNow(),
        [AIRTABLE_WA_PHONE_NUMBER_ID_FIELD]: WHATSAPP_PHONE_NUMBER_ID,
        [AIRTABLE_WA_STATUS_FIELD]: "Activa",
      });
    } else {
      await airtableUpdateConversation(finalConvo.id, {
        [AIRTABLE_WA_LAST_MESSAGE_FIELD]: text,
        [AIRTABLE_WA_LAST_MESSAGE_TIME_FIELD]: isoNow(),
        [AIRTABLE_WA_STATUS_FIELD]: "Activa",
      });
    }

    const msgId = data?.messages?.[0]?.id || `out_${Date.now()}`;
    await airtableCreateMessage({
      [AIRTABLE_MSG_ID_FIELD]: msgId,
      [AIRTABLE_MSG_DIRECTION_FIELD]: "OUT",
      [AIRTABLE_MSG_WA_ID_FIELD]: wa_id,
      [AIRTABLE_MSG_TEXT_FIELD]: text,
      [AIRTABLE_MSG_DATE_FIELD]: isoNow(),
      [AIRTABLE_MSG_CONVO_LINK_FIELD]: [finalConvo.id],
    });

    sseSend(wa_id, {
      type: "message",
      direction: "OUT",
      message_id: msgId,
      wa_id,
      text,
      date: isoNow(),
    });

    logInfo("[PORTAL-SEND] ✅ OUT sent:", { wa_id, msgId });

    return res.status(200).json({ ok: true, data });
  } catch (e) {
    logError("[PORTAL-SEND] ❌ Error", e);
    return res.status(500).json({ ok: false, error: e?.response?.data || e.message });
  }
});

// ===================================
// Portal → cerrar conversación manualmente
// ===================================
app.post("/portal/close", portalAuth, async (req, res) => {
  try {
    const { wa_id } = req.body;
    if (!wa_id) {
      return res.status(400).json({ ok: false, error: "Body must include { wa_id }" });
    }

    const convo = await airtableFindConversationByWaId(wa_id);
    if (!convo) {
      return res.status(404).json({ ok: false, error: "Conversation not found" });
    }

    const finalText =
      "⏳ Hemos cerrado esta conversación. Si deseas volver a hablar con nosotros, por favor reserva otra cita en Calendly o escríbenos por correo.";

    const data = await sendWhatsAppText(wa_id, finalText);
    const msgId = data?.messages?.[0]?.id || `out_close_${Date.now()}`;

    await airtableCreateMessage({
      [AIRTABLE_MSG_ID_FIELD]: msgId,
      [AIRTABLE_MSG_DIRECTION_FIELD]: "OUT",
      [AIRTABLE_MSG_WA_ID_FIELD]: wa_id,
      [AIRTABLE_MSG_TEXT_FIELD]: finalText,
      [AIRTABLE_MSG_DATE_FIELD]: isoNow(),
      [AIRTABLE_MSG_CONVO_LINK_FIELD]: [convo.id],
    });

    await airtableUpdateConversation(convo.id, {
      [AIRTABLE_WA_STATUS_FIELD]: "Cerrada",
      [AIRTABLE_WA_LAST_MESSAGE_FIELD]: finalText,
      [AIRTABLE_WA_LAST_MESSAGE_TIME_FIELD]: isoNow(),
    });

    sseSend(wa_id, {
      type: "conversation_closed",
      wa_id,
      text: finalText,
      date: isoNow(),
    });

    logInfo("[PORTAL-CLOSE] ✅ Closed convo:", wa_id);

    return res.status(200).json({ ok: true, closed: true });
  } catch (e) {
    logError("[PORTAL-CLOSE] ❌ Error", e);
    return res.status(500).json({ ok: false, error: e?.response?.data || e.message });
  }
});

// ===================================
// WhatsApp Webhook Verification
// ===================================
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

// ===================================
// WhatsApp Webhook (IN) → Airtable + SSE
// ===================================
app.post("/webhooks/whatsapp", async (req, res) => {
  res.sendStatus(200);

  try {
    const body = req.body;
    logDebug("[WA-WEBHOOK] BODY ✅", JSON.stringify(body).slice(0, 800));
    if (!body?.entry?.length) return;

    for (const entry of body.entry) {
      for (const change of entry.changes || []) {
        const value = change.value || {};
        const messages = value.messages || [];
        const contacts = value.contacts || [];
        if (!messages.length) continue;

        const msg = messages[0];
        const waId = msg.from;
        const text = msg?.text?.body || "(no-text)";
        const timestampIso = msg.timestamp
          ? new Date(Number(msg.timestamp) * 1000).toISOString()
          : isoNow();

        const phoneNumberId = value?.metadata?.phone_number_id || null;
        const contactName = contacts?.[0]?.profile?.name || "";

        logInfo("[WA] Incoming:", { waId, contactName, text });

        // 1) Buscar conversación existente
        let convo = await airtableFindConversationByWaId(waId);

        // ===================================
        // ✅ BLOQUEO DE REAPERTURA SI ESTÁ CERRADA
        // ===================================
        if (convo && convo.fields?.[AIRTABLE_WA_STATUS_FIELD] === "Cerrada") {
          logInfo("[WA] 🔒 BLOCKED reopen (CLOSED):", waId);

          const inMsgId = msg.id || `in_${Date.now()}`;
          await airtableCreateMessage({
            [AIRTABLE_MSG_ID_FIELD]: inMsgId,
            [AIRTABLE_MSG_DIRECTION_FIELD]: "IN",
            [AIRTABLE_MSG_WA_ID_FIELD]: waId,
            [AIRTABLE_MSG_TEXT_FIELD]: text,
            [AIRTABLE_MSG_DATE_FIELD]: timestampIso,
            [AIRTABLE_MSG_CONVO_LINK_FIELD]: [convo.id],
          });

          const data = await sendWhatsAppText(waId, CLOSED_AUTO_REPLY);
          const outMsgId = data?.messages?.[0]?.id || `out_closed_${Date.now()}`;

          await airtableCreateMessage({
            [AIRTABLE_MSG_ID_FIELD]: outMsgId,
            [AIRTABLE_MSG_DIRECTION_FIELD]: "OUT",
            [AIRTABLE_MSG_WA_ID_FIELD]: waId,
            [AIRTABLE_MSG_TEXT_FIELD]: CLOSED_AUTO_REPLY,
            [AIRTABLE_MSG_DATE_FIELD]: isoNow(),
            [AIRTABLE_MSG_CONVO_LINK_FIELD]: [convo.id],
          });

          sseSend(waId, {
            type: "message",
            direction: "IN",
            message_id: inMsgId,
            wa_id: waId,
            name: contactName,
            text,
            date: timestampIso,
          });

          sseSend(waId, {
            type: "message",
            direction: "OUT",
            message_id: outMsgId,
            wa_id: waId,
            text: CLOSED_AUTO_REPLY,
            date: isoNow(),
          });

          continue;
        }

        // 2) Buscar cita por teléfono
        const phoneE164 = toE164FromWaId(waId);
        const appointment = await airtableFindAppointmentByPhone(phoneE164);

        // ✅ si ya hay mensajes, NO puede ser Programada
        const hasMsgs = await airtableHasMessages(waId);

        // ✅ Estado correcto:
        let status = "Activa";
        if (appointment && !hasMsgs) status = "Programada";

        const convoFields = {
          [AIRTABLE_WA_ID_FIELD]: waId,
          Nombre: contactName,
          [AIRTABLE_WA_LAST_MESSAGE_FIELD]: text,
          [AIRTABLE_WA_LAST_MESSAGE_TIME_FIELD]: timestampIso,
          [AIRTABLE_WA_PHONE_NUMBER_ID_FIELD]: phoneNumberId,
          [AIRTABLE_WA_STATUS_FIELD]: status,
        };

        if (appointment) convoFields[AIRTABLE_WA_LINK_FIELD] = [appointment.id];

        // 3) Upsert conversación
        if (convo) {
          convo = await airtableUpdateConversation(convo.id, convoFields);
        } else {
          convo = await airtableCreateConversation(convoFields);
        }

        // 4) Guardar mensaje IN
        const msgId = msg.id || `in_${Date.now()}`;
        await airtableCreateMessage({
          [AIRTABLE_MSG_ID_FIELD]: msgId,
          [AIRTABLE_MSG_DIRECTION_FIELD]: "IN",
          [AIRTABLE_MSG_WA_ID_FIELD]: waId,
          [AIRTABLE_MSG_TEXT_FIELD]: text,
          [AIRTABLE_MSG_DATE_FIELD]: timestampIso,
          [AIRTABLE_MSG_CONVO_LINK_FIELD]: [convo.id],
        });

        // 5) SSE portal
        sseSend(waId, {
          type: "message",
          direction: "IN",
          message_id: msgId,
          wa_id: waId,
          name: contactName,
          text,
          date: timestampIso,
        });

        logInfo("[WA] ✅ Saved IN:", { waId, msgId, status });
      }
    }
  } catch (e) {
    logError("[WA-WEBHOOK] ❌ Error", e);
  }
});

// ===================================
// LISTEN
// ===================================
app.listen(PORT, () => {
  console.log("Server running on port", PORT, "TZ=", TZ, "NODE_ENV=", NODE_ENV);
});