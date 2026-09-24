// Writing one submission (+ its add-on rows) to D1.
//
// Why this is NOT one db.batch(): inside a batch, last_insert_rowid() is
// overwritten by every INSERT, so a batch that inserts the parent and then the
// children reads the wrong parent id for every child after the first. The
// parent goes in on its own, and its id comes from meta.last_row_id — the only
// value that is reliably about the statement that just ran.
//
// If the child insert then fails, the parent is deleted so the office never
// sees a lead with a silently missing add-on list. (ON DELETE CASCADE on
// submission_addons makes that cleanup complete by itself.)

export async function insertSubmission(db, { customer, pricing, submittedAt }) {
  const parent = await db
    .prepare(
      `INSERT INTO submissions
         (name, phone, address, best_time, plan, base_price, addon_total, total_price, status, submitted_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'New', ?, ?)`
    )
    .bind(
      customer.name,
      customer.phone,
      customer.address,
      customer.bestTime,
      pricing.plan,
      pricing.basePrice,
      pricing.addonTotal,
      pricing.total,
      submittedAt,
      submittedAt
    )
    .run();

  const submissionId = parent && parent.meta ? parent.meta.last_row_id : null;
  if (!submissionId) throw new Error("insert_submission_no_rowid");

  if (pricing.lines.length) {
    try {
      await db.batch(
        pricing.lines.map((line) =>
          db
            .prepare(
              `INSERT INTO submission_addons
                 (submission_id, addon_name, addon_price, quantity, included_free, locked)
               VALUES (?, ?, ?, ?, ?, ?)`
            )
            .bind(
              submissionId,
              line.storedName,
              // addon_price is the LINE TOTAL for this row, not the unit price:
              // it keeps SUM(addon_price) == submissions.addon_total exactly, for
              // both normal add-ons (unit x qty) and the equipment counts (only
              // the units above the included count). $0 for included/locked lines.
              line.lineTotal,
              line.quantity,
              line.includedFree ? 1 : 0,
              line.locked ? 1 : 0
            )
        )
      );
    } catch (err) {
      // Partial write cleanup. Best-effort: if this delete also fails there is
      // nothing further to try, and the original error is the one worth raising.
      try {
        await db.prepare(`DELETE FROM submissions WHERE id = ?`).bind(submissionId).run();
      } catch {
        /* ignore */
      }
      throw err;
    }
  }

  return submissionId;
}

// Matches the dashboard's own display format (#0001).
export function submissionNumber(id) {
  return `#${String(id).padStart(4, "0")}`;
}
