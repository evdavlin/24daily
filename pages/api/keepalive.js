// pages/api/keepalive.js
// Called by Vercel Cron every 5 days to prevent Supabase free tier from pausing
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  // Simple lightweight query — just counts players rows
  const { count, error } = await supabase
    .from("players")
    .select("*", { count: "exact", head: true });

  if (error) {
    console.error("Keep-alive failed:", error);
    return res.status(500).json({ ok: false, error: error.message });
  }

  return res.status(200).json({ ok: true, players: count, ts: new Date().toISOString() });
}
