const express = require('express');
const axios = require('axios');
const Anthropic = require('@anthropic-ai/sdk');
const { google } = require('googleapis');
const app = express();
app.use(express.json());

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const WA_TOKEN = process.env.WA_TOKEN;
const PHONE_ID = process.env.PHONE_NUMBER_ID;

// Memoria temporal de conversaciones
const conversations = {};

// ── Horarios y lógica de negocio ──────────────────────────────────
const SYSTEM_PROMPT = `Eres el agente de IA de Nails Studio, salón de uñas en Neiva, Colombia.
Eres amigable, cálida y usas español colombiano natural.

HORARIO: Lunes-Sábado
- Mañana: 07:00-12:00 (turnos: 07:00 y 09:00, duración 2h c/u)  
- Tarde: 13:00-18:00 (turnos: 13:00, 15:00 y 16:00, duración 2h c/u, último termina 18:00)
- NO hay servicio domingos ni festivos

SERVICIOS Y PRECIOS (COP):
- Manicure clásica: $25.000
- Uñas en gel: $60.000-$80.000
- Uñas acrílicas: $80.000-$120.000
- Nail art / diseños: +$20.000-$40.000
- Pedicure: $35.000-$45.000
- Retoque gel: $40.000

FLUJO DE AGENDAMIENTO:
1. Pregunta qué servicio quiere
2. Pregunta la fecha deseada
3. Muestra horarios disponibles
4. Confirma nombre completo
5. Confirma la cita y di que recibirá recordatorio 24h antes

Cuando confirmes una cita responde EXACTAMENTE así al final (oculto):
[CITA:nombre|fecha YYYY-MM-DD|hora HH|servicio]

Cuando cancelen una cita:
[CANCELAR:fecha YYYY-MM-DD|hora HH]

Respuestas cortas y amigables. Usa emojis con moderación 💅`;

// ── Webhook verification ──────────────────────────────────────────
app.get('/webhook', (req, res) => {
  if (req.query['hub.verify_token'] === VERIFY_TOKEN) {
    res.send(req.query['hub.challenge']);
  } else {
    res.sendStatus(403);
  }
});

// ── Recibir mensajes ──────────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  
  try {
    const entry = req.body.entry?.[0];
    const change = entry?.changes?.[0];
    const msg = change?.value?.messages?.[0];
    if (!msg || msg.type !== 'text') return;

    const from = msg.from;
    const text = msg.text.body;

    // Mantener historial por usuario (últimos 10 mensajes)
    if (!conversations[from]) conversations[from] = [];
    conversations[from].push({ role: 'user', content: text });
    if (conversations[from].length > 20) conversations[from] = conversations[from].slice(-20);

    // Llamar a Claude
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
      system: SYSTEM_PROMPT,
      messages: conversations[from]
    });

    let reply = response.content[0].text;

    // Detectar comando de agendar
    const citaMatch = reply.match(/\[CITA:([^|]+)\|([^|]+)\|([^|]+)\|([^\]]+)\]/);
    if (citaMatch) {
      const [, nombre, fecha, hora, servicio] = citaMatch;
      await addToGoogleCalendar(nombre, fecha, parseInt(hora), servicio, from);
      await sendWhatsApp(from, `✅ *¡Cita confirmada!*\n📅 ${fecha} a las ${hora}:00\n💅 ${servicio}\n👤 ${nombre}\n\nTe enviaré un recordatorio 24 horas antes 🔔`);
      reply = reply.replace(/\[CITA:[^\]]+\]/g, '').trim();
    }

    const cancelMatch = reply.match(/\[CANCELAR:([^|]+)\|([^\]]+)\]/);
    if (cancelMatch) {
      reply = reply.replace(/\[CANCELAR:[^\]]+\]/g, '').trim();
    }

    if (reply) {
      conversations[from].push({ role: 'assistant', content: reply });
      await sendWhatsApp(from, reply);
    }

  } catch (err) {
    console.error('Error:', err.message);
  }
});

// ── Enviar mensaje por WhatsApp ───────────────────────────────────
async function sendWhatsApp(to, text) {
  await axios.post(
    `https://graph.facebook.com/v19.0/${PHONE_ID}/messages`,
    { messaging_product: 'whatsapp', to, type: 'text', text: { body: text } },
    { headers: { Authorization: `Bearer ${WA_TOKEN}`, 'Content-Type': 'application/json' } }
  );
}

// ── Google Calendar ───────────────────────────────────────────────
async function addToGoogleCalendar(nombre, fecha, hora, servicio, phone) {
  try {
    const auth = new google.auth.GoogleAuth({
      credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS),
      scopes: ['https://www.googleapis.com/auth/calendar']
    });
    const calendar = google.calendar({ version: 'v3', auth });

    const start = new Date(`${fecha}T${String(hora).padStart(2,'0')}:00:00-05:00`);
    const end = new Date(start.getTime() + 2 * 60 * 60 * 1000);

    await calendar.events.insert({
      calendarId: process.env.GOOGLE_CALENDAR_ID,
      requestBody: {
        summary: `💅 ${nombre} — ${servicio}`,
        description: `Clienta: ${nombre}\nServicio: ${servicio}\nTeléfono: +${phone}\nAgendado vía WhatsApp Bot`,
        start: { dateTime: start.toISOString(), timeZone: 'America/Bogota' },
        end: { dateTime: end.toISOString(), timeZone: 'America/Bogota' },
        reminders: {
          useDefault: false,
          overrides: [{ method: 'popup', minutes: 1440 }] // 24h antes
        }
      }
    });
  } catch (e) {
    console.error('Error Google Calendar:', e.message);
  }
}

app.listen(process.env.PORT || 3000, () => console.log('Nails Studio Bot activo ✅'));
