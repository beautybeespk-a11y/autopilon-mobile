# Phase 5 — WhatsApp Business Platform Integration

## Read this before testing — the setup burden, told straight
Like Meta Ads, this cannot be tested just by adding a key. Two things make
it more involved than Meta Ads specifically: WhatsApp Cloud API has **no
OAuth redirect dialog** (you generate a token manually in Meta's dashboard),
and Meta must be able to **reach your webhook from the internet** — which
your Codespace's forwarded URL provides, but only while that Codespace is
running.

### Setup steps
1. In the same Meta App from Phase 4 (or a new one), add the **WhatsApp**
   product.
2. Meta gives you a **test phone number** for free during development —
   good enough for this. Note its **phone_number_id** and the **WhatsApp
   Business Account (WABA) ID**, both shown on the WhatsApp → API Setup page.
3. Generate a **System User access token** with `whatsapp_business_messaging`
   permission (Business Settings → System Users → your app → Generate
   token). Unlike Meta Ads' user tokens, this does not expire after ~60 days
   in the same way — but it can still be revoked, so treat it as a secret.
4. Under WhatsApp → Configuration, set your **Webhook URL** to
   `https://<your-codespace-url>/api/integrations/whatsapp/webhook` and a
   **Verify Token** of your choosing (any string — just make it match
   `WHATSAPP_VERIFY_TOKEN` in your `.env`).
5. Subscribe the webhook to the `messages` field.
6. Set env vars: `WHATSAPP_VERIFY_TOKEN` (whatever you chose in step 4).
   `META_APP_SECRET` is reused from Phase 4 — WhatsApp webhooks are signed
   with the same App Secret as the rest of the Meta App.
7. In the app: **Integrations → WhatsApp Business → Connect**, paste in the
   access token + phone_number_id (+ WABA id, optional) from step 3.

### Known friction, same honesty as Phase 4
- **Test numbers can only message phone numbers you've explicitly added as
  testers** in Meta's dashboard (WhatsApp → API Setup → "To" recipient
  list), until you go through Business Verification for a real production
  number. This is a Meta requirement, not a limitation of this build.
- Outside a 24-hour window since a customer last messaged you, WhatsApp
  requires a **pre-approved message template** to reach them first
  (`send_template_message` exists for this) — you can't just send free-form
  text to someone who hasn't messaged you recently.
- If your Codespace's URL changes, the Webhook URL in Meta's dashboard needs
  updating to match, same as the Meta Ads redirect URI in Phase 4.

## Architecture summary
No changes to the Orchestrator's execution model — WhatsApp is simply
another *client* of the same `handleIncomingMessage` service web chat uses.
That's not just a description — it's an actual refactor made in this phase:
the message-handling logic (system prompt building, history enrichment,
calling the Orchestrator, persisting the reply) was pulled out of
`routes/chat.js` into `server/orchestrator/conversationService.js` so both
the web route and the WhatsApp webhook call the exact same function, per the
phase's explicit "do not duplicate business logic" requirement.

Flow: WhatsApp → webhook (signature-verified, deduped) → resolve which user
owns that phone_number_id → resolve/create the linked web conversation →
`handleIncomingMessage()` (same Orchestrator path as web chat) → reply sent
back via the WhatsApp Cloud API → logged.

## Files added
- `integrations/whatsapp/{api,webhook,validation,index}.js` — Cloud API
  senders, payload parsing, HMAC signature verification, integration
  definition
- `integrations/whatsapp/services/{conversationResolver,ownerLookup}.js` —
  conversation-linking and per-webhook-event user resolution
- `orchestrator/conversationService.js` — the shared message-handling logic
  (new; also now used by `routes/chat.js`, which lost its duplicate copy)
- `routes/whatsappWebhook.js` (public) and `routes/whatsappAuth.js`
  (authenticated) — connect/disconnect/status/settings + the webhook itself
- `tools/whatsapp/messaging.js` — 8 tools

## Database changes
Connection state (token, phone_number_id, WABA id, business name, settings)
reuses the existing `integrations` table (provider='whatsapp'), same pattern
as Meta Ads — no separate `whatsapp_accounts` table. Added:
`whatsapp_conversations` (links a contact phone to the existing
`conversations` table — this is *how* WhatsApp and web chat share one
history, not just a claim), `whatsapp_messages` (delivery/status metadata
per message), `webhook_events` (a webhook redelivery collides on primary
key here and is silently skipped — Meta does redeliver the same event, so
this dedup is not optional).

## API endpoints
- `GET /api/integrations/whatsapp/webhook` — Meta's verification handshake
- `POST /api/integrations/whatsapp/webhook` — incoming messages/statuses
  (public, HMAC-verified, not behind session auth — see the mount-order fix
  below)
- `POST /api/integrations/whatsapp/connect` — verifies the token against the
  real API before saving, never trusts an unchecked token
- `POST /api/integrations/whatsapp/disconnect`
- `GET /api/integrations/whatsapp/status`
- `GET` / `PATCH /api/integrations/whatsapp/settings` — auto-reply, business
  hours, default agent, greeting/away messages, language, notifications

## A real bug I caught and fixed before you'd ever see it
The webhook and the authenticated connect/disconnect/settings routes are
mounted at the same URL prefix. My first pass mounted the auth-gated router
*first* — since it applies `requireAuth` unconditionally to its entire
router, every request to that prefix (including Meta's webhook calls, which
have no session cookie) would have been rejected with 401 before ever
reaching signature verification. Caught this by tracing Express's router
mounting order, not by running it — fixed by mounting the webhook router
first, so unmatched paths fall through to the auth-gated router afterward
and `/webhook` itself never reaches it.

## Tools (8, per spec)
`send_whatsapp_message`, `reply_whatsapp_message`, `send_image`,
`send_document`, `send_template_message` — all **require confirmation**,
since each contacts a real person on a real phone outside the app.
`list_whatsapp_conversations`, `get_whatsapp_conversation` — reads, no
confirmation. `mark_message_read` — no confirmation (a read receipt has no
real-world consequence worth pausing for).

## Message type handling
Text, image, document, location are handled distinctly; audio/video/sticker
are logged but represented generically; anything else Meta ever sends comes
through as `type: "unsupported"` and is logged without ever throwing — the
parser has no code path that crashes on an unrecognized shape.

## Performance / duplicate prevention
The webhook responds `200` immediately after signature verification and
dedup, then processes (calls the AI, sends the reply) asynchronously —
Meta expects a fast ack and will retry aggressively otherwise, which would
compound with the dedup table already needed for its actual redeliveries.
There's no real job queue here (no Redis/BullMQ in this stack) — it's a
fire-and-forget async function, which is honest about being a simplification
appropriate for personal/testing scale, not a production-grade queue.

## Test results — same honesty note as every phase
Every file passes `node --check`. **None of this has been run** — no
network in this sandbox to install dependencies, boot the server, or
receive a real webhook call. This phase specifically cannot be smoke-tested
at all the way Phases 1-3 could with a missing-key fallback — webhook
delivery requires Meta's servers actually reaching your Codespace, so the
very first real test only happens once you've completed the setup steps
above. Please actually walk through: connect, send yourself a WhatsApp
message to your test number, confirm it appears in this app's chat history,
confirm the AI's reply arrives back on WhatsApp, and confirm that same
conversation is visible if you open it from the web Chat page too.

## Security notes
- Webhook signature verification (`X-Hub-Signature-256`, HMAC-SHA256
  against `META_APP_SECRET`) happens before any payload is trusted or
  processed — an unsigned or forged request never reaches parsing.
- Tokens are stored server-side only (in the same `integrations` table
  pattern as Meta Ads), never sent to the frontend.
- Every WhatsApp tool re-validates the connection via `requireValidToken`
  at execution time, not just at connect time.
- The connect endpoint verifies the pasted token against the real API
  before saving it — a bad or revoked token is rejected immediately rather
  than silently stored.

## Known issues / simplifications, disclosed rather than hidden
- No true async job queue — see Performance note above.
- WhatsApp "settings" (business hours, auto-reply, away message) are stored
  and retrievable via API but **not yet enforced** anywhere in the message
  flow — the webhook always processes and replies immediately regardless of
  business hours. Wiring that check into `processWebhookEvents` is a small,
  contained follow-up.
- No web UI was built for the WhatsApp settings themselves (greeting/away
  message/etc.) — only the connect form. The API exists; the settings page
  doesn't yet.

## Production readiness
Solid architecturally (proven pattern for a third time now — search
providers, Meta OAuth, and now a webhook-driven channel, all without
touching the Orchestrator), but explicitly **not** production-ready as-is:
the fire-and-forget processing, the settings-not-enforced gap, and the
Codespace-URL-must-match-webhook-URL fragility are all things to resolve
before real customers depend on it. Fine for personal testing today.

## Future improvements
Telegram/Slack/Discord/Teams would each follow this exact shape: a webhook
or polling endpoint, a conversation resolver into the same `conversations`
table, and a tools file — the Orchestrator still never changes.
