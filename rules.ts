// P1/P2/P3 classification. Pure code over extracted fields; Gemini never picks the tier.
import type { Rules } from "./lib.ts";

export type Fields = {
  caller_name?: string | null; email?: string | null; location?: string | null;
  project_kind?: "residential" | "commercial" | "excluded" | "existing_client" | "unknown" | null;
  property_type?: string | null; carpet_sqft?: number | null; scope_summary?: string | null;
  scope_size?: "full_home" | "floor" | "multi_room" | "single_room" | "office" | "unknown" | null;
  current_state?: string | null; deadline_text?: string | null; weeks_until_deadline?: number | null;
  start_within_weeks?: number | null; advice_only?: boolean | null; just_exploring?: boolean | null;
  decision_maker?: string | null; decision_maker_available?: boolean | null; tenant?: boolean | null;
  referral_source?: string | null; referral_is_personal?: boolean | null;
  budget_lakh?: number | null; budget_text?: string | null; complaint?: boolean | null; wants_human?: boolean | null;
  language?: string | null; pricing_asked_count?: number | null; consultation_preference?: string | null;
  confidence_location?: number | null; confidence_scope?: number | null;
  summary?: string | null; handoff_note?: string | null; missing_information?: string[] | null; flags?: string[] | null;
};

export type Verdict = { tier: "P1" | "P2" | "P3" | "SERVICE"; disposition: string; reasons: string[]; gaps: string[] };

const num = (v: unknown) => (v === null || v === undefined || v === "" || isNaN(Number(v)) ? null : Number(v));
const has = (s: string, list: string[]) => list.some((x) => s.includes(String(x).toLowerCase()));

export function areaStatus(location: string | null | undefined, R: Rules): "served" | "not_served" | "unknown" {
  const loc = String(location ?? "").toLowerCase();
  if (!loc.trim()) return "unknown";
  if (has(loc, R.not_served_areas ?? [])) return "not_served";
  if (has(loc, R.served_areas ?? [])) return "served";
  return "unknown";
}

export function classify(f: Fields, R: Rules, opts: { dropped?: boolean; extractionFailed?: boolean } = {}): Verdict {
  const reasons: string[] = [];
  const gaps: string[] = [];
  if (opts.dropped) return { tier: "P3", disposition: "dropped_call", reasons: ["Call ended before any project details were given; call back"], gaps: [] };
  if (opts.extractionFailed) return { tier: "P2", disposition: "needs_human", reasons: ["Automatic extraction failed twice; a person must read the transcript"], gaps: ["extraction_failed"] };

  if (f.complaint || f.project_kind === "existing_client")
    return { tier: "SERVICE", disposition: "existing_client_escalation", reasons: ["Existing client calling about their project"], gaps: [] };

  const area = areaStatus(f.location, R);
  const scopeText = `${f.scope_summary ?? ""} ${f.property_type ?? ""}`.toLowerCase();
  const excluded = f.project_kind === "excluded" || has(scopeText, R.excluded_project_types ?? []);
  const sq = num(f.carpet_sqft);
  const cm = R.commercial_sqft ?? { min: 500, max: 3000 };
  const minWeeks = Number(R.min_weeks_to_completion ?? 6);

  // Hard gates -> P3 not serviceable (a person confirms before closing).
  const gateFails: string[] = [];
  if (area === "not_served") gateFails.push(`${f.location} is outside Pune and PCMC`);
  if (excluded) gateFails.push("Restaurants, hotels, retail and gyms are out of scope");
  if (f.project_kind === "commercial" && sq !== null && sq < cm.min) gateFails.push(`${sq} sq ft is below the ${cm.min} sq ft commercial minimum`);
  if (gateFails.length) return { tier: "P3", disposition: "not_serviceable", reasons: gateFails, gaps: [] };

  if (f.advice_only) return { tier: "P3", disposition: "advice_only", reasons: ["Wants advice only; the studio only takes redesign with execution"], gaps: [] };
  const wk = num(f.weeks_until_deadline);
  if (wk !== null && wk < minWeeks) return { tier: "P3", disposition: "timeline_too_short", reasons: [`Must be ready in about ${wk} weeks; minimum is ${minWeeks}. Offer a later start.`], gaps: [] };
  if (f.just_exploring) return { tier: "P3", disposition: "exploring", reasons: ["Still exploring; no project commitment yet"], gaps: [] };
  if (!f.location && !f.scope_summary) return { tier: "P3", disposition: "insufficient_information", reasons: ["Neither location nor scope captured"], gaps: [] };

  // Soft gaps -> P2.
  if (area === "unknown") gaps.push("area_unconfirmed");
  if (f.scope_size === "single_room") gaps.push("single_room");
  if (!f.scope_size || f.scope_size === "unknown") gaps.push("scope_unclear");
  if (f.decision_maker_available === false) gaps.push("decision_maker_absent");
  if (f.tenant) gaps.push("tenant");
  if (f.project_kind === "commercial" && sq !== null && sq > cm.max) gaps.push("commercial_above_cap");
  if (!f.project_kind || f.project_kind === "unknown") gaps.push("project_type_unclear");
  const sw = num(f.start_within_weeks), window = Number(R.p1_start_window_weeks ?? 13);
  if (sw !== null && sw > window) gaps.push("start_beyond_window");
  const bl = num(f.budget_lakh);
  if (bl !== null && f.project_kind !== "commercial") {
    const floor = R.budget_floor ?? { min_total_inr: 350000, min_inr_per_sqft: 1200 };
    if (bl * 1e5 < floor.min_total_inr || (sq ? (bl * 1e5) / sq < floor.min_inr_per_sqft : false)) gaps.push("budget_below_floor");
  }
  const minConf = Number(R.min_confidence ?? 0.7);
  if ((num(f.confidence_location) ?? 1) < minConf || (num(f.confidence_scope) ?? 1) < minConf) gaps.push("low_confidence");
  if (f.wants_human) gaps.push("asked_for_a_person");

  const label: Record<string, string> = {
    area_unconfirmed: "Locality not recognised as served", single_room: "Single room only", scope_unclear: "Scope not clear",
    decision_maker_absent: "Decision-maker not on the call or attending", tenant: "Tenant (needs landlord consent)",
    commercial_above_cap: "Commercial space above the ~3,000 sq ft cap", project_type_unclear: "Project type unclear",
    start_beyond_window: `Wants to start more than ${window} weeks out`, budget_below_floor: "Stated budget may be below the studio's range",
    low_confidence: "Extraction unsure about location or scope", asked_for_a_person: "Asked to speak to a person",
  };

  if (!gaps.length) return { tier: "P1", disposition: "book_consultation", reasons: ["In area, in scope, timeline workable, decision-maker engaged"], gaps };

  const boostable = new Set(["single_room", "start_beyond_window", "tenant"]);
  if (f.referral_is_personal && R.referral_boost !== false && gaps.every((g) => boostable.has(g)))
    return { tier: "P1", disposition: "book_consultation", reasons: ["Personal referral lifts this to P1", ...gaps.map((g) => label[g])], gaps };

  return { tier: "P2", disposition: "designer_review", reasons: gaps.map((g) => label[g] ?? g), gaps };
}

// What the voice agent should do next, given what it has heard so far (mid-call tool).
export function instruction(f: Fields, R: Rules): { provisional: string; say: string } {
  const pricing = R.pricing_line ?? "Pricing depends on the site, materials and scope; your designer will go through it at the consultation.";
  const v = classify(f, R);
  const missing: string[] = [];
  if (!f.location) missing.push("which area of Pune");
  if (!f.project_kind || f.project_kind === "unknown") missing.push("whether it's a home or an office");
  if (!f.scope_summary) missing.push("what they want done");
  if (f.weeks_until_deadline == null && !f.deadline_text) missing.push("when it needs to be finished");
  if (f.decision_maker_available == null) missing.push("who will make the decision");
  let say: string;
  if (v.tier === "SERVICE") say = "Existing client issue: apologise sincerely, take their name, project area and designer's name, and promise a senior callback. Do not sell.";
  else if (v.disposition === "not_serviceable") say = `Not a fit: ${v.reasons.join("; ")}. Explain kindly, wish them well, do not book.`;
  else if (v.disposition === "advice_only") say = "Explain the studio only takes full redesign with execution, not advice-only visits; invite them to call back when ready.";
  else if (v.disposition === "timeline_too_short") say = `${v.reasons[0]} Design takes 3-4 weeks and execution 8-16. Offer to note their details for a later start.`;
  else if (missing.length) say = `Ask next, one at a time: ${missing.join("; ")}.`;
  else if (v.tier === "P1") say = "Good fit. Ask for their email for the calendar invite, then call available_slots and offer up to three times. Only say it is booked after book_consultation confirms.";
  else say = "Likely a fit but a designer should review. Do not book. Tell them a designer will call them back, and ask for a convenient time.";
  return { provisional: v.tier, say: `${say} PRICING: never give any number; if asked, say: "${pricing}"` };
}
