# Sandbox to WordPress: launch checklist

Not part of the deploy. Keep this file out of `public/`.

## Repo layout (drag `public` and `functions` into the repo)

```
public/memberships/index.html         Care Plan Builder (assumed slug, rename the folder if it differs)
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

1. **Images.** Only the Care Plan Builder uses images (15 references, all start with `/img/`).
   Upload them to the WordPress media library, then find `/img/` and replace it with the
   uploads folder URL (`https://youknowsuncity.com/wp-content/uploads/YYYY/MM/`).
   Open the page afterwards and confirm each image loads.
2. **Plan pages.** Paste from the first `<!--` comment through the closing `</script>`.
   Delete the demo wrapper above and below it (everything before that comment, and the
   final `</body></html>`).
3. **Care Plan Builder.** Paste only what is between the BEGIN and END markers.
4. **Links.** No change needed. Every link is root-relative and matches the WordPress slugs.
5. **Delete** `functions/[[path]].js` and `public/404.html`. They exist only so unmirrored links work in the sandbox.
6. **Form endpoint.** The builder posts to `/api/care-plan-request`. That endpoint is not in this project.
