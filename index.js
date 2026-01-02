require("dotenv").config();
const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 3000;

app.get("/health", (req, res) => res.status(200).send("OK"));

// Webhook de Calendly (temporal: solo responde OK)
app.post("/webhooks/calendly", async (req, res) => {
  return res.status(200).json({ ok: true });
});

app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
