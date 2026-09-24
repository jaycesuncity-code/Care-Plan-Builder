# Care Plan Builder — LiveCanvas Find/Replace walkthrough

Fourteen edits to bring the hand-maintained LiveCanvas copy of the Builder in line with
the sandbox version. Nothing else in the block changes.

**How to use this:** work top to bottom. Each step has an exact **Find this** block and
an exact **Replace with** block. Before replacing, search the block for the *Find this*
text and confirm the match count — every step says what it should be, and it is **1**
for all fourteen. If a count comes back 0 or 2+, stop and check whether that step was
already applied, rather than guessing.

Steps 1–3 are marked **[Optional]**: they are bug fixes, not part of the intake wiring.
I'd still take them — 1 and 2 matter more now that the form is taller, and 3 is a
visible bug on the success screen. Steps 4–14 are **[Required]**: the form will not
submit without them.

Copy the replacement blocks verbatim, including comments and indentation. Indentation is
two spaces per level, matching the file.

---

## 1. [Optional] Let a tall modal scroll — CSS

The lead modal is `position: fixed` with `align-items: center` and no scroll. Once the
Turnstile widget makes the card taller than a short viewport (a phone in landscape, a
laptop with a big browser toolbar), the card overflows off-screen with no way to reach
it — including its own close button in the top-right. Expected matches: **1**

**Find this**

```css
#sc-cpb .cpb-modal { position: fixed; inset: 0; z-index: 1000; display: flex; align-items: center; justify-content: center; padding: 20px; }
```

**Replace with**

```css
/* overflow-y + margin:auto on the card: the lead modal is now tall enough (with
   the Turnstile widget) to exceed a short viewport, and a fixed, centered flex
   child with no scroll clips off-screen — including its own close button. */
#sc-cpb .cpb-modal { position: fixed; inset: 0; z-index: 1000; display: flex; align-items: center; justify-content: center; padding: 20px; overflow-y: auto; }
```

## 2. [Optional] Keep the card centred while it scrolls — CSS

The other half of step 1. `margin: auto` on the flex child keeps a short card centred
and stops a tall one from being clipped at the top once the overlay scrolls. This rule
is shared with the add-on info modal, which gets the same improvement.
Expected matches: **1**

**Find this**

```css
  position: relative; z-index: 1; width: min(420px, 100%);
```

**Replace with**

```css
  position: relative; z-index: 1; width: min(420px, 100%); margin: auto;
```

## 3. [Optional] Actually hide the form after a successful send — CSS

`.cpb-lead-form { display: flex }` outranks the browser's built-in
`[hidden] { display: none }`, so `form.hidden = true` on success never hid anything: the
customer saw the confirmation *and* the still-filled form with an active "Send My
Request" button. A second click would fail, because a Turnstile token is single-use.
This is the same guard the file already uses for `.cpb-modal[hidden]` and
`.cpb-lock-banner[hidden]`. Expected matches: **1**

**Find this**

```css
.cpb-lead-form { display: flex; flex-direction: column; gap: .9rem; }
```

**Replace with**

```css
.cpb-lead-form { display: flex; flex-direction: column; gap: .9rem; }
/* `display: flex` above outranks the browser's own [hidden] { display: none },
   so form.hidden = true on success did not actually hide the form: the customer
   saw the confirmation AND the filled-in form with an active Send button, and a
   second click would fail (the Turnstile token is single-use). Same guard the
   file already uses for .cpb-modal[hidden] and .cpb-lock-banner[hidden]. */
.cpb-lead-form[hidden] { display: none; }
```

## 4. [Required] The Turnstile container and script — HTML

Replaces the placeholder container and the commented-out script tag. The widget is
rendered explicitly from JS (step 6) because the modal starts hidden and an implicit
`class="cf-turnstile"` render against a hidden container does not produce a usable
widget. Expected matches: **1**

**Find this**

```html
        <!-- Cloudflare Turnstile placeholder. TODO: replace data-sitekey with the real site key and uncomment the script tag before this goes live. -->
        <div class="cf-turnstile" data-sitekey="TODO-REPLACE-WITH-REAL-SITE-KEY"></div>
        <!-- <script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script> -->
```

**Replace with**

```html
        <!-- Cloudflare Turnstile. Rendered EXPLICITLY from JS when this modal opens:
             the modal starts hidden, and an implicit (class="cf-turnstile") render
             against a hidden container does not produce a usable widget. The site
             key lives in TURNSTILE_SITEKEY, next to SUBMIT_ENDPOINT below, so going
             live is a find-and-replace on one line. -->
        <div class="cpb-lead-field cpb-lead-turnstile">
          <div id="cpbTurnstile"></div>
          <span class="cpb-lead-error" id="cpbLeadTurnstileErr" role="alert"></span>
        </div>
        <script src="https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit" async defer></script>
```

> **LiveCanvas note:** this step inserts a `<script>` tag. Paste it in the code editor,
> not the visual editor, and save once — some visual editors strip script tags on a
> WYSIWYG round-trip. After saving, re-open the block and confirm the tag is still
> there before moving on.

## 5. [Required] The two launch constants — JS

Puts `TURNSTILE_SITEKEY` next to `SUBMIT_ENDPOINT`, so going live is a find-and-replace
on two adjacent lines. Expected matches: **1**

**Find this**

```js
  // TODO: point at the real Worker/D1 intake endpoint once it exists. This name is a placeholder —
  // nothing in the project docs has settled on the actual route yet.
  var SUBMIT_ENDPOINT = '/api/care-plan-request';
```

**Replace with**

```js
  /* ================= LAUNCH CONFIG — the only two lines to swap ================= */
  /* Sandbox: same-origin path on the Pages project. At launch the builder runs on
     youknowsuncity.com (WordPress, not on Cloudflare) and posts CROSS-ORIGIN to the
     public intake project, so this becomes an absolute https:// URL and that origin
     must be listed in the endpoint's ALLOWED_ORIGINS. */
  var SUBMIT_ENDPOINT = '/api/care-plan-request';

  /* Cloudflare Turnstile site key. 1x00000000000000000000AA is Cloudflare's
     "always passes, visible widget" TEST key — fine for the sandbox, replace with
     the real site key (and add the live hostnames to the widget) at launch. */
  var TURNSTILE_SITEKEY = '1x00000000000000000000AA';
```

## 6. [Required] The Turnstile lifecycle helpers — JS

Inserted just above the "Open / close" section inside `initLeadModal()`.
Expected matches: **1**

**Find this**

```js
    // -- Open / close, with focus management ---------------------------------

    function resetModalUI() {
```

**Replace with**

```js
    // -- Turnstile ------------------------------------------------------------
    // A token is single-use and expires in ~5 minutes, so the widget is rendered
    // when the modal opens and reset whenever the modal closes or a submission
    // fails — otherwise a retry would replay a spent token and be rejected.
    // The API script is loaded with ?render=explicit and is async, so it may not
    // be ready on the first open; mountTurnstile() waits for it briefly.

    var turnstileHost = modal.querySelector('#cpbTurnstile');
    var turnstileErrEl = modal.querySelector('#cpbLeadTurnstileErr');
    var turnstileWidgetId = null;
    var turnstileWaitTimer = null;

    function setTurnstileError(message) {
      if (turnstileErrEl) turnstileErrEl.textContent = message || '';
    }

    function mountTurnstile() {
      if (!turnstileHost) return;
      if (turnstileWaitTimer) { clearInterval(turnstileWaitTimer); turnstileWaitTimer = null; }
      setTurnstileError('');

      if (!window.turnstile) {
        // Script still in flight. Poll briefly, then tell the customer plainly.
        var waited = 0;
        turnstileWaitTimer = setInterval(function () {
          waited += 100;
          if (window.turnstile) {
            clearInterval(turnstileWaitTimer); turnstileWaitTimer = null;
            mountTurnstile();
          } else if (waited >= 10000) {
            clearInterval(turnstileWaitTimer); turnstileWaitTimer = null;
            setTurnstileError('The verification check could not load. Please refresh the page, or call our office at 575-526-9758.');
          }
        }, 100);
        return;
      }

      if (turnstileWidgetId !== null) { window.turnstile.reset(turnstileWidgetId); return; }

      turnstileWidgetId = window.turnstile.render(turnstileHost, {
        sitekey: TURNSTILE_SITEKEY,
        'error-callback': function () {
          setTurnstileError('The verification check could not run. Please try again.');
        },
        'expired-callback': function () {
          if (turnstileWidgetId !== null) window.turnstile.reset(turnstileWidgetId);
        }
      });
    }

    function resetTurnstile() {
      if (turnstileWaitTimer) { clearInterval(turnstileWaitTimer); turnstileWaitTimer = null; }
      if (window.turnstile && turnstileWidgetId !== null) window.turnstile.reset(turnstileWidgetId);
      setTurnstileError('');
    }

    function turnstileResponse() {
      if (!window.turnstile || turnstileWidgetId === null) return '';
      try { return window.turnstile.getResponse(turnstileWidgetId) || ''; } catch (err) { return ''; }
    }

    // -- Open / close, with focus management ---------------------------------

    function resetModalUI() {
```

## 7. [Required] Render the widget when the modal opens — JS

Must come *after* `modal.hidden = false`: Turnstile needs a visible container.
Expected matches: **1**

**Find this**

```js
      resetModalUI();
      renderRecap();
      modal.hidden = false;
```

**Replace with**

```js
      resetModalUI();
      renderRecap();
      modal.hidden = false;
      mountTurnstile(); // after unhiding: Turnstile needs a visible container
```

## 8. [Required] Reset the widget when the modal closes — JS

Expected matches: **1**

**Find this**

```js
    function closeLeadModal() {
      modal.hidden = true;
```

**Replace with**

```js
    function closeLeadModal() {
      resetTurnstile(); // never carry a spent/stale token into the next open
      modal.hidden = true;
```

## 9. [Required] Phone validation that agrees with the server — JS

The server requires 10–15 actual digits. The old character-class check accepted any 7
characters from the set, so `555-0142` passed here and was then rejected server-side.
Expected matches: **1**

**Find this**

```js
    var PHONE_RE = /^[\d\s().+-]{7,}$/;
```

**Replace with**

```js
    /* The server requires 10-15 actual digits (see lib/intake/validate.js), so the
       character-class check alone is not enough — a 7-character entry would pass
       here and then be rejected server-side. Both sides now agree. */
    var PHONE_RE = /^[\d\s().+-]+$/;
    function phoneLooksValid(value) {
      var digits = String(value).replace(/\D/g, '');
      return PHONE_RE.test(value) && digits.length >= 10 && digits.length <= 15;
    }
```

## 10. [Required] Clear the Turnstile message with the others — JS

Expected matches: **1**

**Find this**

```js
      Object.keys(FIELD_IDS).forEach(function (key) { setError(FIELD_IDS[key], ''); });
      formErrorEl.hidden = true;
```

**Replace with**

```js
      Object.keys(FIELD_IDS).forEach(function (key) { setError(FIELD_IDS[key], ''); });
      setTurnstileError('');
      formErrorEl.hidden = true;
```

## 11. [Required] Use the new phone check — JS

Expected matches: **1**

**Find this**

```js
      else if (!PHONE_RE.test(phone)) { setError(FIELD_IDS.phone, 'Enter a valid phone number.'); ok = false; }
```

**Replace with**

```js
      else if (!phoneLooksValid(phone)) { setError(FIELD_IDS.phone, 'Enter a valid 10-digit phone number.'); ok = false; }
```

## 12. [Required] Require a solved challenge before sending — JS

Expected matches: **1**

**Find this**

```js
      var selection = lastSelection || buildSelectionPayload();

      var payload = {
```

**Replace with**

```js
      var turnstileToken = turnstileResponse();
      if (!turnstileToken) {
        setTurnstileError('Please complete the verification check.');
        return;
      }

      var selection = lastSelection || buildSelectionPayload();

      var payload = {
```

## 13. [Required] Attach the token to the payload — JS

Expected matches: **1**

**Find this**

```js
        bestTime: modal.querySelector('#cpbLeadBestTime').value,
        submittedAt: new Date().toISOString()
      };

      // Rate limiting is enforced server-side by the intake Worker — nothing to do here.
      // TODO: no Turnstile token is read/attached here — see the handoff's open questions.

      submitBtn.disabled = true;
```

**Replace with**

```js
        bestTime: modal.querySelector('#cpbLeadBestTime').value,
        submittedAt: new Date().toISOString(),
        turnstileToken: turnstileToken
      };

      // Rate limiting is enforced server-side by the intake endpoint (429 +
      // Retry-After, handled below). Prices in this payload are recomputed
      // server-side from the catalog and are never trusted as sent.

      submitBtn.disabled = true;
```

## 14. [Required] Status-aware response handling, including the 429 — JS

The biggest block. The old handler collapsed every non-2xx into one generic message.
This one reads the JSON body, puts field errors next to their inputs, resets the spent
Turnstile token, and gives the rate limit its own message with a wait time from the
`Retry-After` header. The success text is unchanged. Expected matches: **1**

**Find this**

```js
      }).then(function (res) {
        if (!res.ok) throw new Error('Request failed');
        form.hidden = true;
        confirmEl.hidden = false;
        confirmEl.innerHTML = '<p>We received your Care Plan request. No payment has been taken, and your Care Plan is not active yet. A Sun City team member will contact you during regular office hours, Monday&ndash;Friday, 8:00&nbsp;AM&ndash;5:00&nbsp;PM.</p>';
        var items = focusableEls();
        if (items.length) items[0].focus();
      }).catch(function () {
        formErrorEl.hidden = false;
        formErrorEl.textContent = 'Something went wrong sending your request. Please try again, or call us directly.';
        submitBtn.disabled = false;
        submitBtn.textContent = 'Send My Request';
      });
```

**Replace with**

```js
      }).then(function (res) {
        // Read the JSON body either way: errors carry { code, error, fieldErrors }.
        return res.json().then(function (data) { return { res: res, data: data }; },
                               function ()     { return { res: res, data: null }; });
      }).then(function (out) {
        var res = out.res, data = out.data || {};

        if (res.ok) {
          form.hidden = true;
          confirmEl.hidden = false;
          confirmEl.innerHTML = '<p>We received your Care Plan request. No payment has been taken, and your Care Plan is not active yet. A Sun City team member will contact you during regular office hours, Monday&ndash;Friday, 8:00&nbsp;AM&ndash;5:00&nbsp;PM.</p>';
          var items = focusableEls();
          if (items.length) items[0].focus();
          return;
        }

        // The token was spent on this attempt, pass or fail — get a fresh one
        // before the customer can retry.
        resetTurnstile();
        submitBtn.disabled = false;
        submitBtn.textContent = 'Send My Request';

        // Field-level messages, next to the inputs they belong to.
        var fieldErrors = data.fieldErrors || {};
        var serverToLocal = { customerName: FIELD_IDS.name, phone: FIELD_IDS.phone, address: FIELD_IDS.address };
        var placedAny = false;
        Object.keys(fieldErrors).forEach(function (key) {
          if (key === 'turnstileToken') { setTurnstileError(fieldErrors[key]); placedAny = true; return; }
          if (serverToLocal[key]) { setError(serverToLocal[key], fieldErrors[key]); placedAny = true; }
        });

        var message;
        if (res.status === 429) {
          // Server-side rate limit. Retry-After is in seconds.
          var retryAfter = Number(res.headers.get('Retry-After'));
          var minutes = retryAfter > 0 ? Math.max(1, Math.ceil(retryAfter / 60)) : 0;
          message = minutes
            ? 'We have already received several requests from this connection. Please wait about ' + minutes +
              (minutes === 1 ? ' minute' : ' minutes') + ' and try again, or call our office at 575-526-9758 and we will take your request over the phone.'
            : 'We have already received several requests from this connection. Please wait a few minutes and try again, or call our office at 575-526-9758.';
        } else if (data.code === 'TURNSTILE_FAILED') {
          message = 'The verification check did not pass. Please complete it again and resend.';
        } else if (res.status === 400 && placedAny) {
          message = 'Please check the highlighted fields and try again.';
        } else if (res.status === 400) {
          message = data.error || 'Please check your details and try again.';
        } else {
          message = 'Something went wrong sending your request. Please try again, or call us directly at 575-526-9758.';
        }

        formErrorEl.hidden = false;
        formErrorEl.textContent = message;
      }).catch(function () {
        // Network-level failure: no response at all.
        resetTurnstile();
        formErrorEl.hidden = false;
        formErrorEl.textContent = 'Something went wrong sending your request. Please try again, or call us directly at 575-526-9758.';
        submitBtn.disabled = false;
        submitBtn.textContent = 'Send My Request';
      });
```

---

## What changed overall

- **Turnstile is live instead of a placeholder.** The widget is rendered explicitly when
  the lead modal opens (step 4, 6, 7), reset when it closes or when a submission fails
  (steps 8, 14), and its token is required before anything is sent (step 12) and
  attached to the payload (step 13). The site key is one constant next to
  `SUBMIT_ENDPOINT` (step 5).
- **Errors are specific instead of generic.** The endpoint's field-level messages land
  next to the right inputs, and the rate limit gets its own message with a wait time
  and the office phone number (step 14).
- **Phone validation matches the server**, so nobody gets past the form only to be
  rejected by the endpoint (steps 9, 11).
- **Three pre-existing bugs fixed** (steps 1–3): a modal that couldn't scroll, a card
  that could be clipped, and a form that never actually hid itself after a successful
  send.
- **Not changed:** the pricing arrays, the plan/add-on rendering, the recap, the
  selection payload, the focus trap, and the confirmation wording. The numbers the
  customer sees are untouched — and every price is now recomputed server-side from a
  catalog that a parity test keeps in step with this block's own `PLANS` and
  `ADDON_GROUPS`.

## Once it is live, double-check these

Open the page on the real site and go through the form once, all the way to the
confirmation screen. Specifically:

1. **The widget actually appears.** A Turnstile site key is bound to specific
   hostnames — if `youknowsuncity.com` and `www.youknowsuncity.com` aren't both on the
   widget's hostname list, the box renders as an error. Check with the page loaded both
   ways, if both resolve.
2. **The script survived LiveCanvas.** Re-open the block in the code editor and confirm
   the `challenges.cloudflare.com` `<script>` tag from step 4 is still present. A
   WYSIWYG save can strip it, and the symptom is "The verification check could not
   load" after ten seconds.
3. **A real submission lands in the dashboard** with the right plan, the right total, and
   the call-time you picked, and **the office email arrives** at service@suncitylc.com.
   Send one test lead with an obviously fake name so it is easy to delete afterwards.
4. **The cross-origin POST is not blocked.** Open the browser console on the live page
   while submitting. A CORS error means the live origin isn't in the endpoint's
   `ALLOWED_ORIGINS` — that list lives in `wrangler.toml`, not the Cloudflare dashboard
   (see `SETUP.md`).
5. **The 429 wording reads sensibly.** Submit six times in a row from one connection.
   The sixth should be refused with the wait-time message, not a generic failure.
6. **Delete the test rows** from the dashboard once you're happy, and remember the first
   real submission number will follow your test ones.
