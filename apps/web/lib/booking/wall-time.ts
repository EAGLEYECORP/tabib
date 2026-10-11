import { MOROCCO_TIME_ZONE } from "./slots";

/**
 * Wall-clock time to an absolute instant.
 *
 * A practitioner opens "Tuesday, nine to one". Storing that means resolving
 * 09:00 in Morocco to a moment in time, and Morocco's offset is not constant:
 * the country keeps UTC+1 year-round but returns to UTC for the month of
 * Ramadan. Only the time-zone database knows when, so the conversion has to
 * consult it rather than add a fixed hour.
 *
 * It is done here, in JavaScript, rather than with PostgreSQL's AT TIME ZONE,
 * for one reason: every time a patient or a doctor *reads* is formatted by
 * Intl, which uses the runtime's ICU data. If writing consulted a different
 * copy of the time-zone database from reading, the two could disagree and a
 * doctor's 09:00 would be shown to a patient as 08:00. Keeping both on the
 * same source means they can only ever be wrong together, which is a much
 * smaller problem than being wrong separately -- and the observed gap is real:
 * some PostgreSQL builds still carry an outdated Africa/Casablanca.
 */

/** Offset of a zone at a given instant, in minutes east of UTC. */
function offsetMinutesAt(instant: Date, timeZone: string): number {
  // Formatting the instant in the target zone and reading it back as if it
  // were UTC gives the shift between the two.
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant);

  const field = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? "0");
  // Intl renders midnight as hour 24 in some locales/engines.
  const hour = field("hour") % 24;

  const asUtc = Date.UTC(
    field("year"),
    field("month") - 1,
    field("day"),
    hour,
    field("minute"),
    field("second"),
  );

  return (asUtc - instant.getTime()) / 60_000;
}

/**
 * Resolves a local date and time in a zone to the instant it names.
 *
 * Two passes: guess using the offset in force at the naive instant, then
 * recheck with the offset actually in force at that result. One correction is
 * enough for every real transition, and the second pass is what makes a date
 * either side of Morocco's Ramadan change come out right.
 *
 * @param date "YYYY-MM-DD" in the practice's local calendar
 * @param time "HH:MM" on the practice's local clock
 */
export function wallTimeToInstant(
  date: string,
  time: string,
  timeZone: string = MOROCCO_TIME_ZONE,
): Date {
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);

  if (
    !Number.isFinite(year) ||
    !Number.isFinite(month) ||
    !Number.isFinite(day) ||
    !Number.isFinite(hour) ||
    !Number.isFinite(minute)
  ) {
    throw new RangeError(`Not a local date and time: ${date} ${time}`);
  }

  const naive = Date.UTC(year, month - 1, day, hour, minute, 0, 0);

  const firstGuess = naive - offsetMinutesAt(new Date(naive), timeZone) * 60_000;
  const corrected = naive - offsetMinutesAt(new Date(firstGuess), timeZone) * 60_000;

  return new Date(corrected);
}

export interface Block {
  readonly start: Date;
  readonly end: Date;
}

/**
 * The same consulting hours, week after week.
 *
 * Each week is converted from its own wall-clock time rather than by adding
 * seven days to the first instant. Across Morocco's Ramadan change those are
 * not the same thing: the clock moves but "nine o'clock" does not, and a
 * practitioner who opened their Tuesday mornings means nine every Tuesday.
 */
export function weeklyBlocks(options: {
  date: string;
  start: string;
  end: string;
  weeks: number;
  timeZone?: string;
}): Block[] {
  const timeZone = options.timeZone ?? MOROCCO_TIME_ZONE;
  const weeks = Math.min(Math.max(Math.trunc(options.weeks) || 1, 1), 26);

  const [year, month, day] = options.date.split("-").map(Number);
  const blocks: Block[] = [];

  for (let week = 0; week < weeks; week += 1) {
    // Date arithmetic on a UTC anchor, so stepping a week never slips a day
    // because of an offset change in between.
    const anchor = new Date(Date.UTC(year, month - 1, day));
    anchor.setUTCDate(anchor.getUTCDate() + week * 7);
    const localDate = anchor.toISOString().slice(0, 10);

    const start = wallTimeToInstant(localDate, options.start, timeZone);
    let end = wallTimeToInstant(localDate, options.end, timeZone);

    // An end time earlier than the start means the block runs past midnight.
    if (end.getTime() <= start.getTime()) {
      const nextDay = new Date(anchor);
      nextDay.setUTCDate(nextDay.getUTCDate() + 1);
      end = wallTimeToInstant(nextDay.toISOString().slice(0, 10), options.end, timeZone);
    }

    blocks.push({ start, end });
  }

  return blocks;
}

export type BlockRejection = "INVALID_TIME" | "ENDS_BEFORE_START" | "SHORTER_THAN_SLOT";

/** Checks a block the way the database will, so the form can say so first. */
export function validateBlock(options: {
  date: string;
  start: string;
  end: string;
  slotMinutes: number;
}): BlockRejection | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(options.date)) return "INVALID_TIME";
  if (!/^\d{2}:\d{2}$/.test(options.start) || !/^\d{2}:\d{2}$/.test(options.end)) {
    return "INVALID_TIME";
  }
  if (options.slotMinutes < 5 || options.slotMinutes > 240) return "INVALID_TIME";

  const [startHour, startMinute] = options.start.split(":").map(Number);
  const [endHour, endMinute] = options.end.split(":").map(Number);
  const startOfDay = startHour * 60 + startMinute;
  const endOfDay = endHour * 60 + endMinute;

  if (endOfDay <= startOfDay) return "ENDS_BEFORE_START";
  if (endOfDay - startOfDay < options.slotMinutes) return "SHORTER_THAN_SLOT";
  return null;
}

/** How many consultations a block of these hours yields. */
export function slotsInBlock(start: string, end: string, slotMinutes: number): number {
  const [startHour, startMinute] = start.split(":").map(Number);
  const [endHour, endMinute] = end.split(":").map(Number);
  const minutes = endHour * 60 + endMinute - (startHour * 60 + startMinute);
  return minutes <= 0 ? 0 : Math.floor(minutes / slotMinutes);
}
