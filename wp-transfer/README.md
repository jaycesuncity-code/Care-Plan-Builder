# wp-transfer — WordPress / LiveCanvas staging package

This package is based on `main` @ `8eefb9f280700c93636b11f50bb096b3920090f8`, with the WordPress-only Member Rewards safety fix on branch `docs/wp-transfer-staging` (commit `469263e`).

The intended WordPress-facing backend host is now fixed as:

`https://care-plan-builder.pages.dev`

That choice does **not** make the staff app public. Cloudflare Access must remain on the hostname by default, with public exceptions limited to exactly `/catalog.json` and `/api/care-plan-request` before dynamic WordPress integration is tested logged out.

## Files and staging status

| File | WordPress page | Paste status | Notes |
|---|---|---|---|
| `01-member-rewards-program.html` | `/member-rewards-program/` | **READY** | Rebuilt under `.scp-rw`; no global CSS, duplicate page landmarks, scripts, or placeholders. |
| `02-memberships.html` | `/memberships/` | **READY** | Static. Two visible photo placeholders remain an owner/content item before public launch. |
| `03-hvac-care-plan.html` | `/hvac-care-plan/` | **READY** | Catalog host is already set to `https://care-plan-builder.pages.dev/catalog.json`; page fails soft to embedded prices if catalog cannot load. |
| `04-plumbing-care-plan.html` | `/plumbing-care-plan/` | **READY** | Same catalog behavior as HVAC. |
| `05-bundled-care-plan.html` | `/bundled-care-plan/` | **READY** | Same catalog behavior as HVAC. |
| `06-premier-care-plan.html` | `/premier-care-plan/` | **READY** | Same catalog behavior as HVAC. |
| `07-careplan-builder.html` | `/careplan-builder/` | **VISUAL STAGING READY** | Backend host is set, but Turnstile and 15 Media Library files still have placeholders. Full integration waits for public catalog/intake paths, real Turnstile, media URLs, and n8n configuration. |

## Remaining placeholders

Only `07-careplan-builder.html` should contain launch placeholders:

- `{{TURNSTILE_SITEKEY}}`
- 15 distinct `{{MEDIA_URL:...}}` values, with `question-mark-icon.png` referenced twice (16 image references total)

Do **not** invent Media Library URLs. Upload the files first and use the File URL that WordPress actually assigns.

Expected Builder media files:

`hvac.JPG`, `general-plumbing.JPG`, `bundled.JPG`, `premier.JPG`, `background.png`, `addon-hvaccount.jpg`, `addon-filterchange.jpg`, `addon-minisplit.jpg`, `addon-waterheatercount.jpg`, `addon-softenerservice.jpg`, `addon-softenersalt.jpg`, `addon-reverseosmosis.jpg`, `addon-tanklessflush.jpg`, `addon-bigbluefilter.jpg`, `question-mark-icon.png`.

Do not upload `hvac1.JPG` or `scph-transparent-logo.png`. Resize the oversized hero/plan photos and the large question-mark icon before upload.

## LiveCanvas rules

Use **one HTML block per page** and use the **CODE editor only**. Do not round-trip these blocks through a visual HTML editor. Leave LiveCanvas's “Insert Script to head” field empty. After saving, reopen the code editor and verify the full block remains intact. On plan pages, both inline script blocks must still be present; on the Builder, the Turnstile loader and the main inline script must remain present.

For existing public pages (Member Rewards, HVAC, Plumbing), stage on a duplicate/private draft rather than overwriting the live page first. For Memberships, Bundled, Premier, and Builder, create Draft/Private pages and keep them noindex during staging.

## Known public-launch decisions not silently changed here

The package deliberately does **not** choose these for the owner: Rewards naming; Builder phone (`575-526-9758` vs `575-777-9758`); `Additional HVAC System` vs `# of HVAC Systems`; `Additional Water Heater` vs `# of Water Heaters`; the real destination or removal of `Read Reviews`; final replacement photos; `/memberships/` vs `/services/maintenance-plan`; and the future of `/member-sign-up/`.

The four plan files still contain `Read Reviews` links with `href="#"`; that is acceptable for private staging but blocks public launch until resolved.

## Verification

`build-paste-files.py` checks exact source-region extraction, production substitutions, executable staff/test route leakage, balanced scripts/styles, CSS scoping, and Builder media placeholder count. Member Rewards now follows the same BEGIN/END marker extraction model as Memberships.

Run from a checkout containing this branch/package:

```bash
python3 wp-transfer/build-paste-files.py --check
npm ci
npm run test:unit
npm run test:api
```

The known pre-existing unit-test drift is `tests/test-submissions.test.mjs`, which still expects the dashboard label `Live` even though the intended UI now says `Real`. Do not change application behavior just to satisfy that stale assertion.

See `../WP-TRANSFER-PLAN.md` for Cloudflare configuration, readiness verdicts, staging order, and launch blockers.