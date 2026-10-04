/**
 * WhatsApp inbound receiver.
 *
 * The WhatsApp Cloud API connector is outbound only — it can send messages but
 * cannot read replies, because Meta delivers inbound messages by webhook.
 * This module closes that gap:
 *
 *   GET  /whatsapp/webhook   Meta's verification handshake (hub.challenge)
 *   POST /whatsapp/webhook   Meta posts inbound messages here
 *   MCP tool get_inbound_messages   the agent polls for what humans said
 *
 * Voice notes: Meta sends a media id, not a file. If WHATSAPP_TOKEN is set we
 * download the audio and serve it at /whatsapp/media/<id> so speech-to-text
 * can fetch it over plain HTTP.
 */

const inbox = [];            // newest last
const media = new Map();     // media_id -> { buffer, mime }

const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN || 'bhojan-verify';
const WA_TOKEN = process.env.WHATSAPP_TOKEN || '';
const GRAPH = 'https://graph.facebook.com/v21.0';

/** Meta's one-time subscription handshake. */
export function verifyWebhook(req, res) {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
}

async function fetchMedia(mediaId) {
  if (!WA_TOKEN) return null;
  try {
    const metaRes = await fetch(`${GRAPH}/${mediaId}`, {
      headers: { Authorization: `Bearer ${WA_TOKEN}` },
    });
    if (!metaRes.ok) return null;
    const { url, mime_type } = await metaRes.json();

    const binRes = await fetch(url, {
      headers: { Authorization: `Bearer ${WA_TOKEN}` },
    });
    if (!binRes.ok) return null;

    const buffer = Buffer.from(await binRes.arrayBuffer());
    media.set(mediaId, { buffer, mime: mime_type || 'audio/ogg' });
    return mime_type;
  } catch {
    return null;
  }
}

/**
 * Meta posts here. Always 200 quickly, or Meta retries and eventually
 * disables the subscription.
 */
export async function receiveWebhook(req, res, publicBase) {
  res.sendStatus(200);

  try {
    const entries = req.body?.entry || [];
    for (const entry of entries) {
      for (const change of entry.changes || []) {
        const value = change.value || {};
        const contacts = value.contacts || [];
        for (const msg of value.messages || []) {
          const contact = contacts.find((c) => c.wa_id === msg.from);
          const record = {
            id: msg.id,
            from: msg.from,
            name: contact?.profile?.name || null,
            type: msg.type,
            at: new Date(Number(msg.timestamp) * 1000).toISOString(),
            received_at: new Date().toISOString(),
            text: null,
            audio_url: null,
          };

          if (msg.type === 'text') {
            record.text = msg.text?.body ?? null;
          } else if (msg.type === 'audio' || msg.type === 'voice') {
            const mediaId = msg.audio?.id || msg.voice?.id;
            if (mediaId) {
              await fetchMedia(mediaId);
              record.audio_url = `${publicBase}/whatsapp/media/${mediaId}`;
            }
          } else if (msg.type === 'interactive') {
            record.text =
              msg.interactive?.button_reply?.title ||
              msg.interactive?.list_reply?.title ||
              null;
          } else if (msg.type === 'button') {
            record.text = msg.button?.text ?? null;
          }

          inbox.push(record);
          if (inbox.length > 300) inbox.shift();
        }
      }
    }
  } catch (err) {
    console.error('whatsapp webhook parse error', err);
  }
}

export function serveMedia(req, res) {
  const item = media.get(req.params.id);
  if (!item) return res.sendStatus(404);
  res.set('Content-Type', item.mime).send(item.buffer);
}

/** Messages since an ISO timestamp, optionally from one number. */
export function listInbound({ since, from, limit = 20 } = {}) {
  let out = inbox;
  if (since) {
    const t = Date.parse(since);
    if (!Number.isNaN(t)) out = out.filter((m) => Date.parse(m.received_at) > t);
  }
  if (from) out = out.filter((m) => m.from.endsWith(String(from).replace(/\D/g, '')));
  return out.slice(-limit);
}

export function clearInbound() {
  inbox.length = 0;
  media.clear();
}

export function inboxSize() {
  return inbox.length;
}

/** Test helper: inject a message as if Meta had delivered it. */
export function injectInbound({ from, name, text, type = 'text' }) {
  const record = {
    id: `sim-${Date.now()}`,
    from: String(from),
    name: name || null,
    type,
    at: new Date().toISOString(),
    received_at: new Date().toISOString(),
    text: text ?? null,
    audio_url: null,
    simulated: true,
  };
  inbox.push(record);
  return record;
}

// --------------------------------------------------------------------------
// Outbound.
//
// AgenticOrg's native WhatsApp connector only sends, and registering it means
// fighting the native-connector name check. Since this server already receives
// inbound messages, it sends from here too — one connector for the whole
// channel.
//
// Needs WHATSAPP_TOKEN and WHATSAPP_PHONE_NUMBER_ID.
// --------------------------------------------------------------------------

const PHONE_ID = process.env.WHATSAPP_PHONE_NUMBER_ID || '';
const outboundLog = [];

export function whatsappConfigured() {
  return Boolean(WA_TOKEN && PHONE_ID);
}

export function getOutboundLog() {
  return outboundLog;
}

function logOut(entry) {
  outboundLog.push({ at: new Date().toISOString(), ...entry });
  if (outboundLog.length > 200) outboundLog.shift();
}

const NOT_SET = {
  ok: false,
  error:
    'WHATSAPP_TOKEN and WHATSAPP_PHONE_NUMBER_ID are not set. Add them in ' +
    'Render → Environment from the Meta app dashboard (WhatsApp → API Setup).',
};

async function send(payload, label) {
  if (!whatsappConfigured()) return NOT_SET;

  const started = Date.now();
  try {
    const res = await fetch(`${GRAPH}/${PHONE_ID}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${WA_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ messaging_product: 'whatsapp', ...payload }),
    });

    const body = await res.json().catch(() => ({}));
    logOut({ label, to: payload.to, ok: res.ok, status: res.status, ms: Date.now() - started });

    if (!res.ok) {
      const meta = body?.error || {};
      // 131047 / 131026: outside the 24-hour customer-service window.
      const windowClosed = [131047, 131026].includes(meta.code);
      return {
        ok: false,
        http_status: res.status,
        error: meta.message || body,
        hint: windowClosed
          ? 'WhatsApp only allows a free-form message within 24 hours of the ' +
            'person last messaging your number. Ask them to send anything first, ' +
            'or use an approved template.'
          : undefined,
      };
    }

    return { ok: true, message_id: body?.messages?.[0]?.id || null, to: payload.to };
  } catch (err) {
    logOut({ label, to: payload.to, ok: false, error: String(err.message) });
    return { ok: false, error: String(err.message) };
  }
}

/** A plain text message. Used for the family. */
export function sendText({ to, text }) {
  return send(
    { to: String(to).replace(/\D/g, ''), type: 'text', text: { body: text, preview_url: false } },
    'text'
  );
}

/**
 * A voice note, from a URL — give it the audio_url that gnani_speak returned.
 * Used for the cook, who is briefed by voice.
 */
export function sendVoice({ to, audio_url }) {
  return send(
    { to: String(to).replace(/\D/g, ''), type: 'audio', audio: { link: audio_url } },
    'voice'
  );
}
