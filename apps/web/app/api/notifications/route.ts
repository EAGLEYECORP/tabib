import { createClient } from "@supabase/supabase-js";
import { timingSafeEqual } from "node:crypto";
import { renderNotification } from "../../../lib/notifications/templates";
import {
  UnsendableError,
  providerFromEnvironment,
} from "../../../lib/notifications/providers";

/**
 * Draining the notification outbox.
 *
 * Triggers put rows in `public.notifications`; this sends them. It is one
 * endpoint rather than two so there is one thing to schedule: it queues
 * tomorrow's reminders and then sends whatever is waiting, which makes the
 * whole system a single cron entry.
 *
 *   * * /10 * * *   curl -X POST -H "authorization: Bearer $NOTIFY_SECRET" …
 *
 * Running it more often than necessary is harmless. Reminders are queued
 * under a unique index, claiming uses `for update skip locked`, and a message
 * is marked sent only once a provider has accepted it — so two overlapping
 * runs cannot send anything twice, and a run that dies leaves its rows
 * pending rather than losing them.
 */

export const dynamic = "force-dynamic";

/** Service role: the outbox is deliberately unreachable under RLS. */
function serviceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
  }
  return createClient(url, key, { auth: { persistSession: false } });
}

/**
 * Compared in constant time, and only after the lengths match — a plain `===`
 * on a secret leaks its length and prefix to anyone willing to time the
 * endpoint.
 */
function authorised(request: Request): boolean {
  const expected = process.env.NOTIFY_SECRET;
  if (!expected) return false;

  const header = request.headers.get("authorization") ?? "";
  const offered = header.startsWith("Bearer ") ? header.slice(7) : header;

  const a = Buffer.from(offered);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

interface Row {
  id: number;
  template: string;
  payload: Record<string, unknown>;
  to_phone: string | null;
}

export async function POST(request: Request): Promise<Response> {
  if (!authorised(request)) {
    // 404 rather than 401: an endpoint that confirms it exists is an endpoint
    // worth guessing at.
    return new Response("Not found", { status: 404 });
  }

  let provider;
  try {
    provider = providerFromEnvironment();
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "provider misconfigured" },
      { status: 500 },
    );
  }

  const supabase = serviceClient();

  const { data: reminders } = await supabase.rpc("enqueue_due_reminders", {
    p_within: "24 hours",
  });

  const { data, error } = await supabase.rpc("claim_notifications", { p_limit: 50 });
  if (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }

  const rows = (data ?? []) as Row[];
  let sent = 0;
  let failed = 0;
  let skipped = 0;

  for (const row of rows) {
    const body = renderNotification(row.template, row.payload);

    // A template this deployment does not know is left to retry, because
    // deploying the missing template should pick it up. A recipient with no
    // number on file never will have one by retrying, so that one is given up
    // on at once and stays visible in `last_error`.
    if (!row.to_phone || !body) {
      await supabase.rpc("mark_notification_failed", {
        p_id: row.id,
        p_error: body ? "no phone number on file" : `unknown template ${row.template}`,
        p_permanent: Boolean(body),
      });
      skipped += 1;
      continue;
    }

    try {
      await provider.send(row.to_phone, body);
      await supabase.rpc("mark_notification_sent", { p_id: row.id });
      sent += 1;
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      await supabase.rpc("mark_notification_failed", {
        p_id: row.id,
        p_error: message,
        // A number the provider will never accept is not worth four more
        // attempts.
        p_permanent: cause instanceof UnsendableError,
      });
      failed += 1;
    }
  }

  return Response.json({
    provider: provider.name,
    remindersQueued: reminders ?? 0,
    claimed: rows.length,
    sent,
    failed,
    skipped,
  });
}
