/**
 * Delhivery mock, served as an MCP server for AgenticOrg.
 *
 * Two surfaces:
 *   /mcp      MCP (streamable HTTP) — the four tools the agent may call.
 *   /admin/*  plain REST — scenario control and the call log, for the person
 *             running evals. Deliberately NOT exposed as MCP tools, so the
 *             agent cannot switch off its own failure injection.
 */

import express from 'express';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import {
  SCENARIOS,
  setScenario,
  getScenario,
  getCalls,
  resetState,
  checkPincode,
  createShipment,
  trackShipment,
  cancelShipment,
  ApiError,
} from './delhivery.js';

import {
  verifyWebhook,
  receiveWebhook,
  serveMedia,
  listInbound,
  clearInbound,
  inboxSize,
  injectInbound,
  sendText,
  sendVoice,
  whatsappConfigured,
  getOutboundLog,
} from './whatsapp.js';

import {
  listTabs,
  readRange,
  writeRange,
  appendRows,
  getSheetCalls,
  clearSheetCalls,
  sheetConfigured,
} from './sheets.js';

import {
  speak,
  transcribe,
  serveClip,
  gnaniConfigured,
  getGnaniCalls,
  clearGnaniClips,
} from './gnani.js';

const API_TOKEN = process.env.DELHIVERY_MOCK_TOKEN || 'test-token';
const ADMIN_KEY = process.env.ADMIN_KEY || 'admin-key';
const AUTH = `Token ${API_TOKEN}`;

/** Wrap a mock call so MCP always gets a readable result, errors included. */
async function call(fn, args, label) {
  try {
    const body = await fn({ ...args, authorization: AUTH });
    return {
      content: [{ type: 'text', text: JSON.stringify(body, null, 2) }],
    };
  } catch (err) {
    const status = err instanceof ApiError ? err.status : 500;
    const body = err instanceof ApiError ? err.body : { error: String(err.message) };
    return {
      isError: true,
      content: [
        {
          type: 'text',
          text: `HTTP ${status} from ${label}\n${JSON.stringify(body, null, 2)}`,
        },
      ],
    };
  }
}

function buildServer(publicBaseUrl = "") {
  const server = new McpServer({ name: 'delhivery-mock', version: '1.0.0' });

  server.registerTool(
    'delhivery_check_pincode',
    {
      title: 'Check pincode serviceability',
      description:
        'Check whether Delhivery delivers to a 6-digit pincode before placing a grocery order. ' +
        'Mirrors GET /c/api/pin-codes/json/?filter_codes=<pin>. ' +
        'An empty delivery_codes array means NOT serviceable — do not order.',
      inputSchema: { pin: z.string().describe('6-digit delivery pincode, e.g. 560102') },
    },
    async ({ pin }) => call(checkPincode, { pin }, 'GET /c/api/pin-codes/json/')
  );

  server.registerTool(
    'delhivery_create_shipment',
    {
      title: 'Create a shipment',
      description:
        'Book a delivery for a paid grocery order. Mirrors POST /api/cmu/create.json, ' +
        'which requires the body form-encoded as format=json&data=<json>. ' +
        'Returns a waybill number used for tracking. Never call this before payment succeeds.',
      inputSchema: {
        order_id: z.string().describe('Unique order reference'),
        pin: z.string().describe('6-digit delivery pincode'),
        address: z.string().describe('Full delivery address'),
        name: z.string().describe('Name of the person receiving'),
        phone: z.string().describe('Contact phone number'),
        payment_mode: z
          .enum(['Prepaid', 'COD', 'Pickup'])
          .describe('Prepaid once the agent has already paid'),
        pickup_location: z
          .string()
          .describe('Registered warehouse name, case sensitive'),
        total_amount: z.number().describe('Order value in rupees'),
      },
    },
    async (a) => {
      const data = {
        shipments: [
          {
            order: a.order_id,
            name: a.name,
            add: a.address,
            pin: a.pin,
            phone: a.phone,
            payment_mode: a.payment_mode,
            total_amount: a.total_amount,
            country: 'India',
          },
        ],
        pickup_location: { name: a.pickup_location },
      };
      const rawBody = `format=json&data=${encodeURIComponent(JSON.stringify(data))}`;
      return call(createShipment, { rawBody }, 'POST /api/cmu/create.json');
    }
  );

  server.registerTool(
    'delhivery_track_shipment',
    {
      title: 'Track a shipment',
      description:
        'Check the live status of a booked delivery by waybill. Mirrors ' +
        'GET /api/v1/packages/json/?waybill=<wbn>. Status is one of Manifested, ' +
        'In Transit, Dispatched, Delivered, Canceled. Only treat groceries as ' +
        'arrived when Status is Delivered — a booking is not an arrival.',
      inputSchema: { waybill: z.string().describe('Waybill number from create_shipment') },
    },
    async ({ waybill }) =>
      call(trackShipment, { waybill }, 'GET /api/v1/packages/json/')
  );

  server.registerTool(
    'delhivery_cancel_shipment',
    {
      title: 'Cancel a shipment',
      description:
        'Cancel a booked delivery, for example when nobody is cooking that night ' +
        'so fresh groceries would rot. Mirrors POST /api/p/edit with cancellation.',
      inputSchema: { waybill: z.string().describe('Waybill number to cancel') },
    },
    async ({ waybill }) =>
      call(cancelShipment, { waybill }, 'POST /api/p/edit')
  );

  server.registerTool(
    'whatsapp_get_inbound_messages',
    {
      title: 'Read incoming WhatsApp messages',
      description:
        'Read what the family and the cook have sent on WhatsApp. The WhatsApp ' +
        'Cloud API connector can only send; Meta delivers replies by webhook, so ' +
        'this returns what arrived. Use it to check for a menu swap before the ' +
        '6 PM lock, and for the cook\'s reply after dinner. A voice note comes ' +
        'back as audio_url — send that to speech-to-text.',
      inputSchema: {
        since: z
          .string()
          .optional()
          .describe('ISO timestamp; only messages received after it'),
        from: z
          .string()
          .optional()
          .describe('Phone number to filter by, digits only'),
        limit: z.number().optional().describe('Max messages, default 20'),
      },
    },
    async ({ since, from, limit }) => ({
      content: [
        {
          type: 'text',
          text: JSON.stringify(listInbound({ since, from, limit }), null, 2),
        },
      ],
    })
  );

  // --- the household sheet: the agent's only memory ------------------------

  // The platform's MCP client coerces every argument to a string and rejects
  // numbers, booleans and nulls inside an array schema. So values arrive as a
  // JSON string and the server parses them.
  const cellValues = z
    .string()
    .describe(
      'Rows of cells as a JSON string, outermost array is rows. ' +
      'Example: [["tomato","0","pcs"]]. Quote every value.'
    );

  const asText = async (promise) => ({
    content: [{ type: 'text', text: JSON.stringify(await promise, null, 2) }],
  });

  server.registerTool(
    'sheet_read',
    {
      title: 'Read the household sheet',
      description:
        'Read a range from the household Google Sheet. This is where the agent ' +
        'finds everything it knows: who is allowed to do what (people), what is ' +
        'in the kitchen (pantry), nutrition targets (goals), health findings ' +
        '(health), dish nutrition (dishes), ingredients per dish (recipes), the ' +
        'spending limit and phone numbers (rules), and what was eaten before ' +
        '(history). Always read before deciding. Range is A1 notation with the ' +
        'tab name, e.g. "pantry!A1:F20".',
      inputSchema: {
        range: z
          .string()
          .describe('A1 notation including the tab, e.g. "people!A1:F10"'),
      },
    },
    async ({ range }) => asText(readRange(range))
  );

  server.registerTool(
    'sheet_write',
    {
      title: 'Overwrite cells in the household sheet',
      description:
        'Overwrite a block of cells, starting at an anchor cell. The block is ' +
        'sized from the values given, so "pantry!B2" with three rows writes B2:B4. ' +
        'Use this to deduct stock after the cook confirms dinner, and to update ' +
        'spent_so_far in rules after an order. Read the range first — this ' +
        'replaces what is there.',
      inputSchema: {
        range: z
          .string()
          .describe('Anchor cell in A1 notation with the tab, e.g. "rules!B3"'),
        values: cellValues,
      },
    },
    async ({ range, values }) => asText(writeRange(range, values))
  );

  server.registerTool(
    'sheet_append',
    {
      title: 'Add rows to the household sheet',
      description:
        'Add rows to the bottom of a tab without touching anything above. Use it ' +
        'to log a confirmed dinner to the history tab, and to record consumption ' +
        'in usage. Columns must be in the same order as the tab headers.',
      inputSchema: {
        tab: z.string().describe('Tab name, e.g. "history"'),
        values: cellValues,
      },
    },
    async ({ tab, values }) => asText(appendRows(tab, values))
  );

  // --- voice: the cook's interface ----------------------------------------

  server.registerTool(
    'gnani_speak',
    {
      title: 'Say something as a voice note',
      description:
        'Turn text into speech with Gnani and get back a URL to the audio. ' +
        'Use this for the cook, who is briefed by voice in Hindi, not by text. ' +
        'Returns audio_url — send that with the WhatsApp media tool. Keep the ' +
        'text short and spoken, the way a person would say it out loud.',
      inputSchema: {
        text: z.string().describe('What to say, in the target language'),
        language: z
          .string()
          .optional()
          .describe('BCP-47 code. hi-IN for the cook, en-IN for the family. Default hi-IN'),
        voice: z
          .string()
          .optional()
          .describe('Nalini, Kaveri or Deepak. Default Nalini'),
        speed: z
          .string()
          .optional()
          .describe('slow, medium or fast. Default slow — the cook is working while listening'),
      },
    },
    async (a) => ({
      content: [
        {
          type: 'text',
          text: JSON.stringify(await speak({ ...a, publicBase: publicBaseUrl }), null, 2),
        },
      ],
    })
  );

  server.registerTool(
    'gnani_transcribe',
    {
      title: 'Listen to a voice note',
      description:
        'Turn a voice note into text with Gnani. Give it the audio_url from ' +
        'whatsapp_get_inbound_messages. Use it whenever the cook or the family ' +
        'replies by voice instead of typing — the cook usually will, because her ' +
        'hands are busy. Audio must be under 60 seconds.',
      inputSchema: {
        audio_url: z.string().describe('URL of the voice note'),
        language_code: z
          .string()
          .optional()
          .describe('BCP-47 code of the speaker. Default hi-IN'),
      },
    },
    async (a) => ({
      content: [{ type: 'text', text: JSON.stringify(await transcribe(a), null, 2) }],
    })
  );

  // --- whatsapp outbound ---------------------------------------------------

  server.registerTool(
    'whatsapp_send_text',
    {
      title: 'Send a WhatsApp text',
      description:
        'Send a text message on WhatsApp. Use it for the family — menu, cost, ' +
        'budget left, anything needing a yes. Do not send money or nutrition ' +
        'numbers to the cook. Give the number as digits with country code, e.g. ' +
        '919800000001; the people tab has them.',
      inputSchema: {
        to: z.string().describe('Phone number, digits only with country code'),
        text: z.string().describe('The message'),
      },
    },
    async (a) => ({
      content: [{ type: 'text', text: JSON.stringify(await sendText(a), null, 2) }],
    })
  );

  server.registerTool(
    'whatsapp_send_voice',
    {
      title: 'Send a WhatsApp voice note',
      description:
        'Send a voice note. Pass the audio_url that gnani_speak returned. This ' +
        'is how the cook is briefed — she is working and cannot read a long ' +
        'message. Call gnani_speak first, then this with its audio_url.',
      inputSchema: {
        to: z.string().describe('Phone number, digits only with country code'),
        audio_url: z.string().describe('audio_url from gnani_speak'),
      },
    },
    async (a) => ({
      content: [{ type: 'text', text: JSON.stringify(await sendVoice(a), null, 2) }],
    })
  );

  return server;
}

// ------------------------------------------------------------------ http app

const app = express();
app.use(express.json({ limit: '2mb' }));

app.get('/', (_req, res) => {
  res.json({
    name: 'bhojan-support',
    mcp_endpoint: '/mcp',
    tools: [
      'delhivery_check_pincode',
      'delhivery_create_shipment',
      'delhivery_track_shipment',
      'delhivery_cancel_shipment',
      'whatsapp_get_inbound_messages',
      'sheet_read',
      'sheet_write',
      'sheet_append',
      'gnani_speak',
      'gnani_transcribe',
      'whatsapp_send_text',
      'whatsapp_send_voice',
    ],
    current_scenario: getScenario(),
    scenarios: SCENARIOS,
    sheet_bridge: sheetConfigured() ? 'configured' : 'SHEET_WEBAPP_URL not set',
    gnani_voice: gnaniConfigured() ? 'configured' : 'GNANI_API_KEY not set',
    whatsapp_outbound: whatsappConfigured()
      ? 'configured'
      : 'WHATSAPP_TOKEN / WHATSAPP_PHONE_NUMBER_ID not set',
  });
});

app.get('/health', (_req, res) =>
  res.json({
    ok: true,
    scenario: getScenario(),
    sheet_bridge: sheetConfigured(),
    gnani_voice: gnaniConfigured(),
    whatsapp_outbound: whatsappConfigured(),
  })
);

// --- admin: scenario control (NOT an MCP tool, on purpose) -------------------

function requireAdmin(req, res, next) {
  const key = req.get('x-admin-key') || req.query.key;
  if (key !== ADMIN_KEY) return res.status(401).json({ error: 'bad admin key' });
  next();
}

app.get('/admin/scenario', requireAdmin, (_req, res) =>
  res.json({ scenario: getScenario(), available: SCENARIOS })
);

app.post('/admin/scenario', requireAdmin, (req, res) => {
  const name = req.body?.scenario || req.query.scenario;
  try {
    res.json({ scenario: setScenario(name), at: new Date().toISOString() });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/admin/calls', requireAdmin, (_req, res) =>
  res.json({ count: getCalls().length, calls: getCalls() })
);

app.post('/admin/reset', requireAdmin, (_req, res) => {
  resetState();
  clearInbound();
  clearSheetCalls();
  clearGnaniClips();
  res.json({ ok: true, scenario: getScenario() });
});

// --- admin: sheet bridge health -------------------------------------------
// Proves the Apps Script deployment works before a recording, without the
// agent having to be involved.

app.get('/admin/sheet/tabs', requireAdmin, async (_req, res) =>
  res.json(await listTabs())
);

app.get('/admin/sheet/read', requireAdmin, async (req, res) => {
  if (!req.query.range) return res.status(400).json({ error: 'range required' });
  res.json(await readRange(String(req.query.range)));
});

app.get('/admin/sheet/calls', requireAdmin, (_req, res) =>
  res.json({ count: getSheetCalls().length, calls: getSheetCalls() })
);

// --- voice ----------------------------------------------------------------
// Generated clips are served unauthenticated so WhatsApp can fetch them.

app.get('/audio/:id', serveClip);

app.get('/admin/whatsapp/sent', requireAdmin, (_req, res) =>
  res.json({ count: getOutboundLog().length, sent: getOutboundLog() })
);

app.get('/admin/gnani/calls', requireAdmin, (_req, res) =>
  res.json({ count: getGnaniCalls().length, calls: getGnaniCalls() })
);

app.get('/admin/gnani/test', requireAdmin, async (req, res) =>
  res.json(
    await speak({
      text: String(req.query.text || 'Aaj dal, bhindi aur roti banani hai.'),
      language: String(req.query.language || 'hi-IN'),
      publicBase: publicBase(req),
    })
  )
);

// --- whatsapp inbound ------------------------------------------------------

function publicBase(req) {
  return (
    process.env.PUBLIC_BASE_URL ||
    `${req.get('x-forwarded-proto') || req.protocol}://${req.get('host')}`
  );
}

app.get('/whatsapp/webhook', verifyWebhook);
app.post('/whatsapp/webhook', (req, res) => receiveWebhook(req, res, publicBase(req)));
app.get('/whatsapp/media/:id', serveMedia);

app.get('/admin/inbound', requireAdmin, (req, res) =>
  res.json({ count: inboxSize(), messages: listInbound({ limit: 50 }) })
);

// Simulate an inbound message, for testing without a live WhatsApp number.
app.post('/admin/inbound', requireAdmin, (req, res) => {
  const { from, name, text } = req.body || {};
  if (!from || !text) {
    return res.status(400).json({ error: 'from and text are required' });
  }
  res.json(injectInbound({ from, name, text }));
});

// --- mcp endpoint (stateless: one server+transport per request) -------------

app.post('/mcp', async (req, res) => {
  const server = buildServer(publicBase(req));
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless
    enableJsonResponse: true,
  });
  res.on('close', () => {
    transport.close();
    server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: String(err.message) },
        id: null,
      });
    }
  }
});

const methodNotAllowed = (_req, res) =>
  res.status(405).json({
    jsonrpc: '2.0',
    error: { code: -32000, message: 'Method not allowed. Use POST /mcp.' },
    id: null,
  });
app.get('/mcp', methodNotAllowed);
app.delete('/mcp', methodNotAllowed);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`delhivery-mock listening on :${PORT}`);
  console.log(`  MCP   POST /mcp`);
  console.log(`  admin POST /admin/scenario  (x-admin-key)`);
  console.log(`  scenarios: ${SCENARIOS.join(', ')}`);
});
