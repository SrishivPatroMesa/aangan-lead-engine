// lead-engine: one function, many routes. See README for each route's contract.
import { json, db, config, rules, secret, sharedSecretOk, hmacHex, safeEqual, logEvent, isAfterHours, istLabel, e164, MissingCredential, Permanent } from "./lib.ts";
import { normalise } from "./extract.ts";
import { processRecord, assignDesigner } from "./pipeline.ts";
import { instruction, Fields } from "./rules.ts";
import * as H from "./hubspot.ts";
import * as C from "./calendly.ts";

const args = (b: any) => {
  const a = b?.arguments ?? b?.args ?? b?.parameters ?? b?.input ?? b?.function?.arguments ?? b;
  return typeof a === "string" ? (() => { try { return JSON.parse(a); } catch { return {}; } })() : (a ?? {});
};
const toolReply = (result: string, extra: Record<string, unknown> = {}) => json({ result, ...extra });

async function ingest(body: any, source: "vaani" | "simulated" | "replay") {
  const R = await rules();
  const n = normalise(body);
  const row: any = {
    vaani_call_id: n.vaani_call_id, source, direction: n.direction ?? "inbound", caller_phone: n.caller_phone, caller_name: n.caller_name,
    started_at: n.started_at, ended_at: n.ended_at, duration_sec: n.duration_sec, after_hours: isAfterHours(n.started_at, R),
    ended_reason: n.ended_reason, recording_url: n.recording_url, transcript: n.transcript, caller_turns: n.caller_turns,
    raw: body, status: "received", next_retry_at: new Date().toISOString(),
  };
  // Idempotent on the Vaani call id: a re-delivered webhook never creates a second record.
  const { data: existing } = await db().from("call_records").select("id,status").eq("vaani_call_id", n.vaani_call_id).maybeSingle();
  if (existing) return { id: existing.id, duplicate: true, status: existing.status };
  const { data, error } = await db().from("call_records").insert(row).select("*").single();
  if (error) {
    if (/duplicate key/i.test(error.message)) { const { data: d } = await db().from("call_records").select("id,status").eq("vaani_call_id", n.vaani_call_id).single(); return { id: d!.id, duplicate: true, status: d!.status }; }
    throw new Error(error.message);
  }
  if (n.cost_inr != null || n.cost_usd != null)
    await db().from("usage_costs").insert({ call_record_id: data.id, vendor: "vaani", units: n.duration_sec ?? 0, unit: "seconds", amount_inr: n.cost_inr ?? (n.cost_usd != null ? n.cost_usd * Number(R.cost_model?.usd_to_inr ?? 84) : null), detail: { currency: n.cost_inr != null ? "INR" : "USD", raw: n.cost_inr ?? n.cost_usd }, source: "actual" });
  else
    await db().from("usage_costs").insert({ call_record_id: data.id, vendor: "vaani", units: n.duration_sec ?? 0, unit: "seconds", amount_inr: null, source: "unavailable", detail: { note: "Vaani did not report cost in the webhook" } });
  await logEvent(data.id, "vaani", "webhook", "ok", { duration: n.duration_sec, caller_turns: n.caller_turns }, `vaani:${n.vaani_call_id}`);
  return { id: data.id, duplicate: false, record: data };
}

async function vaaniAuthorised(req: Request, raw: string, cfg: Record<string, string>) {
  if (sharedSecretOk(req, cfg)) return true;
  const signing = await secret("vaani_webhook_secret");
  if (!signing) return false;
  const sig = (req.headers.get("x-vaani-signature") ?? req.headers.get("x-webhook-signature") ?? req.headers.get("x-signature") ?? "").replace(/^sha256=/, "");
  if (!sig) return false;
  return safeEqual(sig, await hmacHex(signing, raw));
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const path = url.pathname.replace(/^.*\/lead-engine/, "") || "/";
  const raw = req.method === "POST" ? await req.text() : "";
  let body: any = {};
  try { body = raw ? JSON.parse(raw) : {}; } catch { return json({ error: "invalid JSON" }, 400); }
  const cfg = await config();

  try {
    // ---------- Calendly webhook (own signature)
    if (path === "/calendly/webhook") {
      const key = await secret("calendly_signing_key");
      const hdr = req.headers.get("calendly-webhook-signature") ?? "";
      const t = /t=([^,]+)/.exec(hdr)?.[1], v1 = /v1=([^,]+)/.exec(hdr)?.[1];
      if (!key || !t || !v1 || !safeEqual(v1, await hmacHex(key, `${t}.${raw}`))) return json({ error: "bad signature" }, 401);
      if (Math.abs(Date.now() / 1000 - Number(t)) > 300) return json({ error: "stale" }, 401);
      const ev = body.event, p = body.payload ?? {};
      const inviteeUri = p.uri ?? p.invitee ?? null;
      const { data: b } = await db().from("bookings_log").select("*").eq("calendly_invitee_uri", inviteeUri).order("created_at", { ascending: false }).limit(1);
      const booking = b?.[0];
      if (!booking) return json({ ok: true, note: "not a booking made by the agent" });
      const newStatus = ev === "invitee.canceled" ? "canceled" : ev === "invitee_no_show.created" ? "no_show" : null;
      if (newStatus) {
        await db().from("bookings_log").update({ status: newStatus, attended: newStatus === "no_show" ? false : booking.attended }).eq("id", booking.id);
        const { data: cr } = await db().from("call_records").select("id,hubspot_deal_id,hubspot_contact_id,assigned_owner_id").eq("vaani_call_id", booking.call_ref).maybeSingle();
        if (cr) {
          await db().from("call_records").update({ booking_status: newStatus }).eq("id", cr.id);
          if (cr.hubspot_deal_id) {
            const pipe = await H.pipelineInfo();
            await H.updateDeal(cr.hubspot_deal_id, { dealstage: pipe.stages.follow_up, booking_status: newStatus, next_action: newStatus === "no_show" ? "Missed consultation: call to reschedule" : "Consultation cancelled: call to rebook" });
            await H.createTask(newStatus === "no_show" ? "No-show: call to reschedule" : "Cancelled: call to rebook", `Calendly ${ev} for ${istLabel(booking.slot_start)}`, new Date(Date.now() + 24 * 3600e3).toISOString(), "HIGH", cr.assigned_owner_id, cr.hubspot_contact_id, cr.hubspot_deal_id, null);
          }
          await logEvent(cr.id, "calendly", ev, "ok", { booking: booking.id });
        }
      }
      return json({ ok: true });
    }

    // ---------- Vaani end-of-call webhook
    if (path === "/vaani/webhook") {
      if (!(await vaaniAuthorised(req, raw, cfg))) return json({ error: "unauthorised" }, 401);
      const r = await ingest(body, "vaani");
      if (!r.duplicate && r.record) {
        // @ts-ignore EdgeRuntime is available on Supabase
        EdgeRuntime.waitUntil(processRecord(r.record).catch(() => {}));
      }
      return json({ ok: true, call_record_id: r.id, duplicate: r.duplicate });
    }

    // Everything below needs the shared secret.
    if (!sharedSecretOk(req, cfg)) return json({ error: "unauthorised" }, 401);
    const R = await rules();

    if (path === "/health") {
      const { data: present } = await db().rpc("secrets_present");
      const { count: waiting } = await db().from("call_records").select("id", { count: "exact", head: true }).in("status", ["waiting_credentials", "needs_attention"]);
      const { count: designers } = await db().from("designers").select("id", { count: "exact", head: true }).eq("active", true);
      return json({ ok: true, secrets_present: present, hubspot_pipeline_ready: !!cfg.hubspot_pipeline, active_designers: designers, calls_in_recovery: waiting, pricing_policy: R.pricing_policy });
    }

    // ---------- Live tools the voice agent calls during the conversation
    if (path === "/tools/check-rules") {
      const f: Fields = args(body);
      const i = instruction(f, R);
      return toolReply(`Provisional tier ${i.provisional}. ${i.say}`, { provisional_tier: i.provisional });
    }
    if (path === "/tools/lookup-caller") {
      const a = args(body); const phone = e164(a.phone ?? a.caller_phone ?? a.from);
      if (!phone) return toolReply("No caller number available; treat as a new caller.");
      try {
        const c = await H.findContactByPhone(phone);
        if (!c) return toolReply("New caller: no record found.", { known: false });
        const first = c.properties?.firstname;
        return toolReply(`Returning caller${first ? ` named ${first}` : ""}. Greet them by name and ask whether this is about an existing project or something new.`, { known: true, first_name: first ?? null });
      } catch { return toolReply("Caller lookup unavailable right now; treat as a new caller and carry on."); }
    }
    if (path === "/tools/available-slots") {
      const a = args(body);
      const f: Fields = { location: a.location ?? null };
      const { designer_id } = await assignDesigner("P1", f, R, a.designer_id ?? null);
      if (!designer_id) return toolReply("No designer calendars are connected yet. Do not offer times. Say a designer will call back to fix a time.", { slots: [] });
      const { data: d } = await db().from("designers").select("name,calendly_event_type_uri").eq("id", designer_id).single();
      if (!d?.calendly_event_type_uri) return toolReply("This designer's calendar isn't connected. Do not offer times; say a designer will confirm a time by message.", { slots: [] });
      const start = a.preferred_date ? new Date(`${a.preferred_date}T09:00:00+05:30`) : new Date(Date.now() + 2 * 3600e3);
      const from = new Date(Math.max(start.getTime(), Date.now() + 15 * 60e3));
      const to = new Date(from.getTime() + Math.min(Number(R.booking_window_days ?? 7), 7) * 86400e3 - 60e3);
      try {
        const times = await C.availableTimes(d.calendly_event_type_uri, from.toISOString(), to.toISOString());
        const picked: string[] = []; const days = new Set<string>();
        for (const t of times) { const day = t.slice(0, 10); if (!days.has(day)) { picked.push(t); days.add(day); } if (picked.length === 3) break; }
        for (const t of times) { if (picked.length >= 3) break; if (!picked.includes(t)) picked.push(t); }
        if (!picked.length) return toolReply("No free consultation times in the next week. Do not invent times; say a designer will call to arrange one.", { slots: [] });
        const ref = a.call_id ?? `phone:${e164(a.phone) ?? "unknown"}`;
        await db().from("bookings_log").insert(picked.map((t) => ({ call_ref: ref, caller_phone: e164(a.phone), designer_id, slot_start: t, status: "offered" })));
        return toolReply(`Offer these times with ${d.name}: ${picked.map((t) => istLabel(t)).join("; ")}. When the caller picks one, call book_consultation with that start_time and designer_id.`, { designer_id, designer_name: d.name, slots: picked.map((t) => ({ start_time: t, label: istLabel(t) })) });
      } catch (e) {
        return toolReply("The calendar can't be reached right now. Do not offer times; say a designer will confirm a time by message.", { slots: [], error: (e as Error).message });
      }
    }
    if (path === "/tools/book-consultation") {
      const a = args(body);
      const ref = String(a.call_id ?? `phone:${e164(a.phone) ?? "unknown"}`);
      const email = String(a.email ?? "").trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return toolReply("Not booked: a valid email is needed for the calendar invite. Ask for it and spell it back.", { booked: false });
      if (!a.start_time || !a.designer_id || !a.name) return toolReply("Not booked: need name, start_time and designer_id from available_slots.", { booked: false });
      const { data: already } = await db().from("bookings_log").select("*").eq("call_ref", ref).eq("status", "confirmed").maybeSingle();
      if (already) return toolReply(`Already booked for ${istLabel(already.slot_start)}. Confirm that time; do not book again.`, { booked: true, start_time: already.slot_start });
      const { data: d } = await db().from("designers").select("name,calendly_event_type_uri").eq("id", a.designer_id).single();
      if (!d?.calendly_event_type_uri) return toolReply("Not booked: calendar not connected. Say a designer will confirm by message.", { booked: false });
      try {
        const r = await C.book(d.calendly_event_type_uri, a.start_time, a.name, email, e164(a.phone));
        if (!r.ok) {
          await db().from("bookings_log").insert({ call_ref: ref, caller_phone: e164(a.phone), designer_id: a.designer_id, slot_start: a.start_time, status: "failed", invitee_email: email, error: r.error });
          return toolReply("That time was just taken or couldn't be booked. Apologise, call available_slots again and offer the next time once. If that fails, say a designer will confirm by message.", { booked: false });
        }
        await db().from("bookings_log").insert({ call_ref: ref, caller_phone: e164(a.phone), designer_id: a.designer_id, slot_start: a.start_time, status: "confirmed", invitee_email: email, calendly_invitee_uri: r.invitee_uri, calendly_event_uri: r.event_uri });
        return toolReply(`Booked and confirmed: ${istLabel(a.start_time)} with ${d.name}. A calendar invite is going to ${email}. You may now tell the caller it is booked.`, { booked: true, start_time: a.start_time });
      } catch (e) {
        await db().from("bookings_log").insert({ call_ref: ref, caller_phone: e164(a.phone), designer_id: a.designer_id, slot_start: a.start_time, status: "failed", invitee_email: email, error: (e as Error).message });
        return toolReply("Booking system unavailable. Do not say it's booked. Say a designer will confirm the time by message today.", { booked: false });
      }
    }

    // ---------- Worker: process due records (pg_cron calls this every minute)
    if (path === "/process") {
      const { data: due, error } = await db().rpc("claim_due_calls", { p_limit: Number(url.searchParams.get("limit") ?? 10) });
      if (error) throw new Error(error.message);
      const results: Record<string, string> = {};
      for (const rec of due ?? []) results[rec.id] = await processRecord(rec);
      return json({ ok: true, processed: Object.keys(results).length, results });
    }

    // ---------- Testing without a phone: same pipeline, marked simulated
    if (path === "/simulate") {
      const r = await ingest(body, body.source === "replay" ? "replay" : "simulated");
      const outcome = r.duplicate ? r.status : await processRecord(r.record);
      const { data } = await db().from("call_records").select("id,tier,disposition,reasons,status,waiting_on,last_error,handoff_note").eq("id", r.id).single();
      return json({ ok: true, outcome, record: data });
    }

    // ---------- Admin / setup
    if (path === "/admin/hubspot/setup") return json(await H.setup(String(R.hubspot_plan ?? "free")));
    if (path === "/admin/hubspot/owners") return json(await H.owners());
    if (path === "/admin/calendly/setup") {
      const u = await C.me();
      const org = u.current_organization;
      const out: any = { user: u.name, organization: org, event_types: await C.eventTypes(org) };
      let key = await secret("calendly_signing_key");
      if (!key) { key = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, ""); await db().rpc("set_app_secret", { p_name: "calendly_signing_key", p_value: key }); }
      out.webhook = await C.subscribeWebhook(`${Deno.env.get("SUPABASE_URL")}/functions/v1/lead-engine/calendly/webhook`, org, key);
      return json(out);
    }
    if (path === "/admin/designers" && req.method === "POST") {
      const list = Array.isArray(body) ? body : body.designers ?? [];
      const rows = list.filter((d: any) => d?.name).map((d: any) => ({ name: String(d.name).trim(), email: d.email ?? null, role: d.role ?? "designer", hubspot_owner_id: d.hubspot_owner_id ? String(d.hubspot_owner_id) : null, calendly_event_type_uri: d.calendly_event_type_uri ?? null, areas: d.areas ?? [], specialities: d.specialities ?? [], active: d.active ?? true }));
      if (!rows.length) return json({ error: "send designers: [{ name, hubspot_owner_id?, calendly_event_type_uri?, areas?, role? }]" }, 400);
      const { data, error } = await db().from("designers").upsert(rows, { onConflict: "name" }).select("id,name,role,active,hubspot_owner_id");
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true, designers: data });
    }
    if (path === "/admin/retry" && req.method === "POST") {
      const id = body.call_record_id;
      const { data: cur } = await db().from("call_records").select("extraction,extraction_failed,tier").eq("id", id).single();
      const resume = !cur ? "received" : (cur.extraction == null && !cur.extraction_failed) ? "received" : !cur.tier ? "extracted" : "classified";
      await db().from("call_records").update({ status: resume, attempts: 0, next_retry_at: new Date().toISOString(), locked_until: null, last_error: null }).eq("id", id).in("status", ["needs_attention", "waiting_credentials"]);
      const { data: rec } = await db().from("call_records").select("*").eq("id", id).single();
      return json({ ok: true, outcome: rec ? await processRecord(rec) : "not found" });
    }
    return json({ error: "not found", path }, 404);
  } catch (e) {
    const err = e as Error;
    const status = err instanceof MissingCredential ? 503 : err instanceof Permanent ? 422 : 500;
    return json({ error: err.message }, status);
  }
});
