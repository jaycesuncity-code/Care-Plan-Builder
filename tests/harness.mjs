// Process + assertion plumbing shared by the integration and e2e runners.
// Starts the mock services and `wrangler pages dev` against a local D1, and
// gives the tests a tiny assert/report helper.

import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const MOCK_PORT = 8799;
export const PAGES_PORT = 8788;
export const BASE = `http://127.0.0.1:${PAGES_PORT}`;
export const MOCK_BASE = `http://127.0.0.1:${MOCK_PORT}`;

export const TURNSTILE_PASS = "1x0000000000000000000000000000000AA";
export const TURNSTILE_FAIL = "2x0000000000000000000000000000000AA";
export const TURNSTILE_SPENT = "3x0000000000000000000000000000000AA";

const env = {
  ...process.env,
  WRANGLER_SEND_METRICS: "false",
  CI: "1",
  NO_COLOR: "1",
};

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function run(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"], ...options });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

// `npx wrangler` is a wrapper process: signalling it does not stop the wrangler
// child holding the port, and a stale server would silently answer the next
// group's requests with the previous group's config. Every server is started in
// its own process group, killed as a group, and the port is confirmed free
// before the next one starts.
export async function waitForPortFree(url, { timeoutMs = 20000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fetch(url, { signal: AbortSignal.timeout(1000) });
    } catch {
      return true; // nothing listening
    }
    await sleep(250);
  }
  throw new Error(`port still in use: ${url}`);
}

export async function waitForHttp(url, { timeoutMs = 60000, expectStatus } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (!expectStatus || res.status === expectStatus) return true;
      lastError = new Error(`status ${res.status}`);
    } catch (err) {
      lastError = err;
    }
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${url}: ${lastError && lastError.message}`);
}

// --- local D1 ---------------------------------------------------------------

export async function applyMigrations() {
  const result = await run("npx", ["wrangler", "d1", "migrations", "apply", "care-plan-builder", "--local"]);
  if (result.code !== 0) {
    throw new Error(`migrations failed:\n${result.stdout}\n${result.stderr}`);
  }
  return result;
}

export async function d1(sql) {
  const result = await run("npx", [
    "wrangler",
    "d1",
    "execute",
    "care-plan-builder",
    "--local",
    "--json",
    "--command",
    sql,
  ]);
  if (result.code !== 0) throw new Error(`d1 failed for "${sql}":\n${result.stderr || result.stdout}`);
  const jsonStart = result.stdout.indexOf("[");
  if (jsonStart === -1) return [];
  try {
    const parsed = JSON.parse(result.stdout.slice(jsonStart));
    return parsed[0] && parsed[0].results ? parsed[0].results : [];
  } catch {
    return [];
  }
}

// Back to just the four seed rows, with the rate-limit table empty.
export async function resetData() {
  await d1("DELETE FROM submission_addons WHERE submission_id > 4");
  await d1("DELETE FROM submission_notes WHERE submission_id > 4");
  await d1("DELETE FROM submissions WHERE id > 4");
  await d1("DELETE FROM intake_rate_limit");
}

// --- servers ----------------------------------------------------------------

export function startMocks() {
  const child = spawn("node", [join(ROOT, "tests", "mock-services.mjs"), String(MOCK_PORT)], {
    cwd: ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", () => {});
  child.stderr.on("data", (d) => process.stderr.write(`[mock] ${d}`));
  return child;
}

/**
 * Writes .dev.vars (gitignored) and starts `wrangler pages dev`.
 * Returns { child, stop() }.
 */
export async function startPagesDev(vars, { quiet = true } = {}) {
  const merged = {
    TURNSTILE_SECRET: TURNSTILE_PASS,
    TURNSTILE_VERIFY_URL: `${MOCK_BASE}/turnstile/siteverify`,
    N8N_WEBHOOK_URL: `${MOCK_BASE}/webhook/care-plan-request`,
    N8N_WEBHOOK_SECRET: "test-webhook-secret",
    IP_HASH_SALT: "test-salt",
    DASHBOARD_URL: BASE,
    ALLOWED_ORIGINS: `${BASE},https://youknowsuncity.com`,
    RATE_LIMIT_MAX: "50",
    RATE_LIMIT_WINDOW_SECONDS: "600",
    ...vars,
  };

  writeFileSync(
    join(ROOT, ".dev.vars"),
    Object.entries(merged)
      .map(([k, v]) => `${k}="${v}"`)
      .join("\n") + "\n"
  );

  await waitForPortFree(`${BASE}/`);

  const child = spawn(
    "npx",
    ["wrangler", "pages", "dev", "public", "--port", String(PAGES_PORT), "--ip", "127.0.0.1"],
    { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"], detached: true }
  );
  let log = "";
  child.stdout.on("data", (d) => {
    log += d;
    if (!quiet) process.stdout.write(`[pages] ${d}`);
  });
  child.stderr.on("data", (d) => {
    log += d;
    if (!quiet) process.stderr.write(`[pages] ${d}`);
  });

  try {
    await waitForHttp(`${BASE}/`, { timeoutMs: 90000 });
  } catch (err) {
    killGroup(child, "SIGKILL");
    throw new Error(`${err.message}\n--- wrangler output ---\n${log.slice(-4000)}`);
  }

  return {
    child,
    log: () => log,
    async stop() {
      killGroup(child, "SIGTERM");
      try {
        await waitForPortFree(`${BASE}/`, { timeoutMs: 8000 });
      } catch {
        killGroup(child, "SIGKILL");
        await waitForPortFree(`${BASE}/`, { timeoutMs: 10000 });
      }
    },
  };
}

function killGroup(child, signal) {
  try {
    process.kill(-child.pid, signal); // negative pid = the whole process group
  } catch {
    try {
      child.kill(signal);
    } catch {
      /* already gone */
    }
  }
}

export async function mockReset() {
  await fetch(`${MOCK_BASE}/_mock/reset`, { method: "POST" });
}

export async function mockMode(mode) {
  await fetch(`${MOCK_BASE}/_mock/mode`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode }),
  });
}

export async function mockReceived() {
  const res = await fetch(`${MOCK_BASE}/_mock/received`);
  return res.json();
}

// --- tiny test reporter -----------------------------------------------------

export const results = { passed: 0, failed: 0, failures: [] };

export function check(label, condition, detail) {
  if (condition) {
    results.passed++;
    console.log(`  ✓ ${label}`);
  } else {
    results.failed++;
    results.failures.push(label);
    console.log(`  ✗ ${label}${detail ? `\n      ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  }
}

export function checkEqual(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  check(label, ok, ok ? null : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

export function group(name) {
  console.log(`\n${name}`);
}

export function summary() {
  console.log(`\n${results.failed === 0 ? "PASS" : "FAIL"} — ${results.passed} passed, ${results.failed} failed`);
  if (results.failures.length) {
    console.log("failures:");
    for (const f of results.failures) console.log(`  - ${f}`);
  }
  return results.failed === 0;
}

// --- request helpers --------------------------------------------------------

export const VALID_LEAD = {
  customerName: "Sandbox Tester",
  phone: "(575) 555-0142",
  address: "100 Sandbox Ln, Las Cruces, NM 88001",
  bestTime: "morning",
  turnstileToken: "dummy-token",
};

export async function postIntake(body, { origin, ip, headers } = {}) {
  const res = await fetch(`${BASE}/api/care-plan-request`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(origin ? { Origin: origin } : {}),
      ...(ip ? { "CF-Connecting-IP": ip } : {}),
      ...(headers || {}),
    },
    body: JSON.stringify(body),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* no body */
  }
  return { status: res.status, headers: res.headers, body: json };
}

export function fixturesDir() {
  const dir = join(ROOT, "tests", ".tmp");
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function cleanupTmp() {
  rmSync(join(ROOT, "tests", ".tmp"), { recursive: true, force: true });
}
