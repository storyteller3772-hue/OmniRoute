import type { Store } from "../db.js";
import { logger } from "../logger.js";

export function topicUrlFor(channelId: string): string {
  return `https://www.youtube.com/xml/feeds/videos.xml?channel_id=${channelId}`;
}

export function callbackUrlFor(publicUrl: string): string {
  return new URL("/websub/youtube", publicUrl).toString();
}

export interface SubscribeOptions {
  hub: string;
  topic: string;
  callback: string;
  secret: string;
  leaseSeconds: number;
  mode?: "subscribe" | "unsubscribe";
}

/**
 * Sends the subscription request. The hub answers 202 and then calls back to
 * verify - so a 202 here means "accepted", not "subscribed". The subscription
 * is only live once the GET verification handler has echoed the challenge.
 */
export async function sendSubscriptionRequest(o: SubscribeOptions): Promise<void> {
  const form = new URLSearchParams({
    "hub.mode": o.mode ?? "subscribe",
    "hub.topic": o.topic,
    "hub.callback": o.callback,
    "hub.verify": "async",
    "hub.secret": o.secret,
    "hub.lease_seconds": String(o.leaseSeconds),
  });

  const res = await fetch(o.hub, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });

  if (res.status !== 202 && res.status !== 204 && !res.ok) {
    const body = (await res.text().catch(() => "")).slice(0, 300);
    throw new Error(`WebSub hub rejected ${o.mode ?? "subscribe"}: HTTP ${res.status} ${body}`);
  }
}

/** Renew once 80% of the lease has elapsed, so a slow hub still has room. */
export function shouldRenew(leaseExpiresAt: string | null, leaseSeconds: number, now = Date.now()): boolean {
  if (!leaseExpiresAt) return true;
  const expiry = Date.parse(leaseExpiresAt);
  if (Number.isNaN(expiry)) return true;
  const renewAt = expiry - leaseSeconds * 0.2 * 1000;
  return now >= renewAt;
}

export async function ensureSubscription(
  store: Store,
  o: SubscribeOptions
): Promise<{ renewed: boolean }> {
  const existing = store.getSubscription(o.topic);
  if (existing?.state === "active" && !shouldRenew(existing.lease_expires_at, o.leaseSeconds)) {
    return { renewed: false };
  }

  logger.info({ topic: o.topic, callback: o.callback }, "requesting WebSub subscription");
  await sendSubscriptionRequest(o);
  store.upsertSubscription(o.topic, o.callback, { state: "pending" });
  return { renewed: true };
}
