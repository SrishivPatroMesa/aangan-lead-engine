# Aangan inbound lead engine

Answers every inbound call (Vaani), extracts the details (Gemini), tiers the lead P1/P2/P3 by fixed rules in code, books P1 consultations in real calendars (Calendly), and puts every lead in HubSpot with an owner, a task and a due date. Nothing is lost: any step that can't run is parked and retried.

## Deployed (Supabase project `aangan-phone-agent`, Mumbai)

Base URL: `https://jrzwheloknetdvvzshhj.supabase.co/functions/v1/lead-engine`

| Route | Caller | Purpose |
|---|---|---|
| `POST /vaani/webhook` | Vaani, end of every call | Store call (idempotent on call id), then process |
| `POST /tools/lookup-caller` | Vaani, start of call | Returning caller? |
| `POST /tools/check-rules` | Vaani, mid-call | Provisional tier + what to say next |
| `POST /tools/available-slots` | Vaani, P1 only | Real Calendly times for the assigned designer |
| `POST /tools/book-consultation` | Vaani, P1 only | Book in Calendly; never "booked" without confirmation |
| `POST /calendly/webhook` | Calendly | Cancel / no-show → deal back to follow-up + task |
| `POST /process` | pg_cron, every minute | Process due calls, retry failures |
| `GET /health` | You | Which credentials are present, recovery count |
| `POST /simulate` | You | Test a call without a phone (marked simulated) |
| `POST /admin/hubspot/setup` | You, once | Create 23 deal properties + "Inbound enquiries" pipeline; list owners |
| `POST /admin/calendly/setup` | You, once | List event types; register Calendly webhook |
| `POST /admin/designers` | You | Upsert designers (HubSpot owner id, Calendly event type, areas) |
| `POST /admin/retry` | You | Re-run a call from the recovery queue |

All routes except the two webhooks require the shared secret (`x-webhook-secret` header or `?secret=`). Vaani may instead sign with `vaani_webhook_secret` (HMAC-SHA256 hex in `x-vaani-signature`). Calendly is verified by its own signature.

## Pipeline per call
received → extracted (Gemini, or dropped-call detection) → classified (code, versioned rules) → synced (HubSpot contact → deal or ticket → note → task) → done.
Missing credential → `waiting_credentials` (retried every 10 min, resumes where it stopped). Other errors → retry with backoff (2, 4, 8… min), after 6 attempts → `needs_attention`. Both show in the `recovery_queue` view.

## Go-live checklist
1. **Secrets** (Supabase SQL editor; stored in Vault):
   `select set_app_secret('gemini_api_key', '...');`
   `select set_app_secret('hubspot_token', '...');`  (private app; scopes: crm.objects.contacts/deals/owners read+write, tickets, crm.schemas.deals.write, crm.objects.deals.write)
   `select set_app_secret('calendly_token', '...');`  (paid plan; scopes incl. scheduled_events:write, webhooks:write)
2. `POST /admin/hubspot/setup` → note owner ids.
3. `POST /admin/calendly/setup` → note each designer's event type URI.
4. `POST /admin/designers` with the 4 designers (+ receptionists with role "receptionist").
5. Set `p3_owner_hubspot_id` and `escalation_owner_hubspot_id` in `studio_rules`.
6. Configure the Vaani agent from `vaani/system-prompt.md` and `vaani/tools.json` (replace `<WEBHOOK_SECRET>`).
7. Test: `/simulate`, then a real call; check HubSpot and `select * from recovery_queue`.

## Changing rules
Edit `studio_rules` (service areas, thresholds, SLA hours, pricing policy) and bump `rules_version`. No redeploy. Every classification stores the version used.

## Tests
`deno test tests/` — 31 tests: all 20 September calls + edge cases (dropped call, extraction failure, unknown area, caps, referral boost limits, no price in tool output, no "booked" without confirmation).
