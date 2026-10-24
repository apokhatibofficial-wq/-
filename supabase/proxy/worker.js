// api.<domain> on Cloudflare (free Workers plan): forwards every request to the MEDLINK function on Supabase.
// - The sites and the API stay on one domain, so the session cookie is a first-party cookie (browsers block
//   third-party ones).
// - It passes the real client IP (CF-Connecting-IP) for the rate limits, with a shared secret: the function refuses
//   any request that does not come through here, so nobody can call it directly and fake the IP.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const target = new URL(env.SUPABASE_FUNCTION_URL.replace(/\/+$/, "") + url.pathname + url.search);
    const headers = new Headers(request.headers);
    // Whatever the caller sent in these headers is replaced.
    headers.set("x-medlink-proxy", env.PROXY_SECRET);
    headers.set("x-medlink-client-ip", request.headers.get("cf-connecting-ip") ?? "");
    headers.delete("x-forwarded-for");
    headers.delete("host");
    const init = { method: request.method, headers, redirect: "manual" };
    if (request.method !== "GET" && request.method !== "HEAD") {
      init.body = request.body;
      init.duplex = "half"; // a streamed body (required by the fetch standard, accepted by Workers)
    }
    const res = await fetch(target, init);
    // Status, Set-Cookie, Location and the API's security headers pass through unchanged.
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers: res.headers });
  },
};
