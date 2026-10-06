// Drives the real Care Plan Builder page in Chromium: plan/add-on selection,
// the lead modal, the Turnstile lifecycle, a real submission through the real
// endpoint into the local D1, the 429 message, and the dashboard rendering the
// resulting row.
//
//   npm i -D playwright && npx playwright install chromium
//   npm run test:e2e
//
// Turnstile: challenges.cloudflare.com is NOT called. The API script request is
// intercepted and fulfilled with a stub that implements the same
// render/reset/getResponse contract, which is what this page's code actually
// talks to. That keeps the test hermetic and still exercises every line of the
// wiring (explicit render on open, reset on close and on failure, token
// attached to the payload). The dummy SITEKEY/secret pair is verified for real
// against Cloudflare's documented sandbox semantics in tests/run-integration.mjs.
//
// Images: /img/* isn't in the repo (it's uploaded to WordPress separately), so
// tiny stand-ins are generated before the run and deleted afterwards.

import { mkdirSync, writeFileSync, existsSync, rmSync, readdirSync, rmdirSync } from "node:fs";
import { join } from "node:path";

import {
  BASE,
  ROOT,
  VALID_LEAD,
  applyMigrations,
  check,
  checkEqual,
  d1,
  group,
  mockReset,
  resetData,
  sleep,
  startMocks,
  startPagesDev,
  summary,
} from "./harness.mjs";

// --- stand-in images --------------------------------------------------------

const IMG_DIR = join(ROOT, "public", "img");
const IMAGE_NAMES = [
  "addon-bigbluefilter.jpg",
  "addon-filterchange.jpg",
  "addon-hvaccount.jpg",
  "addon-minisplit.jpg",
  "addon-reverseosmosis.jpg",
  "addon-softenersalt.jpg",
  "addon-softenerservice.jpg",
  "addon-tanklessflush.jpg",
  "addon-waterheatercount.jpg",
  "background.png",
  "bundled.JPG",
  "general-plumbing.JPG",
  "hvac.JPG",
  "premier.JPG",
  "question-mark-icon.png",
];

// 1x1 PNG, served under every name (browsers sniff content, not extension).
const ONE_PX_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
  "base64"
);

function writeStandInImages() {
  const created = [];
  const dirExisted = existsSync(IMG_DIR);
  mkdirSync(IMG_DIR, { recursive: true });
  for (const name of IMAGE_NAMES) {
    const path = join(IMG_DIR, name);
    if (existsSync(path)) continue; // never clobber a real image
    writeFileSync(path, ONE_PX_PNG);
    created.push(path);
  }
  return { created, dirExisted };
}

function removeStandInImages({ created, dirExisted }) {
  for (const path of created) rmSync(path, { force: true });
  if (!dirExisted && existsSync(IMG_DIR) && readdirSync(IMG_DIR).length === 0) rmdirSync(IMG_DIR);
}

// --- Turnstile stub ---------------------------------------------------------

const TURNSTILE_STUB = `
(function () {
  window.__turnstile = { renders: [], resets: [], removes: [], tokenSerial: 0 };
  var widgets = {};
  var nextId = 0;
  window.turnstile = {
    render: function (container, options) {
      var id = 'stub-widget-' + (++nextId);
      var el = typeof container === 'string' ? document.querySelector(container) : container;
      window.__turnstile.renders.push({
        id: id,
        sitekey: options && options.sitekey,
        visible: !!(el && el.offsetParent !== null),
        hasErrorCallback: !!(options && options['error-callback']),
        hasExpiredCallback: !!(options && options['expired-callback'])
      });
      widgets[id] = 'stub-token-' + (++window.__turnstile.tokenSerial);
      if (el) el.setAttribute('data-stub-widget', id);
      return id;
    },
    reset: function (id) {
      window.__turnstile.resets.push(id);
      // A real reset invalidates the old token and issues a fresh one later.
      widgets[id] = 'stub-token-' + (++window.__turnstile.tokenSerial);
    },
    remove: function (id) { window.__turnstile.removes.push(id); delete widgets[id]; },
    getResponse: function (id) { return widgets[id] || ''; }
  };
})();
`;

async function stubTurnstile(page) {
  await page.route(/challenges\.cloudflare\.com\/turnstile\/v0\/api\.js.*/, (route) =>
    route.fulfill({ status: 200, contentType: "application/javascript", body: TURNSTILE_STUB })
  );
}

// ---------------------------------------------------------------------------

let playwright;
try {
  playwright = await import("playwright");
} catch {
  console.error(
    "playwright is not installed. This suite is optional:\n" +
      "  npm i -D playwright && npx playwright install chromium\n" +
      "then re-run: npm run test:e2e"
  );
  process.exit(2);
}

const launchOptions = {};
const preinstalled = "/opt/pw-browsers/chromium";
if (existsSync(preinstalled)) launchOptions.executablePath = preinstalled;

const images = writeStandInImages();
const mocks = startMocks();
let pages = null;
let browser = null;

async function fillLead(page, overrides = {}) {
  const lead = { ...VALID_LEAD, ...overrides };
  await page.fill("#cpbLeadName", lead.customerName);
  await page.fill("#cpbLeadPhone", lead.phone);
  await page.fill("#cpbLeadAddress", lead.address);
  if (lead.bestTime !== undefined) {
    await page.click("#cpbLeadBestTimeButton");
    await page.click(`#cpbLeadBestTimeList [data-value="${lead.bestTime}"]`);
  }
  await page.check("#cpbLeadAck");
}

async function main() {
  await sleep(400);
  console.log("applying migrations to the local D1…");
  await applyMigrations();
  await resetData();
  await mockReset();

  // RATE_LIMIT_MAX=1 so the second real submission trips the 429 path in the UI.
  pages = await startPagesDev({ RATE_LIMIT_MAX: "1", RATE_LIMIT_WINDOW_SECONDS: "600" });
  browser = await playwright.chromium.launch(launchOptions);
  const context = await browser.newContext({ viewport: { width: 1280, height: 780 } });
  const page = await context.newPage();

  // Two different things worth watching, kept apart:
  //   jsErrors      — uncaught exceptions in the page's own code. Must be zero.
  //   failedLocal   — failed requests to THIS origin. Must be zero (a blocked
  //                   external font/CDN in a sandboxed test container is not a
  //                   defect, and the 429 below is deliberate).
  const jsErrors = [];
  const failedLocal = [];
  page.on("pageerror", (err) => jsErrors.push(String(err)));
  page.on("console", (msg) => {
    if (msg.type() === "error" && !/Failed to load resource/i.test(msg.text())) jsErrors.push(msg.text());
  });
  page.on("requestfailed", (req) => {
    if (req.url().startsWith(BASE)) failedLocal.push(`${req.method()} ${req.url()} — ${req.failure()?.errorText}`);
  });

  await stubTurnstile(page);

  group("E2E 1 — the builder loads and prices a selection");
  await page.goto(`${BASE}/memberships/`, { waitUntil: "networkidle" });
  check("the builder block rendered", (await page.locator("#sc-cpb").count()) === 1);

  // Premier starts with no phantom complimentary lines.
  await page.click('[data-plan="premier"]');
  await page.waitForTimeout(250);
  checkEqual("Premier starts with no active included add-on cards", await page.locator(".cpb-addon.is-included").count(), 0);

  // Paid Water Softener Service controls the complimentary salt quantity 1:1.
  await page.click('[data-addon="wsv"]');
  await page.waitForTimeout(150);
  let selection = JSON.parse(await page.locator("#sc-cpb").getAttribute("data-selection"));
  let wsvLine = selection.addons.find((a) => a.id === "wsv");
  let wssLine = selection.addons.find((a) => a.id === "wss");
  checkEqual("Premier softener service x1 is paid", wsvLine.lineTotal, 75);
  checkEqual("Premier salt x1 is included", wssLine.quantity, 1);
  checkEqual("Premier salt x1 is $0", wssLine.lineTotal, 0);
  check("Premier salt is marked included", wssLine.includedFree === true, wssLine);

  await page.click('[data-addon="wsv"] [data-qty-plus="wsv"]');
  await page.waitForTimeout(100);
  selection = JSON.parse(await page.locator("#sc-cpb").getAttribute("data-selection"));
  wsvLine = selection.addons.find((a) => a.id === "wsv");
  wssLine = selection.addons.find((a) => a.id === "wss");
  checkEqual("increasing softener service updates paid quantity", wsvLine.quantity, 2);
  checkEqual("increasing softener service updates salt quantity", wssLine.quantity, 2);
  checkEqual("softener service x2 costs $150", wsvLine.lineTotal, 150);

  await page.click('[data-addon="wsv"] [data-qty-minus="wsv"]');
  await page.waitForTimeout(100);
  selection = JSON.parse(await page.locator("#sc-cpb").getAttribute("data-selection"));
  checkEqual("decreasing softener service updates salt quantity", selection.addons.find((a) => a.id === "wss").quantity, 1);

  await page.click('[data-line="wsv"] [data-remove="wsv"]');
  await page.waitForTimeout(100);
  selection = JSON.parse(await page.locator("#sc-cpb").getAttribute("data-selection"));
  checkEqual("removing softener service removes complimentary salt", selection.addons.filter((a) => a.id === "wss").length, 0);

  // Stale paid salt from Plumbing must not duplicate/charge after switching to Premier.
  await page.click('[data-plan="plumbing"]');
  await page.click('[data-addon="wss"]');
  await page.waitForTimeout(100);
  await page.click('[data-plan="premier"]');
  await page.waitForTimeout(150);
  selection = JSON.parse(await page.locator("#sc-cpb").getAttribute("data-selection"));
  checkEqual("switching Plumbing to Premier leaves no duplicate salt line", selection.addons.filter((a) => a.id === "wss").length, 0);

  // Add a billable HVAC add-on and raise the HVAC system count to 3.
  await page.click('[data-addon="mst"]');
  await page.click('[data-coverage-qty="hvacSystems"] [data-qty-plus="hvacSystems"]');
  await page.click('[data-coverage-qty="hvacSystems"] [data-qty-plus="hvacSystems"]');
  await page.waitForTimeout(250);

  selection = JSON.parse(await page.locator("#sc-cpb").getAttribute("data-selection"));
  checkEqual("plan in the on-page payload", selection.plan, "Premier Care Plan");
  // 600 + Mini-Split 80 + 2 additional HVAC systems (2 x 125)
  checkEqual("the builder's own total", selection.total, 930);

  group("E2E 2 — the lead modal and the Turnstile lifecycle");
  await page.click('[data-cpb="cta"]');
  await page.waitForSelector("#cpbLeadModal:not([hidden])");
  await page.waitForTimeout(300);

  let turnstileState = await page.evaluate(() => window.__turnstile);
  checkEqual("the widget is rendered exactly once on open", turnstileState.renders.length, 1);
  checkEqual(
    "it is rendered with the sandbox sitekey from TURNSTILE_SITEKEY",
    turnstileState.renders[0].sitekey,
    "1x00000000000000000000AA"
  );
  check(
    "it is rendered only once the container is visible",
    turnstileState.renders[0].visible === true,
    turnstileState.renders[0]
  );
  check("an expired-callback is registered", turnstileState.renders[0].hasExpiredCallback);

  const recapText = await page.locator("#cpbLeadRecap").innerText();
  check("the recap names the plan", /Premier Care Plan/.test(recapText), recapText);
  check("the canonical recap has no phantom salt/RO service", !/Water Softener Salt|Reverse Osmosis Service/.test(recapText), recapText);
  check("the recap shows the annual total", /\$930/.test(recapText), recapText);

  // Closing must reset the widget: a token is single-use.
  check(
    "the modal scrolls rather than clipping its own close button on a short viewport",
    await page.evaluate(() => {
      const modal = document.querySelector("#cpbLeadModal");
      return getComputedStyle(modal).overflowY === "auto";
    })
  );
  await page.click("#cpbLeadModal .cpb-modal-close");
  await page.waitForTimeout(200);
  turnstileState = await page.evaluate(() => window.__turnstile);
  check("closing the modal resets the widget", turnstileState.resets.length >= 1, turnstileState);

  await page.click('[data-cpb="cta"]');
  await page.waitForSelector("#cpbLeadModal:not([hidden])");
  await page.waitForTimeout(250);
  turnstileState = await page.evaluate(() => window.__turnstile);
  checkEqual("re-opening reuses the same widget instead of stacking another", turnstileState.renders.length, 1);

  group("E2E 3 — client-side validation runs before any request");
  let requestCount = 0;
  page.on("request", (req) => {
    if (req.url().includes("/api/care-plan-request") && req.method() === "POST") requestCount++;
  });
  await page.click("#cpbLeadSubmitBtn");
  await page.waitForTimeout(300);
  checkEqual("an empty form sends nothing", requestCount, 0);
  check("the name error is shown", (await page.locator("#cpbLeadNameErr").innerText()).length > 0);
  check("the phone error is shown", (await page.locator("#cpbLeadPhoneErr").innerText()).length > 0);
  check("the acknowledgement error is shown", (await page.locator("#cpbLeadAckErr").innerText()).length > 0);

  await page.fill("#cpbLeadPhone", "555-0142");
  await page.fill("#cpbLeadName", "Sandbox Tester");
  await page.fill("#cpbLeadAddress", "100 Sandbox Ln");
  await page.check("#cpbLeadAck");
  await page.click("#cpbLeadSubmitBtn");
  await page.waitForTimeout(300);
  checkEqual("a 7-digit phone still sends nothing", requestCount, 0);
  check(
    "the client now asks for 10 digits, matching the server",
    /10-digit/.test(await page.locator("#cpbLeadPhoneErr").innerText())
  );

  group("E2E 4 — a missing Turnstile token blocks submission");
  await page.evaluate(() => {
    // Simulate a widget that has not been solved yet.
    window.turnstile.getResponse = () => "";
  });
  await fillLead(page);
  await page.click("#cpbLeadSubmitBtn");
  await page.waitForTimeout(300);
  checkEqual("nothing is sent without a token", requestCount, 0);
  check(
    "the customer is asked to complete the check",
    /verification check/i.test(await page.locator("#cpbLeadTurnstileErr").innerText())
  );

  group("E2E 5 — a real submission, end to end");
  await page.evaluate(() => {
    window.turnstile.getResponse = (id) => "stub-token-real";
  });
  await fillLead(page, { bestTime: "midday" });
  await page.click("#cpbLeadSubmitBtn");
  await page.waitForSelector("#cpbLeadConfirm:not([hidden])", { timeout: 15000 });
  checkEqual("the POST was sent once", requestCount, 1);
  const confirmText = await page.locator("#cpbLeadConfirm").innerText();
  check("the confirmation says no payment was taken", /No payment has been taken/i.test(confirmText), confirmText);
  check("the form is hidden after success", await page.locator("#cpbLeadForm").isHidden());

  const rows = await d1("SELECT * FROM submissions WHERE id > 4 ORDER BY id DESC LIMIT 1");
  const row = rows[0];
  check("a row reached D1", !!row, rows);
  checkEqual("the plan was derived server-side", row.plan, "Premier Care Plan");
  checkEqual("the base price is the catalog's", row.base_price, 600);
  checkEqual("the add-on total is the server's (80 + 2 x 125)", row.addon_total, 330);
  checkEqual("the total matches the builder's on-screen figure", row.total_price, 930);
  checkEqual("'midday' survived as Midday", row.best_time, "Midday");
  checkEqual("the customer's name was stored", row.name, VALID_LEAD.customerName);

  const addonRows = await d1(
    `SELECT addon_name, addon_price, quantity, included_free, locked FROM submission_addons WHERE submission_id = ${row.id} ORDER BY id`
  );
  checkEqual("two add-on rows: mini-split + system count", addonRows.length, 2);
  checkEqual("the equipment-count row keeps the total count", addonRows.find((a) => a.addon_name.startsWith("# of HVAC")).quantity, 3);
  checkEqual(
    "the equipment-count row bills only the additional units",
    addonRows.find((a) => a.addon_name.startsWith("# of HVAC")).addon_price,
    250
  );
  checkEqual("canonical Premier D1 row has no phantom included lines", addonRows.filter((a) => a.included_free).length, 0);

  group("E2E 6 — the 429 message the customer actually sees");
  // RATE_LIMIT_MAX is 1 for this run, so the next submission is rate limited.
  // Close the confirmation first, the way a customer would.
  await page.keyboard.press("Escape");
  await page.waitForSelector("#cpbLeadModal", { state: "hidden" });
  await page.click('[data-cpb="cta"]');
  await page.waitForSelector("#cpbLeadModal:not([hidden])");
  await page.evaluate(() => {
    window.turnstile.getResponse = () => "stub-token-second";
  });
  await fillLead(page);
  const resetsBefore = (await page.evaluate(() => window.__turnstile)).resets.length;
  await page.click("#cpbLeadSubmitBtn");
  await page.waitForFunction(() => {
    const el = document.querySelector("#cpbLeadFormError");
    return el && !el.hidden && el.textContent.trim().length > 0;
  }, { timeout: 15000 });

  const errorText = await page.locator("#cpbLeadFormError").innerText();
  check("the 429 gets its own specific message", /already received several requests/i.test(errorText), errorText);
  check("it tells the customer how long to wait", /wait about \d+ minute/i.test(errorText), errorText);
  check("it offers the office phone number", /575-526-9758/.test(errorText), errorText);
  check("the form is still usable", await page.locator("#cpbLeadForm").isVisible());
  checkEqual("the submit button is re-enabled", await page.locator("#cpbLeadSubmitBtn").isDisabled(), false);
  const resetsAfter = (await page.evaluate(() => window.__turnstile)).resets.length;
  check("the spent token was reset after the failure", resetsAfter > resetsBefore, { resetsBefore, resetsAfter });

  group("E2E 7 — the dashboard renders the new submission");
  const dash = await context.newPage();
  const dashErrors = [];
  const dashFailedLocal = [];
  dash.on("pageerror", (err) => dashErrors.push(String(err)));
  dash.on("console", (msg) => {
    if (msg.type() === "error" && !/Failed to load resource/i.test(msg.text())) dashErrors.push(msg.text());
  });
  dash.on("requestfailed", (req) => {
    if (req.url().startsWith(BASE)) dashFailedLocal.push(`${req.method()} ${req.url()} — ${req.failure()?.errorText}`);
  });
  await dash.goto(`${BASE}/`, { waitUntil: "networkidle" });
  await dash.waitForSelector(`tr[data-id="${row.id}"]`, { timeout: 15000 });
  check("the new lead appears in the queue", (await dash.locator(`tr[data-id="${row.id}"]`).count()) === 1);

  await dash.click(`tr[data-id="${row.id}"]`);
  await dash.waitForTimeout(400);
  checkEqual("the detail modal shows the customer", await dash.locator("#modalName").innerText(), VALID_LEAD.customerName);
  checkEqual("it shows the stored call time verbatim", await dash.locator("#modalBestTime").innerText(), "Midday");
  const priceTable = await dash.locator("#modalPriceTable").innerText();
  check("the price table renders the plan base", /Premier Care Plan \(base\)/.test(priceTable), priceTable);
  check("canonical dashboard detail has no phantom water-treatment lines", !/Water Softener Salt|Reverse Osmosis Service/.test(priceTable), priceTable);
  check("it shows the equipment count with its quantity", /# of HVAC Systems/.test(priceTable), priceTable);
  check("it shows the server-computed total", /\$930/.test(priceTable), priceTable);
  checkEqual("the dashboard threw no JS errors rendering it", dashErrors, []);
  checkEqual("no dashboard request to this origin failed", dashFailedLocal, []);

  group("E2E 8 — no page errors anywhere in the builder run");
  checkEqual("the builder threw no JS errors", jsErrors, []);
  checkEqual("no builder request to this origin failed", failedLocal, []);
}

let ok = false;
try {
  await main();
  ok = summary();
} catch (err) {
  console.error("\ne2e error:", err && err.stack ? err.stack : err);
  ok = false;
} finally {
  if (browser) await browser.close().catch(() => {});
  if (pages) await pages.stop();
  mocks.kill("SIGKILL");
  removeStandInImages(images);
}
process.exit(ok ? 0 : 1);
