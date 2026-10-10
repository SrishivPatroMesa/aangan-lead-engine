// Per-call state machine: received -> extracted -> classified -> synced -> done.
// Every step is idempotent; failures retry with backoff; missing credentials park the call without losing it.
import { db, rules, logEvent, eventDone, MissingCredential, Permanent, istLabel, Rules } from "./lib.ts";
import { classify, Fields } from "./rules.ts";
import { geminiExtract } from "./extract.ts";
import * as H from "./hubspot.ts";

const MAX_ATTEMPTS = 6;

export async function assignDesigner(tier: string, f: Fields, R: Rules, preferredId?: string | null) {
  const fallback = R.default_owner_hubspot_id ?? null; // nobody's lead goes unowned
  if (tier === "SERVICE") return { designer_id: null, owner: R.escalation_owner_hubspot_id ?? fallback };
  if (tier === "P3") return { designer_id: null, owner: R.p3_owner_hubspot_id ?? fallback };
  const { data } = await db().from("designers").select("*").eq("active", true).eq("role", "designer");
  const list = data ?? [];
  if (!list.length) return { designer_id: null, owner: fallback };
  let chosen = preferredId ? list.find((d: any) => d.id === preferredId) : null;
  if (!chosen) {
    const loc = String(f.location ?? "").toLowerCase();
    const areaMatch = list.filter((d: any) => (d.areas ?? []).some((a: string) => loc.includes(a.toLowerCase())));
    const pool = areaMatch.length ? areaMatch : list;
    pool.sort((a: any, b: any) => Date.parse(a.last_assigned_at ?? "1970-01-01") - Date.parse(b.last_assigned_at ?? "1970-01-01"));
    chosen = pool[0];
  }
  await db().from("designers").update({ last_assigned_at: new Date().toISOString() }).eq("id", chosen.id);
  return { designer_id: chosen.id as string, owner: (chosen.hubspot_owner_id ?? fallback) as string | null, name: chosen.name as string };
}

function dealProps(rec: any, f: Fields, R: Rules, pipe: { id: string; stages: Record<string, string> }, ownerId: string | null) {
  const stage = rec.booking_status === "confirmed" ? "consultation_booked" : rec.tier === "P1" ? "new_enquiry" : rec.tier === "P2" ? "needs_review" : "follow_up";
  const who = f.caller_name ?? rec.caller_name ?? "Caller";
  const designer = rec.designer_name ? ` · ${rec.designer_name}` : "";
  return {
    dealname: `${who} – ${f.property_type ?? "interiors"}${f.location ? ", " + f.location : ""}${designer}`.slice(0, 200),
    pipeline: pipe.id, dealstage: pipe.stages[stage], hubspot_owner_id: ownerId,
    lead_priority: rec.tier, qualification_reasons: (rec.reasons ?? []).join("\n"), lead_disposition: rec.disposition,
    project_type: f.scope_size ?? (f.project_kind === "commercial" ? "office" : "unknown"),
    property_type: f.property_type, carpet_area_sqft: f.carpet_sqft, locality: f.location,
    target_completion: f.deadline_text, weeks_to_deadline: f.weeks_until_deadline, budget_stated: f.budget_text,
    decision_maker: f.decision_maker, lead_source_detail: f.referral_source,
    missing_information: (f.missing_information ?? []).join("\n"), call_summary: rec.summary, handoff_note: rec.handoff_note,
    inbound_call_id: rec.vaani_call_id, recording_url: rec.recording_url,
    booking_status: rec.booking_status ?? "none",
    next_action: rec.tier === "P1" ? (rec.booking_status === "confirmed" ? "Prepare for consultation" : "Call to book consultation") : rec.tier === "P2" ? "Review and decide" : "Follow up",
  };
}

function composeHandoff(rec: any, f: Fields, booking: any | null): string {
  const L: string[] = [];
  L.push(`${rec.tier} · ${rec.disposition.replace(/_/g, " ")}${rec.after_hours ? " · after hours" : ""}`);
  L.push(`${f.caller_name ?? rec.caller_name ?? "Caller"} · ${rec.caller_phone ?? "number withheld"} · ${istLabel(rec.started_at ?? rec.created_at)}`);
  if (rec.designer_name) L.push(`Assigned designer: ${rec.designer_name}`);
  if (booking) L.push(`Consultation: ${istLabel(booking.slot_start)} (confirmed in Calendly)`);
  if (f.handoff_note) L.push("", f.handoff_note);
  L.push("", `Why ${rec.tier}: ${(rec.reasons ?? []).join("; ")}`);
  if ((f.missing_information ?? []).length) L.push(`Ask on callback: ${(f.missing_information ?? []).join(", ")}`);
  if ((f.flags ?? []).length) L.push(`Flags: ${(f.flags ?? []).join("; ")}`);
  if ((f.pricing_asked_count ?? 0) > 0) L.push(`Asked about pricing ${f.pricing_asked_count}×: lead with it.`);
  return L.join("\n");
}

async function confirmedBooking(rec: any) {
  const { data } = await db().from("bookings_log").select("*").eq("status", "confirmed").eq("call_ref", rec.vaani_call_id).limit(1);
  if (data?.length) return data[0];
  if (!rec.caller_phone) return null;
  const since = new Date(Date.parse(rec.started_at ?? rec.created_at) - 3 * 3600e3).toISOString();
  const { data: d2 } = await db().from("bookings_log").select("*").eq("status", "confirmed").eq("caller_phone", rec.caller_phone).gte("created_at", since).order("created_at", { ascending: false }).limit(1);
  return d2?.[0] ?? null;
}

async function save(id: string, patch: Record<string, unknown>) {
  const { error } = await db().from("call_records").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", id);
  if (error) throw new Error(`save: ${error.message}`);
}

export async function processRecord(rec: any): Promise<string> {
  const R = await rules();
  try {
    // 1. Extract
    if (rec.status === "received" || (rec.status === "waiting_credentials" && !rec.extraction && !rec.extraction_failed)) {
      const dropped = !rec.transcript || rec.caller_turns === 0 || (rec.duration_sec ?? 0) < 8;
      let fields: Fields = {}, failed = false;
      if (!dropped) {
        const provided = rec.raw?.extraction ?? null;
        if (provided && (rec.source === "simulated" || rec.source === "replay")) fields = provided;
        else {
          try { fields = (await geminiExtract(rec.id, rec.transcript, String(rec.started_at ?? rec.created_at).slice(0, 10), R)).fields; }
          catch (e) { if (String((e as Error).message).startsWith("EXTRACTION_FAILED")) failed = true; else throw e; }
        }
      }
      const patch = {
        extraction: fields, extraction_failed: failed, status: "extracted", waiting_on: null,
        caller_name: fields.caller_name ?? rec.caller_name, email: fields.email ?? null, summary: fields.summary ?? (dropped ? "Call dropped before details were given" : null),
        pricing_asked: Number(fields.pricing_asked_count ?? 0), language: fields.language ?? null,
        platform_hints: { ...(rec.platform_hints ?? {}), dropped },
      };
      await save(rec.id, patch);
      rec = { ...rec, ...patch }; // keep the in-memory record identical to what was saved
      await logEvent(rec.id, "pipeline", "extract", "ok", { dropped, failed });
    }

    // 2. Classify + assign
    if (rec.status === "extracted" || (rec.status === "waiting_credentials" && rec.extraction && !rec.tier)) {
      const f: Fields = rec.extraction ?? {};
      const dropped = !!(rec.platform_hints?.dropped);
      const v = classify(f, R, { dropped, extractionFailed: !!rec.extraction_failed });
      const booking = await confirmedBooking(rec);
      const a = await assignDesigner(v.tier, f, R, booking?.designer_id ?? null);
      await db().from("qualifications").insert({ call_record_id: rec.id, tier: v.tier, disposition: v.disposition, reasons: v.reasons, gaps: v.gaps, rules_version: String(R.rules_version ?? "unversioned"), fields: f });
      rec = { ...rec, designer_name: (a as any).name ?? null, tier: v.tier, disposition: v.disposition, reasons: v.reasons, designer_id: a.designer_id, assigned_owner_id: a.owner, booking_status: booking ? "confirmed" : (v.tier === "P1" ? "none" : null), booking_id: booking?.id ?? null, status: "classified" };
      rec.handoff_note = composeHandoff(rec, f, booking);
      await save(rec.id, { tier: v.tier, disposition: v.disposition, reasons: v.reasons, designer_id: a.designer_id, assigned_owner_id: a.owner, booking_status: rec.booking_status, booking_id: rec.booking_id, handoff_note: rec.handoff_note, status: "classified" });
      await logEvent(rec.id, "pipeline", "classify", "ok", { tier: v.tier, disposition: v.disposition, owner: a.owner });
    }

    // 3. HubSpot sync (contact -> deal or ticket -> note -> task)
    if (rec.status === "classified" || (rec.status === "waiting_credentials" && rec.tier && !rec.processed_at)) {
      const f: Fields = rec.extraction ?? {};
      if (rec.designer_id && !rec.designer_name) {
        const { data: d } = await db().from("designers").select("name").eq("id", rec.designer_id).maybeSingle();
        rec.designer_name = d?.name ?? null;
      }
      if (!rec.hubspot_contact_id) {
        const c = await H.upsertContact(rec.caller_phone, f.caller_name ?? rec.caller_name, f.email ?? rec.email, null);
        rec.hubspot_contact_id = c.id; rec.is_existing_contact = c.existing;
        await save(rec.id, { hubspot_contact_id: c.id, is_existing_contact: c.existing });
        await logEvent(rec.id, "hubspot", "contact_upsert", "ok", c, `contact:${rec.id}`);
      }
      if (rec.tier === "SERVICE") {
        if (!rec.hubspot_ticket_id) {
          try {
            rec.hubspot_ticket_id = await H.createTicket(`Existing client: ${f.caller_name ?? "caller"} – ${f.location ?? "project"}`, rec.handoff_note, rec.assigned_owner_id, rec.hubspot_contact_id);
            await logEvent(rec.id, "hubspot", "ticket_create", "ok", { id: rec.hubspot_ticket_id }, `ticket:${rec.id}`);
          } catch (e) {
            // No ticket access (e.g. key without the tickets scope): the urgent task on the contact carries it instead.
            if (!(e instanceof Permanent)) throw e;
            rec.hubspot_ticket_id = "none";
            await logEvent(rec.id, "hubspot", "ticket_create", "skipped", `Ticket not created, urgent task used instead: ${(e as Error).message.slice(0, 200)}`, `ticket:${rec.id}`);
          }
          await save(rec.id, { hubspot_ticket_id: rec.hubspot_ticket_id });
        }
      } else if (!rec.hubspot_deal_id) {
        const pipe = await H.pipelineInfo();
        const existing = await H.findDealByCall(rec.vaani_call_id);
        rec.hubspot_deal_id = existing ?? await H.createDeal(dealProps(rec, f, R, pipe, rec.assigned_owner_id), rec.hubspot_contact_id);
        await save(rec.id, { hubspot_deal_id: rec.hubspot_deal_id });
        await logEvent(rec.id, "hubspot", "deal_create", "ok", { id: rec.hubspot_deal_id, reused: !!existing }, `deal:${rec.id}`);
      }
      if (!(await eventDone(rec.id, `note:${rec.id}`))) {
        const detail = [["Property", f.property_type], ["Carpet area", f.carpet_sqft ? `${f.carpet_sqft} sq ft` : null], ["Scope", f.scope_summary], ["Current state", f.current_state],
          ["Timeline", f.deadline_text], ["Decision-maker", f.decision_maker], ["Budget stated", f.budget_text], ["How they found us", f.referral_source],
          ["Email", f.email ?? rec.email], ["Consultation preference", f.consultation_preference], ["Recording", rec.recording_url], ["Call ID", rec.vaani_call_id]]
          .filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`).join("\n");
        const body = `${rec.handoff_note}\n\n— Details —\n${detail}\n\n— Call transcript —\n${(rec.transcript ?? "(none)").slice(0, 20000)}`.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/\n/g, "<br>");
        const ticketRef = rec.hubspot_ticket_id && rec.hubspot_ticket_id !== "none" ? rec.hubspot_ticket_id : null;
        const id = await H.createNote(body, rec.hubspot_contact_id, rec.hubspot_deal_id ?? null, ticketRef);
        await logEvent(rec.id, "hubspot", "note_create", "ok", { id }, `note:${rec.id}`);
      }
      if (!rec.hubspot_task_id) {
        const sla = R.sla_hours ?? { P1: 2, P2: 24, P3: 72, SERVICE: 0.25 };
        const due = new Date(Date.now() + Number(sla[rec.tier] ?? 24) * 3600e3).toISOString();
        const subj = rec.tier === "SERVICE" ? "URGENT: call back existing client"
          : rec.tier === "P1" ? (rec.booking_status === "confirmed" ? "Prepare for booked consultation" : "Call to book consultation (P1)")
          : rec.tier === "P2" ? "Review enquiry and decide (P2)" : "Follow up enquiry (P3)";
        const prio = rec.tier === "SERVICE" || rec.tier === "P1" ? "HIGH" : rec.tier === "P2" ? "MEDIUM" : "LOW";
        const subject = rec.designer_name ? `${subj} → ${rec.designer_name}` : subj;
        rec.hubspot_task_id = await H.createTask(subject, rec.handoff_note, due, prio, rec.assigned_owner_id, rec.hubspot_contact_id, rec.hubspot_deal_id ?? null, rec.hubspot_ticket_id && rec.hubspot_ticket_id !== "none" ? rec.hubspot_ticket_id : null);
        await save(rec.id, { hubspot_task_id: rec.hubspot_task_id });
        if (rec.hubspot_deal_id) await H.updateDeal(rec.hubspot_deal_id, { next_action_due: due.slice(0, 10) });
        await logEvent(rec.id, "hubspot", "task_create", "ok", { id: rec.hubspot_task_id, due }, `task:${rec.id}`);
      }
      rec.status = "synced";
      await save(rec.id, { status: "synced", waiting_on: null });
    }

    // 4. Link a booking made during the call to the deal, then finish
    if (rec.status === "synced") {
      const booking = await confirmedBooking(rec);
      if (booking && rec.hubspot_deal_id && !(await eventDone(rec.id, `booking:${booking.id}`))) {
        const pipe = await H.pipelineInfo();
        await H.updateDeal(rec.hubspot_deal_id, { dealstage: pipe.stages.consultation_booked, booking_status: "confirmed", consultation_time: booking.slot_start, calendly_event_uri: booking.calendly_event_uri });
        await H.createNote(`Consultation booked for ${istLabel(booking.slot_start)} (confirmed in Calendly).`, rec.hubspot_contact_id, rec.hubspot_deal_id, null);
        await logEvent(rec.id, "hubspot", "booking_link", "ok", { booking: booking.id }, `booking:${booking.id}`);
        await save(rec.id, { booking_status: "confirmed", booking_id: booking.id });
      }
      await save(rec.id, { status: "done", processed_at: new Date().toISOString(), last_error: null, locked_until: null });
      await logEvent(rec.id, "pipeline", "done", "ok");
      return "done";
    }
    return rec.status;
  } catch (e) {
    const err = e as Error;
    if (err instanceof MissingCredential) {
      await save(rec.id, { status: "waiting_credentials", waiting_on: err.what, last_error: err.message, next_retry_at: new Date(Date.now() + 10 * 60e3).toISOString(), locked_until: null });
      await logEvent(rec.id, "pipeline", "wait", "waiting_credentials", err.what);
      return "waiting_credentials";
    }
    const attempts = (rec.attempts ?? 0) + 1;
    const permanent = err instanceof Permanent;
    const giveUp = permanent || attempts >= MAX_ATTEMPTS;
    await save(rec.id, {
      attempts, last_error: err.message.slice(0, 1000), locked_until: null,
      status: giveUp ? "needs_attention" : rec.status,
      next_retry_at: giveUp ? null : new Date(Date.now() + Math.min(2 ** attempts, 60) * 60e3).toISOString(),
    });
    await logEvent(rec.id, "pipeline", "error", "error", err.message.slice(0, 1000), undefined, attempts);
    return giveUp ? "needs_attention" : "retrying";
  }
}
