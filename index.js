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

// Turnos fijos del negocio (hora de inicio)
const TURNOS = [8, 10, 13, 15, 17];

// ── Consultar turnos ocupados en Google Calendar ──────────────────
async function getBookedSlots(fecha) {
  try {
    const auth = new google.auth.GoogleAuth({
      credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS),
      scopes: ['https://www.googleapis.com/auth/calendar']
    });
    const calendar = google.calendar({ version: 'v3', auth });

    const dayStart = new Date(`${fecha}T00:00:00-05:00`);
    const dayEnd   = new Date(`${fecha}T23:59:59-05:00`);

    const events = await calendar.events.list({
      calendarId: process.env.GOOGLE_CALENDAR_ID,
      timeMin: dayStart.toISOString(),
      timeMax: dayEnd.toISOString(),
      singleEvents: true,
      orderBy: 'startTime'
    });

    // Retorna las horas de inicio de todos los eventos del día
    return (events.data.items || []).map(e => new Date(e.start.dateTime).getHours());
  } catch (e) {
    console.error('Error leyendo Calendar:', e.message);
    return [];
  }
}

// ── Verificar si un turno específico está libre ───────────────────
async function isTurnoLibre(fecha, hora) {
  const ocupados = await getBookedSlots(fecha);
  return !ocupados.includes(hora);
}

// ── Construir prompt con disponibilidad real ──────────────────────
async function buildSystemPrompt() {
  let disponibilidad = '';
  const today = new Date();

  for (let i = 0; i <= 7; i++) {
    const d = new Date(today);
    d.setDate(today.getDate() + i);
    if (d.getDay() === 0) continue; // Sin domingos

    const fechaKey = formatDateKey(d);
    const ocupados = await getBookedSlots(fechaKey);
    const libres   = TURNOS.filter(h => !ocupados.includes(h));

    if (libres.length > 0) {
      const slots = libres.map(h =>
        `${String(h).padStart(2,'0')}:00-${String(h+2).padStart(2,'0')}:00`
      ).join(', ');
      disponibilidad += `\n  ${formatFecha(fechaKey)}: ${slots}`;
    } else {
      disponibilidad += `\n  ${formatFecha(fechaKey)}: Sin disponibilidad`;
    }
  }

  return `Eres el asistente virtual del salón Natalia Tovar Nails Studio en Neiva, Colombia.
Tu comunicación es formal, cordial y profesional. Tratas a las clientas de "usted".

REGLA ABSOLUTA — MUY IMPORTANTE:
Solo hay UNA persona atendiendo en el salón.
Por eso solo se puede atender UNA clienta por turno, sin importar el procedimiento.
Si un turno ya tiene una cita, está COMPLETAMENTE BLOQUEADO para cualquier otra persona.
NUNCA ofrezcas un turno ocupado, sin excepción.

TURNOS FIJOS (cada uno dura exactamente 2 horas):
  Turno 1: 08:00 - 10:00
  Turno 2: 10:00 - 12:00
  Turno 3: 13:00 - 15:00
  Turno 4: 15:00 - 17:00
  Turno 5: 17:00 - 19:00

DISPONIBILIDAD REAL — PRÓXIMOS 7 DÍAS:
${disponibilidad}

SERVICIOS (muestre solo nombres, nunca el precio a menos que pregunten):
• Tradicional Pies        • Tradicional Manos
• Combo Tradicional       • Semi Pies
• Semi Manos              • Rubber Decorado
• Rubber Elaborado        • Dipping
• Recubrimiento           • Press On
• Poli Gel                • Reparación
• Retiro de Otro Lugar    • 1 Uña
• Tradicional/Reparación/Decorado
• Manos Combo             • Jelly Spa

PRECIOS (solo si la clienta pregunta explícitamente):
Tradicional Pies $25.000 | Tradicional Manos $25.000 | Combo Tradicional $45.000
Semi Pies $40.000 | Semi Manos $50.000 | Rubber Decorado $60.000
Rubber Elaborado $70.000 | Dipping $70.000 | Recubrimiento $85.000
Press On $85.000 | Poli Gel $110.000 | Reparación $5.000
Retiro de Otro Lugar $15.000 | 1 Uña $7.000
Tradicional/Reparación/Decorado $25.000 | Manos Combo $20.000 | Jelly Spa $20.000

FLUJO PARA AGENDAR:
1. Preguntar qué servicio desea
2. Preguntar la fecha de preferencia
3. Mostrar ÚNICAMENTE los turnos libres de esa fecha
4. Si todos los turnos de esa fecha están ocupados, decir claramente que no hay disponibilidad y sugerir otra fecha
5. Pedir nombre completo
6. Confirmar todos los datos con la clienta antes de ejecutar el comando

FLUJO PARA CANCELAR:
1. Solicitar nombre completo
2. Solicitar fecha y hora
3. Confirmar antes de proceder

COMANDOS DEL SISTEMA (al final del mensaje, la clienta NO los ve):

Para AGENDAR (solo cuando ya tienes nombre, fecha, hora y servicio confirmados):
[AGENDAR:nombre completo|fecha YYYY-MM-DD|hora HH|servicio]

Para CANCELAR:
[CANCELAR:nombre completo|fecha YYYY-MM-DD|hora HH]

REGLAS DE COMUNICACIÓN:
- Formal y cordial, nunca efusivo
- No usar "amor", "hermosa", "mi cielo" ni similares
- Si un turno está ocupado: decir exactamente "Ese horario ya se encuentra ocupado. Le ofrecemos los siguientes turnos disponibles: ..."
- Si no hay disponibilidad en la fecha solicitada: "Para esa fecha no contamos con disponibilidad. La fecha más próxima disponible es..."
- Respuestas concisas, máximo 5 líneas
- Si preguntan si es un bot: indicar que es el asistente virtual de Natalia Tovar Nails Studio`;
}

// ── Helpers ───────────────────────────────────────────────────────
function formatDateKey(d) {
  return d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0');
}

function formatFecha(fecha) {
  const dias  = ['Domingo','Lunes','Martes','Miércoles','Jueves','Viernes','Sábado'];
  const meses = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
  const d = new Date(fecha + 'T12:00:00');
  return `${dias[d.getDay()]} ${d.getDate()} de ${meses[d.getMonth()]}`;
}

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

    const systemPrompt = await buildSystemPrompt();

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
      system: systemPrompt,
      messages: conversations[from]
    });

    let reply = response.content[0].text;

    // ── Detectar AGENDAR ─────────────────────────────────────────
    const agendarMatch = reply.match(/\[AGENDAR:([^|]+)\|([^|]+)\|([^|]+)\|([^\]]+)\]/);
    if (agendarMatch) {
      const [, nombre, fecha, hora, servicio] = agendarMatch;
      const horaInt = parseInt(hora);

      // Verificación final: confirmar que el turno sigue libre
      const libre = await isTurnoLibre(fecha, horaInt);
      reply = reply.replace(/\[AGENDAR:[^\]]+\]/g, '').trim();

      if (!libre) {
        // Turno ocupado en el último momento — buscar alternativas
        const ocupados = await getBookedSlots(fecha);
        const alternativas = TURNOS.filter(h => !ocupados.includes(h));
        const textoAlternativas = alternativas.length > 0
          ? `Los turnos disponibles para esa fecha son: ${alternativas.map(h => `${String(h).padStart(2,'0')}:00-${String(h+2).padStart(2,'0')}:00`).join(', ')}.`
          : `No hay más turnos disponibles para esa fecha.`;

        await sendWhatsApp(from,
          `Ese horario ya se encuentra ocupado.\n${textoAlternativas}\n¿Cuál prefiere?`
        );
      } else {
        await addToGoogleCalendar(nombre, fecha, horaInt, servicio, from);
        await sendWhatsApp(from,
          `*Cita confirmada*\n\n` +
          `Nombre: ${nombre}\n` +
          `Servicio: ${servicio}\n` +
          `Fecha: ${formatFecha(fecha)}\n` +
          `Hora: ${String(horaInt).padStart(2,'0')}:00 - ${String(horaInt+2).padStart(2,'0')}:00\n\n` +
          `Recibirá un recordatorio una hora antes de su cita.`
        );
      }
    }

    // ── Detectar CANCELAR ────────────────────────────────────────
    const cancelarMatch = reply.match(/\[CANCELAR:([^|]+)\|([^|]+)\|([^\]]+)\]/);
    if (cancelarMatch) {
      const [, nombre, fecha, hora] = cancelarMatch;
      const cancelado = await cancelFromGoogleCalendar(nombre, fecha, parseInt(hora));
      reply = reply.replace(/\[CANCELAR:[^\]]+\]/g, '').trim();

      if (cancelado) {
        await sendWhatsApp(from,
          `*Cita cancelada*\n\n` +
          `Nombre: ${nombre}\n` +
          `Fecha: ${formatFecha(fecha)}\n` +
          `Hora: ${String(parseInt(hora)).padStart(2,'0')}:00\n\n` +
          `Quedamos a su disposición para una nueva cita cuando lo desee.`
        );
      } else {
        await sendWhatsApp(from,
          `No se encontró una cita registrada para ${nombre} el ${formatFecha(fecha)} a las ${String(parseInt(hora)).padStart(2,'0')}:00.\n` +
          `Por favor verifique los datos e intente nuevamente.`
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
    const end   = new Date(start.getTime() + 2 * 60 * 60 * 1000);

    await calendar.events.insert({
      calendarId: process.env.GOOGLE_CALENDAR_ID,
      requestBody: {
        summary: `💅 ${nombre} — ${servicio}`,
        description: `Clienta: ${nombre}\nServicio: ${servicio}\nTeléfono: +${phone}\nAgendado vía WhatsApp — Natalia Tovar Nails Studio`,
        start: { dateTime: start.toISOString(), timeZone: 'America/Bogota' },
        end:   { dateTime: end.toISOString(),   timeZone: 'America/Bogota' },
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

    // Recordatorio WhatsApp 1 hora antes a la clienta
    const msHastaRecordatorio = start.getTime() - Date.now() - (60 * 60 * 1000);
    if (msHastaRecordatorio > 0) {
      setTimeout(async () => {
        const key = `${phone}_${fecha}_${hora}`;
        if (!remindersSent.has(key)) {
          remindersSent.add(key);
          try {
            await sendWhatsApp(phone,
              `Recordatorio de Natalia Tovar Nails Studio\n\n` +
              `Le informamos que en *1 hora* tiene su cita:\n\n` +
              `Servicio: ${servicio}\n` +
              `Hora: ${String(hora).padStart(2,'00')}:00 - ${String(hora+2).padStart(2,'00')}:00\n\n` +
              `La esperamos.`
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
    const end   = new Date(start.getTime() + 2 * 60 * 60 * 1000);

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

app.listen(process.env.PORT || 3000, () => console.log('Natalia Tovar Nails Studio — Bot activo ✅'));
