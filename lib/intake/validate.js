// Cheap, allocation-light validation for the intake payload. Runs BEFORE the
// rate-limit read and the Turnstile round-trip, so obviously-bad requests
// never cost a D1 query or an outbound fetch.
//
// Returns { ok: true, value } or { ok: false, fieldErrors }.

import { MAX_ADDON_QTY, getAddon, getPlan } from "./catalog.js";

export const MAX_BODY_BYTES = 16 * 1024;

export const NAME_MAX = 120;
export const ADDRESS_MAX = 200;
export const PHONE_DIGITS_MIN = 10;
export const PHONE_DIGITS_MAX = 15;

// The builder's <select> sends these four values. "" means the customer made
// no choice, which is a real answer worth keeping — migration 0004 widens the
// best_time CHECK so "Midday" and "No preference" can be stored as-is instead
// of being collapsed into a value the customer never picked.
export const BEST_TIME_MAP = {
  "": "No preference",
  morning: "Morning",
  midday: "Midday",
  afternoon: "Afternoon",
  // Accepted for forward compatibility: already-capitalized values, and the
  // two options the DB allowed before this project existed.
  Morning: "Morning",
  Midday: "Midday",
  Afternoon: "Afternoon",
  Evening: "Evening",
  Anytime: "Anytime",
  "No preference": "No preference",
};

// Mirror of the builder's character class, with a digit-count rule on top.
const PHONE_CHARS_RE = /^[\d\s().+-]+$/;

export function normalizePhone(raw) {
  return String(raw).replace(/\D/g, "");
}

export function validateIntake(body) {
  const fieldErrors = {};

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, fieldErrors: { _form: "Malformed request body." } };
  }

  // --- customer fields ---
  const name = typeof body.customerName === "string" ? body.customerName.trim() : "";
  if (!name) fieldErrors.customerName = "Name is required.";
  else if (name.length > NAME_MAX) fieldErrors.customerName = `Name must be ${NAME_MAX} characters or fewer.`;

  const phoneRaw = typeof body.phone === "string" ? body.phone.trim() : "";
  const phoneDigits = normalizePhone(phoneRaw);
  if (!phoneRaw) {
    fieldErrors.phone = "Phone number is required.";
  } else if (!PHONE_CHARS_RE.test(phoneRaw)) {
    fieldErrors.phone = "Enter a valid phone number.";
  } else if (phoneDigits.length < PHONE_DIGITS_MIN || phoneDigits.length > PHONE_DIGITS_MAX) {
    fieldErrors.phone = "Enter a valid 10-digit phone number.";
  }

  const address = typeof body.address === "string" ? body.address.trim() : "";
  if (!address) fieldErrors.address = "Service address is required.";
  else if (address.length > ADDRESS_MAX) fieldErrors.address = `Address must be ${ADDRESS_MAX} characters or fewer.`;

  const bestTimeRaw = typeof body.bestTime === "string" ? body.bestTime.trim() : "";
  const bestTime = BEST_TIME_MAP[bestTimeRaw];
  if (bestTime === undefined) fieldErrors.bestTime = "Choose one of the listed call times.";

  // --- plan ---
  const planId = typeof body.planId === "string" ? body.planId.trim() : "";
  if (!planId) fieldErrors.planId = "No plan was selected.";
  else if (!getPlan(planId)) fieldErrors.planId = "That plan is not available.";

  // --- add-ons: ids and quantities only; every price is recomputed server-side ---
  const addonsInput = body.addons;
  const addons = [];
  if (addonsInput != null && !Array.isArray(addonsInput)) {
    fieldErrors.addons = "Add-ons must be a list.";
  } else if (Array.isArray(addonsInput)) {
    if (addonsInput.length > 50) {
      fieldErrors.addons = "Too many add-ons.";
    } else {
      for (const entry of addonsInput) {
        if (!entry || typeof entry !== "object") {
          fieldErrors.addons = "Malformed add-on entry.";
          break;
        }
        const item = getAddon(entry.id);
        if (!item) {
          fieldErrors.addons = `Unknown add-on: ${safeLabel(entry.id)}`;
          break;
        }
        const quantity = entry.quantity == null ? 1 : Number(entry.quantity);
        if (!Number.isInteger(quantity) || quantity < 0) {
          fieldErrors.addons = `Invalid quantity for ${item.name}.`;
          break;
        }
        if (quantity > MAX_ADDON_QTY) {
          fieldErrors.addons = `${item.name} is limited to ${MAX_ADDON_QTY}. Call the office for more.`;
          break;
        }
        addons.push({ id: item.id, quantity });
      }
    }
  }

  // --- Turnstile token (verified later; only presence/shape checked here) ---
  const turnstileToken = typeof body.turnstileToken === "string" ? body.turnstileToken.trim() : "";
  if (!turnstileToken) fieldErrors.turnstileToken = "Please complete the verification check.";
  else if (turnstileToken.length > 2048) fieldErrors.turnstileToken = "Verification token was not accepted.";

  if (Object.keys(fieldErrors).length) return { ok: false, fieldErrors };

  return {
    ok: true,
    value: { name, phone: phoneRaw, address, bestTime, planId, addons, turnstileToken },
  };
}

// Keeps a hostile `id` out of the response verbatim.
function safeLabel(value) {
  return String(value == null ? "" : value)
    .replace(/[^\w #-]/g, "")
    .slice(0, 40);
}
