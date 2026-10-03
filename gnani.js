/**
 * Gnani (Vachana) voice.
 *
 * AgenticOrg will not accept a connector named for a service it does not
 * already know, so Gnani cannot be registered there as a native connector.
 * It is a plain REST API, so we call it from here instead and expose two MCP
 * tools. The brief requires real speech, not a mock, and this is the real API.
 *
 * Docs: https://docs.gnani.ai
 *   TTS  POST https://api.vachana.ai/api/v1/tts/inference   (JSON  -> binary audio)
 *   STT  POST https://api.vachana.ai/stt/v3                 (multipart -> JSON)
 *   Auth header on both: X-API-Key-ID
 */

const API_KEY = process.env.GNANI_API_KEY || '';
const TTS_URL = 'https://api.vachana.ai/api/v1/tts/inference';
const STT_URL = 'https://api.vachana.ai/stt/v3';
const TIMEOUT_MS = Number(process.env.GNANI_TIMEOUT_MS || 45000);

/** Generated audio, served at /audio/<id>.wav so WhatsApp can fetch it. */
const clips = new Map();
const calls = [];

export function gnaniConfigured() {
  return Boolean(API_KEY);
}

export function getGnaniCalls() {
  return calls;
}

export function clearGnaniClips() {
  clips.clear();
  calls.length = 0;
}

export function serveClip(req, res) {
  const id = String(req.params.id || '').replace(/\.wav$/, '');
  const clip = clips.get(id);
  if (!clip) return res.sendStatus(404);
  res.set('Content-Type', clip.mime).send(clip.buffer);
}

function log(entry) {
  calls.push({ at: new Date().toISOString(), ...entry });
  if (calls.length > 200) calls.shift();
}

function withTimeout() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  return { signal: controller.signal, done: () => clearTimeout(timer) };
}

const NO_KEY = {
  ok: false,
  error:
    'GNANI_API_KEY is not set. Add it in Render → Environment, using the key ' +
    'from the Gnani playground.',
};

/**
 * Text -> speech. Returns a URL the agent can send as a WhatsApp voice note.
 * Defaults are tuned for the cook: Hindi, a female voice, slightly slow.
 */
export async function speak({
  text,
  language = 'hi-IN',
  voice = 'Nalini',
  speed = 'slow',
  publicBase = '',
}) {
  if (!API_KEY) return NO_KEY;

  const started = Date.now();
  const t = withTimeout();

  try {
    const res = await fetch(TTS_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key-ID': API_KEY,
      },
      body: JSON.stringify({
        text,
        model: 'timbre-v2.5',
        voice,
        language,
        speed,
        audio_config: {
          sample_rate: 48000,
          num_channels: 1,
          sample_width: 2,
          encoding: 'linear_pcm',
          container: 'wav',
        },
      }),
      signal: t.signal,
    });

    if (!res.ok) {
      const body = await res.text();
      log({ tool: 'speak', ok: false, status: res.status, ms: Date.now() - started });
      return {
        ok: false,
        http_status: res.status,
        error: body.slice(0, 400),
      };
    }

    const buffer = Buffer.from(await res.arrayBuffer());
    const id = `tts-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    clips.set(id, { buffer, mime: res.headers.get('content-type') || 'audio/wav' });
    if (clips.size > 50) clips.delete(clips.keys().next().value);

    log({ tool: 'speak', ok: true, language, voice, bytes: buffer.length, ms: Date.now() - started });

    return {
      ok: true,
      audio_url: `${publicBase}/audio/${id}.wav`,
      language,
      voice,
      bytes: buffer.length,
      spoken_text: text,
    };
  } catch (err) {
    log({ tool: 'speak', ok: false, error: String(err.message), ms: Date.now() - started });
    return {
      ok: false,
      error:
        err.name === 'AbortError'
          ? `Gnani TTS timed out after ${TIMEOUT_MS}ms`
          : String(err.message),
    };
  } finally {
    t.done();
  }
}

/**
 * Speech -> text. Takes a URL (a WhatsApp voice note, or a clip from /audio).
 * Gnani caps a single REST request at 60 seconds of audio.
 */
export async function transcribe({ audio_url, language_code = 'hi-IN', format = 'transcribe' }) {
  if (!API_KEY) return NO_KEY;

  const started = Date.now();
  const t = withTimeout();

  try {
    const audioRes = await fetch(audio_url, { signal: t.signal });
    if (!audioRes.ok) {
      log({ tool: 'transcribe', ok: false, stage: 'download', status: audioRes.status });
      return {
        ok: false,
        error: `Could not download the audio (HTTP ${audioRes.status} from ${audio_url})`,
      };
    }

    const bytes = Buffer.from(await audioRes.arrayBuffer());
    const mime = audioRes.headers.get('content-type') || 'audio/ogg';
    const ext = mime.includes('wav') ? 'wav' : mime.includes('mp') ? 'mp3' : 'ogg';

    const form = new FormData();
    form.append('audio_file', new Blob([bytes], { type: mime }), `clip.${ext}`);
    form.append('language_code', language_code);
    form.append('format', format);

    const res = await fetch(STT_URL, {
      method: 'POST',
      headers: { 'X-API-Key-ID': API_KEY },   // fetch sets the multipart boundary
      body: form,
      signal: t.signal,
    });

    const text = await res.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = { ok: false, error: 'Gnani did not return JSON', first_200_chars: text.slice(0, 200) };
    }

    log({
      tool: 'transcribe',
      ok: res.ok && body.success !== false,
      status: res.status,
      language_code,
      ms: Date.now() - started,
    });

    if (!res.ok) return { ok: false, http_status: res.status, error: body };
    return { ok: true, ...body };
  } catch (err) {
    log({ tool: 'transcribe', ok: false, error: String(err.message), ms: Date.now() - started });
    return {
      ok: false,
      error:
        err.name === 'AbortError'
          ? `Gnani STT timed out after ${TIMEOUT_MS}ms`
          : String(err.message),
    };
  } finally {
    t.done();
  }
}
