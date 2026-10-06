# Sandbox to WordPress: launch checklist

Not part of the deploy. Keep this file out of `public/`.

## Repo layout (drag `public` and `functions` into the repo)

```
public/memberships/index.html         Memberships landing page — built by a separate branch (feature/memberships-landing-page)
public/careplan-builder/index.html    Care Plan Builder
public/hvac-care-plan/index.html
public/plumbing-care-plan/index.html
public/bundled-care-plan/index.html
public/premier-care-plan/index.html
public/img/                           YOUR images, names exactly as in your folder (case matters)
public/_headers                       noindex on every sandbox page
public/404.html                       sandbox only
functions/[[path]].js                 sandbox only: unmirrored links go to the live site
```

## Before launch

The `/memberships/` landing page is built by a separate branch (`feature/memberships-landing-page`); this checklist does not add separate launch steps for it.

1. **Images.** Only the Care Plan Builder uses images (15 references, all start with `/img/`).
   Upload them to the WordPress media library, then find `/img/` and replace it with the
   uploads folder URL (`https://youknowsuncity.com/wp-content/uploads/YYYY/MM/`).
   Open the page afterwards and confirm each image loads.
2. **Plan pages.** Paste from the first `<!--` comment through the closing `</script>`.
   Delete the demo wrapper above and below it (everything before that comment, and the
   final `</body></html>`).
3. **Care Plan Builder.** Paste only what is between the BEGIN and END markers.
4. **Links.** No change needed. Every link is root-relative and matches the WordPress slugs.
5. **Do not delete the Cloudflare Care Plan Builder.** It is now the permanent staff-practice Builder and posts to `/api/test/care-plan-request`. Sandbox-only fallback files such as `functions/[[path]].js` and `public/404.html` can still be removed if no longer needed.
6. **Public endpoints.** This repo contains the live `/api/care-plan-request`, the practice `/api/test/care-plan-request`, and
   `/api/pricing` for sandbox/testing. At launch, copy those public Functions plus
   `lib/intake/*` to the separate `care-plan-intake` Pages project and point the
   WordPress Builder's `SUBMIT_ENDPOINT` and `PRICING_ENDPOINT` at that project. Keep
   `/api/pricing-admin` and `lib/admin/*` only in the gated dashboard project.


## Live/Test rule

The future WordPress/public Builder must post to the live endpoint. The Cloudflare-hosted
staff practice Builder remains in this repo and posts to the test endpoint. Both routes
share `lib/intake/handle-request.js`; the browser never controls `is_test`.
