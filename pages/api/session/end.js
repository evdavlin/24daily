// pages/api/session/end.js
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Always computed server-side — never trusted from client.
// Puzzle rolls over at 8 AM ET each day.
function getPuzzleDateET() {
  const now = new Date();
  const etStr = now.toLocaleString("en-US", { timeZone: "America/New_York" });
  const et = new Date(etStr);
  if (et.getHours() < 8) et.setDate(et.getDate() - 1);
  const y = et.getFullYear();
  const m = String(et.getMonth() + 1).padStart(2, "0");
  const d = String(et.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { anonId, firstSolveTime, solutionCount, solutions } = req.body;

  if (!anonId) {
    return res.status(400).json({ error: "Missing anonId" });
  }

  // Ignore puzzleDate from client body — always recompute server-side
  const puzzleDate = getPuzzleDateET();

  try {
    // 1. Upsert player row (one row per anon_id, forever)
    const { error: playerErr } = await supabase
      .from("players")
      .upsert({ anon_id: anonId }, { onConflict: "anon_id" });
    if (playerErr) throw playerErr;

    // 2. Upsert today's session — replay overwrites previous attempt
    const { error: sessionErr } = await supabase
      .from("sessions")
      .upsert(
        {
          anon_id:          anonId,
          puzzle_date:      puzzleDate,
          first_solve_time: firstSolveTime ?? null,
          solution_count:   solutionCount  ?? 0,
          solutions:        solutions       ?? [],
          completed_at:     new Date().toISOString(),
        },
        { onConflict: "anon_id,puzzle_date" }
      );
    if (sessionErr) throw sessionErr;

    // 3. Fetch all sessions for today to compute percentile ranks
    const { data: todaySessions, error: fetchErr } = await supabase
      .from("sessions")
      .select("first_solve_time, solution_count")
      .eq("puzzle_date", puzzleDate);
    if (fetchErr) throw fetchErr;

    const total = todaySessions.length;

    // Speed: % of players slower (higher time) or who never solved
    let speedPct = null;
    if (firstSolveTime != null) {
      const slower = todaySessions.filter(
        s => s.first_solve_time == null || s.first_solve_time > firstSolveTime
      ).length;
      speedPct = Math.round((slower / total) * 100);
    }

    // Volume: % of players with fewer solutions
    let solutionsPct = null;
    if (solutionCount != null && solutionCount > 0) {
      const fewer = todaySessions.filter(
        s => (s.solution_count ?? 0) < solutionCount
      ).length;
      solutionsPct = Math.round((fewer / total) * 100);
    }

    return res.status(200).json({
      speedPct,
      solutionsPct,
      totalPlayers: total,
      puzzleDate,
    });

  } catch (err) {
    console.error("Session end error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
}
