const express = require('express');
const axios = require('axios');
const Anthropic = require('@anthropic-ai/sdk');
const { google } = require('googleapis');
const app = express();
app.use(express.json());

const anthropic  = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const WA_TOKEN     = process.env.WA_TOKEN;
const PHONE_ID     = process.env.PHONE_NUMBER_ID;
const CALENDAR_ID  = process.env.GOOGLE_CALENDAR_ID;

// ─────────────────────────────────────────────────────────────────
// MEMORIA GLOBAL DE TURNOS
// turnosOcupados: Set de strings "YYYY-MM-DD_HH" — fuente de verdad local
// Se carga desde Google Calendar al arrancar y se actualiza en tiempo real
// ─────────────────────────────────────────────────────────────────
const turnosOcupados = new Set();   // "2026-04-01_08", "2026-04-01_10", etc.
const turnosBloqueados = new Set(); // Bloqueo temporal mientras se procesa un agendamiento
const conversations  = {};
const remindersSent  = new Set();

const TURNOS = [8, 10, 13, 15, 17]; // Horas de inicio válidas

// ─────────────────────────────────────────────────────────────────
// GOOGLE CALENDAR — cliente
// ─────────────────────────────────────────────────────────────────
function getCalendar() {
  const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS),
    scopes: ['https://www.googleapis.com/auth/calendar']
  });
  return google.calendar({ version: 'v3', auth });
}

// ─────────────────────────────────────────────────────────────────
// Cargar todos los eventos futuros desde Google Calendar a memoria
// Se ejecuta al iniciar el servidor
// ─────────────────────────────────────────────────────────────────
async function cargarCalendarEnMemoria() {
  try {
    const calendar = getCalendar();
    const ahora    = new Date();
    const en30dias = new Date(ahora.getTime() + 30 * 24 * 60 * 60 * 1000);

    const res = await calendar.events.list({
      calendarId:   CALENDAR_ID,
      timeMin:      ahora.toISOString(),
      timeMax:      en30dias.toISOString(),
      singleEvents: true,
      orderBy:      'startTime',
      maxResults:   200
    });

    turnosOcupados.clear();
    for (const evento of (res.data.items || [])) {
      const dt   = evento.start.dateTime || evento.start.date;
      const d    = new Date(dt);
      const key  = turnoKey(formatDateKey(d), d.getHours());
      turnosOcupados.add(key);
      console.log(`📅 Cargado desde Calendar: ${key}`);
    }
    console.log(`✅ Calendar cargado. Turnos ocupados: ${turnosOcupados.size}`);
  } catch (e) {
    console.error('Error cargando Calendar:', e.message);
  }
}

// ─────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────
function turnoKey(fecha, hora) {
  return `${fecha}_${String(hora).padStart(2,'0')}`;
}

function formatDateKey(d) {
  return d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0');
}

function formatFecha(fecha) {
  const dias  = ['Domingo','Lunes','Martes','Miércoles','Jueves','Viernes','Sábado'];
  const meses = ['enero','febrero','marzo','abril','mayo','junio',
                 'julio','agosto','septiembre','octubre','noviembre','diciembre'];
  const d = new Date(fecha + 'T12:00:00-05:00');
  return `${dias[d.getDay()]} ${d.getDate()} de ${meses[d.getMonth()]} de ${d.getFullYear()}`;
}

function formatTurno(h) {
  return `${String(h).padStart(2,'0')}:00 - ${String(h+2).padStart(2,'0')}:00`;
}

// ─────────────────────────────────────────────────────────────────
// Verificar si un turno está libre (memoria + bloqueo temporal)
// ─────────────────────────────────────────────────────────────────
function isTurnoDisponible(fecha, hora) {
  const key = turnoKey(fecha, hora);
  return !turnosOcupados.has(key) && !turnosBloqueados.has(key);
}

// ─────────────────────────────────────────────────────────────────
// Obtener turnos libres para una fecha
// ─────────────────────────────────────────────────────────────────
function getTurnosLibres(fecha) {
  return TURNOS.filter(h => isTurnoDisponible(fecha, h));
}

// ─────────────────────────────────────────────────────────────────
// Construir disponibilidad para el prompt (próximos 7 días)
// ─────────────────────────────────────────────────────────────────
function buildDisponibilidad() {
  const today = new Date();
  let texto = '';

  for (let i = 0; i <= 7; i++) {
    const d = new Date(today);
    d.setDate(today.getDate() + i);
    if (d.getDay() === 0) continue; // Sin domingos

    const fechaKey = formatDateKey(d);
    const libres   = getTurnosLibres(fechaKey);

    if (libres.length > 0) {
      const slots = libres.map(h => formatTurno(h)).join(' | ');
      texto += `\n  ${formatFecha(fechaKey)}: ${slots}`;
    } else {
      texto += `\n  ${formatFecha(fechaKey)}: SIN DISPONIBILIDAD`;
    }
  }

  return texto || '\n  Sin disponibilidad en los próximos 7 días.';
}

// ─────────────────────────────────────────────────────────────────
// SYSTEM PROMPT
// ─────────────────────────────────────────────────────────────────
function buildSystemPrompt() {
  const today    = new Date();
  const fechaHoy = formatDateKey(today);
  const diaHoy   = formatFecha(fechaHoy);
  const disponibilidad = buildDisponibilidad();

  return `Eres el asistente virtual del salón Natalia Tovar Nails Studio en Neiva, Colombia.
Tu comunicación es formal, cordial y profesional. Tratas a las clientas de "usted".

════════════════════════════════════════
FECHA ACTUAL
════════════════════════════════════════
Hoy es: ${diaHoy} (${fechaHoy}) — Año 2026.
NUNCA agendes en 2025 ni en fechas pasadas.
Si la clienta dice "mañana", "el viernes" etc., calcula desde hoy (${fechaHoy}).

════════════════════════════════════════
REGLA ABSOLUTA — 1 TURNO = 1 CLIENTA
════════════════════════════════════════
Solo hay UNA persona atendiendo en el salón.
Un turno ocupado está BLOQUEADO para cualquier otra clienta, sin importar el servicio.
NUNCA ofrezcas un turno que no aparezca en la disponibilidad de abajo.

TURNOS FIJOS (2 horas cada uno):
  08:00 - 10:00 | 10:00 - 12:00 | 13:00 - 15:00 | 15:00 - 17:00 | 17:00 - 19:00
Atención: Lunes a Sábado. NO domingos ni festivos.

════════════════════════════════════════
DISPONIBILIDAD REAL — VERIFICADA EN ESTE MOMENTO
════════════════════════════════════════
${disponibilidad}

INSTRUCCIÓN CRÍTICA:
- Solo ofrece los turnos que aparecen arriba como disponibles.
- Si la fecha solicitada aparece SIN DISPONIBILIDAD, dilo claramente y ofrece la fecha más próxima con turnos libres.
- NUNCA supongas ni inventes disponibilidad.

════════════════════════════════════════
SERVICIOS (solo nombres, nunca precio salvo que pregunten)
════════════════════════════════════════
• Tradicional Pies      • Tradicional Manos     • Combo Tradicional
• Semi Pies             • Semi Manos             • Rubber Decorado
• Rubber Elaborado      • Dipping                • Recubrimiento
• Press On              • Poli Gel               • Reparación
• Retiro de Otro Lugar  • 1 Uña                  • Manos Combo
• Tradicional/Reparación/Decorado                • Jelly Spa

PRECIOS (solo si preguntan explícitamente):
Tradicional Pies/Manos $25.000 | Combo Tradicional $45.000 | Semi Pies $40.000
Semi Manos $50.000 | Rubber Decorado $60.000 | Rubber Elaborado $70.000
Dipping $70.000 | Recubrimiento $85.000 | Press On $85.000 | Poli Gel $110.000
Reparación $5.000 | Retiro de Otro Lugar $15.000 | 1 Uña $7.000
Tradicional/Reparación/Decorado $25.000 | Manos Combo $20.000 | Jelly Spa $20.000

════════════════════════════════════════
FLUJO DE AGENDAMIENTO
════════════════════════════════════════
1. Preguntar servicio deseado.
2. Preguntar fecha de preferencia.
3. Mostrar SOLO los turnos disponibles de esa fecha (de la lista de arriba).
4. Esperar a que elija turno.
5. Pedir nombre completo.
6. Confirmar: nombre + servicio + fecha + hora.
7. Ejecutar comando [AGENDAR].

FLUJO DE CANCELACIÓN:
1. Pedir nombre completo.
2. Pedir fecha y hora.
3. Confirmar antes de cancelar.
4. Ejecutar comando [CANCELAR].

════════════════════════════════════════
COMANDOS (al final del mensaje, la clienta NO los ve)
════════════════════════════════════════
[AGENDAR:nombre completo|YYYY-MM-DD|HH|servicio]
[CANCELAR:nombre completo|YYYY-MM-DD|HH]

════════════════════════════════════════
TONO
════════════════════════════════════════
- Formal y cordial. Sin "amor", "hermosa" ni similares.
- Turno ocupado: "Ese horario ya se encuentra ocupado."
- Sin disponibilidad en fecha: "Para esa fecha no contamos con disponibilidad."
- Respuestas máximo 5 líneas.`;
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
  res.sendStatus(200);

  try {
    const entry  = req.body.entry?.[0];
    const change = entry?.changes?.[0];
    const msg    = change?.value?.messages?.[0];
    if (!msg || msg.type !== 'text') return;

    const from = msg.from;
    const text = msg.text.body;
    console.log(`📩 [${from}]: ${text}`);

    if (!conversations[from]) conversations[from] = [];
    conversations[from].push({ role: 'user', content: text });
    if (conversations[from].length > 20) {
      conversations[from] = conversations[from].slice(-20);
    }

    // Prompt reconstruido en cada mensaje con disponibilidad actualizada
    const systemPrompt = buildSystemPrompt();

    const aiRes = await anthropic.messages.create({
      model:      'claude-sonnet-4-20250514',
      max_tokens: 1000,
      system:     systemPrompt,
      messages:   conversations[from]
    });

    let reply = aiRes.content[0].text;
    console.log(`🤖 IA: ${reply}`);

    // ── AGENDAR ──────────────────────────────────────────────────
    const agendarMatch = reply.match(/\[AGENDAR:([^|]+)\|([^|]+)\|([^|]+)\|([^\]]+)\]/);
    if (agendarMatch) {
      const [, nombre, fecha, horaStr, servicio] = agendarMatch;
      const hora = parseInt(horaStr);
      const key  = turnoKey(fecha, hora);
      reply = reply.replace(/\[AGENDAR:[^\]]+\]/g, '').trim();

      // Verificación atómica: bloquear el turno en memoria inmediatamente
      if (!isTurnoDisponible(fecha, hora)) {
        // Turno ya ocupado o siendo procesado por otro usuario
        const libresAhora = getTurnosLibres(fecha);
        const textoAlt = libresAhora.length > 0
          ? `Turnos disponibles para esa fecha:\n${libresAhora.map(h => `  • ${formatTurno(h)}`).join('\n')}`
          : `No hay más turnos disponibles para esa fecha.`;
        await sendWhatsApp(from,
          `Ese horario ya se encuentra ocupado.\n\n${textoAlt}\n\n¿Cuál prefiere?`
        );
        console.log(`⚠️ Turno ${key} ya ocupado — rechazado para ${from}`);
      } else {
        // Bloquear inmediatamente para que ningún otro usuario tome este turno
        turnosBloqueados.add(key);

        try {
          await addToGoogleCalendar(nombre, fecha, hora, servicio, from);

          // Mover de bloqueado a ocupado definitivamente
          turnosBloqueados.delete(key);
          turnosOcupados.add(key);

          await sendWhatsApp(from,
            `*Cita confirmada*\n\n` +
            `Nombre: ${nombre}\n` +
            `Servicio: ${servicio}\n` +
            `Fecha: ${formatFecha(fecha)}\n` +
            `Hora: ${formatTurno(hora)}\n\n` +
            `Recibirá un recordatorio una hora antes de su cita.`
          );
          console.log(`✅ Agendada y bloqueada: ${key} — ${nombre}`);
        } catch (e) {
          // Si falla Calendar, liberar el bloqueo
          turnosBloqueados.delete(key);
          await sendWhatsApp(from,
            `Ocurrió un error al guardar la cita. Por favor intente nuevamente.`
          );
        }
      }
    }

    // ── CANCELAR ─────────────────────────────────────────────────
    const cancelarMatch = reply.match(/\[CANCELAR:([^|]+)\|([^|]+)\|([^\]]+)\]/);
    if (cancelarMatch) {
      const [, nombre, fecha, horaStr] = cancelarMatch;
      const hora = parseInt(horaStr);
      const key  = turnoKey(fecha, hora);
      reply = reply.replace(/\[CANCELAR:[^\]]+\]/g, '').trim();

      const cancelado = await cancelFromGoogleCalendar(nombre, fecha, hora);

      if (cancelado) {
        // Liberar el turno en memoria
        turnosOcupados.delete(key);
        await sendWhatsApp(from,
          `*Cita cancelada*\n\n` +
          `Nombre: ${nombre}\n` +
          `Fecha: ${formatFecha(fecha)}\n` +
          `Hora: ${formatTurno(hora)}\n\n` +
          `Quedamos a su disposición para una nueva cita cuando lo desee.`
        );
        console.log(`❌ Cancelada y liberada: ${key} — ${nombre}`);
      } else {
        await sendWhatsApp(from,
          `No se encontró una cita para ${nombre} el ${formatFecha(fecha)} a las ${String(hora).padStart(2,'0')}:00.\n` +
          `Por favor verifique los datos e intente nuevamente.`
        );
      }
    }

    // ── Respuesta IA ─────────────────────────────────────────────
    if (reply) {
      conversations[from].push({ role: 'assistant', content: reply });
      await sendWhatsApp(from, reply);
    }

  } catch (err) {
    console.error('Error general:', err.message);
  }
});

// ─────────────────────────────────────────────────────────────────
// Enviar mensaje WhatsApp
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
  const calendar = getCalendar();
  const start    = new Date(`${fecha}T${String(hora).padStart(2,'0')}:00:00-05:00`);
  const end      = new Date(start.getTime() + 2 * 60 * 60 * 1000);

  await calendar.events.insert({
    calendarId: CALENDAR_ID,
    requestBody: {
      summary:     `💅 ${nombre} — ${servicio}`,
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

  // Recordatorio WhatsApp 1 hora antes a la clienta
  const msHasta = start.getTime() - Date.now() - (60 * 60 * 1000);
  if (msHasta > 0) {
    setTimeout(async () => {
      const key = `reminder_${phone}_${fecha}_${hora}`;
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
          console.error('Error recordatorio:', e.message);
        }
      }
    }, msHasta);
  }
}

// ─────────────────────────────────────────────────────────────────
// Google Calendar — Cancelar evento
// ─────────────────────────────────────────────────────────────────
async function cancelFromGoogleCalendar(nombre, fecha, hora) {
  try {
    const calendar = getCalendar();
    const start    = new Date(`${fecha}T${String(hora).padStart(2,'0')}:00:00-05:00`);
    const end      = new Date(start.getTime() + 2 * 60 * 60 * 1000);

    const events = await calendar.events.list({
      calendarId:   CALENDAR_ID,
      timeMin:      start.toISOString(),
      timeMax:      end.toISOString(),
      singleEvents: true,
      orderBy:      'startTime'
    });

    if (!events.data.items || events.data.items.length === 0) return false;

    const nombreLower = nombre.toLowerCase();
    const evento = events.data.items.find(e =>
      e.summary && e.summary.toLowerCase().includes(nombreLower)
    ) || events.data.items[0];

    await calendar.events.delete({
      calendarId: CALENDAR_ID,
      eventId:    evento.id
    });

    return true;
  } catch (e) {
    console.error('Error cancelando:', e.message);
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────
// INICIAR SERVIDOR — primero cargar Calendar en memoria
// ─────────────────────────────────────────────────────────────────
app.listen(process.env.PORT || 3000, async () => {
  console.log('Natalia Tovar Nails Studio — Bot iniciando...');
  await cargarCalendarEnMemoria();
  console.log('Natalia Tovar Nails Studio — Bot activo ✅');
});
