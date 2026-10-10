/**
 * Presenting slots to a patient.
 *
 * The database returns a flat list of free times; a person needs them grouped
 * by day, with a sense of morning and afternoon. All of that is display, and
 * display happens in Morocco's time zone rather than the browser's: a patient
 * booking from Paris or Madrid must see the hour they are expected at the
 * cabinet, not their own local time.
 *
 * The zone is resolved through the IANA database rather than a fixed offset,
 * which matters here more than it usually would. Morocco sits on UTC+1
 * year-round but returns to UTC for the month of Ramadan, so a cabinet's
 * "09:00" is not a constant distance from UTC, and a hard-coded +01:00 would
 * show the wrong hour for several weeks a year.
 */

export const MOROCCO_TIME_ZONE = "Africa/Casablanca";

export interface Slot {
  readonly start: Date;
  readonly end: Date;
}

export interface SlotDay {
  /** Local calendar date, "yyyy-mm-dd" in the cabinet's zone. */
  readonly date: string;
  /** Midday of that local date, for formatting a heading. */
  readonly anchor: Date;
  readonly slots: readonly Slot[];
}

/** Parses what the `available_slots` function returns. */
export function toSlots(
  rows: readonly { slot_start: string; slot_end: string }[] | null,
): Slot[] {
  return (rows ?? []).map((row) => ({
    start: new Date(row.slot_start),
    end: new Date(row.slot_end),
  }));
}

/** The local calendar date of an instant, in the cabinet's zone. */
export function localDate(instant: Date, timeZone = MOROCCO_TIME_ZONE): string {
  // en-CA formats as yyyy-mm-dd, which sorts correctly as a string.
  return new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone,
  }).format(instant);
}

export function formatTime(instant: Date, timeZone = MOROCCO_TIME_ZONE): string {
  return new Intl.DateTimeFormat("fr-MA", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone,
  }).format(instant);
}

export function formatDayLong(instant: Date, timeZone = MOROCCO_TIME_ZONE): string {
  return new Intl.DateTimeFormat("fr-MA", {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone,
  }).format(instant);
}

/**
 * A relative label where one helps. "Mardi 14 avril" is precise but slower to
 * read than "Demain" when the appointment is tomorrow.
 */
export function dayLabel(
  instant: Date,
  now: Date = new Date(),
  timeZone = MOROCCO_TIME_ZONE,
): string {
  const target = localDate(instant, timeZone);
  if (target === localDate(now, timeZone)) return "Aujourd'hui";
  if (target === localDate(new Date(now.getTime() + 86_400_000), timeZone)) return "Demain";
  return formatDayLong(instant, timeZone);
}

/**
 * Groups slots into local days, preserving order and dropping nothing.
 *
 * Days with no free time are absent rather than present and empty: a column
 * of dashes for a Sunday tells the patient less than simply not offering it.
 */
export function groupByDay(
  slots: readonly Slot[],
  timeZone = MOROCCO_TIME_ZONE,
): SlotDay[] {
  const byDate = new Map<string, Slot[]>();

  for (const slot of slots) {
    const date = localDate(slot.start, timeZone);
    const bucket = byDate.get(date);
    if (bucket) bucket.push(slot);
    else byDate.set(date, [slot]);
  }

  return [...byDate.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, daySlots]) => ({
      date,
      anchor: daySlots[0].start,
      slots: [...daySlots].sort((a, b) => a.start.getTime() - b.start.getTime()),
    }));
}

/** The soonest free time, for the "next availability" line on a profile. */
export function nextAvailability(slots: readonly Slot[]): Slot | null {
  if (slots.length === 0) return null;
  return slots.reduce((soonest, slot) =>
    slot.start.getTime() < soonest.start.getTime() ? slot : soonest,
  );
}
