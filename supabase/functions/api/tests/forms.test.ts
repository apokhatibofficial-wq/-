import { assertEquals } from "jsr:@std/assert@1.0.14";
import { appSql, type Client, hospital, ownerSql, staff, test, TestApi } from "./harness.ts";

export const visit = (ar = "نوع الزيارة") => ({
  id: "visit", type: "single", req: true, label: { ar, en: "Visit type", tr: "Ziyaret türü" },
  opts: [{ id: "new", label: { ar: "استشارة جديدة", en: "New", tr: "Yeni" } }, { id: "fu", label: { ar: "متابعة", en: "Follow-up", tr: "Kontrol" } }],
});
export const note = () => ({ id: "note", type: "short", req: false, label: { ar: "ملاحظة لموظف الاستقبال", en: "Note", tr: "Not" }, opts: [] });
export const first = () => ({ id: "first", type: "yesno", req: true, label: { ar: "هل هذه زيارتك الأولى؟", en: "First visit?", tr: "İlk ziyaret?" }, opts: [] });

export async function publish(admin: Client, ...questions: unknown[]): Promise<number> {
  assertEquals((await admin.put("/hospital/form/draft", { questions })).status, 200);
  const r = await admin.post("/hospital/form/publish", {});
  assertEquals(r.status, 200, JSON.stringify(r.body));
  return r.body.version;
}

test("Acceptance 12/14: a published question appears on the booking link; a saved draft does not", async () => {
  const api = await TestApi.create();
  const { client: owner } = await api.companyUser("owner");
  const { slug, adminClient: admin } = await hospital(api, owner);
  const anon = api.anonymous();
  assertEquals((await anon.get(`/public/hospitals/${slug}/form`)).body.form, null);
  assertEquals(await publish(admin, visit()), 1);
  let pub = (await anon.get(`/public/hospitals/${slug}/form`)).body.form;
  assertEquals(pub.version, 1);
  assertEquals(pub.questions[0].label.ar, "نوع الزيارة");
  assertEquals(pub.questions[0], visit());

  assertEquals((await admin.put("/hospital/form/draft", { questions: [visit(), note()] })).status, 200);
  pub = (await anon.get(`/public/hospitals/${slug}/form`)).body.form;
  assertEquals(pub.questions.length, 1);
  const state = await admin.get("/hospital/form");
  assertEquals(state.body.draft.questions.length, 2);
  assertEquals(state.body.live.version, 1);

  assertEquals((await admin.post("/hospital/form/publish", {})).status, 200);
  pub = (await anon.get(`/public/hospitals/${slug}/form`)).body.form;
  assertEquals([pub.version, pub.questions.length], [2, 2]);
  const versions = (await admin.get("/hospital/form/versions")).body.versions;
  assertEquals(versions[0].summary, [1, 0, 0, 0]);
  assertEquals(versions[0].live, true);
  assertEquals(versions[0].questionCount, 2);
  assertEquals((await admin.get("/hospital/form")).body.draft, null);
});

test("Acceptance 15: publishing is blocked until every question has Arabic text and choice questions have 2 options", async () => {
  const api = await TestApi.create();
  const { client: owner } = await api.companyUser("owner");
  const { adminClient: admin } = await hospital(api, owner);
  const bad = [
    { id: "a", type: "short", req: false, label: { ar: "", en: "No Arabic", tr: "" }, opts: [] },
    { id: "b", type: "single", req: true, label: { ar: "اختر", en: "", tr: "" }, opts: [{ id: "x", label: { ar: "واحد", en: "", tr: "" } }] },
  ];
  assertEquals((await admin.put("/hospital/form/draft", { questions: bad })).status, 200);
  const r = await admin.post("/hospital/form/publish", {});
  assertEquals(r.status, 422);
  assertEquals(r.body.error, "FORM_BLOCKED");
  assertEquals(r.body.detail, [{ question: 1, code: "LABEL_AR_REQUIRED" }, { question: 2, code: "OPTIONS_REQUIRED" }]);
  assertEquals((await admin.get("/hospital/form")).body.live, null);
  for (const q of [
    { id: "a", type: "upload", req: false, label: { ar: "x" }, opts: [] },
    { id: "BAD ID", type: "short", req: false, label: { ar: "x" }, opts: [] },
    { id: "a", type: "short", req: false, label: { ar: "x" }, opts: [{ id: "o", label: { ar: "y" } }] },
  ]) assertEquals((await admin.put("/hospital/form/draft", { questions: [q] })).status, 422);
  assertEquals((await admin.put("/hospital/form/draft", { questions: [note(), note()] })).status, 422);
  assertEquals((await admin.put("/hospital/form/draft", { questions: [{ ...note(), req: "yes" }] })).status, 400);

  await publish(admin, visit());
  await admin.put("/hospital/form/draft", { questions: [visit()] });
  assertEquals((await admin.post("/hospital/form/publish", {})).status, 409);
});

test("Acceptance 16: a publish that fails inside the database keeps the live version and the draft", async () => {
  const api = await TestApi.create();
  const { client: owner } = await api.companyUser("owner");
  const { hospitalId: hid, slug, adminClient: admin } = await hospital(api, owner);
  await publish(admin, visit());
  await admin.put("/hospital/form/draft", { questions: [visit(), note()] });
  await ownerSql.unsafe(`
    CREATE FUNCTION test_fail_publish() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.hospital_id = '${hid}' THEN RAISE EXCEPTION 'simulated failure'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER test_fail_publish BEFORE INSERT ON form_versions FOR EACH ROW EXECUTE FUNCTION test_fail_publish();`);
  try {
    const r = await admin.post("/hospital/form/publish", {});
    assertEquals(r.status, 500);
    assertEquals(r.body.error, "INTERNAL");
  } finally {
    await ownerSql.unsafe("DROP TRIGGER test_fail_publish ON form_versions; DROP FUNCTION test_fail_publish();");
  }
  const pub = (await api.anonymous().get(`/public/hospitals/${slug}/form`)).body.form;
  assertEquals([pub.version, pub.questions.length], [1, 1]);
  assertEquals((await admin.get("/hospital/form")).body.draft.questions.length, 2);
  const [{ n }] = await ownerSql<{ n: number }[]>`SELECT count(*)::int AS n FROM form_versions WHERE hospital_id = ${hid}`;
  assertEquals(n, 1);
  assertEquals((await admin.post("/hospital/form/publish", {})).status, 200);
});

test("Acceptance 17: restoring an old version publishes it as a new version; old versions stay", async () => {
  const api = await TestApi.create();
  const { client: owner } = await api.companyUser("owner");
  const { slug, adminClient: admin } = await hospital(api, owner);
  await publish(admin, visit());
  await publish(admin, visit(), note(), first());
  await admin.put("/hospital/form/draft", { questions: [note()] });
  assertEquals((await admin.post("/hospital/form/versions/2/restore", {})).status, 409);
  const r = await admin.post("/hospital/form/versions/1/restore", {});
  assertEquals(r.status, 200);
  assertEquals(r.body, { version: 3, restoredFrom: 1 });
  const versions = (await admin.get("/hospital/form/versions")).body.versions;
  assertEquals(versions.map((v: any) => v.version), [3, 2, 1]);
  assertEquals(versions[0].restoredFrom, 1);
  assertEquals(versions[0].summary, [0, 0, 2, 0]);
  assertEquals((await api.anonymous().get(`/public/hospitals/${slug}/form`)).body.form.questions.length, 1);
  assertEquals((await admin.get("/hospital/form")).body.draft, null);
  assertEquals((await admin.get("/hospital/form/versions/2")).body.questions.length, 3);
  assertEquals((await admin.get("/hospital/form/versions/9")).status, 404);
  assertEquals((await admin.get("/hospital/form/versions/abc")).status, 404);
});

test("Only the hospital admin edits the form; published versions cannot be modified in the database", async () => {
  const api = await TestApi.create();
  const { client: owner } = await api.companyUser("owner");
  const { adminClient: admin } = await hospital(api, owner);
  const { client: reception } = await staff(api, admin, "reception");
  assertEquals((await reception.get("/hospital/form")).status, 403);
  assertEquals((await reception.put("/hospital/form/draft", { questions: [note()] })).status, 403);
  assertEquals((await reception.post("/hospital/form/publish", {})).status, 403);
  assertEquals((await owner.get("/hospital/form")).status, 403);
  await publish(admin, visit());
  let code = "";
  try {
    await appSql.begin(async (tx) => {
      await tx`SELECT set_config('app.scope', 'system', true)`;
      await tx`UPDATE form_versions SET schema_json = '{}'`;
    });
  } catch (e) {
    code = (e as { code: string }).code;
  }
  assertEquals(code, "42501");
});
