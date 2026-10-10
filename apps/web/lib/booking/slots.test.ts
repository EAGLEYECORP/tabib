import { describe, expect, it } from "vitest";
import {
  dayLabel,
  formatDayLong,
  formatTime,
  groupByDay,
  localDate,
  nextAvailability,
  toSlots,
  type Slot,
} from "./slots";

/**
 * Slot presentation.
 *
 * The interesting cases are all about the cabinet's time zone: a patient must
 * see the hour they are expected there, whatever their own clock says, and
 * Morocco's clock does not keep a constant offset from UTC.
 */

function slot(startIso: string, minutes = 30): Slot {
  const start = new Date(startIso);
  return { start, end: new Date(start.getTime() + minutes * 60_000) };
}

describe("toSlots", () => {
  it("parses what the database returns", () => {
    const slots = toSlots([
      { slot_start: "2026-04-14T08:00:00+00:00", slot_end: "2026-04-14T08:30:00+00:00" },
    ]);
    expect(slots).toHaveLength(1);
    expect(slots[0].start.toISOString()).toBe("2026-04-14T08:00:00.000Z");
  });

  it("copes with nothing at all", () => {
    expect(toSlots(null)).toEqual([]);
    expect(toSlots([])).toEqual([]);
  });
});

describe("times are shown in the cabinet's zone", () => {
  it("renders the hour the patient is expected, not the viewer's", () => {
    // 08:00 UTC in July is 09:00 in Casablanca.
    expect(formatTime(new Date("2026-07-14T08:00:00Z"))).toBe("09:00");
  });

  it("follows Morocco's Ramadan shift rather than a fixed offset", () => {
    // Morocco keeps UTC+1 year-round but returns to UTC for Ramadan. In 2026
    // that puts mid-March on UTC and April back on UTC+1, so the same instant
    // reads as a different wall-clock hour either side of the change.
    const duringRamadan = formatTime(new Date("2026-03-10T08:00:00Z"));
    const afterRamadan = formatTime(new Date("2026-04-10T08:00:00Z"));
    expect(duringRamadan).toBe("08:00");
    expect(afterRamadan).toBe("09:00");
    expect(duringRamadan).not.toBe(afterRamadan);
  });

  it("assigns a late-evening slot to the local day, not the UTC one", () => {
    // 23:30 UTC in July is already 00:30 the next day in Casablanca.
    expect(localDate(new Date("2026-07-14T23:30:00Z"))).toBe("2026-07-15");
  });
});

describe("groupByDay", () => {
  it("puts each slot under its local day, in order", () => {
    const slots = [
      slot("2026-07-15T09:00:00Z"),
      slot("2026-07-14T08:00:00Z"),
      slot("2026-07-14T08:30:00Z"),
    ];
    const days = groupByDay(slots);
    expect(days.map((d) => d.date)).toEqual(["2026-07-14", "2026-07-15"]);
    expect(days[0].slots).toHaveLength(2);
    expect(formatTime(days[0].slots[0].start)).toBe("09:00");
    expect(formatTime(days[0].slots[1].start)).toBe("09:30");
  });

  it("omits days with nothing free rather than showing an empty column", () => {
    const days = groupByDay([slot("2026-07-14T08:00:00Z"), slot("2026-07-16T08:00:00Z")]);
    expect(days.map((d) => d.date)).toEqual(["2026-07-14", "2026-07-16"]);
  });

  it("keeps a day that straddles midnight together under its local date", () => {
    const days = groupByDay([
      slot("2026-07-14T22:30:00Z"), // 23:30 local, same day
      slot("2026-07-14T23:30:00Z"), // 00:30 local, next day
    ]);
    expect(days.map((d) => d.date)).toEqual(["2026-07-14", "2026-07-15"]);
  });

  it("returns nothing for an empty diary", () => {
    expect(groupByDay([])).toEqual([]);
  });
});

describe("dayLabel", () => {
  const now = new Date("2026-07-14T10:00:00Z");

  it("says today and tomorrow where that is clearer than a date", () => {
    expect(dayLabel(new Date("2026-07-14T15:00:00Z"), now)).toBe("Aujourd'hui");
    expect(dayLabel(new Date("2026-07-15T09:00:00Z"), now)).toBe("Demain");
  });

  it("spells out anything further off", () => {
    const label = dayLabel(new Date("2026-07-17T09:00:00Z"), now);
    expect(label).toMatch(/vendredi/i);
    expect(label).toContain("17");
  });

  it("decides by the cabinet's day, not the viewer's", () => {
    // 23:30 UTC on the 14th is already the 15th in Casablanca, so it is
    // "tomorrow" even though UTC still calls it today.
    expect(dayLabel(new Date("2026-07-14T23:30:00Z"), now)).toBe("Demain");
  });
});

describe("nextAvailability", () => {
  it("finds the soonest slot regardless of input order", () => {
    const soonest = nextAvailability([
      slot("2026-07-16T09:00:00Z"),
      slot("2026-07-14T08:00:00Z"),
      slot("2026-07-15T09:00:00Z"),
    ]);
    expect(soonest?.start.toISOString()).toBe("2026-07-14T08:00:00.000Z");
  });

  it("returns null when the practitioner has nothing free", () => {
    expect(nextAvailability([])).toBeNull();
  });
});

describe("formatDayLong", () => {
  it("writes a date a patient can read aloud", () => {
    const label = formatDayLong(new Date("2026-07-14T09:00:00Z"));
    expect(label).toMatch(/mardi/i);
    expect(label).toContain("14");
    expect(label).toMatch(/juillet/i);
  });
});
