import { createClient, SupabaseClient } from "jsr:@supabase/supabase-js@2";

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

let _sb: SupabaseClient | null = null;
export function db(): SupabaseClient {
  if (!_sb) {
    const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SECRET_KEY")!;
    _sb = createClient(Deno.env.get("SUPABASE_URL")!, key, { auth: { persistSession: false } });
  }
  return _sb;
}

const secretCache = new Map<string, { v: string | null; at: number }>();
export async function secret(name: string): Promise<string | null> {
  const c = secretCache.get(name);
  if (c && Date.now() - c.at < 60_000) return c.v;
  const { data } = await db().rpc("get_app_secret", { p_name: name });
  const v = (data as string | null) || null;
  secretCache.set(name, { v, at: Date.now() });
  return v;
}

export async function config(): Promise<Record<string, string>> {
  const { data } = await db().from("app_config").select("key,value");
  return Object.fromEntries((data ?? []).map((r: any) => [r.key, r.value]));
}

export type Rules = Record<string, any>;
export async function rules(): Promise<Rules> {
  const { data, error } = await db().from("studio_rules").select("key,value");
  if (error) throw new Error(`rules: ${error.message}`);
  return Object.fromEntries((data ?? []).map((r: any) => [r.key, r.value]));
}

export function sharedSecretOk(req: Request, cfg: Record<string, string>): boolean {
  const s = cfg.webhook_secret;
  if (!s) return false;
  const u = new URL(req.url);
  const auth = req.headers.get("authorization") ?? "";
  return req.headers.get("x-webhook-secret") === s || auth === `Bearer ${s}` || u.searchParams.get("secret") === s;
}

export async function hmacHex(key: string, msg: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(msg));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

export async function logEvent(callId: string | null, system: string, action: string, status: string, detail?: unknown, key?: string, attempt = 1) {
  await db().from("integration_events").insert({
    call_record_id: callId, system, action, status, attempt, idempotency_key: key ?? null,
    detail: detail === undefined ? null : (typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 4000)),
  });
}
export async function eventDone(callId: string, key: string): Promise<boolean> {
  const { data } = await db().from("integration_events").select("id").eq("call_record_id", callId).eq("idempotency_key", key).eq("status", "ok").limit(1);
  return !!(data && data.length);
}

export class MissingCredential extends Error { constructor(public what: string) { super(`missing credential: ${what}`); } }
export class Permanent extends Error {}

export function e164(raw: unknown): string | null {
  if (!raw) return null;
  let s = String(raw).replace(/[^\d+]/g, "");
  if (!s) return null;
  if (s.startsWith("00")) s = "+" + s.slice(2);
  if (!s.startsWith("+")) {
    if (s.length === 10) s = "+91" + s;
    else if (s.length === 11 && s.startsWith("0")) s = "+91" + s.slice(1);
    else if (s.length === 12 && s.startsWith("91")) s = "+" + s;
    else s = "+" + s;
  }
  return s;
}

export function istHour(iso: string | null | undefined): { hour: number; dow: number } {
  const d = iso ? new Date(iso) : new Date();
  const p = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", hour: "numeric", minute: "numeric", weekday: "short", hour12: false }).formatToParts(d);
  const h = Number(p.find((x) => x.type === "hour")?.value) + Number(p.find((x) => x.type === "minute")?.value) / 60;
  const wd = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.find((x) => x.type === "weekday")?.value ?? "");
  return { hour: h, dow: wd };
}
export function isAfterHours(iso: string | null | undefined, R: Rules): boolean {
  const h = R.studio_hours ?? { open: 10, close: 19, closed_days: [0] };
  const { hour, dow } = istHour(iso);
  return (h.closed_days ?? []).includes(dow) || hour < h.open || hour >= h.close;
}
export function istLabel(iso: string | Date): string {
  return new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit", hour12: true }).format(new Date(iso));
}

export async function fetchJson(url: string, init: RequestInit, timeoutMs = 15000): Promise<{ status: number; body: any }> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { ...init, signal: ctl.signal });
    const text = await r.text();
    let body: any = text;
    try { body = text ? JSON.parse(text) : null; } catch { /* keep text */ }
    return { status: r.status, body };
  } finally { clearTimeout(t); }
}
