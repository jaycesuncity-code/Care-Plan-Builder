# Care Plan audit remediation: deployment checklist (October 29, 2026)

**DO NOT MERGE** until the encrypted environment variables below have been set and reviewed. The protected submissions API will intentionally return 503 if its Access audience is missing.

1. Confirm the staff Dashboard's Cloudflare Access application AUD, then configure encrypted `DASHBOARD_ACCESS_AUD`. It is *different* from the pricing-editor `ACCESS_AUD`; retain the existing `ACCESS_TEAM_DOMAIN`. Both GET and PATCH now validate a signed JWT and the company email domain server-side.
2. Configure encrypted `TURNSTILE_TEST_SECRET` on the staff/practice deployment using Cloudflare's *test secret*. Confirm `TURNSTILE_SECRET` is the *real production* secret for live intake. Do not store either value in Git.
3. Verify real Turnstile hostnames for WordPress apex and www, live vs practice classification, and that invalid live test tokens fail closed.
4. Test locally: `npm run test:unit`, then bounded `npm run test:api`, then browser testing. The local harness uses `DEV_ADMIN_EMAIL` to exercise dashboard routes, **but do not set that value on deployed environments**.
5. Test signed-out staff API requests and signed-in dashboard + Pricing Editor; confirm the real Access audience and JWT authorizations. Use one controlled live intake smoke test only after settings are correct.
6. Audit all stale branch deployments for access and unmerged code before deleting any branch; they share production D1.
7. WordPress draft 230802 pricing deadline was raised from 1.5 seconds to 6 seconds separately via WPVibe. Other LiveCanvas accessibility improvements, media compression, tracking privacy checks, and stale configuration comments still need review. Do not assume repository-practice HTML edits automatically reach WordPress.
8. No GitHub Actions workflow was changed. Do not add unbounded workers or duplicate PR/push triggers.

This change is narrowly intended to resolve the verified high-priority security flaws without redesigning Care Plan pricing or enrollment.
