// End-to-end API tests against a real `wrangler pages dev` + local D1, with the
// n8n webhook and Turnstile siteverify mocked locally (tests/mock-services.mjs).
//
//   npm run test:api
//
// Four groups, each with its own wrangler process because TURNSTILE_SECRET and
// the rate-limit window are read from env at startup:
//   A  happy paths, validation, tampering, CORS, n8n failure modes, dashboard API
//   B  Turnstile always-fails secret (2x...)
//   C  Turnstile already-spent secret (3x...)
//   D  rate limit trip, Retry-After, per-IP isolation, recovery

import {
  BASE,
  TURNSTILE_FAIL,
  TURNSTILE_SPENT,
  VALID_LEAD,
  applyMigrations,
  check,
  checkEqual,
  d1,
  group,
  mockMode,
  mockReceived,
  mockReset,
  postIntake,
  resetData,
  sleep,
  startMocks,
  startPagesDev,
  summary,
} from "./harness.mjs";

const mocks = startMocks();
let pages = null;

async function withPages(vars, fn) {
  pages = await startPagesDev(vars);
  try {
    await fn();
  } finally {
    await pages.stop();
    pages = null;
  }
}

async function rowFor(submissionId) {
  const rows = await d1(`SELECT * FROM submissions WHERE id = ${Number(submissionId)}`);
  return rows[0] || null;
}

async function addonsFor(submissionId) {
  return d1(
    `SELECT addon_name, addon_price, quantity, included_free, locked FROM submission_addons WHERE submission_id = ${Number(
      submissionId
    )} ORDER BY id`
  );
}

async function main() {
  await sleep(400);
  console.log("applying migrations to the local D1…");
  await applyMigrations();
  await resetData();

  // =========================================================================
  await withPages({}, async () => {
    group("A1 — CORS");
    await mockReset();

    const preflightAllowed = await fetch(`${BASE}/api/care-plan-request`, {
      method: "OPTIONS",
      headers: { Origin: "https://youknowsuncity.com", "Access-Control-Request-Method": "POST" },
    });
    check("preflight from an allowed origin returns 204", preflightAllowed.status === 204, preflightAllowed.status);
    checkEqual(
      "preflight echoes the origin",
      preflightAllowed.headers.get("access-control-allow-origin"),
      "https://youknowsuncity.com"
    );
    check("preflight allows POST", (preflightAllowed.headers.get("access-control-allow-methods") || "").includes("POST"));
    checkEqual("preflight sets Vary: Origin", preflightAllowed.headers.get("vary"), "Origin");

    const preflightDenied = await fetch(`${BASE}/api/care-plan-request`, {
      method: "OPTIONS",
      headers: { Origin: "https://evil.example", "Access-Control-Request-Method": "POST" },
    });
    check("preflight from a denied origin returns 403", preflightDenied.status === 403, preflightDenied.status);
    check(
      "denied preflight sends no Access-Control-Allow-Origin",
      preflightDenied.headers.get("access-control-allow-origin") === null
    );
    checkEqual("denied preflight still sets Vary: Origin", preflightDenied.headers.get("vary"), "Origin");

    const deniedPost = await postIntake({ ...VALID_LEAD, planId: "hvac", addons: [] }, { origin: "https://evil.example" });
    check("POST from a denied origin returns 403", deniedPost.status === 403, deniedPost.status);
    checkEqual("denied POST names the reason", deniedPost.body && deniedPost.body.code, "ORIGIN_NOT_ALLOWED");

    const allowedPost = await postIntake(
      { ...VALID_LEAD, planId: "hvac", addons: [], basePrice: 260, total: 260 },
      { origin: "https://youknowsuncity.com", ip: "203.0.113.10" }
    );
    check("POST from an allowed origin succeeds", allowedPost.status === 201, allowedPost);
    checkEqual(
      "successful POST echoes the origin",
      allowedPost.headers.get("access-control-allow-origin"),
      "https://youknowsuncity.com"
    );

    const noOrigin = await postIntake({ ...VALID_LEAD, planId: "hvac", addons: [] }, { ip: "203.0.113.11" });
    check("POST with no Origin header (same-origin/curl) is allowed", noOrigin.status === 201, noOrigin);

    group("A2 — method handling");
    const getRes = await fetch(`${BASE}/api/care-plan-request`);
    check("GET on the intake route returns 405", getRes.status === 405, getRes.status);
    check("405 sets Allow: POST, OPTIONS", (getRes.headers.get("allow") || "").includes("POST"));

    group("A3 — happy path, all four plans");
    await mockReset();

    // HVAC + one normal add-on, quantity 2
    const hvac = await postIntake(
      {
        ...VALID_LEAD,
        planId: "hvac",
        plan: "HVAC Care Plan",
        basePrice: 260,
        addons: [{ id: "qfc", name: "Quarterly Filter Change", unitPrice: 120, quantity: 2, lineTotal: 240 }],
        total: 500,
      },
      { ip: "203.0.113.20" }
    );
    check("HVAC submission returns 201", hvac.status === 201, hvac);
    checkEqual("HVAC total", hvac.body && hvac.body.total, 500);
    let row = await rowFor(hvac.body.submissionId);
    checkEqual("HVAC plan name derived server-side", row.plan, "HVAC Care Plan");
    checkEqual("HVAC base_price from catalog", row.base_price, 260);
    checkEqual("HVAC addon_total", row.addon_total, 240);
    checkEqual("HVAC total_price = base + addons", row.total_price, row.base_price + row.addon_total);
    checkEqual("best_time mapped from 'morning'", row.best_time, "Morning");
    checkEqual("status defaults to New", row.status, "New");
    let addons = await addonsFor(hvac.body.submissionId);
    checkEqual("HVAC records one add-on row", addons.length, 1);
    checkEqual("add-on row stores the line total", addons[0].addon_price, 240);
    checkEqual("add-on row stores the quantity", addons[0].quantity, 2);
    checkEqual("SUM(addon_price) equals addon_total", addons.reduce((s, a) => s + a.addon_price, 0), row.addon_total);

    // Plumbing + quantity-only add-on (3 water heaters = 2 additional x $50)
    const plumbing = await postIntake(
      {
        ...VALID_LEAD,
        planId: "plumbing",
        addons: [{ id: "waterHeaters", quantity: 3 }],
        basePrice: 160,
        total: 260,
        bestTime: "midday",
      },
      { ip: "203.0.113.21" }
    );
    check("Plumbing submission returns 201", plumbing.status === 201, plumbing);
    row = await rowFor(plumbing.body.submissionId);
    checkEqual("quantity-only add-on bills only units above the included count", row.addon_total, 100);
    checkEqual("Plumbing total_price", row.total_price, 260);
    checkEqual("'midday' is stored as Midday, not collapsed", row.best_time, "Midday");
    addons = await addonsFor(plumbing.body.submissionId);
    checkEqual("quantity-only row keeps the total count", addons[0].quantity, 3);
    checkEqual("quantity-only row stores the surcharge", addons[0].addon_price, 100);

    // Bundled, both systems, mixed add-ons
    const bundled = await postIntake(
      {
        ...VALID_LEAD,
        planId: "bundled",
        addons: [
          { id: "qfc", quantity: 1 },
          { id: "twf", quantity: 1 },
          { id: "hvacSystems", quantity: 2 },
        ],
        basePrice: 400,
        total: 685,
        bestTime: "",
      },
      { ip: "203.0.113.22" }
    );
    check("Bundled submission returns 201", bundled.status === 201, bundled);
    row = await rowFor(bundled.body.submissionId);
    checkEqual("Bundled addon_total (120 + 40 + 125)", row.addon_total, 285);
    checkEqual("Bundled total_price", row.total_price, 685);
    checkEqual("empty bestTime is stored as 'No preference'", row.best_time, "No preference");
    addons = await addonsFor(bundled.body.submissionId);
    checkEqual("Bundled records three add-on rows", addons.length, 3);
    checkEqual("no locked lines under Bundled", addons.filter((a) => a.locked).length, 0);

    // Premier canonical selection: no phantom water-treatment rows
    const premier = await postIntake(
      {
        ...VALID_LEAD,
        planId: "premier",
        addons: [
          { id: "mst", quantity: 1 },
          { id: "hvacSystems", quantity: 3 },
        ],
        basePrice: 600,
        total: 930,
        bestTime: "afternoon",
      },
      { ip: "203.0.113.23" }
    );
    check("Premier submission returns 201", premier.status === 201, premier);
    row = await rowFor(premier.body.submissionId);
    checkEqual("Premier canonical addon_total", row.addon_total, 330);
    checkEqual("Premier canonical total_price", row.total_price, 930);
    addons = await addonsFor(premier.body.submissionId);
    checkEqual("Premier canonical selection has two add-on rows", addons.length, 2);
    checkEqual("Premier canonical selection has no phantom included rows", addons.filter((a) => a.included_free).length, 0);
    checkEqual("Premier canonical selection has no phantom salt", addons.filter((a) => a.addon_name.startsWith("Water Softener Salt")).length, 0);
    checkEqual("Premier canonical selection has no phantom RO service", addons.filter((a) => a.addon_name.startsWith("Reverse Osmosis Service")).length, 0);
    checkEqual(
      "SUM(addon_price) still equals addon_total",
      addons.reduce((s, a) => s + a.addon_price, 0),
      row.addon_total
    );

    // Premier softener pairing: paid service x2 + included salt x2.
    const premierSoftener = await postIntake(
      {
        ...VALID_LEAD,
        planId: "premier",
        addons: [{ id: "wsv", quantity: 2 }],
        basePrice: 600,
        total: 750,
      },
      { ip: "203.0.113.26" }
    );
    check("Premier softener submission returns 201", premierSoftener.status === 201, premierSoftener);
    row = await rowFor(premierSoftener.body.submissionId);
    checkEqual("Premier softener addon_total is $150", row.addon_total, 150);
    checkEqual("Premier softener total is $750", row.total_price, 750);
    addons = await addonsFor(premierSoftener.body.submissionId);
    const softenerServiceRow = addons.find((a) => a.addon_name.startsWith("Water Softener Service"));
    const includedSaltRow = addons.find((a) => a.addon_name.startsWith("Water Softener Salt"));
    checkEqual("paid softener service quantity persists", softenerServiceRow && softenerServiceRow.quantity, 2);
    checkEqual("paid softener service charge persists", softenerServiceRow && softenerServiceRow.addon_price, 150);
    checkEqual("matching included salt quantity persists", includedSaltRow && includedSaltRow.quantity, 2);
    checkEqual("included salt is $0", includedSaltRow && includedSaltRow.addon_price, 0);
    checkEqual("included salt flag persists", includedSaltRow && includedSaltRow.included_free, 1);

    // Premier RO service is paid normally; no extra included line is created.
    const premierRo = await postIntake(
      {
        ...VALID_LEAD,
        planId: "premier",
        addons: [{ id: "ros", quantity: 2 }],
        basePrice: 600,
        total: 700,
      },
      { ip: "203.0.113.27" }
    );
    check("Premier RO submission returns 201", premierRo.status === 201, premierRo);
    row = await rowFor(premierRo.body.submissionId);
    checkEqual("Premier RO addon_total is $100", row.addon_total, 100);
    checkEqual("Premier RO total is $700", row.total_price, 700);
    addons = await addonsFor(premierRo.body.submissionId);
    checkEqual("Premier RO creates one row", addons.filter((a) => a.addon_name.startsWith("Reverse Osmosis Service")).length, 1);
    const roRow = addons.find((a) => a.addon_name.startsWith("Reverse Osmosis Service"));
    checkEqual("Premier RO row is not included/free", roRow && roRow.included_free, 0);
    // Locked line: a plumbing add-on left over from a previous plan, on HVAC
    const locked = await postIntake(
      {
        ...VALID_LEAD,
        planId: "hvac",
        addons: [
          { id: "qfc", quantity: 1 },
          { id: "twf", quantity: 2 },
        ],
        basePrice: 260,
        total: 380,
      },
      { ip: "203.0.113.24" }
    );
    check("submission with a locked line returns 201", locked.status === 201, locked);
    row = await rowFor(locked.body.submissionId);
    checkEqual("locked line is not billed", row.addon_total, 120);
    addons = await addonsFor(locked.body.submissionId);
    const lockedRow = addons.find((a) => a.locked);
    check("locked line is recorded for the office", !!lockedRow, addons);
    check(
      "locked line is $0 and labelled",
      lockedRow && lockedRow.addon_price === 0 && /\(not covered by selected plan\)$/.test(lockedRow.addon_name),
      lockedRow
    );
    checkEqual("locked line keeps the customer's quantity", lockedRow && lockedRow.quantity, 2);

    // Stale/forged independent Premier salt is ignored unless softener service exists.
    const staleSalt = await postIntake(
      {
        ...VALID_LEAD,
        planId: "premier",
        addons: [
          { id: "wss", quantity: 9 },
          { id: "wss", quantity: 1 },
        ],
        basePrice: 600,
        total: 1212,
      },
      { ip: "203.0.113.25" }
    );
    row = await rowFor(staleSalt.body.submissionId);
    checkEqual("independent Premier salt is never charged", row.addon_total, 0);
    checkEqual("independent Premier salt does not change total", row.total_price, 600);
    addons = await addonsFor(staleSalt.body.submissionId);
    checkEqual("independent Premier salt creates no row", addons.filter((a) => a.addon_name.startsWith("Water Softener Salt")).length, 0);

    group("A4 — client prices are never trusted");
    const tampered = await postIntake(
      {
        ...VALID_LEAD,
        planId: "hvac",
        plan: "Premier Care Plan", // lying about the plan name
        basePrice: 1, // lying about the base
        addons: [{ id: "qfc", quantity: 1, unitPrice: 0, lineTotal: 0 }], // lying about the line
        total: 1, // lying about the total
      },
      { ip: "203.0.113.30" }
    );
    check("a tampered payload is still accepted (201)", tampered.status === 201, tampered);
    row = await rowFor(tampered.body.submissionId);
    checkEqual("plan comes from planId, not the client's plan string", row.plan, "HVAC Care Plan");
    checkEqual("base_price recomputed", row.base_price, 260);
    checkEqual("addon_total recomputed", row.addon_total, 120);
    checkEqual("total_price recomputed", row.total_price, 380);
    checkEqual("the response reports the server's total", tampered.body.total, 380);

    group("A5 — validation");
    const before = (await d1("SELECT COUNT(*) AS c FROM submissions"))[0].c;

    const missing = await postIntake({ planId: "hvac", addons: [], turnstileToken: "dummy-token" });
    checkEqual("missing fields return 400", missing.status, 400);
    checkEqual("missing fields are reported per field", Object.keys(missing.body.fieldErrors || {}).sort(), [
      "address",
      "customerName",
      "phone",
    ]);

    const shortPhone = await postIntake({ ...VALID_LEAD, planId: "hvac", addons: [], phone: "555-0142" });
    checkEqual("a 7-digit phone is rejected", shortPhone.status, 400);
    check("the phone error is on the phone field", !!(shortPhone.body.fieldErrors || {}).phone, shortPhone.body);

    const badPlan = await postIntake({ ...VALID_LEAD, planId: "platinum", addons: [] });
    checkEqual("unknown planId returns 400", badPlan.status, 400);
    check("unknown planId is reported on planId", !!(badPlan.body.fieldErrors || {}).planId);

    const badAddon = await postIntake({ ...VALID_LEAD, planId: "hvac", addons: [{ id: "free-boiler", quantity: 1 }] });
    checkEqual("unknown add-on id returns 400", badAddon.status, 400);
    check("unknown add-on is reported on addons", !!(badAddon.body.fieldErrors || {}).addons);

    const tooMany = await postIntake({ ...VALID_LEAD, planId: "hvac", addons: [{ id: "qfc", quantity: 10 }] });
    checkEqual("quantity above 9 returns 400", tooMany.status, 400);
    check("the limit error mentions calling the office", /call the office/i.test((tooMany.body.fieldErrors || {}).addons || ""));

    const noToken = await postIntake({ ...VALID_LEAD, planId: "hvac", addons: [], turnstileToken: "" });
    checkEqual("a missing Turnstile token returns 400", noToken.status, 400);
    check("the token error is a field error", !!(noToken.body.fieldErrors || {}).turnstileToken);

    const badJson = await fetch(`${BASE}/api/care-plan-request`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    checkEqual("malformed JSON returns 400", badJson.status, 400);

    const huge = await postIntake({ ...VALID_LEAD, planId: "hvac", addons: [], address: "x".repeat(20000) });
    check("an oversized body is rejected (400/413)", huge.status === 413 || huge.status === 400, huge.status);

    const after = (await d1("SELECT COUNT(*) AS c FROM submissions"))[0].c;
    checkEqual("no rejected request wrote a row", after, before);

    group("A6 — no internals leak in error bodies");
    const leakCheck = JSON.stringify([missing.body, badPlan.body, badAddon.body, noToken.body]);
    check(
      "error bodies mention no SQL, stack traces or file paths",
      !/SQLITE|sqlite|D1_|stack|at Object\.|\/home\/|lib\/intake/.test(leakCheck),
      leakCheck.slice(0, 200)
    );

    group("A7 — the n8n notification");
    await mockReset();
    const notified = await postIntake(
      {
        ...VALID_LEAD,
        planId: "premier",
        addons: [
          { id: "qfc", quantity: 2 },
          { id: "twf", quantity: 1 },
        ],
        basePrice: 600,
        total: 880,
      },
      { ip: "203.0.113.40" }
    );
    check("submission returns 201", notified.status === 201, notified);
    await sleep(1500);
    let received = await mockReceived();
    checkEqual("exactly one webhook call", received.received.length, 1);
    const call = received.received[0] || {};
    checkEqual("webhook carries the shared secret header", call.secret, "test-webhook-secret");
    const payload = call.payload || {};
    checkEqual("payload submission number is zero-padded", payload.submissionNumber, `#${String(notified.body.submissionId).padStart(4, "0")}`);
    checkEqual("payload plan name", payload.plan && payload.plan.name, "Premier Care Plan");
    checkEqual("payload totals are the server's", payload.totals && payload.totals.total, 880);
    checkEqual("payload addonTotal", payload.totals && payload.totals.addonTotal, 280);
    check("payload carries the customer's contact details", !!(payload.customer && payload.customer.phone && payload.customer.address));
    checkEqual("payload bestTime is the stored value", payload.customer && payload.customer.bestTime, "Morning");
    check("payload carries the dashboard link", typeof payload.dashboardUrl === "string" && payload.dashboardUrl.length > 0);
    check(
      "payload add-ons carry quantity, line total and flags",
      (payload.addons || []).every(
        (a) => "quantity" in a && "lineTotal" in a && "includedFree" in a && "locked" in a && "billable" in a
      ),
      payload.addons
    );
    checkEqual("Premier canonical email payload has no phantom included lines", (payload.addons || []).filter((a) => a.includedFree).length, 0);
    checkEqual("submittedAt is server-side ISO", typeof payload.submittedAt, "string");

    group("A8 — n8n down or slow never fails the customer");
    await mockReset();
    await mockMode("down");
    const whileDown = await postIntake({ ...VALID_LEAD, planId: "hvac", addons: [] }, { ip: "203.0.113.41" });
    checkEqual("submission still returns 201 with n8n refusing connections", whileDown.status, 201);
    check("the row is saved anyway", !!(await rowFor(whileDown.body.submissionId)), whileDown.body);

    await mockMode("timeout");
    const started = Date.now();
    const whileHanging = await postIntake({ ...VALID_LEAD, planId: "hvac", addons: [] }, { ip: "203.0.113.42" });
    const elapsed = Date.now() - started;
    checkEqual("submission still returns 201 with n8n hanging", whileHanging.status, 201);
    check("the customer is not made to wait for n8n", elapsed < 4000, `${elapsed}ms`);
    check("the row is saved anyway", !!(await rowFor(whileHanging.body.submissionId)), whileHanging.body);

    await mockMode("500");
    const while500 = await postIntake({ ...VALID_LEAD, planId: "hvac", addons: [] }, { ip: "203.0.113.43" });
    checkEqual("submission still returns 201 when n8n answers 500", while500.status, 201);
    await mockMode("ok");

    group("A9 — the dashboard API sees the new rows");
    const listRes = await fetch(`${BASE}/api/submissions`);
    const list = await listRes.json();
    checkEqual("GET /api/submissions returns 200", listRes.status, 200);
    const newest = list.find((s) => s.id === notified.body.submissionId);
    check("the new submission is in the list", !!newest, list.map((s) => s.id));
    checkEqual(
      "the row keeps the documented JSON contract",
      Object.keys(newest || {}).sort(),
      [
        "addonDetail",
        "addons",
        "address",
        "basePrice",
        "bestTime",
        "id",
        "name",
        "phone",
        "plan",
        "notes",
        "status",
        "submittedAt",
        "total",
      ].sort()
    );
    check("addons is still a plain array of names", (newest.addons || []).every((a) => typeof a === "string"));
    checkEqual("basePrice comes through", newest.basePrice, 600);
    checkEqual("total comes through", newest.total, 880);
    checkEqual("notes starts empty", newest.notes.length, 0);
    check(
      "addonDetail carries per-line totals and flags",
      (newest.addonDetail || []).every((a) => typeof a.price === "number" && typeof a.quantity === "number")
    );

    group("A10 — PATCH still works");
    const patchRes = await fetch(`${BASE}/api/submissions/${notified.body.submissionId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "Contacted", note: "Called back, wants a Tuesday visit." }),
    });
    const patched = await patchRes.json();
    checkEqual("PATCH returns 200", patchRes.status, 200);
    checkEqual("status updated", patched.status, "Contacted");
    checkEqual("the note is attached", patched.notes.length, 1);
    checkEqual("the note carries the new status", patched.notes[0].status, "Contacted");
    check("PATCH response keeps addonDetail too", Array.isArray(patched.addonDetail));

    const badPatch = await fetch(`${BASE}/api/submissions/${notified.body.submissionId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "Nonsense" }),
    });
    checkEqual("an invalid status is still rejected", badPatch.status, 400);
  });

  // =========================================================================
  await withPages({ TURNSTILE_SECRET: TURNSTILE_FAIL }, async () => {
    group("B — Turnstile failure (secret 2x…, always fails)");
    await mockReset();
    const before = (await d1("SELECT COUNT(*) AS c FROM submissions"))[0].c;
    const res = await postIntake({ ...VALID_LEAD, planId: "hvac", addons: [] }, { ip: "203.0.113.50" });
    checkEqual("a failed challenge returns 403", res.status, 403);
    checkEqual("the failure is named", res.body && res.body.code, "TURNSTILE_FAILED");
    check("the customer is told to retry the check", !!(res.body.fieldErrors || {}).turnstileToken);
    const after = (await d1("SELECT COUNT(*) AS c FROM submissions"))[0].c;
    checkEqual("nothing was written to D1", after, before);
    const received = await mockReceived();
    checkEqual("no office email was triggered", received.received.length, 0);
    check("siteverify was actually called", received.siteverifyCalls.length >= 1, received.siteverifyCalls);
  });

  // =========================================================================
  await withPages({ TURNSTILE_SECRET: TURNSTILE_SPENT }, async () => {
    group("C — Turnstile already-spent token (secret 3x…, timeout-or-duplicate)");
    await mockReset();
    const before = (await d1("SELECT COUNT(*) AS c FROM submissions"))[0].c;
    const res = await postIntake({ ...VALID_LEAD, planId: "hvac", addons: [] }, { ip: "203.0.113.51" });
    checkEqual("a spent token returns 403", res.status, 403);
    checkEqual("the failure is named", res.body && res.body.code, "TURNSTILE_FAILED");
    const after = (await d1("SELECT COUNT(*) AS c FROM submissions"))[0].c;
    checkEqual("nothing was written to D1", after, before);
  });

  // =========================================================================
  await withPages({ RATE_LIMIT_MAX: "2", RATE_LIMIT_WINDOW_SECONDS: "5" }, async () => {
    group("D — rate limit (2 per 5s per IP)");
    await mockReset();
    await d1("DELETE FROM intake_rate_limit");

    const body = { ...VALID_LEAD, planId: "hvac", addons: [] };
    const first = await postIntake(body, { ip: "198.51.100.7" });
    const second = await postIntake(body, { ip: "198.51.100.7" });
    const third = await postIntake(body, { ip: "198.51.100.7" });

    checkEqual("1st submission allowed", first.status, 201);
    checkEqual("2nd submission allowed", second.status, 201);
    checkEqual("3rd submission is rate limited", third.status, 429);
    checkEqual("the 429 is named", third.body && third.body.code, "RATE_LIMITED");
    const retryAfter = Number(third.headers.get("retry-after"));
    check("429 carries a usable Retry-After", Number.isInteger(retryAfter) && retryAfter > 0 && retryAfter <= 5, retryAfter);
    check("the 429 message points at the office phone number", /575-526-9758/.test(third.body.error || ""), third.body);

    const otherIp = await postIntake(body, { ip: "198.51.100.8" });
    checkEqual("a different IP is unaffected", otherIp.status, 201);

    const hashed = await d1("SELECT ip_hash FROM intake_rate_limit LIMIT 5");
    check(
      "only salted hashes are stored, never an IP",
      hashed.every((r) => /^[0-9a-f]{64}$/.test(r.ip_hash)),
      hashed
    );
    const raw = await d1("SELECT COUNT(*) AS c FROM intake_rate_limit WHERE ip_hash LIKE '%198.51.100%'");
    checkEqual("no row contains a raw IP", raw[0].c, 0);

    console.log("  … waiting out the 5s window");
    await sleep(6000);
    const recovered = await postIntake(body, { ip: "198.51.100.7" });
    checkEqual("the same IP can submit again after the window", recovered.status, 201);

    // Lazy purge: rows older than 24h are removed on the way past.
    await d1("INSERT INTO intake_rate_limit (ip_hash, created_at_epoch) VALUES ('deadbeef', 1)");
    const beforePurge = (await d1("SELECT COUNT(*) AS c FROM intake_rate_limit WHERE ip_hash = 'deadbeef'"))[0].c;
    await postIntake(body, { ip: "198.51.100.9" });
    const afterPurge = (await d1("SELECT COUNT(*) AS c FROM intake_rate_limit WHERE ip_hash = 'deadbeef'"))[0].c;
    checkEqual("an ancient row existed before the request", beforePurge, 1);
    checkEqual("and was purged lazily by it", afterPurge, 0);
  });

  group("E — data integrity across everything written");
  const mismatched = await d1(
    `SELECT s.id FROM submissions s
      WHERE s.total_price <> s.base_price + s.addon_total`
  );
  checkEqual("every row satisfies total_price = base_price + addon_total", mismatched.length, 0);
  const addonSums = await d1(
    `SELECT s.id, s.addon_total, COALESCE(SUM(a.addon_price), 0) AS summed
       FROM submissions s LEFT JOIN submission_addons a ON a.submission_id = s.id
      WHERE s.id > 4 GROUP BY s.id HAVING s.addon_total <> COALESCE(SUM(a.addon_price), 0)`
  );
  checkEqual("every intake row satisfies addon_total = SUM(addon_price)", addonSums.length, 0);
  const orphans = await d1(
    `SELECT a.id FROM submission_addons a LEFT JOIN submissions s ON s.id = a.submission_id WHERE s.id IS NULL`
  );
  checkEqual("no orphaned add-on rows", orphans.length, 0);
}

let ok = false;
try {
  await main();
  ok = summary();
} catch (err) {
  console.error("\nharness error:", err && err.stack ? err.stack : err);
  ok = false;
} finally {
  if (pages) await pages.stop();
  mocks.kill("SIGKILL");
}
process.exit(ok ? 0 : 1);
