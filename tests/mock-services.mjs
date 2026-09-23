// Local stand-ins for the two outbound services the intake endpoint talks to:
//
//   POST /webhook/care-plan-request   -> the n8n webhook
//   POST /turnstile/siteverify        -> Cloudflare's Turnstile siteverify
//
// The siteverify mock implements Cloudflare's documented sandbox-secret
// behaviour, so the endpoint's real code path is exercised with the real
// semantics without needing outbound network access:
//   1x0000000000000000000000000000000AA -> always passes
//   2x0000000000000000000000000000000AA -> always fails (invalid-input-response)
//   3x0000000000000000000000000000000AA -> token already spent
//                                          (timeout-or-duplicate)
//
// Behaviour knobs, via query string on the URL the Function is pointed at, or
// via the control endpoints below:
//   /webhook/care-plan-request?mode=ok|down|timeout|500
//
// Usage: node tests/mock-services.mjs [port]
//   GET  /_mock/received   -> every webhook call captured, newest last
//   POST /_mock/reset      -> clear captured calls
//   POST /_mock/mode       -> { "mode": "down" } switch webhook behaviour

import { createServer } from "node:http";

const port = Number(process.argv[2] || 8799);

const state = {
  webhookMode: "ok",
  received: [],
  siteverifyCalls: [],
};

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
  res.end(payload);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${port}`);

  if (url.pathname === "/_mock/received" && req.method === "GET") {
    return json(res, 200, { mode: state.webhookMode, received: state.received, siteverifyCalls: state.siteverifyCalls });
  }

  if (url.pathname === "/_mock/reset" && req.method === "POST") {
    state.received = [];
    state.siteverifyCalls = [];
    state.webhookMode = "ok";
    return json(res, 200, { ok: true });
  }

  if (url.pathname === "/_mock/mode" && req.method === "POST") {
    const body = await readBody(req);
    try {
      state.webhookMode = JSON.parse(body).mode || "ok";
    } catch {
      return json(res, 400, { ok: false });
    }
    return json(res, 200, { ok: true, mode: state.webhookMode });
  }

  // --- Turnstile siteverify -------------------------------------------------
  if (url.pathname === "/turnstile/siteverify") {
    const body = await readBody(req);
    // FormData arrives as multipart; pull the two fields out without a parser.
    const secret = (body.match(/name="secret"\r?\n\r?\n([^\r\n]*)/) || [])[1] || "";
    const token = (body.match(/name="response"\r?\n\r?\n([^\r\n]*)/) || [])[1] || "";
    state.siteverifyCalls.push({ secret: secret.slice(0, 4) + "…", tokenLength: token.length });

    if (!token) return json(res, 200, { success: false, "error-codes": ["missing-input-response"] });

    if (secret === "2x0000000000000000000000000000000AA") {
      return json(res, 200, { success: false, "error-codes": ["invalid-input-response"] });
    }
    if (secret === "3x0000000000000000000000000000000AA") {
      return json(res, 200, { success: false, "error-codes": ["timeout-or-duplicate"] });
    }
    if (secret === "1x0000000000000000000000000000000AA") {
      return json(res, 200, {
        success: true,
        challenge_ts: new Date().toISOString(),
        hostname: "localhost",
        action: "",
        cdata: "",
      });
    }
    return json(res, 200, { success: false, "error-codes": ["invalid-input-secret"] });
  }

  // --- n8n webhook ----------------------------------------------------------
  if (url.pathname === "/webhook/care-plan-request") {
    const mode = url.searchParams.get("mode") || state.webhookMode;

    if (mode === "down") {
      // Hard refusal, like a paused/unregistered n8n workflow.
      res.destroy();
      return;
    }
    if (mode === "timeout") {
      // Never answers. The Function's AbortSignal.timeout must give up.
      return;
    }

    const body = await readBody(req);
    let parsed = null;
    try {
      parsed = JSON.parse(body);
    } catch {
      /* keep raw */
    }
    state.received.push({
      at: new Date().toISOString(),
      secret: req.headers["x-webhook-secret"] || null,
      contentType: req.headers["content-type"] || null,
      payload: parsed,
      raw: parsed ? undefined : body,
    });

    if (mode === "500") return json(res, 500, { message: "Workflow could not be started" });
    // n8n's "respond immediately" mode answers with this shape.
    return json(res, 200, { message: "Workflow was started" });
  }

  return json(res, 404, { ok: false, error: "no mock route" });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`mock-services listening on http://127.0.0.1:${port}`);
});
