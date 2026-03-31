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

// ── Turnos válidos ────────────────────────────────────────────────
// Mañana: 08:00-10:00, 10:00-12:00
// Tarde:  13:00-15:00, 15:00-17:00, 17:00-19:00
const TURNOS = [8, 10, 13, 15, 17];

// ── Obtener citas ocupadas desde Google Calendar ──────────────────
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

    const booked = [];
    for (const e of (events.data.items || [])) {
      const startHour = new Date(e.start.dateTime).getHours();
      booked.push(startHour);
    }
    return booked;
  } catch (e) {
    console.error('Error leyendo Calendar:', e.message);
    return [];
  }
}

// ── Construir prompt con disponibilidad real ──────────────────────
async function buildSystemPrompt(from) {
  // Calcular disponibilidad para hoy y los próximos 7 días
  let disponibilidad = '';
  const today = new Date();

  for (let i = 0; i <= 7; i++) {
    const d = new Date(today);
    d.setDate(today.getDate() + i);
    const dow = d.getDay();
    if (dow === 0) continue; // Sin domingos

    const fechaKey = formatDateKey(d);
    const ocupados = await getBookedSlots(fechaKey);
    const libres = TURNOS.filter(h => !ocupados.includes(h));

    if (libres.length > 0) {
      const nombresLibres = libres.map(h => `${String(h).padStart(2,'0')}:00-${String(h+2).padStart(2,'0')}:00`).join(', ');
      disponibilidad += `\n  ${formatFecha(fechaKey)}: ${nombresLibres}`;
    } else {
      disponibilidad += `\n  ${formatFecha(fechaKey)}: Sin disponibilidad`;
    }
  }

  return `Eres el asistente virtual del salón Natalia Tovar Nails Studio en Neiva, Colombia.
Tu comunicación es formal, cordial y profesional. Tratas a las clientas de "usted".
Eres eficiente, precisa y amable, pero sin exageraciones ni palabras cariñosas.

HORARIO DE ATENCIÓN: Lunes a Sábado (NO domingos ni festivos)
Los turnos son FIJOS e inamovibles, cada uno dura exactamente 2 horas:
  - Turno 1: 08:00 a 10:00
  - Turno 2: 10:00 a 12:00
  - Turno 3: 13:00 a 15:00
  - Turno 4: 15:00 a 17:00
  - Turno 5: 17:00 a 19:00

REGLA CRÍTICA DE DISPONIBILIDAD:
Solo puedes ofrecer turnos que estén LIBRES según el calendario real.
NUNCA ofrezcas un turno que ya esté ocupado.
Si un turno está ocupado, NO lo menciones como opción.

DISPONIBILIDAD ACTUAL (próximos 7 días):
${disponibilidad}

SERVICIOS — cuando pregunten, muestra SOLO los nombres, nunca el precio:
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

PRECIOS (solo informe si la clienta pregunta explícitamente):
Tradicional Pies: $25.000 | Tradicional Manos: $25.000 | Combo Tradicional: $45.000
Semi Pies: $40.000 | Semi Manos: $50.000 | Rubber Decorado: $60.000
Rubber Elaborado: $70.000 | Dipping: $70.000 | Recubrimiento: $85.000
Press On: $85.000 | Poli Gel: $110.000 | Reparación: $5.000
Retiro de Otro Lugar: $15.000 | 1 Uña: $7.000
Tradicional / Reparación / Decorado: $25.000 | Manos Combo: $20.000 | Jelly Spa: $20.000

FLUJO PARA AGENDAR:
1. Preguntar qué servicio desea
2. Preguntar la fecha de preferencia
3. Mostrar SOLO los turnos libres de esa fecha (consultando la disponibilidad de arriba)
4. Pedir nombre completo
5. Confirmar la cita con todos los datos antes de ejecutar el comando

FLUJO PARA CANCELAR:
1. Solicitar nombre completo
2. Solicitar fecha y hora de la cita
3. Confirmar con la clienta antes de proceder
4. Ejecutar el comando de cancelación

COMANDOS DEL SISTEMA — agrégalos al final de tu respuesta, la clienta NO los ve:

Para AGENDAR (solo cuando ya tienes nombre, fecha, hora Y servicio confirmados):
[AGENDAR:nombre completo|fecha YYYY-MM-DD|hora HH|servicio]
Ejemplo: [AGENDAR:Laura García|2026-04-05|8|Rubber Decorado]

Para CANCELAR:
[CANCELAR:nombre completo|fecha YYYY-MM-DD|hora HH]
Ejemplo: [CANCELAR:Laura García|2026-04-05|8]

REGLAS DE CONDUCTA:
- Tono siempre formal y cordial, nunca efusivo
- No usar palabras como "amor", "hermosa", "mi cielo", "divino"
- No usar signos de exclamación en exceso
- Confirmar disponibilidad real antes de ofrecer un turno
- Si no hay disponibilidad en la fecha solicitada, ofrecer la fecha más próxima con turnos libres
- Respuestas concisas, máximo 5 líneas
- Si preguntan si es un bot, indicar que es el asistente virtual de Natalia Tovar Nails Studio`;
}

// ── Helpers de fecha ──────────────────────────────────────────────
function formatDateKey(d) {
  return d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0');
}

function formatFecha(fecha) {
  const dias   = ['Domingo','Lunes','Martes','Miércoles','Jueves','Viernes','Sábado'];
  const meses  = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
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

    // Construir prompt con disponibilidad real en tiempo real
    const systemPrompt = await buildSystemPrompt(from);

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

      // Verificar UNA VEZ MÁS que el turno sigue libre antes de guardar
      const ocupados = await getBookedSlots(fecha);
      if (ocupados.includes(horaInt)) {
        reply = reply.replace(/\[AGENDAR:[^\]]+\]/g, '').trim();
        await sendWhatsApp(from,
          `Lo sentimos, el turno de las ${String(horaInt).padStart(2,'0')}:00 del ${formatFecha(fecha)} acaba de ser ocupado.\n` +
          `Por favor indíquenos otra hora de su preferencia.`
        );
      } else {
        await addToGoogleCalendar(nombre, fecha, horaInt, servicio, from);
        reply = reply.replace(/\[AGENDAR:[^\]]+\]/g, '').trim();
        await sendWhatsApp(from,
          `*Cita confirmada*\n\n` +
          `Nombre: ${nombre}\n` +
          `Servicio: ${servicio}\n` +
          `Fecha: ${formatFecha(fecha)}\n` +
          `Hora: ${String(horaInt).padStart(2,'0')}:00 - ${String(horaInt+2).padStart(2,'0')}:00\n\n` +
          `Recibirá un recordatorio una hora antes de su cita. ¡Hasta pronto!`
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

    // Recordatorio WhatsApp 1 hora antes
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
              `Hora: ${String(hora).padStart(2,'0')}:00\n\n` +
              `La esperamos. ¡Hasta pronto!`
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
