// Questions used by several test files.
import { assertEquals } from "jsr:@std/assert@1.0.14";
import type { Client } from "./harness.ts";

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

