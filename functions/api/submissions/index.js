// GET /api/submissions
// Replaces the dashboard's old MOCK_SUBMISSIONS array with a live query
// against D1, joining in each submission's addons and notes.
//
// NOTE: unauthenticated, same as the rest of this repo — see README's
// "Known gaps" section. Cloudflare Access is expected to gate this at
// the edge once that's configured.

import { jsonResponse, groupBy, shapeSubmission, SUBMISSION_COLUMNS } from "../../../lib/submissions.js";

export async function onRequestGet({ env }) {
  try {
    const { results: submissions } = await env.DB.prepare(
      `SELECT ${SUBMISSION_COLUMNS} FROM submissions ORDER BY submitted_at DESC`
    ).all();

    if (!submissions.length) {
      return jsonResponse([]);
    }

    const ids = submissions.map((s) => s.id);
    const placeholders = ids.map(() => "?").join(",");

    const [addonsResult, notesResult] = await Promise.all([
      env.DB.prepare(
        `SELECT submission_id, addon_name, addon_price, quantity, included_free, locked FROM submission_addons WHERE submission_id IN (${placeholders})`
      )
        .bind(...ids)
        .all(),
      env.DB.prepare(
        `SELECT submission_id, status, note_text, created_at FROM submission_notes WHERE submission_id IN (${placeholders}) ORDER BY created_at ASC`
      )
        .bind(...ids)
        .all(),
    ]);

    const addonsBySubmission = groupBy(addonsResult.results, "submission_id");
    const notesBySubmission = groupBy(notesResult.results, "submission_id");

    const shaped = submissions.map((s) =>
      shapeSubmission(s, addonsBySubmission[s.id] || [], notesBySubmission[s.id] || [])
    );

    return jsonResponse(shaped);
  } catch (err) {
    console.error("GET /api/submissions failed:", err);
    return jsonResponse({ error: "Failed to load submissions" }, 500);
  }
}
