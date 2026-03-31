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

// ── Sistema de prompt ──────────────────────────────────────────────
const SYSTEM_PROMPT = `Eres el agente de IA de Nails Studio, salón de uñas en Neiva, Colombia.
Eres amigable, cálida y usas español colombiano natural. Usas emojis con moderación 💅.

HORARIO: Lunes-Sábado
- Mañana: 07:00 y 09:00 (cada turno dura 2 horas)
- Tarde: 13:00, 15:00 y 16:00 (cada turno dura 2 horas, último termina 18:00)
- NO hay servicio domingos ni festivos

SERVICIOS Y PRECIOS (COP):
- Manicure clásica: $25.000
- Uñas en gel: $60.000-$80.000
- Uñas acrílicas: $80.000-$120.000
- Nail art / diseños: +$20.000-$40.000 adicional
- Pedicure: $35.000-$45.000
- Retoque gel: $40.000

FLUJO PARA AGENDAR:
1. Pregunta qué servicio quiere
2. Pregunta la fecha deseada
3. Muestra los horarios disponibles del día
4. Pide nombre completo
5. Confirma la cita

FLUJO PARA CANCELAR:
1. Pregunta el nombre completo de la clienta
2. Pregunta la fecha y hora de la cita
3. Confirma que vas a cancelar
4. Ejecuta el comando de cancelación

COMANDOS DEL SISTEMA (agrégalos al final de tu respuesta, el usuario no los ve):

Para AGENDAR una cita confirmada:
[AGENDAR:nombre completo|fecha YYYY-MM-DD|hora HH|servicio]
Ejemplo: [AGENDAR:Laura García|2026-04-01|9|Uñas en gel]

Para CANCELAR una cita:
[CANCELAR:nombre completo|fecha YYYY-MM-DD|hora HH]
Ejemplo: [CANCELAR:Laura García|2026-04-01|9]

Para REPROGRAMAR: primero cancela con [CANCELAR] y luego agenda con [AGENDAR] en el mismo mensaje.

REGLAS IMPORTANTES:
- Nunca inventes horarios, siempre pregunta qué fecha quiere la clienta
- Confirma siempre antes de cancelar
- Si reprograman, confirma la nueva fecha antes de cancelar la anterior
- Respuestas cortas y amigables (máximo 5 líneas)
- Siempre en español colombiano, tuteo cálido`;

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

    if (!conversations[from]) conversations[from] = [];
    conversations[from].push({ role: 'user', content: text });
    if (conversations[from].length > 20) conversations[from] = conversations[from].slice(-20);

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
      system: SYSTEM_PROMPT,
      messages: conversations[from]
    });

    let reply = response.content[0].text;

    // ── Detectar AGENDAR ─────────────────────────────────────────
    const agendarMatch = reply.match(/\[AGENDAR:([^|]+)\|([^|]+)\|([^|]+)\|([^\]]+)\]/);
    if (agendarMatch) {
      const [, nombre, fecha, hora, servicio] = agendarMatch;
      const eventId = await addToGoogleCalendar(nombre, fecha, parseInt(hora), servicio, from);
      reply = reply.replace(/\[AGENDAR:[^\]]+\]/g, '').trim();

      const dias = ['Domingo','Lunes','Martes','Miércoles','Jueves','Viernes','Sábado'];
      const meses = ['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];
      const fechaObj = new Date(fecha + 'T12:00:00');
      const fechaTexto = `${dias[fechaObj.getDay()]} ${fechaObj.getDate()} ${meses[fechaObj.getMonth()]}`;

      await sendWhatsApp(from,
        `✅ *¡Cita confirmada!*\n\n` +
        `👤 ${nombre}\n` +
        `💅 ${servicio}\n` +
        `📅 ${fechaTexto} a las ${String(hora).padStart(2,'0')}:00\n` +
        `⏰ Duración: 2 horas\n\n` +
        `Recibirás un recordatorio 24 horas antes 🔔`
      );
    }

    // ── Detectar CANCELAR ────────────────────────────────────────
    const cancelarMatch = reply.match(/\[CANCELAR:([^|]+)\|([^|]+)\|([^\]]+)\]/);
    if (cancelarMatch) {
      const [, nombre, fecha, hora] = cancelarMatch;
      const cancelado = await cancelFromGoogleCalendar(nombre, fecha, parseInt(hora));
      reply = reply.replace(/\[CANCELAR:[^\]]+\]/g, '').trim();

      const dias = ['Domingo','Lunes','Martes','Miércoles','Jueves','Viernes','Sábado'];
      const meses = ['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];
      const fechaObj = new Date(fecha + 'T12:00:00');
      const fechaTexto = `${dias[fechaObj.getDay()]} ${fechaObj.getDate()} ${meses[fechaObj.getMonth()]}`;

      if (cancelado) {
        await sendWhatsApp(from,
          `❌ *Cita cancelada*\n\n` +
          `👤 ${nombre}\n` +
          `📅 ${fechaTexto} a las ${String(hora).padStart(2,'0')}:00\n\n` +
          `Si quieres reagendar estamos para servirte 💅`
        );
      } else {
        await sendWhatsApp(from,
          `⚠️ No encontré una cita para *${nombre}* el ${fechaTexto} a las ${String(hora).padStart(2,'0')}:00.\n\nVerifica el nombre y la fecha e intenta de nuevo.`
        );
      }
    }

    if (reply) {
      conversations[from].push({ role: 'assistant', content: reply });
      await sendWhatsApp(from, reply);
    }

  } catch (err) {
    console.error('Error:', err.message);
  }
});

// ── Enviar mensaje WhatsApp ───────────────────────────────────────
async function sendWhatsApp(to, text) {
  await axios.post(
    `https://graph.facebook.com/v19.0/${PHONE_ID}/messages`,
    { messaging_product: 'whatsapp', to, type: 'text', text: { body: text } },
    { headers: { Authorization: `Bearer ${WA_TOKEN}`, 'Content-Type': 'application/json' } }
  );
}

// ── Google Calendar: crear evento ────────────────────────────────
async function addToGoogleCalendar(nombre, fecha, hora, servicio, phone) {
  try {
    const auth = new google.auth.GoogleAuth({
      credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS),
      scopes: ['https://www.googleapis.com/auth/calendar']
    });
    const calendar = google.calendar({ version: 'v3', auth });

    const start = new Date(`${fecha}T${String(hora).padStart(2,'0')}:00:00-05:00`);
    const end = new Date(start.getTime() + 2 * 60 * 60 * 1000);

    const event = await calendar.events.insert({
      calendarId: process.env.GOOGLE_CALENDAR_ID,
      requestBody: {
        summary: `💅 ${nombre} — ${servicio}`,
        description: `Clienta: ${nombre}\nServicio: ${servicio}\nTeléfono: +${phone}\nAgendado vía WhatsApp Bot`,
        start: { dateTime: start.toISOString(), timeZone: 'America/Bogota' },
        end: { dateTime: end.toISOString(), timeZone: 'America/Bogota' },
        reminders: {
          useDefault: false,
          overrides: [
            { method: 'popup', minutes: 1440 },  // 24h antes
            { method: 'popup', minutes: 60 }      // 1h antes
          ]
        }
      }
    });

    console.log(`✅ Cita agendada en Calendar: ${nombre} - ${fecha} ${hora}:00`);
    return event.data.id;
  } catch (e) {
    console.error('Error agendando en Google Calendar:', e.message);
    return null;
  }
}

// ── Google Calendar: cancelar evento ────────────────────────────
async function cancelFromGoogleCalendar(nombre, fecha, hora) {
  try {
    const auth = new google.auth.GoogleAuth({
      credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS),
      scopes: ['https://www.googleapis.com/auth/calendar']
    });
    const calendar = google.calendar({ version: 'v3', auth });

    // Buscar el evento por fecha y hora
    const start = new Date(`${fecha}T${String(hora).padStart(2,'0')}:00:00-05:00`);
    const end = new Date(start.getTime() + 2 * 60 * 60 * 1000);

    const events = await calendar.events.list({
      calendarId: process.env.GOOGLE_CALENDAR_ID,
      timeMin: start.toISOString(),
      timeMax: end.toISOString(),
      singleEvents: true,
      orderBy: 'startTime'
    });

    if (!events.data.items || events.data.items.length === 0) {
      console.log(`⚠️ No se encontró evento para ${nombre} el ${fecha} a las ${hora}:00`);
      return false;
    }

    // Buscar el evento que coincida con el nombre
    const nombreLower = nombre.toLowerCase();
    const evento = events.data.items.find(e =>
      e.summary && e.summary.toLowerCase().includes(nombreLower)
    ) || events.data.items[0]; // Si no coincide nombre exacto, toma el primero de ese horario

    await calendar.events.delete({
      calendarId: process.env.GOOGLE_CALENDAR_ID,
      eventId: evento.id
    });

    console.log(`❌ Cita cancelada en Calendar: ${nombre} - ${fecha} ${hora}:00`);
    return true;
  } catch (e) {
    console.error('Error cancelando en Google Calendar:', e.message);
    return false;
  }
}

app.listen(process.env.PORT || 3000, () => console.log('Nails Studio Bot activo ✅'));
