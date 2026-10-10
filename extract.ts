// Vaani payload normalisation (tolerant: Vaani's exact schema depends on which Vaani) + Gemini extraction.
import { db, secret, logEvent, fetchJson, MissingCredential, Rules, e164 } from "./lib.ts";
import type { Fields } from "./rules.ts";

const pick = (o: any, paths: string[]): any => {
  for (const p of paths) {
    const v = p.split(".").reduce((a: any, k) => (a == null ? undefined : a[k]), o);
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return null;
};

export type NormalisedCall = {
  vaani_call_id: string; direction: string | null; caller_phone: string | null; started_at: string | null; ended_at: string | null;
  duration_sec: number | null; ended_reason: string | null; recording_url: string | null; transcript: string | null;
  caller_turns: number; cost_inr: number | null; cost_usd: number | null; platform_extraction: any; caller_name: string | null;
};

function transcriptText(t: any): { text: string | null; callerTurns: number } {
  if (!t) return { text: null, callerTurns: 0 };
  if (typeof t === "string") {
    const turns = t.split(/\n/).filter((l) => /^(user|caller|customer|human)\s*:/i.test(l.trim())).length;
    return { text: t, callerTurns: turns || (t.trim() ? 1 : 0) };
  }
  if (Array.isArray(t)) {
    let callerTurns = 0;
    const lines = t.map((m: any) => {
      const role = String(m.role ?? m.speaker ?? m.from ?? "").toLowerCase();
      const content = m.content ?? m.text ?? m.message ?? m.transcript ?? "";
      const isCaller = /user|caller|customer|human/.test(role);
      if (isCaller && String(content).trim()) callerTurns++;
      return `${isCaller ? "Caller" : "Agent"}: ${content}`;
    });
    return { text: lines.join("\n"), callerTurns };
  }
  return { text: JSON.stringify(t), callerTurns: 1 };
}

export function normalise(body: any): NormalisedCall {
  const b = body?.data ?? body?.call ?? body?.message ?? body;
  const id = pick(b, ["call_id", "callId", "id", "call.id", "session_id", "room_name"]) ?? pick(body, ["call_id", "id"]);
  const tr = transcriptText(pick(b, ["transcript", "transcript_text", "artifact.transcript", "messages", "conversation", "transcription"]));
  const started = pick(b, ["started_at", "startedAt", "start_time", "created_at", "createdAt"]);
  const ended = pick(b, ["ended_at", "endedAt", "end_time"]);
  let dur = pick(b, ["duration_sec", "duration_seconds", "durationSeconds", "duration", "call_duration"]);
  if (dur == null && started && ended) dur = (Date.parse(ended) - Date.parse(started)) / 1000;
  const costRaw = pick(b, ["cost_inr", "cost.inr", "cost", "total_cost", "cost.total"]);
  const currency = String(pick(b, ["currency", "cost.currency"]) ?? "").toUpperCase();
  return {
    vaani_call_id: String(id ?? `vaani-${crypto.randomUUID()}`),
    direction: pick(b, ["direction", "call_type", "type"]),
    caller_phone: e164(pick(b, ["from_number", "from", "caller_number", "caller_phone", "customer.number", "phone_number", "customer_number"])),
    started_at: started, ended_at: ended,
    duration_sec: dur == null ? null : Math.round(Number(dur)),
    ended_reason: pick(b, ["ended_reason", "endedReason", "disconnection_reason", "disposition", "status"]),
    recording_url: pick(b, ["recording_url", "recordingUrl", "recording.url", "artifact.recordingUrl"]),
    transcript: tr.text, caller_turns: tr.callerTurns,
    cost_inr: costRaw != null && (currency === "INR" || pick(b, ["cost_inr"]) != null) ? Number(costRaw) : null,
    cost_usd: costRaw != null && currency === "USD" ? Number(costRaw) : null,
    platform_extraction: pick(b, ["extracted_entities", "entities", "extraction", "analysis.structuredData", "structured_data", "collected_data"]),
    caller_name: pick(b, ["caller_name", "customer.name", "contact_name"]),
  };
}

// Gemini responseSchema (OpenAPI subset).
const S = (type: string, extra: any = {}) => ({ type, nullable: true, ...extra });
const SCHEMA = {
  type: "OBJECT",
  properties: {
    caller_name: S("STRING"), email: S("STRING", { description: "Only if the caller spelled it out" }),
    location: S("STRING", { description: "Locality/area as said, e.g. Baner, Pimple Saudagar, Nashik" }),
    project_kind: S("STRING", { enum: ["residential", "commercial", "excluded", "existing_client", "unknown"], description: "excluded = restaurant, hotel, shop, gym; existing_client = current client calling about their project" }),
    property_type: S("STRING", { description: "e.g. 3BHK apartment, villa, office" }),
    carpet_sqft: S("NUMBER"),
    scope_summary: S("STRING"),
    scope_size: S("STRING", { enum: ["full_home", "floor", "multi_room", "single_room", "office", "unknown"] }),
    current_state: S("STRING"),
    deadline_text: S("STRING"),
    weeks_until_deadline: S("NUMBER", { description: "Weeks from the call date until work must be finished; null if no deadline" }),
    start_within_weeks: S("NUMBER", { description: "Weeks from the call date until they want to start; null if not said" }),
    advice_only: S("BOOLEAN"), just_exploring: S("BOOLEAN"),
    decision_maker: S("STRING"),
    decision_maker_available: S("BOOLEAN", { description: "True if the caller decides or the decision-makers will attend the consultation; false if they won't; null if unknown" }),
    tenant: S("BOOLEAN"),
    referral_source: S("STRING"),
    referral_is_personal: S("BOOLEAN", { description: "True if referred by a named past client, friend, or someone the owner knows" }),
    budget_lakh: S("NUMBER", { description: "Upper bound of stated budget in lakh rupees" }), budget_text: S("STRING"),
    complaint: S("BOOLEAN"), wants_human: S("BOOLEAN"),
    language: S("STRING"), pricing_asked_count: S("INTEGER"), consultation_preference: S("STRING"),
    confidence_location: S("NUMBER", { description: "0 to 1" }), confidence_scope: S("NUMBER", { description: "0 to 1" }),
    summary: S("STRING", { description: "One line, max 30 words, for the designer. No prices." }),
    handoff_note: S("STRING", { description: "3-6 short lines a designer reads before calling back: who, project, timeline, decision-maker, what they asked, what to lead with. No prices." }),
    missing_information: { type: "ARRAY", items: { type: "STRING" } },
    flags: { type: "ARRAY", items: { type: "STRING" }, description: "e.g. frustrated caller, VIP referral, rental, Hindi speaker" },
  },
  required: ["project_kind", "summary", "handoff_note", "missing_information"],
};

export async function geminiExtract(callId: string, transcript: string, callDate: string, R: Rules): Promise<{ fields: Fields; model: string }> {
  const key = await secret("gemini_api_key");
  if (!key) throw new MissingCredential("gemini_api_key");
  const model = String(R.gemini_model ?? "gemini-2.5-flash");
  const prompt = `You extract structured data from a phone call to an interior design studio in Pune, India. The call date is ${callDate}.
Rules: use only what was said; null when not said; never invent; never include prices. Treat Hindi or Marathi speech normally.

TRANSCRIPT:
${transcript.slice(0, 60000)}`;
  let lastErr = "";
  for (let attempt = 1; attempt <= 2; attempt++) {
    const r = await fetchJson(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: attempt === 1 ? prompt : `${prompt}\n\nYour previous output was invalid (${lastErr}). Return valid JSON matching the schema.` }] }],
        generationConfig: { temperature: 0.1, responseMimeType: "application/json", responseSchema: SCHEMA },
      }),
    }, 45000);
    const usage = r.body?.usageMetadata;
    if (usage) await recordGeminiCost(callId, model, usage, R);
    if (r.status === 401 || r.status === 403) throw new MissingCredential("gemini_api_key (rejected)");
    if (r.status === 429 || r.status >= 500) throw new Error(`gemini ${r.status}`);
    if (r.status !== 200) { lastErr = `HTTP ${r.status}: ${JSON.stringify(r.body).slice(0, 300)}`; await logEvent(callId, "gemini", "extract", "error", lastErr, undefined, attempt); continue; }
    const text = r.body?.candidates?.[0]?.content?.parts?.map((p: any) => p.text ?? "").join("") ?? "";
    try {
      const parsed = JSON.parse(text);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
      await logEvent(callId, "gemini", "extract", "ok", { model, tokens: usage }, undefined, attempt);
      return { fields: parsed as Fields, model };
    } catch (e) {
      lastErr = String((e as Error).message);
      await logEvent(callId, "gemini", "extract", "error", `invalid JSON: ${lastErr}`, undefined, attempt);
    }
  }
  throw new Error(`EXTRACTION_FAILED: ${lastErr}`);
}

async function recordGeminiCost(callId: string, model: string, usage: any, R: Rules) {
  const inTok = Number(usage.promptTokenCount ?? 0), outTok = Number(usage.candidatesTokenCount ?? 0) + Number(usage.thoughtsTokenCount ?? 0);
  const price = R.gemini_price_inr_per_million;
  const amount = price && price.input != null && price.output != null ? (inTok * price.input + outTok * price.output) / 1e6 : null;
  await db().from("usage_costs").insert({
    call_record_id: callId, vendor: "gemini", units: inTok + outTok, unit: "tokens",
    detail: { model, input_tokens: inTok, output_tokens: outTok }, amount_inr: amount,
    source: amount == null ? "unavailable" : "estimated",
  });
}
