// Cloudflare Pages Function for /book/{slug}: gives renamed booking links a real HTTP 301
// (for 90 days, per the approved slug policy) instead of only a client-side redirect.
// Everything else falls through to the static booking app. Set API_ORIGIN in the Pages project
// settings, e.g. https://api.medlink.website
const SLUG = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;

/** Pure decision, so it can be unit-tested: returns the new path for a 301, or null to serve the app. */
export function redirectTarget(slug, status, location) {
  if (!SLUG.test(slug) || status !== 301 || !location) return null;
  const m = /\/public\/book\/([a-z0-9][a-z0-9-]{1,38}[a-z0-9])$/.exec(location);
  return m && m[1] !== slug ? '/book/' + m[1] : null;
}

export async function onRequest(context) {
  const slug = String(context.params.slug ?? '');
  if (!SLUG.test(slug) || !context.env.API_ORIGIN) return context.next();
  try {
    const res = await fetch(context.env.API_ORIGIN + '/public/book/' + slug, { redirect: 'manual' });
    const target = redirectTarget(slug, res.status, res.headers.get('Location'));
    if (target) return Response.redirect(new URL(target, context.request.url).toString(), 301);
  } catch {
    // API unreachable: serve the app, which shows its own error state.
  }
  return context.next();
}
