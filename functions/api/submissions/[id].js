// PATCH /api/submissions/:id
// Body: { "status": "Contacted", "note": "Left voicemail..." }  (note optional)
// Updates the submission's status (and updated_at), and — if a non-empty
// note is present — inserts a submission_notes row tagged with the new
// status. Replaces the old client-side applyStatusChange() array mutation.
//
// NOTE: unauthenticated, same as the rest of this repo — see README's
// "Known gaps" section.

import { STATUSES, jsonResponse, shapeSubmission, SUBMISSION_COLUMNS } from "../../../lib/submissions.js";

export async function onRequestPatch({ request, env, params }) {
  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return jsonResponse({ error: "Invalid submission id" }, 400);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  const { status, note } = body || {};
  if (typeof status !== "string" || !STATUSES.includes(status)) {
    return jsonResponse({ error: `status must be one of: ${STATUSES.join(", ")}` }, 400);
  }

  try {
    const existing = await env.DB.prepare(`SELECT id FROM submissions WHERE id = ?`).bind(id).first();
    if (!existing) {
      return jsonResponse({ error: "Submission not found" }, 404);
    }

    const now = new Date().toISOString();
    const trimmedNote = typeof note === "string" ? note.trim() : "";

    const statements = [
      env.DB.prepare(`UPDATE submissions SET status = ?, updated_at = ? WHERE id = ?`).bind(status, now, id),
    ];

    if (trimmedNote) {
      statements.push(
        env.DB.prepare(
          `INSERT INTO submission_notes (submission_id, status, note_text, created_at) VALUES (?, ?, ?, ?)`
        ).bind(id, status, trimmedNote, now)
      );
    }

    await env.DB.batch(statements);

    // Re-fetch the full row + addons + notes so the response matches the
    // GET contract exactly — the frontend slots this straight back into
    // its local submissions array instead of refetching everything.
    const row = await env.DB.prepare(`SELECT ${SUBMISSION_COLUMNS} FROM submissions WHERE id = ?`).bind(id).first();

    const [addonsResult, notesResult] = await Promise.all([
      env.DB.prepare(
        `SELECT submission_id, addon_name, addon_price, quantity, included_free, locked FROM submission_addons WHERE submission_id = ?`
      )
        .bind(id)
        .all(),
      env.DB.prepare(
        `SELECT submission_id, status, note_text, created_at FROM submission_notes WHERE submission_id = ? ORDER BY created_at ASC`
      )
        .bind(id)
        .all(),
    ]);

    return jsonResponse(shapeSubmission(row, addonsResult.results, notesResult.results));
  } catch (err) {
    console.error(`PATCH /api/submissions/${id} failed:`, err);
    return jsonResponse({ error: "Failed to update submission" }, 500);
  }
}
