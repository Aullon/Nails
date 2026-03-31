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

const conversations = {};
const remindersSent = new Set();

// ── Sistema de prompt ──────────────────────────────────────────────
const SYSTEM_PROMPT = `Eres Natalia Tovar, dueña y estilista de tu propio salón Natalia Tovar Nails Studio en Neiva, Colombia.
Eres súper carismática, alegre, cercana y apasionada por las uñas 💅
Hablas como una amiga colombiana: cálida, con energía, usas emojis con gracia pero sin exagerar.
Tratas a todas tus clientas de "amor", "hermosa", "mi cielo" o por su nombre cuando lo sabes.

TU PERSONALIDAD:
- Recibes a cada clienta con entusiasmo genuino
- Amas tu trabajo y se nota en cada mensaje
- Eres profesional pero nunca fría
- Si alguien pregunta por un servicio, lo describes con emoción
- Si hay disponibilidad, la ofreces de manera tentadora
- Usas frases como "¡Eso te va a quedar divino!", "Ese servicio es espectacular", "Vas a quedar hermosa"
- Si alguien pregunta si eres un bot, di que eres Natalia pero que usas un asistente inteligente para responder más rápido

HORARIO DE ATENCIÓN: Lunes a Sábado
- Mañana: 08:00 y 10:00 (cada turno dura 2 horas, último termina 12:00)
- Tarde: 13:00, 15:00 y 17:00 (cada turno dura 2 horas, último termina 19:00)
- NO hay servicio los domingos ni festivos

SERVICIOS — cuando te pregunten qué servicios ofreces, muestra SOLO la lista de nombres, SIN precios:

💅 Nuestros servicios:
• Tradicional Pies
• Tradicional Manos
• Combo Tradicional
• Semi Pies
• Semi Manos
• Rubber Decorado
• Rubber Elaborado
• Dipping
• Recubrimiento
• Press On
• Poli Gel
• Reparación
• Retiro de Otro Lugar
• 1 Uña
• Tradicional / Reparación / Decorado
• Manos Combo
• Jelly Spa

PRECIOS (solo di el precio si la clienta lo pregunta explícitamente):
- Tradicional Pies: $25.000
- Tradicional Manos: $25.000
- Combo Tradicional: $45.000
- Semi Pies: $40.000
- Semi Manos: $50.000
- Rubber Decorado: $60.000
- Rubber Elaborado: $70.000
- Dipping: $70.000
- Recubrimiento: $85.000
- Press On: $85.000
- Poli Gel: $110.000
- Reparación: $5.000
- Retiro de Otro Lugar: $15.000
- 1 Uña: $7.000
- Tradicional / Reparación / Decorado: $25.000
- Manos Combo: $20.000
- Jelly Spa: $20.000

FLUJO PARA AGENDAR:
1. Pregunta con entusiasmo qué servicio le interesa
2. Pregunta qué fecha le queda bien
3. Muestra los horarios disponibles de forma atractiva
4. Pide el nombre completo con amabilidad
5. Confirma la cita con emoción y calidez

FLUJO PARA CANCELAR:
1. Con comprensión pregunta el nombre completo
2. Pregunta fecha y hora de la cita
3. Confirma antes de cancelar
4. Deja la puerta abierta para reagendar con cariño

COMANDOS DEL SISTEMA — agrégalos al FINAL de tu respuesta, el usuario NO los ve:

Para AGENDAR una cita confirmada:
[AGENDAR:nombre completo|fecha YYYY-MM-DD|hora HH|servicio]
Ejemplo: [AGENDAR:Laura García|2026-04-01|8|Rubber Decorado]

Para CANCELAR una cita:
[CANCELAR:nombre completo|fecha YYYY-MM-DD|hora HH]
Ejemplo: [CANCELAR:Laura García|2026-04-01|8]

Para REPROGRAMAR: pon primero [CANCELAR] y luego [AGENDAR] en el mismo mensaje.

REGLAS IMPORTANTES:
- NUNCA digas el precio a menos que te lo pregunten directamente
- Siempre confirma con la clienta antes de ejecutar una cancelación
- Respuestas cortas y cálidas, máximo 5 líneas
- Habla siempre como Natalia, con personalidad, nunca como un robot
- Español colombiano siempre`;

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
      await addToGoogleCalendar(nombre, fecha, parseInt(hora), servicio, from);
      reply = reply.replace(/\[AGENDAR:[^\]]+\]/g, '').trim();

      await sendWhatsApp(from,
        `🎉 *¡Listo amor, quedaste agendada!* 💅\n\n` +
        `👤 ${nombre}\n` +
        `✨ ${servicio}\n` +
        `📅 ${formatFecha(fecha)} a las ${String(hora).padStart(2,'0')}:00\n` +
        `⏰ Duración: 2 horas\n\n` +
        `Te mando un recordatorio una horita antes 🔔 ¡Nos vemos hermosa! 💖`
      );
    }

    // ── Detectar CANCELAR ────────────────────────────────────────
    const cancelarMatch = reply.match(/\[CANCELAR:([^|]+)\|([^|]+)\|([^\]]+)\]/);
    if (cancelarMatch) {
      const [, nombre, fecha, hora] = cancelarMatch;
      const cancelado = await cancelFromGoogleCalendar(nombre, fecha, parseInt(hora));
      reply = reply.replace(/\[CANCELAR:[^\]]+\]/g, '').trim();

      if (cancelado) {
        await sendWhatsApp(from,
          `❌ *Cita cancelada, mi cielo*\n\n` +
          `👤 ${nombre}\n` +
          `📅 ${formatFecha(fecha)} a las ${String(hora).padStart(2,'0')}:00\n\n` +
          `Cuando quieras volver a agendar aquí estoy 💅💖`
        );
      } else {
        await sendWhatsApp(from,
          `⚠️ Amor, no encontré esa cita en el sistema.\n` +
          `Verifica el nombre y la fecha e intentamos de nuevo 🙏`
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

// ── Formatear fecha bonita ────────────────────────────────────────
function formatFecha(fecha) {
  const dias = ['Domingo','Lunes','Martes','Miércoles','Jueves','Viernes','Sábado'];
  const meses = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
  const d = new Date(fecha + 'T12:00:00');
  return `${dias[d.getDay()]} ${d.getDate()} de ${meses[d.getMonth()]}`;
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

    await calendar.events.insert({
      calendarId: process.env.GOOGLE_CALENDAR_ID,
      requestBody: {
        summary: `💅 ${nombre} — ${servicio}`,
        description: `Clienta: ${nombre}\nServicio: ${servicio}\nTeléfono: +${phone}\nAgendado vía WhatsApp Bot — Natalia Tovar Nails Studio`,
        start: { dateTime: start.toISOString(), timeZone: 'America/Bogota' },
        end: { dateTime: end.toISOString(), timeZone: 'America/Bogota' },
        reminders: {
          useDefault: false,
          overrides: [
            { method: 'popup', minutes: 1440 },
            { method: 'popup', minutes: 60 }
          ]
        }
      }
    });

    console.log(`✅ Agendada: ${nombre} — ${fecha} ${hora}:00 — ${servicio}`);

    // ── Recordatorio WhatsApp 1 hora antes a la clienta ──────────
    const msHastaRecordatorio = start.getTime() - Date.now() - (60 * 60 * 1000);
    if (msHastaRecordatorio > 0) {
      setTimeout(async () => {
        const key = `${phone}_${fecha}_${hora}`;
        if (!remindersSent.has(key)) {
          remindersSent.add(key);
          try {
            await sendWhatsApp(phone,
              `🔔 *¡Hola hermosa! Soy Natalia de Natalia Tovar Nails Studio* 💅\n\n` +
              `En *1 hora* tienes tu cita:\n\n` +
              `✨ ${servicio}\n` +
              `⏰ Hoy a las ${String(hora).padStart(2,'0')}:00\n\n` +
              `¡Te esperamos con todo el amor! 💖`
            );
            console.log(`🔔 Recordatorio enviado a ${phone}`);
          } catch (e) {
            console.error('Error enviando recordatorio:', e.message);
          }
        }
      }, msHastaRecordatorio);
    }

  } catch (e) {
    console.error('Error Google Calendar (agendar):', e.message);
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
      console.log(`⚠️ No encontrado: ${nombre} — ${fecha} ${hora}:00`);
      return false;
    }

    const nombreLower = nombre.toLowerCase();
    const evento = events.data.items.find(e =>
      e.summary && e.summary.toLowerCase().includes(nombreLower)
    ) || events.data.items[0];

    await calendar.events.delete({
      calendarId: process.env.GOOGLE_CALENDAR_ID,
      eventId: evento.id
    });

    console.log(`❌ Cancelada: ${nombre} — ${fecha} ${hora}:00`);
    return true;
  } catch (e) {
    console.error('Error Google Calendar (cancelar):', e.message);
    return false;
  }
}

app.listen(process.env.PORT || 3000, () => console.log('Natalia Tovar Nails Studio Bot activo ✅'));
