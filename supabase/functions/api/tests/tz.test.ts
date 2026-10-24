import { assertEquals } from "jsr:@std/assert@1.0.14";
import { computeDay } from "../src/availability.ts";
import { addDays, dayStartUtc, localDate, localTime, toUtc, weekday } from "../src/tz.ts";

Deno.test("Time zones: local dates and times, Syria (UTC+3, no daylight saving since 2022)", () => {
  const t = new Date("2026-10-24T21:30:00Z");
  assertEquals([localDate(t, "Asia/Damascus"), localTime(t, "Asia/Damascus")], ["2026-10-25", "00:30"]);
  assertEquals(toUtc("2026-10-25", 30, "Asia/Damascus")!.toISOString(), "2026-10-24T21:30:00.000Z");
  assertEquals(dayStartUtc("2026-10-25", "Asia/Damascus").toISOString(), "2026-10-24T21:00:00.000Z");
  assertEquals(toUtc("2026-10-25", 1440, "Asia/Damascus")!.toISOString(), "2026-10-25T21:00:00.000Z");
  assertEquals([addDays("2026-12-31", 1), addDays("2026-03-01", -1), weekday("2026-10-25")], ["2027-01-01", "2026-02-28", 0]);
});

Deno.test("Time zones: a skipped time does not exist; a repeated time is taken as standard time (as .NET does)", () => {
  // New York: 2026-03-08 02:00 → 03:00; 2026-11-01 02:00 → 01:00.
  assertEquals(toUtc("2026-03-08", 150, "America/New_York"), null);
  assertEquals(toUtc("2026-03-08", 180, "America/New_York")!.toISOString(), "2026-03-08T07:00:00.000Z");
  assertEquals(toUtc("2026-11-01", 90, "America/New_York")!.toISOString(), "2026-11-01T06:30:00.000Z");
  // The skipped slot is simply not offered.
  const day = computeDay("America/New_York", new Date("2026-03-01T00:00:00Z"), "2026-03-08", 0,
    [{ weekday: 0, startMin: 60, endMin: 240, slotMinutes: 60, capacity: 1 }], new Set(), new Map());
  assertEquals(day.slots.map((s) => s.localTime), ["01:00", "03:00"]);
});
