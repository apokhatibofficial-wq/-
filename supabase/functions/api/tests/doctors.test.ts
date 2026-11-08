import { assert, assertEquals } from "jsr:@std/assert@1.0.14";
import { normalizeLink, sniffPhoto } from "../src/doctors.ts";
import { appSql, hospital, ownerSql, test, TestApi } from "./harness.ts";

const slug = () => "dr-" + crypto.randomUUID().replaceAll("-", "").slice(0, 12);

const profile = (s: string, extra: Record<string, unknown> = {}) => ({
  slug: s,
  name: "الدكتور أحمد اختبار",
  specialty: "اختصاصي علوم مخبرية طبية",
  about: "سطر أول.\nسطر ثانٍ.",
  phone: "+963 944 000 000",
  verified: true,
  rating: 4.5,
  links: [
    { kind: "instagram", url: "instagram.com/test.doctor" },
    { kind: "whatsapp", url: "+963 944 000 000" },
    { kind: "linkedin", url: "https://www.linkedin.com/in/test" },
  ],
  shamcash: "ABC-123456",
  published: true,
  ...extra,
});

// A 1×1 JPEG and a minimal WebP header: the API reads the type from the bytes.
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0xff, 0xd9]);
const b64 = (b: Uint8Array) => {
  let s = "";
  for (let i = 0; i < b.length; i += 8192) s += String.fromCharCode(...b.subarray(i, i + 8192));
  return btoa(s);
};

async function raw(api: TestApi, path: string, cookie?: string) {
  const headers: Record<string, string> = { "x-medlink-client-ip": "203.0.113.50" };
  if (cookie) headers.cookie = "__Host-medlink_session=" + cookie;
  const res = await api.fetch(path, { method: "GET", headers });
  return { status: res.status, headers: res.headers, bytes: new Uint8Array(await res.arrayBuffer()) };
}

test("Doctor pages: the Owner creates, edits, publishes and deletes them; the input is cleaned and checked", async () => {
  const api = await TestApi.create();
  const { client: owner } = await api.companyUser("owner");
  const s = slug();
  const r = await owner.post("/admin/doctors", profile(s, { published: false }));
  assertEquals(r.status, 201, JSON.stringify(r.body));
  const d = r.body.doctor;
  assert(d.id.startsWith("doc_"));
  assertEquals(d.phone, "+963944000000");
  assertEquals(d.rating, 4.5);
  assertEquals(d.links, [
    { kind: "instagram", url: "https://instagram.com/test.doctor" },
    { kind: "whatsapp", url: "https://wa.me/963944000000" },
    { kind: "linkedin", url: "https://www.linkedin.com/in/test" },
  ]);
  assertEquals([d.published, d.hasPhoto, d.about], [false, false, "سطر أول.\nسطر ثانٍ."]);

  // Unpublished: not public.
  assertEquals((await api.anonymous().get(`/public/doctors/${s}`)).status, 404);
  assertEquals((await owner.post("/admin/doctors", profile(s))).body, { error: "SLUG_TAKEN" });

  const e = await owner.patch(`/admin/doctors/${d.id}`, profile(s, { rating: null, links: [], shamcash: null, verified: false }));
  assertEquals(e.status, 200, JSON.stringify(e.body));
  assertEquals([e.body.doctor.rating, e.body.doctor.links, e.body.doctor.shamcash, e.body.doctor.published], [null, [], null, true]);
  const pub = await api.anonymous().get(`/public/doctors/${s}`);
  assertEquals(pub.status, 200);
  assertEquals(Object.keys(pub.body).sort(), ["about", "links", "name", "phone", "photo", "rating", "shamcash", "slug", "specialty", "verified"]);
  assertEquals(pub.body.photo, null);

  // The links are stored as real JSON, not as a JSON string.
  const [{ t }] = await ownerSql<{ t: string }[]>`SELECT jsonb_typeof(links) AS t FROM doctor_profiles WHERE id = ${d.id}`;
  assertEquals(t, "array");

  const list = (await owner.get("/admin/doctors")).body.doctors;
  assert(list.some((x: any) => x.id === d.id));
  const audit = await ownerSql<{ action: string }[]>`SELECT action FROM audit_log WHERE target = ${d.id} ORDER BY id`;
  assertEquals(audit.map((a) => a.action), ["doctor_create", "doctor_edit"]);

  assertEquals((await owner.delete(`/admin/doctors/${d.id}`)).status, 200);
  assertEquals((await owner.delete(`/admin/doctors/${d.id}`)).status, 404);
  assertEquals((await api.anonymous().get(`/public/doctors/${s}`)).status, 404);
});

test("Doctor pages: invalid input is refused with a field code", async () => {
  const api = await TestApi.create();
  const { client: owner } = await api.companyUser("owner");
  const bad: [Record<string, unknown>, string][] = [
    [{ slug: "Bad Slug" }, "SLUG_INVALID"],
    [{ slug: "a--b" }, "SLUG_INVALID"],
    [{ name: "  " }, "NAME_REQUIRED"],
    [{ name: "x".repeat(121) }, "NAME_REQUIRED"],
    [{ phone: "call me" }, "PHONE_INVALID"],
    [{ rating: 6 }, "RATING_INVALID"],
    [{ rating: 4.3 }, "RATING_INVALID"],
    [{ rating: "5" }, "RATING_INVALID"],
    [{ links: [{ kind: "instagram", url: "javascript:alert(1)" }] }, "LINK_INVALID"],
    [{ links: [{ kind: "website", url: "http://example.com" }] }, "LINK_INVALID"],
    [{ links: [{ kind: "website", url: "https://user:pw@example.com" }] }, "LINK_INVALID"],
    [{ links: [{ kind: "myspace", url: "https://example.com" }] }, "LINK_INVALID"],
    [{ links: Array.from({ length: 13 }, () => ({ kind: "website", url: "https://example.com" })) }, "LINK_INVALID"],
    [{ about: "x".repeat(3001) }, "ABOUT_INVALID"],
    [{ about: "bell\u0007" }, "ABOUT_INVALID"],
    [{ shamcash: "x".repeat(101) }, "SHAMCASH_INVALID"],
    [{ published: "yes" }, "BAD_FIELD"],
  ];
  for (const [extra, code] of bad) {
    const r = await owner.post("/admin/doctors", profile(slug(), extra));
    assertEquals([r.status, r.body], [422, { error: code }], JSON.stringify(extra));
  }
  assertEquals((await owner.patch("/admin/doctors/doc_missing", profile(slug()))).status, 404);
});

test("Doctor pages: only the Owner writes; Support and Viewer read the list; hospital users and the public see nothing more", async () => {
  const api = await TestApi.create();
  const { client: owner } = await api.companyUser("owner");
  const { client: support } = await api.companyUser("support");
  const { client: viewer } = await api.companyUser("viewer");
  const h = await hospital(api, owner);
  const d = (await owner.post("/admin/doctors", profile(slug(), { published: false }))).body.doctor;
  for (const c of [support, viewer]) {
    assertEquals((await c.get("/admin/doctors")).status, 200);
    assertEquals((await c.post("/admin/doctors", profile(slug()))).status, 403);
    assertEquals((await c.patch(`/admin/doctors/${d.id}`, profile(d.slug))).status, 403);
    assertEquals((await c.delete(`/admin/doctors/${d.id}`)).status, 403);
    assertEquals((await c.put(`/admin/doctors/${d.id}/photo`, { data: b64(JPEG) })).status, 403);
  }
  assertEquals((await h.adminClient.get("/admin/doctors")).status, 403);
  assertEquals((await api.anonymous().get("/admin/doctors")).status, 401);

  // Second layer: the database itself refuses a hospital-scope session and lets the public (system) scope only read.
  const hospitalRows = await appSql.begin(async (tx) => {
    await tx`SELECT set_config('app.scope', 'hospital', true), set_config('app.hospital_id', ${h.hospitalId}, true)`;
    return await tx`SELECT id FROM doctor_profiles`;
  });
  assertEquals(hospitalRows.length, 0);
  let refused = false;
  try {
    await appSql.begin(async (tx) => {
      await tx`SELECT set_config('app.scope', 'system', true)`;
      await tx`UPDATE doctor_profiles SET published = true WHERE id = ${d.id}`;
      const [{ p }] = await tx<{ p: boolean }[]>`SELECT published AS p FROM doctor_profiles WHERE id = ${d.id}`;
      if (!p) throw new Error("no-op");
    });
  } catch {
    refused = true;
  }
  assert(refused, "the system scope must not change a profile");
});

test("Doctor pages: photos are checked by their bytes, versioned, and public only when the page is published", async () => {
  const api = await TestApi.create();
  const { client: owner } = await api.companyUser("owner");
  const s = slug();
  const d = (await owner.post("/admin/doctors", profile(s, { published: false }))).body.doctor;

  assertEquals((await owner.put(`/admin/doctors/${d.id}/photo`, { data: btoa("<svg onload=alert(1)>") })).body, { error: "PHOTO_INVALID" });
  assertEquals((await owner.put(`/admin/doctors/${d.id}/photo`, { data: "not base64!" })).body, { error: "PHOTO_INVALID" });
  const big = new Uint8Array(400 * 1024 + 1);
  big.set(JPEG.subarray(0, 3));
  assertEquals((await owner.put(`/admin/doctors/${d.id}/photo`, { data: b64(big) })).status, 422);

  const up = await owner.put(`/admin/doctors/${d.id}/photo`, { data: b64(JPEG) });
  assertEquals([up.status, up.body], [200, { photoRev: 1 }]);
  // The console can see it; the public cannot while the page is unpublished.
  const mine = await raw(api, `/admin/doctors/${d.id}/photo`, owner.sessionToken!);
  assertEquals([mine.status, mine.headers.get("content-type"), mine.headers.get("cache-control")], [200, "image/jpeg", "no-store"]);
  assertEquals(mine.bytes, JPEG);
  assertEquals((await raw(api, `/public/doctors/${s}/photo?v=1`)).status, 404);

  await owner.patch(`/admin/doctors/${d.id}`, profile(s));
  const pub = await api.anonymous().get(`/public/doctors/${s}`);
  assertEquals(pub.body.photo, `/public/doctors/${s}/photo?v=1`);
  const img = await raw(api, pub.body.photo);
  assertEquals([img.status, img.headers.get("content-type"), img.headers.get("cache-control")], [200, "image/jpeg", "public, max-age=31536000, immutable"]);
  assertEquals(img.headers.get("x-content-type-options"), "nosniff");
  assertEquals((await raw(api, `/public/doctors/${s}/photo?v=0`)).headers.get("cache-control"), "public, max-age=300");
  // Every other API answer stays uncacheable.
  assertEquals(pub.headers.get("cache-control"), "no-store");

  const del = await owner.send("DELETE", `/admin/doctors/${d.id}/photo`, {});
  assertEquals([del.status, del.body], [200, { photoRev: 2 }]);
  assertEquals((await api.anonymous().get(`/public/doctors/${s}`)).body.photo, null);
  assertEquals((await raw(api, `/public/doctors/${s}/photo?v=1`)).status, 404);
});

test("Doctor pages: link and photo checks (unit)", () => {
  assertEquals(normalizeLink({ kind: "maps", url: "maps.app.goo.gl/abc" }).url, "https://maps.app.goo.gl/abc");
  assertEquals(normalizeLink({ kind: "whatsapp", url: "0944 000 000" }).url, "https://wa.me/0944000000");
  for (const url of ["data:text/html,x", "vbscript:x", "https://localhost", "ftp://example.com"]) {
    let threw = false;
    try {
      normalizeLink({ kind: "website", url });
    } catch {
      threw = true;
    }
    assert(threw, url);
  }
  assertEquals(sniffPhoto(JPEG), "image/jpeg");
  assertEquals(sniffPhoto(new TextEncoder().encode("RIFF\0\0\0\0WEBPVP8 ")), "image/webp");
  assertEquals(sniffPhoto(new TextEncoder().encode("GIF89a")), null);
  return Promise.resolve();
});
