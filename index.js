require("dotenv").config();
const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json({ limit: "1mb" }));

// ✅ Render necesita process.env.PORT
const PORT = process.env.PORT || 3000;

// ===== ENV =====
const {
  // Calendly
  CALENDLY_PAT,
  CALENDLY_USER_URI,
  CALENDLY_POLL_INTERVAL_MINUTES = "5",
  CALENDLY_LOOKAHEAD_DAYS = "14",

  // Airtable (citas)
  AIRTABLE_TOKEN,
  AIRTABLE_BASE_ID,
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

  TZ = "Europe/Madrid",
  LOG_LEVEL = "info",
  NODE_ENV = "development",
} = process.env;

// ===== Basic routes =====
app.get("/", (req, res) =>
  res.status(200).send("Calendly → Airtable sync + WhatsApp webhook service running")
);
app.get("/health", (req, res) => res.status(200).send("OK"));

// =============================
// Helpers
// =============================
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

// Convert wa_id "346187..." to E164 "+346187..."
function toE164FromWaId(waId) {
  if (!waId) return null;
  return waId.startsWith("+") ? waId : `+${waId}`;
}

// =============================
// Airtable API helpers
// =============================
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

// =============================
// SSE: Tiempo real (Portal)
// =============================
const sseClientsByWaId = new Map(); // wa_id -> Set(res)

function sseSend(waId, event) {
  const clients = sseClientsByWaId.get(waId);
  if (!clients || clients.size === 0) return;

  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of clients) {
    try {
      res.write(payload);
    } catch (e) {}
  }
}

// ✅ Portal se conecta aquí para recibir updates en tiempo real
app.get("/sse", (req, res) => {
  const waId = String(req.query.wa_id || "").trim();
  if (!waId) return res.status(400).send("Missing wa_id");

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  // registrar cliente
  if (!sseClientsByWaId.has(waId)) sseClientsByWaId.set(waId, new Set());
  sseClientsByWaId.get(waId).add(res);

  // mensaje inicial
  res.write(`data: ${JSON.stringify({ type: "connected", waId, ts: isoNow() })}\n\n`);

  // cleanup
  req.on("close", () => {
    const set = sseClientsByWaId.get(waId);
    if (set) {
      set.delete(res);
      if (set.size === 0) sseClientsByWaId.delete(waId);
    }
  });
});

// =============================
// WhatsApp Cloud API send helper
// =============================
async function sendWhatsAppText(toWaIdOrPhone, text) {
  if (!WHATSAPP_ACCESS_TOKEN || !WHATSAPP_PHONE_NUMBER_ID) {
    throw new Error("Missing WHATSAPP_ACCESS_TOKEN or WHATSAPP_PHONE_NUMBER_ID");
  }

  const toClean = String(toWaIdOrPhone).replace(/\s/g, "");
  const url = `https://graph.facebook.com/${META_GRAPH_VERSION}/${WHATSAPP_PHONE_NUMBER_ID}/messages`;

  const payload = {
    messaging_product: "whatsapp",
    to: toClean.startsWith("+") ? toClean.slice(1) : toClean, // Meta admite sin "+"
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

// =============================
// Portal → send message (humano)
// =============================
app.post("/portal/send", async (req, res) => {
  try {
    const { wa_id, text } = req.body;
    if (!wa_id || !text) {
      return res.status(400).json({ ok: false, error: "Body must include { wa_id, text }" });
    }

    // 1) enviar por WhatsApp Cloud API
    const data = await sendWhatsAppText(wa_id, text);

    // 2) asegurar conversación existe
    let convo = await airtableFindConversationByWaId(wa_id);
    if (!convo) {
      // si no existía, la creamos mínima
      convo = await airtableCreateConversation({
        [AIRTABLE_WA_ID_FIELD]: wa_id,
        "Nombre": "",
        [AIRTABLE_WA_LAST_MESSAGE_FIELD]: text,
        [AIRTABLE_WA_LAST_MESSAGE_TIME_FIELD]: isoNow(),
        [AIRTABLE_WA_PHONE_NUMBER_ID_FIELD]: WHATSAPP_PHONE_NUMBER_ID,
        [AIRTABLE_WA_STATUS_FIELD]: "Mensaje enviado",
      });
    } else {
      // actualizar "último mensaje"
      await airtableUpdateConversation(convo.id, {
        [AIRTABLE_WA_LAST_MESSAGE_FIELD]: text,
        [AIRTABLE_WA_LAST_MESSAGE_TIME_FIELD]: isoNow(),
        [AIRTABLE_WA_STATUS_FIELD]: "Mensaje enviado",
      });
    }

    // 3) guardar mensaje OUT
    const msgId = data?.messages?.[0]?.id || `out_${Date.now()}`;
    await airtableCreateMessage({
      [AIRTABLE_MSG_ID_FIELD]: msgId,
      [AIRTABLE_MSG_DIRECTION_FIELD]: "OUT",
      [AIRTABLE_MSG_WA_ID_FIELD]: wa_id,
      [AIRTABLE_MSG_TEXT_FIELD]: text,
      [AIRTABLE_MSG_DATE_FIELD]: isoNow(),
      [AIRTABLE_MSG_CONVO_LINK_FIELD]: [convo.id],
    });

    // 4) emitir por SSE
    sseSend(wa_id, {
      type: "message",
      direction: "OUT",
      message_id: msgId,
      wa_id,
      text,
      date: isoNow(),
    });

    return res.status(200).json({ ok: true, data });
  } catch (e) {
    console.error("[PORTAL-SEND] Error:", e?.response?.data || e.message);
    return res.status(500).json({ ok: false, error: e?.response?.data || e.message });
  }
});

// =============================
// WhatsApp Webhook Verification
// =============================
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

// =============================
// WhatsApp Webhook (IN) → Airtable + SSE
// =============================
app.post("/webhooks/whatsapp", async (req, res) => {
  // Respondemos rápido (obligatorio)
  res.sendStatus(200);

  try {
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
        const waId = msg.from; // "346187..."
        const text = msg?.text?.body || "(no-text)";
        const timestampIso = msg.timestamp
          ? new Date(Number(msg.timestamp) * 1000).toISOString()
          : isoNow();

        const phoneNumberId = value?.metadata?.phone_number_id || null;
        const contactName = contacts?.[0]?.profile?.name || "";

        console.log("[WA] Incoming message:", { waId, contactName, text });

        // 1) Buscar cita por teléfono E164 (+34...)
        const phoneE164 = toE164FromWaId(waId);
        const appointment = await airtableFindAppointmentByPhone(phoneE164);

        // 2) Upsert conversación
        const convoFields = {
          [AIRTABLE_WA_ID_FIELD]: waId,
          "Nombre": contactName,
          [AIRTABLE_WA_LAST_MESSAGE_FIELD]: text,
          [AIRTABLE_WA_LAST_MESSAGE_TIME_FIELD]: timestampIso,
          [AIRTABLE_WA_PHONE_NUMBER_ID_FIELD]: phoneNumberId,
          [AIRTABLE_WA_STATUS_FIELD]: "Programada", // o "Abierta" si prefieres
        };

        if (appointment) {
          convoFields[AIRTABLE_WA_LINK_FIELD] = [appointment.id];
        }

        let convo = await airtableFindConversationByWaId(waId);

        if (convo) {
          convo = await airtableUpdateConversation(convo.id, convoFields);
          console.log("[WA] ✅ Updated conversation:", waId);
        } else {
          convo = await airtableCreateConversation(convoFields);
          console.log("[WA] ✅ Created conversation:", waId);
        }

        // 3) Guardar mensaje IN en tabla Mensajes WhatsApp
        const msgId = msg.id || `in_${Date.now()}`;

        await airtableCreateMessage({
          [AIRTABLE_MSG_ID_FIELD]: msgId,
          [AIRTABLE_MSG_DIRECTION_FIELD]: "IN",
          [AIRTABLE_MSG_WA_ID_FIELD]: waId,
          [AIRTABLE_MSG_TEXT_FIELD]: text,
          [AIRTABLE_MSG_DATE_FIELD]: timestampIso,
          [AIRTABLE_MSG_CONVO_LINK_FIELD]: [convo.id],
        });

        console.log("[WA] ✅ Saved message:", msgId);

        // 4) Emitir por SSE (portal en tiempo real)
        sseSend(waId, {
          type: "message",
          direction: "IN",
          message_id: msgId,
          wa_id: waId,
          name: contactName,
          text,
          date: timestampIso,
        });
      }
    }
  } catch (e) {
    console.error("[WA-WEBHOOK] ❌ Error:", e?.response?.data || e.message);
  }
});

// =============================
// Auto-close conversations (24h desde último IN del usuario)
// =============================
// Nota: para hacerlo perfecto habría que registrar "last_user_message_at" (solo IN).
// Para simplificar ahora: usamos Fecha último mensaje, que se actualiza con IN y OUT.
// Si quieres que sea estrictamente "último IN", te lo ajusto en 2 minutos.
const AUTO_CLOSE_CHECK_MINUTES = 15;
const AUTO_CLOSE_AFTER_HOURS = 24;

async function autoCloseConversations() {
  try {
    // buscar conversaciones que NO estén cerradas
    // y cuya "Fecha último mensaje" sea menor que now - 24h
    const cutoff = new Date(Date.now() - AUTO_CLOSE_AFTER_HOURS * 60 * 60 * 1000).toISOString();

    const formula = encodeURIComponent(
      `AND({${AIRTABLE_WA_STATUS_FIELD}}!="Cerrada",{${AIRTABLE_WA_LAST_MESSAGE_TIME_FIELD}}<"${cutoff}")`
    );

    const url = `${airtableConversationsUrl}?filterByFormula=${formula}&pageSize=50`;
    const res = await axios.get(url, { headers: airtableHeaders() });

    const records = res.data.records || [];
    if (!records.length) return;

    console.log(`[AUTO-CLOSE] Found ${records.length} conversations to close`);

    for (const r of records) {
      const waId = r.fields?.[AIRTABLE_WA_ID_FIELD];
      if (!waId) continue;

      // mensaje final (puedes cambiarlo a template cuando quieras)
      const finalText =
        "⏳ Hemos cerrado esta conversación. Si deseas volver a hablar con nosotros, por favor reserva otra cita en Calendly o escríbenos por correo.";

      try {
        // enviar WhatsApp (OUT)
        await sendWhatsAppText(waId, finalText);

        // guardar mensaje OUT
        const msgId = `out_close_${Date.now()}`;
        await airtableCreateMessage({
          [AIRTABLE_MSG_ID_FIELD]: msgId,
          [AIRTABLE_MSG_DIRECTION_FIELD]: "OUT",
          [AIRTABLE_MSG_WA_ID_FIELD]: waId,
          [AIRTABLE_MSG_TEXT_FIELD]: finalText,
          [AIRTABLE_MSG_DATE_FIELD]: isoNow(),
          [AIRTABLE_MSG_CONVO_LINK_FIELD]: [r.id],
        });

        // marcar cerrada
        await airtableUpdateConversation(r.id, {
          [AIRTABLE_WA_STATUS_FIELD]: "Cerrada",
        });

        // SSE
        sseSend(waId, {
          type: "conversation_closed",
          wa_id: waId,
          text: finalText,
          date: isoNow(),
        });

        console.log("[AUTO-CLOSE] Closed:", waId);
      } catch (e) {
        console.error("[AUTO-CLOSE] Error closing:", waId, e?.response?.data || e.message);
      }
    }
  } catch (e) {
    console.error("[AUTO-CLOSE] Error:", e?.response?.data || e.message);
  }
}

setInterval(autoCloseConversations, AUTO_CLOSE_CHECK_MINUTES * 60 * 1000);

// =============================
// (Opcional) WhatsApp test sender
// =============================
app.post("/whatsapp/send-test", async (req, res) => {
  try {
    const { to, text } = req.body;
    if (!to || !text) return res.status(400).json({ ok: false, error: "Body must include { to, text }" });

    const data = await sendWhatsAppText(to, text);
    return res.status(200).json({ ok: true, data });
  } catch (e) {
    console.error("[WA-SEND] Error:", e?.response?.data || e.message);
    return res.status(500).json({ ok: false, error: e?.response?.data || e.message });
  }
});

// =============================
// LISTEN (Render detecta el puerto)
// =============================
app.listen(PORT, () => {
  console.log("Server running on port", PORT, "TZ=", TZ, "NODE_ENV=", NODE_ENV);
});