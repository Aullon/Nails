const express = require('express');
const axios = require('axios');
const Anthropic = require('@anthropic-ai/sdk');
const { google } = require('googleapis');
const app = express();
app.use(express.json());

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const WA_TOKEN    = process.env.WA_TOKEN;
const PHONE_ID    = process.env.PHONE_NUMBER_ID;

const conversations = {};
const remindersSent = new Set();

// Turnos fijos (hora de inicio). Cada uno dura 2 horas.
const TURNOS = [8, 10, 13, 15, 17];

// ─────────────────────────────────────────────────────────────────
// GOOGLE CALENDAR — autenticación reutilizable
// ─────────────────────────────────────────────────────────────────
function getCalendarClient() {
  const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS),
    scopes: ['https://www.googleapis.com/auth/calendar']
  });
  return google.calendar({ version: 'v3', auth });
}

// ─────────────────────────────────────────────────────────────────
// Consultar horas OCUPADAS en Google Calendar para una fecha dada
// Devuelve array de horas de inicio ocupadas, ej: [8, 13]
// ─────────────────────────────────────────────────────────────────
async function getHorasOcupadas(fecha) {
  try {
    const calendar  = getCalendarClient();
    const dayStart  = new Date(`${fecha}T00:00:00-05:00`);
    const dayEnd    = new Date(`${fecha}T23:59:59-05:00`);

    const res = await calendar.events.list({
      calendarId:   process.env.GOOGLE_CALENDAR_ID,
      timeMin:      dayStart.toISOString(),
      timeMax:      dayEnd.toISOString(),
      singleEvents: true,
      orderBy:      'startTime'
    });

    const ocupadas = (res.data.items || []).map(e => {
      const dt = e.start.dateTime || e.start.date;
      return new Date(dt).getHours();
    });

    console.log(`📅 ${fecha} — ocupadas: [${ocupadas.join(', ')}]`);
    return ocupadas;
  } catch (e) {
    console.error('Error leyendo Calendar:', e.message);
    return []; // Si falla, no bloquear al usuario
  }
}

// ─────────────────────────────────────────────────────────────────
// Turnos LIBRES para una fecha (consulta Calendar en tiempo real)
// ─────────────────────────────────────────────────────────────────
async function getTurnosLibres(fecha) {
  const ocupadas = await getHorasOcupadas(fecha);
  return TURNOS.filter(h => !ocupadas.includes(h));
}

// ─────────────────────────────────────────────────────────────────
// Verificar si UN turno específico está libre
// ─────────────────────────────────────────────────────────────────
async function isTurnoLibre(fecha, hora) {
  const ocupadas = await getHorasOcupadas(fecha);
  return !ocupadas.includes(hora);
}

// ─────────────────────────────────────────────────────────────────
// Formatear fecha clave YYYY-MM-DD
// ─────────────────────────────────────────────────────────────────
function formatDateKey(d) {
  return d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0');
}

// ─────────────────────────────────────────────────────────────────
// Formatear fecha legible: "Martes 31 de marzo de 2026"
// ─────────────────────────────────────────────────────────────────
function formatFecha(fecha) {
  const dias  = ['Domingo','Lunes','Martes','Miércoles','Jueves','Viernes','Sábado'];
  const meses = ['enero','febrero','marzo','abril','mayo','junio',
                 'julio','agosto','septiembre','octubre','noviembre','diciembre'];
  const d = new Date(fecha + 'T12:00:00-05:00');
  return `${dias[d.getDay()]} ${d.getDate()} de ${meses[d.getMonth()]} de ${d.getFullYear()}`;
}

// ─────────────────────────────────────────────────────────────────
// Formatear turno: "08:00 - 10:00"
// ─────────────────────────────────────────────────────────────────
function formatTurno(h) {
  return `${String(h).padStart(2,'0')}:00 - ${String(h + 2).padStart(2,'0')}:00`;
}

// ─────────────────────────────────────────────────────────────────
// Construir disponibilidad real para los próximos 7 días
// Esta info se inyecta en el prompt para que la IA la use
// ─────────────────────────────────────────────────────────────────
async function buildDisponibilidad() {
  const today = new Date();
  let texto = '';

  for (let i = 0; i <= 7; i++) {
    const d = new Date(today);
    d.setDate(today.getDate() + i);
    if (d.getDay() === 0) continue; // Sin domingos

    const fechaKey = formatDateKey(d);
    const libres   = await getTurnosLibres(fechaKey);

    if (libres.length > 0) {
      const slots = libres.map(h => formatTurno(h)).join(' | ');
      texto += `\n  ${formatFecha(fechaKey)}: DISPONIBLE → ${slots}`;
    } else {
      texto += `\n  ${formatFecha(fechaKey)}: SIN DISPONIBILIDAD`;
    }
  }

  return texto || '\n  Sin disponibilidad en los próximos 7 días.';
}

// ─────────────────────────────────────────────────────────────────
// SYSTEM PROMPT — construido con disponibilidad real en cada mensaje
// ─────────────────────────────────────────────────────────────────
async function buildSystemPrompt() {
  const today        = new Date();
  const fechaHoy     = formatDateKey(today);
  const diaHoy       = formatFecha(fechaHoy);
  const disponibilidad = await buildDisponibilidad();

  return `Eres el asistente virtual del salón Natalia Tovar Nails Studio en Neiva, Colombia.
Tu comunicación es formal, cordial y profesional. Tratas a las clientas de "usted".

════════════════════════════════════════
FECHA Y HORA ACTUAL
════════════════════════════════════════
Hoy es: ${diaHoy}
Fecha en sistema: ${fechaHoy}
Año actual: 2026

REGLA ABSOLUTA DE FECHAS:
- Todas las citas son en 2026 o en el futuro.
- NUNCA agendes en 2025 ni en fechas pasadas.
- Si la clienta dice "mañana", "el viernes", "la próxima semana", calcula
  la fecha exacta a partir de hoy (${fechaHoy}) en el año 2026.

════════════════════════════════════════
TURNOS FIJOS (1 clienta por turno, sin excepciones)
════════════════════════════════════════
Turno 1: 08:00 - 10:00
Turno 2: 10:00 - 12:00
Turno 3: 13:00 - 15:00
Turno 4: 15:00 - 17:00
Turno 5: 17:00 - 19:00

Solo hay UNA persona atendiendo. Un turno ocupado = bloqueado para cualquier otra clienta.
Jornada: Lunes a Sábado. NO se trabaja domingos ni festivos.

════════════════════════════════════════
DISPONIBILIDAD REAL — CONSULTADA AHORA MISMO EN GOOGLE CALENDAR
════════════════════════════════════════
${disponibilidad}

INSTRUCCIÓN CRÍTICA:
- ÚNICAMENTE ofrece los turnos marcados como DISPONIBLE arriba.
- Si la clienta pide una fecha que aparece como SIN DISPONIBILIDAD, díselo claramente
  y ofrécele la fecha más próxima que tenga turnos disponibles.
- NUNCA inventes ni supongas disponibilidad. Solo usa lo que aparece arriba.

════════════════════════════════════════
SERVICIOS (muestre solo nombres, NUNCA el precio salvo que pregunten)
════════════════════════════════════════
• Tradicional Pies          • Tradicional Manos
• Combo Tradicional         • Semi Pies
• Semi Manos                • Rubber Decorado
• Rubber Elaborado          • Dipping
• Recubrimiento             • Press On
• Poli Gel                  • Reparación
• Retiro de Otro Lugar      • 1 Uña
• Tradicional/Reparación/Decorado
• Manos Combo               • Jelly Spa

PRECIOS (solo si la clienta pregunta explícitamente):
Tradicional Pies $25.000 | Tradicional Manos $25.000 | Combo Tradicional $45.000
Semi Pies $40.000 | Semi Manos $50.000 | Rubber Decorado $60.000
Rubber Elaborado $70.000 | Dipping $70.000 | Recubrimiento $85.000
Press On $85.000 | Poli Gel $110.000 | Reparación $5.000
Retiro de Otro Lugar $15.000 | 1 Uña $7.000
Tradicional/Reparación/Decorado $25.000 | Manos Combo $20.000 | Jelly Spa $20.000

════════════════════════════════════════
FLUJO DE AGENDAMIENTO
════════════════════════════════════════
1. Preguntar qué servicio desea.
2. Preguntar la fecha de preferencia.
3. Consultar la disponibilidad de arriba y mostrar SOLO los turnos libres de esa fecha.
   Si no hay turnos libres, decirlo e indicar la fecha más próxima disponible.
4. Esperar a que la clienta elija un turno.
5. Pedir nombre completo.
6. Confirmar todos los datos (nombre, servicio, fecha, hora) ANTES de ejecutar el comando.
7. Solo entonces ejecutar el comando [AGENDAR].

FLUJO DE CANCELACIÓN:
1. Solicitar nombre completo.
2. Solicitar fecha y hora de la cita.
3. Confirmar con la clienta antes de proceder.
4. Ejecutar el comando [CANCELAR].

════════════════════════════════════════
COMANDOS DEL SISTEMA (al final del mensaje, la clienta NO los ve)
════════════════════════════════════════
Para AGENDAR (solo cuando nombre + servicio + fecha + hora estén confirmados):
[AGENDAR:nombre completo|fecha YYYY-MM-DD|hora HH|servicio]
Ejemplo: [AGENDAR:Laura García|2026-04-03|8|Rubber Decorado]

Para CANCELAR:
[CANCELAR:nombre completo|fecha YYYY-MM-DD|hora HH]
Ejemplo: [CANCELAR:Laura García|2026-04-03|8]

════════════════════════════════════════
TONO Y CONDUCTA
════════════════════════════════════════
- Formal y cordial. Nunca efusivo.
- No usar "amor", "hermosa", "mi cielo", "divino" ni similares.
- Si un turno está ocupado: "Ese horario ya se encuentra ocupado."
- Si no hay disponibilidad en la fecha: "Para esa fecha no contamos con disponibilidad."
- Respuestas concisas, máximo 5 líneas.
- Si preguntan si es un bot: indicar que es el asistente virtual de Natalia Tovar Nails Studio.`;
}

// ─────────────────────────────────────────────────────────────────
// WEBHOOK — verificación
// ─────────────────────────────────────────────────────────────────
app.get('/webhook', (req, res) => {
  if (req.query['hub.verify_token'] === VERIFY_TOKEN) {
    res.send(req.query['hub.challenge']);
  } else {
    res.sendStatus(403);
  }
});

// ─────────────────────────────────────────────────────────────────
// WEBHOOK — recibir mensajes
// ─────────────────────────────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  res.sendStatus(200); // Responder a Meta de inmediato

  try {
    const entry  = req.body.entry?.[0];
    const change = entry?.changes?.[0];
    const msg    = change?.value?.messages?.[0];
    if (!msg || msg.type !== 'text') return;

    const from = msg.from;
    const text = msg.text.body;
    console.log(`📩 Mensaje de ${from}: ${text}`);

    // Mantener historial de conversación
    if (!conversations[from]) conversations[from] = [];
    conversations[from].push({ role: 'user', content: text });
    if (conversations[from].length > 20) {
      conversations[from] = conversations[from].slice(-20);
    }

    // Construir prompt con disponibilidad real consultada ahora mismo
    const systemPrompt = await buildSystemPrompt();

    const aiResponse = await anthropic.messages.create({
      model:      'claude-sonnet-4-20250514',
      max_tokens: 1000,
      system:     systemPrompt,
      messages:   conversations[from]
    });

    let reply = aiResponse.content[0].text;
    console.log(`🤖 Respuesta IA: ${reply}`);

    // ── Procesar comando AGENDAR ──────────────────────────────────
    const agendarMatch = reply.match(/\[AGENDAR:([^|]+)\|([^|]+)\|([^|]+)\|([^\]]+)\]/);
    if (agendarMatch) {
      const [, nombre, fecha, horaStr, servicio] = agendarMatch;
      const hora = parseInt(horaStr);
      reply = reply.replace(/\[AGENDAR:[^\]]+\]/g, '').trim();

      // Verificación final en Calendar antes de guardar
      const libre = await isTurnoLibre(fecha, hora);

      if (!libre) {
        // Turno tomado en el último segundo — mostrar alternativas reales
        const libresAhora = await getTurnosLibres(fecha);
        const textoAlt = libresAhora.length > 0
          ? `Los turnos disponibles para esa fecha son:\n${libresAhora.map(h => `  • ${formatTurno(h)}`).join('\n')}`
          : `No hay más turnos disponibles para esa fecha.`;

        await sendWhatsApp(from,
          `Ese horario ya se encuentra ocupado.\n\n${textoAlt}\n\n¿Cuál prefiere?`
        );
        console.log(`⚠️ Turno ${hora}:00 del ${fecha} ya estaba ocupado al confirmar.`);
      } else {
        // Guardar en Google Calendar
        await addToGoogleCalendar(nombre, fecha, hora, servicio, from);
        await sendWhatsApp(from,
          `*Cita confirmada*\n\n` +
          `Nombre: ${nombre}\n` +
          `Servicio: ${servicio}\n` +
          `Fecha: ${formatFecha(fecha)}\n` +
          `Hora: ${formatTurno(hora)}\n\n` +
          `Recibirá un recordatorio una hora antes de su cita.`
        );
        console.log(`✅ Cita guardada: ${nombre} — ${fecha} ${hora}:00 — ${servicio}`);
      }
    }

    // ── Procesar comando CANCELAR ─────────────────────────────────
    const cancelarMatch = reply.match(/\[CANCELAR:([^|]+)\|([^|]+)\|([^\]]+)\]/);
    if (cancelarMatch) {
      const [, nombre, fecha, horaStr] = cancelarMatch;
      const hora = parseInt(horaStr);
      reply = reply.replace(/\[CANCELAR:[^\]]+\]/g, '').trim();

      const cancelado = await cancelFromGoogleCalendar(nombre, fecha, hora);

      if (cancelado) {
        await sendWhatsApp(from,
          `*Cita cancelada*\n\n` +
          `Nombre: ${nombre}\n` +
          `Fecha: ${formatFecha(fecha)}\n` +
          `Hora: ${formatTurno(hora)}\n\n` +
          `Quedamos a su disposición para una nueva cita cuando lo desee.`
        );
        console.log(`❌ Cancelada: ${nombre} — ${fecha} ${hora}:00`);
      } else {
        await sendWhatsApp(from,
          `No se encontró una cita registrada para ${nombre} el ${formatFecha(fecha)} ` +
          `a las ${String(hora).padStart(2,'0')}:00.\n` +
          `Por favor verifique los datos e intente nuevamente.`
        );
      }
    }

    // ── Enviar respuesta de la IA ─────────────────────────────────
    if (reply) {
      conversations[from].push({ role: 'assistant', content: reply });
      await sendWhatsApp(from, reply);
    }

  } catch (err) {
    console.error('Error general:', err.message);
  }
});

// ─────────────────────────────────────────────────────────────────
// Enviar mensaje por WhatsApp
// ─────────────────────────────────────────────────────────────────
async function sendWhatsApp(to, text) {
  try {
    await axios.post(
      `https://graph.facebook.com/v19.0/${PHONE_ID}/messages`,
      { messaging_product: 'whatsapp', to, type: 'text', text: { body: text } },
      { headers: { Authorization: `Bearer ${WA_TOKEN}`, 'Content-Type': 'application/json' } }
    );
  } catch (e) {
    console.error('Error enviando WhatsApp:', e.message);
  }
}

// ─────────────────────────────────────────────────────────────────
// Google Calendar — Crear evento
// ─────────────────────────────────────────────────────────────────
async function addToGoogleCalendar(nombre, fecha, hora, servicio, phone) {
  try {
    const calendar = getCalendarClient();
    const start    = new Date(`${fecha}T${String(hora).padStart(2,'0')}:00:00-05:00`);
    const end      = new Date(start.getTime() + 2 * 60 * 60 * 1000);

    await calendar.events.insert({
      calendarId: process.env.GOOGLE_CALENDAR_ID,
      requestBody: {
        summary:     `💅 ${nombre} — ${servicio}`,
        description: `Clienta: ${nombre}\nServicio: ${servicio}\nTeléfono: +${phone}\nAgendado vía WhatsApp — Natalia Tovar Nails Studio`,
        start: { dateTime: start.toISOString(), timeZone: 'America/Bogota' },
        end:   { dateTime: end.toISOString(),   timeZone: 'America/Bogota' },
        reminders: {
          useDefault: false,
          overrides: [
            { method: 'popup', minutes: 1440 }, // 24h antes (para Natalia)
            { method: 'popup', minutes: 60 }    // 1h antes (para Natalia)
          ]
        }
      }
    });

    // Recordatorio WhatsApp a la clienta 1 hora antes
    const msHasta = start.getTime() - Date.now() - (60 * 60 * 1000);
    if (msHasta > 0) {
      setTimeout(async () => {
        const key = `${phone}_${fecha}_${hora}`;
        if (!remindersSent.has(key)) {
          remindersSent.add(key);
          try {
            await sendWhatsApp(phone,
              `Recordatorio de Natalia Tovar Nails Studio\n\n` +
              `Le informamos que en *1 hora* tiene su cita:\n\n` +
              `Servicio: ${servicio}\n` +
              `Hora: ${formatTurno(hora)}\n\n` +
              `La esperamos.`
            );
            console.log(`🔔 Recordatorio enviado a ${phone}`);
          } catch (e) {
            console.error('Error enviando recordatorio:', e.message);
          }
        }
      }, msHasta);
    }

  } catch (e) {
    console.error('Error creando evento en Calendar:', e.message);
    throw e;
  }
}

// ─────────────────────────────────────────────────────────────────
// Google Calendar — Cancelar evento
// ─────────────────────────────────────────────────────────────────
async function cancelFromGoogleCalendar(nombre, fecha, hora) {
  try {
    const calendar = getCalendarClient();
    const start    = new Date(`${fecha}T${String(hora).padStart(2,'0')}:00:00-05:00`);
    const end      = new Date(start.getTime() + 2 * 60 * 60 * 1000);

    const events = await calendar.events.list({
      calendarId:   process.env.GOOGLE_CALENDAR_ID,
      timeMin:      start.toISOString(),
      timeMax:      end.toISOString(),
      singleEvents: true,
      orderBy:      'startTime'
    });

    if (!events.data.items || events.data.items.length === 0) {
      console.log(`⚠️ No encontrado: ${nombre} — ${fecha} ${hora}:00`);
      return false;
    }

    // Buscar por nombre; si no coincide exacto, tomar el primero del bloque
    const nombreLower = nombre.toLowerCase();
    const evento = events.data.items.find(e =>
      e.summary && e.summary.toLowerCase().includes(nombreLower)
    ) || events.data.items[0];

    await calendar.events.delete({
      calendarId: process.env.GOOGLE_CALENDAR_ID,
      eventId:    evento.id
    });

    return true;
  } catch (e) {
    console.error('Error cancelando evento en Calendar:', e.message);
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────
app.listen(process.env.PORT || 3000, () =>
  console.log('Natalia Tovar Nails Studio — Bot activo ✅')
);
