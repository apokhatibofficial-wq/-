// Runs the proxy against a local stand-in for the function: checks the forwarded path, headers, body, status,
// Set-Cookie and Location. Usage: node supabase/proxy/test.mjs
import http from "node:http";
import assert from "node:assert/strict";
import worker from "./worker.js";

let seen;
const upstream = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    seen = { url: req.url, method: req.method, headers: req.headers, body };
    res.setHeader("Set-Cookie", "__Host-medlink_session=abc; Path=/; Secure; HttpOnly; SameSite=Strict");
    if (req.url.startsWith("/functions/v1/api/public/book/")) {
      res.statusCode = 301;
      res.setHeader("Location", "/public/book/new-slug");
    }
    res.setHeader("content-type", "application/json");
    res.end('{"ok":true}');
  });
});
await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
const env = { SUPABASE_FUNCTION_URL: `http://127.0.0.1:${upstream.address().port}/functions/v1/api/`, PROXY_SECRET: "s".repeat(40) };

const post = await worker.fetch(new Request("https://api.medlink.website/auth/login?x=1", {
  method: "POST",
  headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.7", "x-medlink-proxy": "forged", "x-medlink-client-ip": "1.2.3.4", cookie: "a=b" },
  body: '{"email":"x"}',
}), env);
assert.equal(post.status, 200);
assert.equal(seen.url, "/functions/v1/api/auth/login?x=1");
assert.equal(seen.method, "POST");
assert.equal(seen.body, '{"email":"x"}');
assert.equal(seen.headers["x-medlink-proxy"], "s".repeat(40));
assert.equal(seen.headers["x-medlink-client-ip"], "203.0.113.7");
assert.equal(seen.headers.cookie, "a=b");
assert.match(post.headers.get("set-cookie"), /__Host-medlink_session=abc/);
assert.equal(await post.text(), '{"ok":true}');

const moved = await worker.fetch(new Request("https://api.medlink.website/public/book/old-slug"), env);
assert.equal(moved.status, 301);
assert.equal(moved.headers.get("location"), "/public/book/new-slug");
upstream.close();
console.log("proxy OK: path, query, body, secret, client IP, cookies, redirects");
