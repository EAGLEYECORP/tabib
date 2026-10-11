import { describe, expect, it } from "vitest";
import { slotsInBlock, validateBlock, wallTimeToInstant, weeklyBlocks } from "./wall-time";
import { formatTime } from "./slots";

/**
 * Turning a practitioner's "nine o'clock" into a moment in time.
 *
 * Morocco keeps UTC+1 year-round but returns to UTC for the month of Ramadan,
 * so these cases are the ones that a fixed offset gets wrong — and getting
 * them wrong means patients arriving an hour early or late.
 */

describe("wallTimeToInstant", () => {
  it("resolves an ordinary morning to the right instant", () => {
    // Mid-July: Morocco is on UTC+1, so 09:00 local is 08:00 UTC.
    expect(wallTimeToInstant("2027-07-13", "09:00").toISOString()).toBe(
      "2027-07-13T08:00:00.000Z",
    );
  });

  it("follows the Ramadan return to UTC", () => {
    // February 2027 falls in Ramadan, when Morocco is on UTC: 09:00 local is
    // 09:00 UTC. A hard-coded +01:00 would put this block an hour out.
    expect(wallTimeToInstant("2027-02-16", "09:00").toISOString()).toBe(
      "2027-02-16T09:00:00.000Z",
    );
  });

  it("gives the same wall-clock hour on both sides of the change", () => {
    // Whatever the offset, nine o'clock has to read back as nine o'clock.
    for (const date of ["2027-01-15", "2027-02-16", "2027-03-20", "2027-07-13"]) {
      expect(formatTime(wallTimeToInstant(date, "09:00")), date).toBe("09:00");
    }
  });

  it("round-trips every hour of a day either side of the change", () => {
    for (const date of ["2027-02-16", "2027-07-13"]) {
      for (let hour = 6; hour <= 20; hour += 1) {
        const time = `${String(hour).padStart(2, "0")}:30`;
        expect(formatTime(wallTimeToInstant(date, time)), `${date} ${time}`).toBe(time);
      }
    }
  });

  it("handles midnight and the end of the day", () => {
    expect(formatTime(wallTimeToInstant("2027-07-13", "00:00"))).toBe("00:00");
    expect(formatTime(wallTimeToInstant("2027-07-13", "23:45"))).toBe("23:45");
  });

  it("refuses something that is not a date and time", () => {
    expect(() => wallTimeToInstant("not-a-date", "09:00")).toThrow(RangeError);
  });
});

describe("weeklyBlocks", () => {
  it("returns one block per week requested", () => {
    const blocks = weeklyBlocks({
      date: "2027-07-13",
      start: "09:00",
      end: "13:00",
      weeks: 4,
    });
    expect(blocks).toHaveLength(4);
  });

  it("keeps the same wall-clock hours every week", () => {
    const blocks = weeklyBlocks({
      date: "2027-07-13",
      start: "09:00",
      end: "13:00",
      weeks: 4,
    });
    for (const block of blocks) {
      expect(formatTime(block.start)).toBe("09:00");
      expect(formatTime(block.end)).toBe("13:00");
    }
  });

  it("holds the hour across the Ramadan change rather than drifting", () => {
    // Starting a fortnight before the clocks move and repeating through it:
    // adding seven days to the first instant would shift the later weeks by
    // an hour, so each week is converted from its own wall-clock time.
    const blocks = weeklyBlocks({
      date: "2027-01-26",
      start: "09:00",
      end: "12:00",
      weeks: 6,
    });

    for (const block of blocks) {
      expect(formatTime(block.start)).toBe("09:00");
    }

    // And the underlying instants genuinely differ across the boundary, which
    // is what proves the conversion is doing something.
    const utcHours = new Set(blocks.map((b) => b.start.getUTCHours()));
    expect(utcHours.size).toBeGreaterThan(1);
  });

  it("steps exactly seven local days each time", () => {
    const blocks = weeklyBlocks({
      date: "2027-07-13",
      start: "09:00",
      end: "13:00",
      weeks: 3,
    });
    const dates = blocks.map((b) =>
      new Intl.DateTimeFormat("en-CA", {
        timeZone: "Africa/Casablanca",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(b.start),
    );
    expect(dates).toEqual(["2027-07-13", "2027-07-20", "2027-07-27"]);
  });

  it("treats an end before the start as running past midnight", () => {
    const [block] = weeklyBlocks({
      date: "2027-07-13",
      start: "22:00",
      end: "02:00",
      weeks: 1,
    });
    expect(block.end.getTime()).toBeGreaterThan(block.start.getTime());
    expect(block.end.getTime() - block.start.getTime()).toBe(4 * 3_600_000);
  });

  it("clamps the repeat to something sane", () => {
    expect(weeklyBlocks({ date: "2027-07-13", start: "09:00", end: "13:00", weeks: 0 }))
      .toHaveLength(1);
    expect(weeklyBlocks({ date: "2027-07-13", start: "09:00", end: "13:00", weeks: 500 }))
      .toHaveLength(26);
  });
});

describe("validateBlock", () => {
  const base = { date: "2027-07-13", start: "09:00", end: "13:00", slotMinutes: 30 };

  it("accepts a sensible morning", () => {
    expect(validateBlock(base)).toBeNull();
  });

  it("refuses a block that ends before it starts", () => {
    expect(validateBlock({ ...base, start: "13:00", end: "09:00" })).toBe("ENDS_BEFORE_START");
  });

  it("refuses a block shorter than one consultation", () => {
    expect(validateBlock({ ...base, end: "09:20", slotMinutes: 30 })).toBe("SHORTER_THAN_SLOT");
  });

  it("refuses an implausible consultation length", () => {
    expect(validateBlock({ ...base, slotMinutes: 1 })).toBe("INVALID_TIME");
    expect(validateBlock({ ...base, slotMinutes: 600 })).toBe("INVALID_TIME");
  });

  it("refuses malformed input", () => {
    expect(validateBlock({ ...base, date: "13/07/2027" })).toBe("INVALID_TIME");
    expect(validateBlock({ ...base, start: "9h" })).toBe("INVALID_TIME");
  });
});

describe("slotsInBlock", () => {
  it("counts the consultations a block yields", () => {
    expect(slotsInBlock("09:00", "13:00", 30)).toBe(8);
    expect(slotsInBlock("09:00", "10:00", 15)).toBe(4);
  });

  it("never counts a consultation that would run past the end", () => {
    expect(slotsInBlock("09:00", "09:50", 20)).toBe(2);
  });

  it("is zero for an empty or backwards block", () => {
    expect(slotsInBlock("09:00", "09:00", 30)).toBe(0);
    expect(slotsInBlock("13:00", "09:00", 30)).toBe(0);
  });
});
