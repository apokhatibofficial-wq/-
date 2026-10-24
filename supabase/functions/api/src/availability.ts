// Turns weekly timetables into bookable slots. All times are wall-clock times in the hospital's own time zone;
// "today" is the hospital's today. The booking window counts today as day 1; slots that start sooner than the minimum
// notice are not offered.
import { addDays, hhmm, localDate, toUtc, weekday } from "./tz.ts";

export interface Block {
  weekday: number;
  startMin: number;
  endMin: number;
  slotMinutes: number;
  capacity: number;
}

export interface Slot {
  startUtc: Date;
  localTime: string;
  capacity: number;
  free: number;
}

/** Status: "open", "full" (every slot taken) or "closed" (no hours, a closure, or nothing left today). */
export interface Day {
  date: string;
  status: "open" | "full" | "closed";
  slots: Slot[];
}

export const openCount = (d: Day) => d.slots.filter((s) => s.free > 0).length;

export function computeDays(tz: string, now: Date, windowDays: number, minNoticeMin: number, blocks: Block[], closed: Set<string>,
  booked: Map<number, number>): Day[] {
  const today = localDate(now, tz);
  const days: Day[] = [];
  for (let i = 0; i < windowDays; i++) days.push(computeDay(tz, now, addDays(today, i), minNoticeMin, blocks, closed, booked));
  return days;
}

/** booked: number of seats taken per slot start (epoch milliseconds). */
export function computeDay(tz: string, now: Date, date: string, minNoticeMin: number, blocks: Block[], closed: Set<string>,
  booked: Map<number, number>): Day {
  if (closed.has(date)) return { date, status: "closed", slots: [] };
  const todays = blocks.filter((b) => b.weekday === weekday(date)).sort((a, b) => a.startMin - b.startMin);
  if (todays.length === 0) return { date, status: "closed", slots: [] };
  const earliest = now.getTime() + minNoticeMin * 60000;
  const slots: Slot[] = [];
  let anyInTime = false;
  for (const b of todays) {
    for (let m = b.startMin; m + b.slotMinutes <= b.endMin; m += b.slotMinutes) {
      const utc = toUtc(date, m, tz);
      if (utc === null) continue; // skipped by a daylight-saving change
      if (utc.getTime() < earliest) continue;
      anyInTime = true;
      const free = b.capacity - (booked.get(utc.getTime()) ?? 0);
      if (free > 0) slots.push({ startUtc: utc, localTime: hhmm(m), capacity: b.capacity, free });
    }
  }
  if (!anyInTime) return { date, status: "closed", slots: [] };
  return { date, status: slots.length === 0 ? "full" : "open", slots };
}
