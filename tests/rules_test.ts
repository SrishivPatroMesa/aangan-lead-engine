import { classify, instruction } from "../rules.ts";
import { R, SEPT } from "./fixtures.ts";
const eq = (a: unknown, b: unknown, m: string) => { if (a !== b) throw new Error(`${m}: expected ${b}, got ${a}`); };

for (const [id, f, tier, disp] of SEPT) {
  Deno.test(`September ${id} -> ${tier}`, () => {
    const v = classify(f, R);
    eq(v.tier, tier, id);
    if (disp) eq(v.disposition, disp, `${id} disposition`);
    if (!v.reasons.length) throw new Error(`${id} has no reasons`);
  });
}
Deno.test("T08 dropped call -> P3 dropped_call", () => { const v = classify({}, R, { dropped: true }); eq(v.tier, "P3", "T08"); eq(v.disposition, "dropped_call", "T08"); });
Deno.test("extraction failure never drops a lead -> P2 needs_human", () => eq(classify({}, R, { extractionFailed: true }).tier, "P2", "fail"));
Deno.test("nothing captured -> P3 insufficient_information", () => eq(classify({ project_kind: "residential" }, R).disposition, "insufficient_information", "empty"));
Deno.test("unknown locality -> P2, not declined", () => eq(classify({ location: "Somewhere Nagar", project_kind: "residential", scope_summary: "full home", scope_size: "full_home", decision_maker_available: true }, R).tier, "P2", "area"));
Deno.test("commercial above cap -> P2", () => eq(classify({ location: "Baner", project_kind: "commercial", scope_summary: "office", scope_size: "office", carpet_sqft: 4500, decision_maker_available: true }, R).tier, "P2", "cap"));
Deno.test("low confidence -> P2", () => eq(classify({ location: "Baner", project_kind: "residential", scope_summary: "x", scope_size: "full_home", decision_maker_available: true, confidence_location: 0.4 }, R).tier, "P2", "conf"));
Deno.test("asked for a person -> P2", () => eq(classify({ location: "Baner", project_kind: "residential", scope_summary: "x", scope_size: "full_home", decision_maker_available: true, wants_human: true }, R).tier, "P2", "human"));
Deno.test("referral lifts single room to P1", () => eq(classify({ location: "Aundh", project_kind: "residential", scope_summary: "bedroom", scope_size: "single_room", decision_maker_available: true, referral_is_personal: true }, R).tier, "P1", "boost"));
Deno.test("referral does NOT lift a budget gap", () => eq(classify({ location: "Aundh", project_kind: "residential", scope_summary: "bedroom", scope_size: "multi_room", decision_maker_available: true, referral_is_personal: true, budget_lakh: 1 }, R).tier, "P2", "noboost"));
Deno.test("start beyond window -> P2", () => eq(classify({ location: "Baner", project_kind: "residential", scope_summary: "x", scope_size: "full_home", decision_maker_available: true, start_within_weeks: 30 }, R).tier, "P2", "window"));
Deno.test("tool instruction never contains a rupee figure and always carries the pricing rule", () => {
  for (const [, f] of SEPT) { const i = instruction(f, R); if (/₹|\blakh|per sq/i.test(i.say.split("PRICING:")[0])) throw new Error("price leaked"); if (!i.say.includes("PRICING")) throw new Error("no pricing rule"); }
});
Deno.test("P1 instruction requires confirmation before saying booked", () => {
  const i = instruction(SEPT[0][1], R); if (!/Only say it is booked after/.test(i.say)) throw new Error(i.say);
});
