# Bhojan support server — MCP

Three jobs, one deployment. Built for The Ken's Case-Build Competition 2026,
Round 3.

**0. The household sheet.** The agent's only memory. AgenticOrg's native Google
Sheets connector is OAuth2 and wants a Client ID and Secret — a Google Cloud
project. This server reaches the sheet through an Apps Script web app bound to
the sheet itself, which already runs as the sheet's owner. No OAuth, no cloud
project, one connector instead of two. See section 8.

**1. Delhivery mock.** So the agent can check serviceability, book a delivery
and track it — and so you can **force each failure** your eval cases need.

**2. WhatsApp inbound receiver.** The WhatsApp Cloud API connector is
outbound-only: it sends, but Meta delivers replies by webhook, so the agent
cannot read them. This server receives those webhooks and exposes them as an
MCP tool the agent polls. Without it the family's menu swap and the cook's
"haan" never reach the agent. See section 7.

---

## 1. Deploy it

It must be reachable from AgenticOrg, so localhost will not do.

**Render (easiest, free):**
1. Push this folder to a GitHub repo.
2. render.com → New → Web Service → connect the repo.
3. Runtime Node, build `npm install`, start `npm start`.
4. Environment → add `ADMIN_KEY` (any string you choose).
5. Deploy. You get `https://<name>.onrender.com`.

**Or anywhere else** that runs Node 20+ and gives a public HTTPS URL
(Railway, Fly, a VPS). A `Dockerfile` is included.

Check it is up: `curl https://<your-url>/health`

> Render's free tier sleeps after inactivity. Hit `/health` a minute before a
> recording so the first tool call is not a 30-second cold start.

---

## 2. Register it in AgenticOrg

Dashboard → Connectors → Add Connector

| Field | Value |
|---|---|
| Name | `delhivery_<yourteam>` (names are org-wide unique) |
| MCP | ✅ tick it |
| MCP Server URL | `https://<your-url>/mcp` |
| Category | `quick_commerce` |
| Auth Type | `none` |
| Rate limit | leave at 100/min |

Register. AgenticOrg reads the tool catalogue and registers four tools.
Then in your agent's **Step 4 → Connectors**, add this connector and tick
its four tools under Authorized Tools.

The URL must end in `/mcp`. Pointing at the root will discover nothing.

---

## 3. The four tools

| Tool | Mirrors | The agent uses it to |
|---|---|---|
| `delhivery_check_pincode` | `GET /c/api/pin-codes/json/?filter_codes=` | Confirm the home pincode is serviceable before ordering |
| `delhivery_create_shipment` | `POST /api/cmu/create.json` | Book delivery after payment succeeds |
| `delhivery_track_shipment` | `GET /api/v1/packages/json/?waybill=` | Confirm groceries actually arrived before briefing the cook |
| `delhivery_cancel_shipment` | `POST /api/p/edit` | Cancel fresh orders when nobody is cooking |

`create_shipment` enforces Delhivery's real body quirk — the payload must be
form-encoded as `format=json&data=<json>`, not plain JSON. Mandatory fields
(`order`, `phone`, `add`, `pin`, `payment_mode`, `pickup_location.name`) are
validated and rejected with the documented error shape.

---

## 4. Forcing failures for evals

Scenario control is a **plain REST endpoint, not an MCP tool** — deliberately.
If the agent could switch scenarios it could disable its own failure injection,
and the eval would prove nothing.

```bash
# set a scenario
curl -X POST "https://<your-url>/admin/scenario?scenario=no_rider" \
  -H "x-admin-key: $ADMIN_KEY"

# what is active now
curl "https://<your-url>/admin/scenario" -H "x-admin-key: $ADMIN_KEY"

# every call the agent made, with timestamps — paste into your run log
curl "https://<your-url>/admin/calls" -H "x-admin-key: $ADMIN_KEY"

# clear shipments and go back to happy
curl -X POST "https://<your-url>/admin/reset" -H "x-admin-key: $ADMIN_KEY"
```

### Scenarios, and the eval each one drives

| Scenario | What the API does | Eval case |
|---|---|---|
| `happy` | Everything succeeds, delivered ~32 min | The main recorded run |
| `pin_not_serviceable` | `delivery_codes: []` | Agent must not order at all |
| `no_rider` | Books fine, status stuck on `Manifested` | 6 — booking is not arrival |
| `late_delivery` | `Delivered`, but after the cook's start | 1 — switch to a pantry dish |
| `malformed` | 200 OK, schema broken | 6 — do not assume it worked |
| `timeout` | Hangs 45s | 6 — check status, retry once |
| `auth_fail` | 401 | Credential failure handling |
| `server_error` | 500 | Retry-once behaviour |
| `cancelled` | Status `Canceled` after booking | Recover after courier drops it |

**`/admin/calls` is your evidence.** It logs every request and response with a
timestamp and the scenario in force. That is the run log Round 3 asks for,
produced by the system rather than written up afterwards.

---

## 5. What is documented vs. invented

Round 3 caps you at three hypothetical partner capabilities, so be exact about
which parts of this mock go beyond Delhivery's docs.

**Documented** — endpoint paths, the `format=json&data=` body, mandatory field
names, `delivery_codes` / `ShipmentData` response shapes, status values
(Manifested, In Transit, Dispatched, Delivered, Canceled), `Authorization: Token`.

**Invented — declare this one.** `promised_delivery_time` on create, and
`PromisedDeliveryDate` on track. Delhivery documents serviceability and
tracking but **not** a guaranteed arrival-by time. The agent needs one to decide
whether groceries beat the cook, so the mock returns it.

That gap is worth stating plainly in your answer: *serviceability and tracking
tell you where a parcel is, not whether dinner is at risk.* It is the clearest
missing capability on the logistics rail, and you found it by building against
the docs rather than reading them.

Both invented fields are marked `INVENTED` in `src/delhivery.js`.

---

## 6. Run locally

```bash
npm install
npm start          # :3000
./test.sh          # smoke test: all tools + every failure path
```

Env vars: `PORT`, `ADMIN_KEY` (default `admin-key`), `WHATSAPP_VERIFY_TOKEN`
(default `bhojan-verify`), `WHATSAPP_TOKEN`, `PUBLIC_BASE_URL`,
`DELHIVERY_MOCK_TOKEN` (default `test-token`), **`SHEET_WEBAPP_URL`** (the Apps
Script `/exec` URL — required for the sheet tools), `SHEET_SECRET` (default
`bhojan-2026`, must match `SECRET` in `apps-script/Code.gs`).

---

## 7. WhatsApp inbound

The Cloud API connector in AgenticOrg exposes only outbound tools
(`send_text_message`, `send_media_message`, `send_template_message`,
`get_message_templates`, `get_business_profile`). There is no way to read a
reply, because Meta pushes inbound messages to a webhook you host.

This server hosts it.

| Route | Purpose |
|---|---|
| `GET /whatsapp/webhook` | Meta's one-time verification handshake |
| `POST /whatsapp/webhook` | Meta posts inbound messages here |
| `GET /whatsapp/media/:id` | Serves a downloaded voice note over plain HTTP |
| MCP `whatsapp_get_inbound_messages` | The agent polls for what humans said |

### Wiring it to Meta

In the Meta app dashboard → WhatsApp → Configuration → Webhook:

- **Callback URL:** `https://<your-url>/whatsapp/webhook`
- **Verify token:** whatever you set as `WHATSAPP_VERIFY_TOKEN` (default `bhojan-verify`)
- **Subscribe to:** the `messages` field

Then set `WHATSAPP_TOKEN` to your permanent access token so voice notes get
downloaded. Without it, text still works and audio returns a URL that 404s.

### The 24-hour window

Plain `send_text_message` only works for 24 hours after a human messages your
number. Outside that window you need `send_template_message` with a
Meta-approved template.

**For a recording this is easy:** have whoever plays the family and the cook
each send one message to the number before you start. That opens the window
and every agent message in the run goes through as a normal text or voice
note, no template approval needed.

### Testing without a live number

```bash
curl -X POST "https://<your-url>/admin/inbound" \
  -H "x-admin-key: $ADMIN_KEY" -H 'Content-Type: application/json' \
  -d '{"from":"919800000001","name":"Priya","text":"bhindi banao aaj"}'
```

That injects a message as if Meta had delivered it, so you can test the swap
and confirmation paths before the number is live.

```bash
curl "https://<your-url>/admin/inbound" -H "x-admin-key: $ADMIN_KEY"   # read all
```

### Worth saying in your answer

This gap is a real finding, not a workaround you should hide. India's most
common household channel is outbound-only for agents: an agent can talk to a
household on WhatsApp but cannot hear it back without hosting infrastructure
Meta does not provide. That is a concrete missing capability on the voice and
comms side, and you found it by building.

---

## 8. The household sheet

The agent has no memory between runs. Everything it knows it reads from one
Google Sheet, and everything it learns it writes back there.

| Tool | What it is for |
|---|---|
| `sheet_read` | Who may do what (`people`), stock (`pantry`), targets (`goals`), health findings (`health`), dish nutrition (`dishes`), ingredients (`recipes`), limit and phones (`rules`), past dinners (`history`) |
| `sheet_write` | Deduct stock after the cook confirms; update `spent_so_far` after an order |
| `sheet_append` | Log a confirmed dinner to `history`; record consumption in `usage` |

### Why not the native Sheets connector

AgenticOrg registers OAuth2 connectors server-side: the form asks for a Client
ID and Client Secret. Getting those means a Google Cloud project, the Sheets API
enabled, a consent screen, and a refresh token — for one spreadsheet.

An Apps Script web app bound to the sheet is already authorised on it, because
it runs as the sheet's owner. The server calls that instead. The sheet stays a
real, live Google Sheet the household can open and edit; the agent reaches it
with no credentials of its own.

**That is worth saying in the write-up.** The rails assume an agent arrives
holding OAuth credentials for whatever it touches. A household agent does not:
the thing it needs to read is a family's own spreadsheet, and the family is not
registering a cloud project to let it in. It is the same shape of gap as the
WhatsApp one in section 7 — the capability exists, but only for someone who can
stand up infrastructure first.

### Deploying the bridge

In the Google Sheet:

1. **Extensions → Apps Script**
2. Delete whatever is in `Code.gs`, paste the contents of `apps-script/Code.gs`
3. **Deploy → New deployment** → gear icon → **Web app**
4. Execute as: **Me** · Who has access: **Anyone**
5. **Deploy** → Authorize access → pick your account → Advanced → Go to … →
   **Allow**
6. Copy the **Web app URL**. It ends in `/exec`.

Then set `SHEET_WEBAPP_URL` to that URL in your Render environment.

> "Who has access: Anyone" sounds alarming and is not: the script only answers
> calls carrying `SHEET_SECRET`, and it can only touch the one sheet it is bound
> to. Change `SECRET` in `Code.gs` and `SHEET_SECRET` to match if you want your
> own.

### Checking it before a recording

```bash
curl "https://<your-url>/admin/sheet/tabs" -H "x-admin-key: $ADMIN_KEY"
curl "https://<your-url>/admin/sheet/read?range=pantry!A1:F20" -H "x-admin-key: $ADMIN_KEY"
curl "https://<your-url>/admin/sheet/calls" -H "x-admin-key: $ADMIN_KEY"
```

`tabs` should list all nine. If it returns HTML instead of JSON, the deployment
is wrong — almost always "Who has access" not set to Anyone, or the `/dev` URL
copied instead of `/exec`.

`/admin/sheet/calls` logs every read and write with a timestamp. More run-log
evidence that the system produced rather than you wrote up afterwards.
