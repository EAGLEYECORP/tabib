import { createBrowserClient } from "@supabase/ssr";

/**
 * Supabase client for the browser.
 *
 * Carries the signed-in user's session, so every query it makes is subject to
 * the row-level security policies in supabase/schema.sql — the same rules the
 * server is held to.
 */
export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
}
