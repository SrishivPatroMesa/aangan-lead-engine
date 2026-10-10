// Calendly: real availability and booking (Scheduling API needs a paid plan), plus webhook setup.
import { secret, fetchJson, MissingCredential, Permanent } from "./lib.ts";

const BASE = "https://api.calendly.com";
async function cal(method: string, path: string, body?: unknown) {
  const token = await secret("calendly_token");
  if (!token) throw new MissingCredential("calendly_token");
  const r = await fetchJson(`${BASE}${path}`, {
    method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (r.status === 401) throw new MissingCredential("calendly_token (rejected)");
  if (r.status === 403) throw new Permanent(`Calendly refused (403). Booking by API needs a paid Calendly plan. ${JSON.stringify(r.body).slice(0, 200)}`);
  if (r.status === 429 || r.status >= 500) throw new Error(`Calendly ${r.status}`);
  return r;
}

export async function availableTimes(eventTypeUri: string, fromIso: string, toIso: string): Promise<string[]> {
  const q = new URLSearchParams({ event_type: eventTypeUri, start_time: fromIso, end_time: toIso });
  const r = await cal("GET", `/event_type_available_times?${q}`);
  if (r.status !== 200) throw new Permanent(`Calendly availability failed (${r.status}): ${JSON.stringify(r.body).slice(0, 300)}`);
  return (r.body.collection ?? []).filter((s: any) => s.status === "available").map((s: any) => s.start_time);
}

export async function book(eventTypeUri: string, startIso: string, name: string, email: string, phone: string | null) {
  const invitee: any = { name, email, timezone: "Asia/Kolkata" };
  if (phone) invitee.text_reminder_number = phone;
  let r = await cal("POST", "/invitees", { event_type: eventTypeUri, start_time: startIso, invitee });
  if (r.status === 400 && invitee.text_reminder_number && /text_reminder/i.test(JSON.stringify(r.body))) {
    delete invitee.text_reminder_number;
    r = await cal("POST", "/invitees", { event_type: eventTypeUri, start_time: startIso, invitee });
  }
  if (r.status === 201 || r.status === 200) {
    const res = r.body.resource ?? r.body;
    return { ok: true as const, invitee_uri: res.uri as string, event_uri: res.event as string };
  }
  return { ok: false as const, status: r.status, error: JSON.stringify(r.body).slice(0, 400) };
}

export async function me() {
  const r = await cal("GET", "/users/me");
  if (r.status !== 200) throw new Permanent(`Calendly /users/me failed: ${r.status}`);
  return r.body.resource;
}
export async function eventTypes(orgUri: string) {
  const r = await cal("GET", `/event_types?${new URLSearchParams({ organization: orgUri, count: "100", active: "true" })}`);
  if (r.status !== 200) throw new Permanent(`Calendly event types failed: ${r.status}`);
  return (r.body.collection ?? []).map((e: any) => ({ uri: e.uri, name: e.name, duration: e.duration, owner: e.profile?.name, pooling: e.pooling_type ?? null }));
}
export async function subscribeWebhook(url: string, orgUri: string, signingKey: string) {
  const r = await cal("POST", "/webhook_subscriptions", {
    url, events: ["invitee.created", "invitee.canceled", "invitee_no_show.created"], organization: orgUri, scope: "organization", signing_key: signingKey,
  });
  return { status: r.status, body: r.body };
}
