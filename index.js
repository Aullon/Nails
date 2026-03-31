const express  = require('express');
const axios    = require('axios');
const Anthropic = require('@anthropic-ai/sdk');
const { google } = require('googleapis');
const app = express();
app.use(express.json());

const anthropic    = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const WA_TOKEN     = process.env.WA_TOKEN;
const PHONE_ID     = process.env.PHONE_NUMBER_ID;
const CALENDAR_ID  = process.env.GOOGLE_CALENDAR_ID;

const conversations = {};
const remindersSent = new Set();

// ─────────────────────────────────────────────────────────────────
// TURNOS VÁLIDOS
// ─────────────────────────────────────────────────────────────────
const TURNOS_VALIDOS = [8, 10, 13, 15, 17];

// ─────────────────────────────────────────────────────────────────
// GOOGLE CALENDAR — siempre consulta en tiempo real
// ─────────────────────────────────────────────────────────────────
function getCalendar() {
  const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS),
    scopes: ['https://www.googleapis.com/auth/calendar']
  });
  return google.calendar({ version: 'v3', auth });
}

// Consulta Google Calendar y devuelve las horas ocupadas para una fecha
async function getHorasOcupadasCalendar(fecha) {
  try {
    const calendar = getCalendar();
    const inicio   = new Date(`${fecha}T00:00:00-05:00`);
    const fin      = new Date(`${fecha}T23:59:59-05:00`);

    const res = await calendar.events.list({
      calendarId:   CALENDAR_ID,
      timeMin:      inicio.toISOString(),
      timeMax:      fin.toISOString(),
      singleEvents: true,
      orderBy:      'startTime'
    });

    const ocupadas = (res.data.items || []).map(e => {
      const dt = e.start.dateTime || e.start.date;
      return new Date(dt).getHours();
    });

    console.log(`🔍 Calendar ${fecha}: ocupadas=[${ocupadas.join(',')}]`);
    return ocupadas;
  } catch (e) {
    console.error('Error consultando Calendar:', e.message);
    return [];
  }
}

// Devuelve turnos libres reales para una fecha, leyendo Calendar ahora mismo
async function getTurnosLibresReales(fecha) {
  const ocupadas = await getHorasOcupadasCalendar(fecha);
  const libres   = TURNOS_VALIDOS.filter(h => !ocupadas.includes(h));
  console.log(`✅ Turnos libres ${fecha}: [${libres.join(',')}]`);
  return libres;
}

// Verifica si un turno específico está libre en Calendar ahora mismo
async function verificarTurnoLibre(fecha, hora) {
  const ocupadas = await getHorasOcupadasCalendar(fecha);
  const libre    = !ocupadas.includes(hora);
  console.log(`🔎 Verificación ${fecha} ${hora}:00 → ${libre ? 'LIBRE' : 'OCUPADO'}`);
  return libre;
}

// ─────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────
function formatDateKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
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
// SYSTEM PROMPT — construido con disponibilidad real de Calendar
// ─────────────────────────────────────────────────────────────────
async function buildSystemPrompt() {
  const today    = new Date();
  const fechaHoy = formatDateKey(today);
  const diaHoy   = formatFecha(fechaHoy);

  // Consultar disponibilidad real para los próximos 7 días
  let disponibilidad = '';
  for (let i = 0; i <= 7; i++) {
    const d = new Date(today);
    d.setDate(today.getDate() + i);
    if (d.getDay() === 0) continue;

    const fk     = formatDateKey(d);
    const libres = await getTurnosLibresReales(fk);

    if (libres.length > 0) {
      disponibilidad += `\n  ${formatFecha(fk)}: ${libres.map(formatTurno).join(' | ')}`;
    } else {
      disponibilidad += `\n  ${formatFecha(fk)}: SIN DISPONIBILIDAD`;
    }
  }

  return `Eres el asistente virtual del salón Natalia Tovar Nails Studio en Neiva, Colombia.
Comunicación formal, cordial y profesional. Trata a las clientas de "usted".

══════════════════════════════════════
FECHA HOY: ${diaHoy} | AÑO: 2026
NUNCA agendes en 2025 ni en fechas pasadas.
══════════════════════════════════════

══════════════════════════════════════
REGLA DE ORO — IRROMPIBLE
══════════════════════════════════════
Solo hay UNA persona atendiendo. Un turno ocupado = BLOQUEADO PARA TODOS.
No importa el servicio, no importa la clienta: si el turno está tomado, no está disponible.

TURNOS (2 horas c/u): 08:00-10:00 | 10:00-12:00 | 13:00-15:00 | 15:00-17:00 | 17:00-19:00
Atención: Lunes a Sábado. Sin domingos ni festivos.

══════════════════════════════════════
DISPONIBILIDAD REAL — GOOGLE CALENDAR AHORA MISMO
══════════════════════════════════════
${disponibilidad}

INSTRUCCIÓN CRÍTICA:
Solo ofrece turnos que aparezcan arriba. Si no aparece, está ocupado.
Si la fecha está SIN DISPONIBILIDAD, díselo y ofrece la más próxima con turnos libres.

══════════════════════════════════════
SERVICIOS (solo nombres, precio solo si preguntan)
══════════════════════════════════════
Tradicional Pies | Tradicional Manos | Combo Tradicional | Semi Pies | Semi Manos
Rubber Decorado | Rubber Elaborado | Dipping | Recubrimiento | Press On | Poli Gel
Reparación | Retiro de Otro Lugar | 1 Uña | Tradicional/Reparación/Decorado
Manos Combo | Jelly Spa

PRECIOS (solo si preguntan):
Trad.Pies/Manos $25k | Combo Trad $45k | Semi Pies $40k | Semi Manos $50k
Rubber Dec $60k | Rubber Elab $70k | Dipping $70k | Recubrimiento $85k
Press On $85k | Poli Gel $110k | Reparación $5k | Retiro $15k | 1 Uña $7k
Trad/Rep/Dec $25k | Manos Combo $20k | Jelly Spa $20k

══════════════════════════════════════
FLUJO ESTRICTO DE AGENDAMIENTO
══════════════════════════════════════
1. Preguntar servicio.
2. Preguntar fecha.
3. Mostrar SOLO turnos disponibles de esa fecha (los de arriba).
4. Clienta elige turno.
5. Pedir nombre completo.
6. Confirmar: nombre + servicio + fecha + hora.
7. Ejecutar [AGENDAR].

FLUJO CANCELACIÓN:
1. Nombre completo → fecha y hora → confirmar → [CANCELAR].

══════════════════════════════════════
COMANDOS (invisibles para la clienta, al final del mensaje)
══════════════════════════════════════
[AGENDAR:nombre|YYYY-MM-DD|HH|servicio]
[CANCELAR:nombre|YYYY-MM-DD|HH]

══════════════════════════════════════
TONO
══════════════════════════════════════
Formal. Sin "amor" ni "hermosa". Máximo 5 líneas por respuesta.`;
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
// WEBHOOK — mensajes entrantes
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
    console.log(`\n📩 [${from}]: "${text}"`);

    if (!conversations[from]) conversations[from] = [];
    conversations[from].push({ role: 'user', content: text });
    if (conversations[from].length > 20) {
      conversations[from] = conversations[from].slice(-20);
    }

    // Construir prompt con disponibilidad real en este momento
    const systemPrompt = await buildSystemPrompt();

    const aiRes = await anthropic.messages.create({
      model:      'claude-sonnet-4-20250514',
      max_tokens: 1000,
      system:     systemPrompt,
      messages:   conversations[from]
    });

    let reply = aiRes.content[0].text;

    // ── AGENDAR ──────────────────────────────────────────────────
    const agendarMatch = reply.match(/\[AGENDAR:([^|]+)\|([^|]+)\|([^|]+)\|([^\]]+)\]/);
    if (agendarMatch) {
      const [, nombre, fecha, horaStr, servicio] = agendarMatch;
      const hora = parseInt(horaStr);
      reply = reply.replace(/\[AGENDAR:[^\]]+\]/g, '').trim();

      console.log(`⚡ Intento de agendamiento: ${nombre} — ${fecha} ${hora}:00 — ${servicio}`);

      // Consultar Calendar AHORA MISMO antes de guardar
      const libre = await verificarTurnoLibre(fecha, hora);

      if (!libre) {
        // Turno ocupado — mostrar qué hay disponible
        const libresAhora = await getTurnosLibresReales(fecha);
        const textoAlt = libresAhora.length > 0
          ? `Turnos disponibles para esa fecha:\n${libresAhora.map(h => `  • ${formatTurno(h)}`).join('\n')}`
          : `No hay más turnos disponibles para esa fecha.`;

        await sendWhatsApp(from,
          `Ese horario ya se encuentra ocupado.\n\n${textoAlt}\n\n¿Cuál prefiere?`
        );
        console.log(`🚫 Bloqueado: ${fecha} ${hora}:00 ya está ocupado`);
      } else {
        // Guardar inmediatamente en Calendar
        await addToGoogleCalendar(nombre, fecha, hora, servicio, from);

        await sendWhatsApp(from,
          `*Cita confirmada*\n\n` +
          `Nombre: ${nombre}\n` +
          `Servicio: ${servicio}\n` +
          `Fecha: ${formatFecha(fecha)}\n` +
          `Hora: ${formatTurno(hora)}\n\n` +
          `Recibirá un recordatorio una hora antes de su cita.`
        );
        console.log(`✅ Cita guardada en Calendar: ${nombre} — ${fecha} ${hora}:00`);
      }
    }

    // ── CANCELAR ─────────────────────────────────────────────────
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
          `Quedamos a su disposición para una nueva cita.`
        );
        console.log(`❌ Cancelada: ${nombre} — ${fecha} ${hora}:00`);
      } else {
        await sendWhatsApp(from,
          `No se encontró cita para ${nombre} el ${formatFecha(fecha)} a las ${String(hora).padStart(2,'0')}:00.\n` +
          `Verifique los datos e intente nuevamente.`
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
// Enviar WhatsApp
// ─────────────────────────────────────────────────────────────────
async function sendWhatsApp(to, text) {
  try {
    await axios.post(
      `https://graph.facebook.com/v19.0/${PHONE_ID}/messages`,
      { messaging_product: 'whatsapp', to, type: 'text', text: { body: text } },
      { headers: { Authorization: `Bearer ${WA_TOKEN}`, 'Content-Type': 'application/json' } }
    );
  } catch (e) {
    console.error('Error WhatsApp:', e.message);
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

  // Recordatorio 1 hora antes por WhatsApp
  const msHasta = start.getTime() - Date.now() - (60 * 60 * 1000);
  if (msHasta > 0) {
    setTimeout(async () => {
      const key = `rem_${phone}_${fecha}_${hora}`;
      if (!remindersSent.has(key)) {
        remindersSent.add(key);
        try {
          await sendWhatsApp(phone,
            `Recordatorio de Natalia Tovar Nails Studio\n\n` +
            `En *1 hora* tiene su cita:\n\n` +
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
app.listen(process.env.PORT || 3000, () => {
  console.log('Natalia Tovar Nails Studio — Bot activo ✅');
});
