/**
 * Delhivery mock — core behaviour.
 *
 * Endpoint paths, request shapes and response field names follow Delhivery's
 * published B2C/Express documentation (checked 2 Oct 2026):
 *   - serviceability : GET  /c/api/pin-codes/json/?filter_codes=<pin>
 *   - create         : POST /api/cmu/create.json      (body: format=json&data=<json>)
 *   - track          : GET  /api/v1/packages/json/?waybill=<wbn>
 *   - cancel         : POST /api/p/edit
 * Auth header follows Delhivery's convention: `Authorization: Token <key>`.
 *
 * Anything this file invents beyond the docs is marked INVENTED in a comment
 * so it can be declared as a hypothetical capability in the submission.
 */

// ---------------------------------------------------------------- scenarios

export const SCENARIOS = [
  'happy',              // everything works
  'pin_not_serviceable',// serviceability returns not serviceable
  'no_rider',           // shipment created, never picked up
  'late_delivery',      // delivered, but after the cook's start time
  'malformed',          // 200 OK with a response that breaks the schema
  'timeout',            // hangs past any sane client timeout
  'auth_fail',          // 401
  'server_error',       // 500
  'cancelled',          // shipment cancelled by the courier after creation
];

const state = {
  scenario: 'happy',
  shipments: new Map(),
  calls: [],            // audit log, used as eval evidence
};

export function setScenario(name) {
  if (!SCENARIOS.includes(name)) {
    throw new Error(`unknown scenario "${name}". one of: ${SCENARIOS.join(', ')}`);
  }
  state.scenario = name;
  return state.scenario;
}

export function getScenario() {
  return state.scenario;
}

export function getCalls() {
  return state.calls;
}

export function resetState() {
  state.scenario = 'happy';
  state.shipments.clear();
  state.calls.length = 0;
}

function log(tool, request, response) {
  state.calls.push({
    at: new Date().toISOString(),
    scenario: state.scenario,
    tool,
    request,
    response,
  });
  if (state.calls.length > 500) state.calls.shift();
}

// ------------------------------------------------------------------ helpers

const SERVICEABLE_PREFIXES = ['110', '122', '201', '560', '400', '600', '500', '700'];

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

class ApiError extends Error {
  constructor(status, body) {
    super(typeof body === 'string' ? body : JSON.stringify(body));
    this.status = status;
    this.body = body;
  }
}

function checkAuth(token) {
  if (state.scenario === 'auth_fail') {
    throw new ApiError(401, { error: 'Invalid or expired token' });
  }
  if (!token || !/^Token\s+\S+/i.test(token)) {
    throw new ApiError(401, {
      error: 'Authorization header must be "Token <api_key>"',
    });
  }
}

function newWaybill() {
  // Delhivery waybills are numeric strings; 14 digits is typical.
  return String(Math.floor(1e13 + Math.random() * 9e13));
}

// ------------------------------------------------------------ serviceability

export async function checkPincode({ pin, authorization }) {
  checkAuth(authorization);

  if (state.scenario === 'timeout') {
    await sleep(45000);
  }
  if (state.scenario === 'server_error') {
    throw new ApiError(500, { error: 'Internal Server Error' });
  }
  if (state.scenario === 'malformed') {
    const bad = { delivery_codes: 'serviceable' }; // string where array is documented
    log('check_pincode_serviceability', { pin }, bad);
    return bad;
  }

  if (!/^\d{6}$/.test(String(pin || ''))) {
    throw new ApiError(400, { error: 'filter_codes must be a 6 digit pincode' });
  }

  const serviceable =
    state.scenario !== 'pin_not_serviceable' &&
    SERVICEABLE_PREFIXES.some((p) => String(pin).startsWith(p));

  // Response shape mirrors Delhivery's documented delivery_codes array.
  const body = serviceable
    ? {
        delivery_codes: [
          {
            postal_code: {
              pin: Number(pin),
              city: 'Bengaluru',
              state_code: 'KA',
              district: 'Bengaluru Urban',
              pre_paid: 'Y',
              cod: 'Y',
              pickup: 'Y',
              repl: 'N',
              cash: 'Y',
              max_amount: 50000,
              is_oda: 'N',
              sort_code: 'BLR/HSR',
              remarks: '',
            },
          },
        ],
      }
    : { delivery_codes: [] };

  log('check_pincode_serviceability', { pin }, body);
  return body;
}

// -------------------------------------------------------------------- create

export async function createShipment({ rawBody, authorization }) {
  checkAuth(authorization);

  if (state.scenario === 'timeout') {
    await sleep(45000);
  }
  if (state.scenario === 'server_error') {
    throw new ApiError(500, { error: 'Internal Server Error' });
  }

  // Delhivery requires the body to be `format=json&data=<json>` — not plain JSON.
  // Getting this wrong is the most common integration failure, so the mock
  // enforces it exactly as the docs describe.
  const match = /(?:^|&)data=([\s\S]*)$/.exec(rawBody || '');
  if (!/(?:^|&)format=json(?:&|$)/.test(rawBody || '') || !match) {
    throw new ApiError(400, {
      success: false,
      rmk: 'body must be form-encoded as format=json&data=<json>',
    });
  }

  let payload;
  try {
    payload = JSON.parse(decodeURIComponent(match[1]));
  } catch {
    throw new ApiError(400, { success: false, rmk: 'data is not valid JSON' });
  }

  const shipment = payload?.shipments?.[0];
  if (!shipment) {
    throw new ApiError(400, { success: false, rmk: 'shipments[] is required' });
  }

  const required = ['order', 'phone', 'add', 'pin', 'payment_mode'];
  const missing = required.filter((f) => !shipment[f]);
  if (missing.length) {
    throw new ApiError(400, {
      success: false,
      rmk: `missing mandatory field(s): ${missing.join(', ')}`,
    });
  }
  if (!payload.pickup_location?.name) {
    throw new ApiError(400, {
      success: false,
      rmk: 'pickup_location.name must match a registered warehouse (case sensitive)',
    });
  }

  if (state.scenario === 'malformed') {
    const bad = { packages: [{ waybill: null, status: undefined }] };
    log('create_shipment', { order: shipment.order }, bad);
    return bad;
  }

  const waybill = shipment.waybill || newWaybill();
  const now = Date.now();

  // INVENTED: Delhivery's docs do not return a promised delivery time on
  // create. We return one so the agent has something to reason about, and we
  // declare it as a hypothetical capability in the submission.
  const minutes = state.scenario === 'late_delivery' ? 150 : 45;
  const promised = new Date(now + minutes * 60000).toISOString();

  state.shipments.set(waybill, {
    waybill,
    order: shipment.order,
    pin: shipment.pin,
    payment_mode: shipment.payment_mode,
    created_at: new Date(now).toISOString(),
    promised_at: promised,
    scenario_at_creation: state.scenario,
  });

  const body = {
    success: true,
    packages: [
      {
        waybill,
        refnum: shipment.order,
        status: 'Success',
        sort_code: 'BLR/HSR',
        remarks: [''],
        // INVENTED, see above.
        promised_delivery_time: promised,
      },
    ],
    upload_wbn: `UPL${now}`,
    rmk: '',
  };

  log('create_shipment', { order: shipment.order, pin: shipment.pin }, body);
  return body;
}

// --------------------------------------------------------------------- track

export async function trackShipment({ waybill, authorization }) {
  checkAuth(authorization);

  if (state.scenario === 'timeout') {
    await sleep(45000);
  }
  if (state.scenario === 'server_error') {
    throw new ApiError(500, { error: 'Internal Server Error' });
  }
  if (state.scenario === 'malformed') {
    const bad = { ShipmentData: {} }; // object where array is documented
    log('track_shipment', { waybill }, bad);
    return bad;
  }

  const ship = state.shipments.get(String(waybill));
  if (!ship) {
    const body = { ShipmentData: [] };
    log('track_shipment', { waybill }, body);
    return body;
  }

  let status, instructions, deliveredAt = null;
  switch (state.scenario) {
    case 'no_rider':
      status = 'Manifested';
      instructions = 'Pickup not yet assigned';
      break;
    case 'cancelled':
      status = 'Canceled';
      instructions = 'Shipment canceled by courier';
      break;
    case 'late_delivery':
      status = 'Delivered';
      instructions = 'Delivered';
      deliveredAt = ship.promised_at; // after the cook's start time
      break;
    default:
      status = 'Delivered';
      instructions = 'Delivered';
      deliveredAt = new Date(Date.parse(ship.created_at) + 32 * 60000).toISOString();
  }

  const body = {
    ShipmentData: [
      {
        Shipment: {
          AWB: ship.waybill,
          ReferenceNo: ship.order,
          Status: {
            Status: status,
            StatusType: status === 'Delivered' ? 'DL' : 'UD',
            StatusDateTime: deliveredAt || new Date().toISOString(),
            Instructions: instructions,
            StatusLocation: 'Bengaluru_HSR (Karnataka)',
          },
          PickUpDate: ship.created_at,
          // INVENTED: see create_shipment.
          PromisedDeliveryDate: ship.promised_at,
          DeliveryDate: deliveredAt,
          OrderType: ship.payment_mode,
          Consignee: { PinCode: ship.pin, City: 'Bengaluru' },
        },
      },
    ],
  };

  log('track_shipment', { waybill }, body);
  return body;
}

// -------------------------------------------------------------------- cancel

export async function cancelShipment({ waybill, authorization }) {
  checkAuth(authorization);

  if (state.scenario === 'server_error') {
    throw new ApiError(500, { error: 'Internal Server Error' });
  }

  const ship = state.shipments.get(String(waybill));
  if (!ship) {
    throw new ApiError(404, { status: false, remark: 'waybill not found' });
  }
  state.shipments.delete(String(waybill));

  const body = { status: true, waybill: String(waybill), remark: 'Cancelled' };
  log('cancel_shipment', { waybill }, body);
  return body;
}

export { ApiError };
