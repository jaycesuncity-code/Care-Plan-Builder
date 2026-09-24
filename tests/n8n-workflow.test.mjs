// The n8n workflow's Code node is the thing that formats the office email, and a
// typo in it is only visible when a real lead comes in. It is plain JavaScript
// inside the exported JSON, so it can be run right here against a realistic
// intake payload — the same payload lib/intake/notify.js builds.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { buildNotificationPayload } from "../lib/intake/notify.js";
import { priceSelection } from "../lib/intake/catalog.js";

const here = dirname(fileURLToPath(import.meta.url));
const workflow = JSON.parse(readFileSync(join(here, "..", "n8n", "care-plan-request-notification.json"), "utf8"));

function nodeNamed(name) {
  return workflow.nodes.find((n) => n.name === name);
}

test("the workflow declares the webhook the endpoint posts to", () => {
  const webhook = nodeNamed("Care Plan Request Webhook");
  assert.ok(webhook, "webhook node missing");
  assert.equal(webhook.type, "n8n-nodes-base.webhook");
  assert.equal(webhook.parameters.httpMethod, "POST");
  assert.equal(webhook.parameters.path, "care-plan-request");
  assert.equal(webhook.parameters.authentication, "headerAuth", "must require the X-Webhook-Secret header");
  assert.equal(webhook.parameters.responseMode, "onReceived", "must respond immediately");
});

test("the Outlook node sends to the office inbox as HTML", () => {
  const outlook = nodeNamed("Send Office Email (Outlook)");
  assert.ok(outlook, "Outlook node missing");
  assert.equal(outlook.type, "n8n-nodes-base.microsoftOutlook");
  assert.equal(outlook.parameters.operation, "send");
  assert.equal(outlook.parameters.toRecipients, "service@suncitylc.com");
  assert.equal(outlook.parameters.additionalFields.bodyContentType, "html");
});

test("credentials are placeholders, never real ids", () => {
  for (const node of workflow.nodes) {
    for (const cred of Object.values(node.credentials || {})) {
      assert.match(cred.id, /^REPLACE_WITH_/, `${node.name} carries a non-placeholder credential id`);
    }
  }
});

test("the workflow ships inactive, so importing it cannot start sending mail", () => {
  assert.equal(workflow.active, false);
});

test("the Code node builds the office email from a real intake payload", () => {
  const code = nodeNamed("Build Office Email").parameters.jsCode;

  // Exactly what the Function would send: Premier with paid softener service
  // x2, the matching complimentary salt x2, plus a normal billable add-on.
  const pricing = priceSelection("premier", [
    { id: "wsv", quantity: 2 },
    { id: "mst", quantity: 1 },
  ]);
  const payload = buildNotificationPayload({
    submissionId: 1234,
    submissionNumber: "#1234",
    customer: {
      name: "Dana W & Sons",
      phone: "(575) 555-2093",
      address: "2210 El Paseo Rd, Las Cruces, NM 88001",
      bestTime: "Midday",
    },
    pricing,
    submittedAt: "2026-09-23T18:04:11.000Z",
    dashboardUrl: "https://care-plan-builder.pages.dev",
  });

  const runCodeNode = new Function("$json", `return (function(){${code}})();`);
  const result = runCodeNode({ body: payload });
  const { subject, html, to } = result.json;

  assert.equal(subject, "New Care Plan request: Premier Care Plan - Dana W & Sons");
  assert.equal(to, "service@suncitylc.com");

  // Everything the office needs to work the lead.
  assert.match(html, /Premier Care Plan/, "plan");
  assert.match(html, /#1234/, "submission number");
  assert.match(html, /MT</, "submitted time in Mountain time");
  assert.match(html, /Dana W &amp; Sons/, "name, HTML-escaped");
  assert.match(html, /\(575\) 555-2093/, "phone");
  assert.match(html, /tel:5755552093/, "click-to-call");
  assert.match(html, /2210 El Paseo Rd/, "address");
  assert.match(html, /Midday/, "best time to call");
  assert.match(html, /Water Softener Service &times; 2/, "paid softener service quantity");
  assert.match(html, /\$75 each/, "softener per-unit price");
  assert.match(html, /\$150/, "softener line total");
  assert.match(html, /Water Softener Salt &times; 2/, "paired salt quantity");
  assert.match(html, /Included with plan/, "paired salt is complimentary");
  assert.match(html, /Mini-Split Tune-Up/, "normal paid add-on");
  assert.match(html, /\$80/, "normal add-on line total");
  assert.match(html, /\$600/, "base price");
  assert.match(html, /\$830\/yr/, "annual total: 600 base + 150 + 80");
  assert.match(html, /care-plan-builder\.pages\.dev/, "dashboard link");
  assert.match(html, /no payment was taken/i, "sets the office's expectation");

  // The total in the email must be the server's, not a re-derivation.
  assert.equal(pricing.total, 830);
});

test("the email marks a locked leftover line as not charged", () => {
  const code = nodeNamed("Build Office Email").parameters.jsCode;
  // A plumbing add-on left over after the customer switched to an HVAC plan.
  const pricing = priceSelection("hvac", [
    { id: "qfc", quantity: 1 },
    { id: "twf", quantity: 2 },
  ]);
  const payload = buildNotificationPayload({
    submissionId: 7,
    submissionNumber: "#0007",
    customer: { name: "Test", phone: "5755550142", address: "1 Test St", bestTime: "No preference" },
    pricing,
    submittedAt: new Date().toISOString(),
    dashboardUrl: "https://example.invalid",
  });
  const html = new Function("$json", `return (function(){${code}})();`)({ body: payload }).json.html;

  assert.match(html, /Not charged/, "the locked line is shown but marked as not charged");
  assert.match(html, /Tankless Water Heater Flush/, "the office still sees what the customer had queued");
  assert.match(html, /\$380\/yr/, "the total excludes the locked line");
});
