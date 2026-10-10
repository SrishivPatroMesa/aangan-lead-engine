// HubSpot: contacts, deals, tickets, notes, tasks, setup. HubSpot is the system of record for people and deals.
import { secret, fetchJson, MissingCredential, Permanent, config, db } from "./lib.ts";

const BASE = "https://api.hubapi.com";
async function hs(method: string, path: string, body?: unknown) {
  const token = await secret("hubspot_token");
  if (!token) throw new MissingCredential("hubspot_token");
  const r = await fetchJson(`${BASE}${path}`, {
    method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (r.status === 401 || r.status === 403) {
    const msg = JSON.stringify(r.body).slice(0, 300);
    if (/scope|permission/i.test(msg)) throw new Permanent(`HubSpot token lacks a scope: ${msg}`);
    throw new MissingCredential("hubspot_token (rejected)");
  }
  if (r.status === 429 || r.status >= 500) throw new Error(`HubSpot ${r.status} on ${path}`);
  return r;
}
const ok = (r: { status: number; body: any }, what: string) => {
  if (r.status >= 200 && r.status < 300) return r.body;
  throw new Permanent(`HubSpot ${what} failed (${r.status}): ${JSON.stringify(r.body).slice(0, 400)}`);
};

// Association type ids (HUBSPOT_DEFINED)
const A = { deal_contact: 3, ticket_contact: 16, note_contact: 202, note_deal: 214, note_ticket: 228, task_contact: 204, task_deal: 216, task_ticket: 230 };
const assoc = (id: string, typeId: number) => ({ to: { id }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: typeId }] });

export async function findContactByPhone(phone: string): Promise<any | null> {
  const props = ["firstname", "lastname", "email", "phone", "mobilephone", "hubspot_owner_id"];
  const digits = phone.replace(/\D/g, "");
  const local = digits.slice(-10);
  const r = ok(await hs("POST", "/crm/v3/objects/contacts/search", {
    filterGroups: [
      { filters: [{ propertyName: "phone", operator: "EQ", value: phone }] },
      { filters: [{ propertyName: "mobilephone", operator: "EQ", value: phone }] },
      { filters: [{ propertyName: "phone", operator: "CONTAINS_TOKEN", value: `*${local}` }] },
    ],
    properties: props, limit: 5,
  }), "contact search");
  const hit = (r.results ?? []).find((c: any) => [c.properties?.phone, c.properties?.mobilephone].some((p: string) => p && p.replace(/\D/g, "").endsWith(local)));
  return hit ?? null;
}

export async function upsertContact(phone: string | null, name: string | null, email: string | null, existingId: string | null) {
  const [firstname, ...rest] = (name ?? "").trim().split(/\s+/);
  if (existingId) return { id: existingId, existing: true };
  let found = phone ? await findContactByPhone(phone) : null;
  if (!found && email) {
    const r = ok(await hs("POST", "/crm/v3/objects/contacts/search", { filterGroups: [{ filters: [{ propertyName: "email", operator: "EQ", value: email }] }], properties: ["email"], limit: 1 }), "email search");
    found = r.results?.[0] ?? null;
  }
  if (found) {
    // Fill only empty fields; never overwrite what a person has entered.
    const p = found.properties ?? {};
    const patch: Record<string, string> = {};
    if (!p.firstname && firstname) patch.firstname = firstname;
    if (!p.lastname && rest.length) patch.lastname = rest.join(" ");
    if (!p.email && email) patch.email = email;
    if (!p.phone && phone) patch.phone = phone;
    if (Object.keys(patch).length) ok(await hs("PATCH", `/crm/v3/objects/contacts/${found.id}`, { properties: patch }), "contact patch");
    return { id: String(found.id), existing: true };
  }
  const props: Record<string, string> = { lifecyclestage: "lead" };
  if (phone) props.phone = phone;
  if (firstname) props.firstname = firstname; else props.firstname = "Caller";
  if (rest.length) props.lastname = rest.join(" ");
  if (email) props.email = email;
  let r = await hs("POST", "/crm/v3/objects/contacts", { properties: props });
  if (r.status === 409 && email) { delete props.email; r = await hs("POST", "/crm/v3/objects/contacts", { properties: props }); }
  const c = ok(r, "contact create");
  return { id: String(c.id), existing: false };
}

export async function findDealByCall(callId: string): Promise<string | null> {
  if (!(await hasDealProp("inbound_call_id"))) return null;
  const r = await hs("POST", "/crm/v3/objects/deals/search", { filterGroups: [{ filters: [{ propertyName: "inbound_call_id", operator: "EQ", value: callId }] }], properties: ["dealname"], limit: 1 });
  if (r.status === 400) return null; // property not created yet; setup will report it
  const b = ok(r, "deal search");
  return b.results?.[0]?.id ? String(b.results[0].id) : null;
}

export async function pipelineInfo(): Promise<{ id: string; stages: Record<string, string> }> {
  const cfg = await config();
  if (!cfg.hubspot_pipeline) throw new MissingCredential("hubspot_setup (run /admin/hubspot/setup)");
  return JSON.parse(cfg.hubspot_pipeline);
}

// Only send properties that exist in this HubSpot account (free plan has 10 custom fields).
const STANDARD = new Set(["dealname", "pipeline", "dealstage", "hubspot_owner_id", "amount", "closedate", "description"]);
async function allowed(): Promise<Set<string>> {
  const cfg = await config();
  let custom: string[] = [];
  try { custom = JSON.parse(cfg.hubspot_deal_props ?? "[]"); } catch { custom = []; }
  return new Set([...STANDARD, ...custom]);
}
export async function hasDealProp(name: string) { return (await allowed()).has(name); }

export async function createDeal(props: Record<string, unknown>, contactId: string) {
  const ok2 = await allowed();
  const clean = Object.fromEntries(Object.entries(props).filter(([k, v]) => ok2.has(k) && v !== null && v !== undefined && v !== "").map(([k, v]) => [k, String(v)]));
  return String(ok(await hs("POST", "/crm/v3/objects/deals", { properties: clean, associations: [assoc(contactId, A.deal_contact)] }), "deal create").id);
}
export async function updateDeal(id: string, props: Record<string, unknown>) {
  const ok2 = await allowed();
  const clean = Object.fromEntries(Object.entries(props).filter(([k, v]) => ok2.has(k) && v !== undefined).map(([k, v]) => [k, v === null ? "" : String(v)]));
  if (!Object.keys(clean).length) return;
  ok(await hs("PATCH", `/crm/v3/objects/deals/${id}`, { properties: clean }), "deal update");
}
export async function createTicket(subject: string, content: string, ownerId: string | null, contactId: string) {
  const props: Record<string, string> = { subject, content, hs_pipeline: "0", hs_pipeline_stage: "1", hs_ticket_priority: "HIGH" };
  if (ownerId) props.hubspot_owner_id = ownerId;
  return String(ok(await hs("POST", "/crm/v3/objects/tickets", { properties: props, associations: [assoc(contactId, A.ticket_contact)] }), "ticket create").id);
}
export async function createNote(body: string, contactId: string, dealId: string | null, ticketId: string | null) {
  const associations = [assoc(contactId, A.note_contact)];
  if (dealId) associations.push(assoc(dealId, A.note_deal));
  if (ticketId) associations.push(assoc(ticketId, A.note_ticket));
  return String(ok(await hs("POST", "/crm/v3/objects/notes", { properties: { hs_timestamp: new Date().toISOString(), hs_note_body: body }, associations }), "note create").id);
}
export async function createTask(subject: string, body: string, dueIso: string, priority: "HIGH" | "MEDIUM" | "LOW", ownerId: string | null, contactId: string, dealId: string | null, ticketId: string | null) {
  const props: Record<string, string> = { hs_timestamp: dueIso, hs_task_subject: subject, hs_task_body: body, hs_task_status: "NOT_STARTED", hs_task_priority: priority, hs_task_type: "CALL" };
  if (ownerId) props.hubspot_owner_id = ownerId;
  const associations = [assoc(contactId, A.task_contact)];
  if (dealId) associations.push(assoc(dealId, A.task_deal));
  if (ticketId) associations.push(assoc(ticketId, A.task_ticket));
  return String(ok(await hs("POST", "/crm/v3/objects/tasks", { properties: props, associations }), "task create").id);
}

// ---- one-time setup: property group, properties, pipeline, owners
const DEAL_PROPS: Array<[string, string, string, string, string[]?]> = [
  ["lead_priority", "Lead priority", "enumeration", "select", ["P1", "P2", "P3"]],
  ["qualification_reasons", "Qualification reasons", "string", "textarea"],
  ["lead_disposition", "Lead disposition", "string", "text"],
  ["project_type", "Project type", "enumeration", "select", ["full_home", "floor", "multi_room", "single_room", "office", "unknown"]],
  ["property_type", "Property type", "string", "text"],
  ["carpet_area_sqft", "Carpet area (sq ft)", "number", "number"],
  ["locality", "Locality", "string", "text"],
  ["target_completion", "Target completion (as said)", "string", "text"],
  ["weeks_to_deadline", "Weeks to deadline", "number", "number"],
  ["budget_stated", "Budget stated by caller", "string", "text"],
  ["decision_maker", "Decision-maker", "string", "text"],
  ["lead_source_detail", "How they found us", "string", "text"],
  ["missing_information", "Missing information", "string", "textarea"],
  ["call_summary", "Call summary", "string", "textarea"],
  ["handoff_note", "Designer handoff note", "string", "textarea"],
  ["inbound_call_id", "Inbound call ID", "string", "text"],
  ["recording_url", "Call recording", "string", "text"],
  ["consultation_time", "Consultation time", "datetime", "date"],
  ["calendly_event_uri", "Calendly event", "string", "text"],
  ["booking_status", "Booking status", "enumeration", "select", ["none", "offered", "confirmed", "failed", "canceled", "no_show", "held"]],
  ["next_action", "Next action", "string", "text"],
  ["next_action_due", "Next action due", "date", "date"],
  ["lost_reason_detail", "Lost reason", "string", "text"],
];
const STAGES: Array<[string, string, string, boolean]> = [
  ["new_enquiry", "New enquiry", "0.1", false], ["needs_review", "Needs review (P2)", "0.1", false], ["follow_up", "Follow-up (P3)", "0.05", false],
  ["consultation_booked", "Consultation booked", "0.3", false], ["consultation_held", "Consultation held", "0.5", false],
  ["proposal_sent", "Proposal sent", "0.7", false], ["won", "Won", "1.0", true], ["lost", "Lost", "0.0", true],
];

// The 10 fields kept on the free plan; everything else goes into the deal note.
const FREE_PROPS = ["lead_priority", "qualification_reasons", "locality", "project_type", "carpet_area_sqft", "target_completion", "booking_status", "next_action", "handoff_note", "inbound_call_id"];
const OPEN_KEYS = ["new_enquiry", "needs_review", "follow_up", "consultation_booked", "consultation_held", "proposal_sent"];

export async function setup(plan: string) {
  const free = plan !== "paid";
  const report: any = { plan: free ? "free" : "paid", properties: { created: [], existed: [], failed: [] } };
  const g = await hs("POST", "/crm/v3/properties/deals/groups", { name: "inbound_lead", label: "Inbound lead", displayOrder: 1 });
  report.group = g.status === 201 ? "created" : g.status === 409 ? "existed" : `failed ${g.status}`;
  const wanted = DEAL_PROPS.filter(([name]) => !free || FREE_PROPS.includes(name));
  for (const [name, label, type, fieldType, opts] of wanted) {
    const body: any = { name, label, type, fieldType, groupName: "inbound_lead" };
    if (opts) body.options = opts.map((o, i) => ({ label: o, value: o, displayOrder: i }));
    const r = await hs("POST", "/crm/v3/properties/deals", body);
    if (r.status === 201) report.properties.created.push(name);
    else if (r.status === 409) report.properties.existed.push(name);
    else report.properties.failed.push({ name, status: r.status, error: JSON.stringify(r.body).slice(0, 200) });
  }
  // Record which of our properties really exist, so the engine never sends one that doesn't.
  const all = ok(await hs("GET", "/crm/v3/properties/deals?archived=false"), "list properties");
  const ours = new Set(DEAL_PROPS.map(([n]) => n));
  const present = (all.results ?? []).map((p: any) => p.name).filter((n: string) => ours.has(n));
  await db().from("app_config").upsert({ key: "hubspot_deal_props", value: JSON.stringify(present), updated_at: new Date().toISOString() });
  report.properties.usable = present;

  const cfg = await config();
  if (cfg.hubspot_pipeline) { report.pipeline = { existed: JSON.parse(cfg.hubspot_pipeline) }; }
  else {
    let info: { id: string; stages: Record<string, string> } | null = null;
    if (!free) {
      const r = await hs("POST", "/crm/v3/pipelines/deals", {
        label: "Inbound enquiries", displayOrder: 1,
        stages: STAGES.map(([, label, p, closed], i) => ({ label, displayOrder: i, metadata: closed ? { probability: p, isClosed: "true" } : { probability: p } })),
      });
      if (r.status === 201) {
        const stages: Record<string, string> = {};
        for (const [key, label] of STAGES) stages[key] = String(r.body.stages.find((s: any) => s.label === label)?.id);
        info = { id: String(r.body.id), stages };
        report.pipeline_mode = "created";
      } else report.pipeline_create_failed = `${r.status}: ${JSON.stringify(r.body).slice(0, 200)}`;
    }
    if (!info) info = await adoptDefaultPipeline(report);
    await db().from("app_config").upsert({ key: "hubspot_pipeline", value: JSON.stringify(info), updated_at: new Date().toISOString() });
    report.pipeline = info;
  }
  report.owners = await owners();
  return report;
}

// Free plan: reuse the one built-in pipeline, rename its stages to ours, add any missing open stage.
async function adoptDefaultPipeline(report: any) {
  const b = ok(await hs("GET", "/crm/v3/pipelines/deals"), "list pipelines");
  const pipe = (b.results ?? []).find((p: any) => p.id === "default") ?? b.results?.[0];
  if (!pipe) throw new Permanent("No deal pipeline found in HubSpot");
  const stages = [...pipe.stages].sort((a: any, b: any) => a.displayOrder - b.displayOrder);
  const isClosed = (s: any) => String(s.metadata?.isClosed) === "true";
  const open = stages.filter((s: any) => !isClosed(s));
  const won = stages.find((s: any) => isClosed(s) && Number(s.metadata?.probability) >= 1);
  const lost = stages.find((s: any) => isClosed(s) && Number(s.metadata?.probability) <= 0);
  if (!won || !lost) throw new Permanent("Built-in pipeline is missing a Won or Lost stage");
  const map: Record<string, string> = { won: String(won.id), lost: String(lost.id) };
  const labels: Record<string, string> = Object.fromEntries(STAGES.map(([k, l]) => [k, l]));
  const probs: Record<string, string> = Object.fromEntries(STAGES.map(([k, , p]) => [k, p]));
  report.stage_changes = [];
  for (let i = 0; i < OPEN_KEYS.length; i++) {
    const key = OPEN_KEYS[i];
    if (open[i]) {
      map[key] = String(open[i].id);
      const r = await hs("PATCH", `/crm/v3/pipelines/deals/${pipe.id}/stages/${open[i].id}`, { label: labels[key], displayOrder: i, metadata: { probability: probs[key] } });
      report.stage_changes.push({ key, renamed: r.status < 300 ? "ok" : `failed ${r.status}` });
    } else {
      const r = await hs("POST", `/crm/v3/pipelines/deals/${pipe.id}/stages`, { label: labels[key], displayOrder: i, metadata: { probability: probs[key] } });
      if (r.status < 300) { map[key] = String(r.body.id); report.stage_changes.push({ key, added: "ok" }); }
      else { map[key] = String(open[open.length - 1].id); report.stage_changes.push({ key, added: `failed ${r.status}; mapped to last open stage` }); }
    }
  }
  report.pipeline_mode = "reused built-in pipeline";
  return { id: String(pipe.id), stages: map };
}

export async function owners() {
  const b = ok(await hs("GET", "/crm/v3/owners?limit=100"), "owners");
  return (b.results ?? []).map((o: any) => ({ id: String(o.id), name: [o.firstName, o.lastName].filter(Boolean).join(" "), email: o.email }));
}
