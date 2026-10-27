import { describe, expect, it } from "vitest";
import {
  TEMPLATES,
  isTemplate,
  renderNotification,
} from "./templates";

/**
 * A text message is charged by the segment: 160 characters of plain GSM-7, or
 * 70 once a single accented character forces UCS-2. Both limits are easy to
 * cross by accident and neither announces itself — the message simply costs
 * twice as much, forever. These tests hold every template to one segment with
 * a realistic Moroccan name in it.
 */

const SEGMENT = 160;

/** 15:00 in Casablanca: June, so Morocco is on its usual UTC+1. */
const startAt = "2026-06-14T14:00:00Z";

const full = {
  start_at: startAt,
  doctor_name: "Dr Youssef El Amrani",
  patient_name: "Salma Bennis-Alaoui",
};

describe("rendering a notification", () => {
  it("has a message for every template the database can queue", () => {
    for (const template of TEMPLATES) {
      expect(renderNotification(template, full)).toBeTruthy();
    }
  });

  it("returns nothing for a template it does not know", () => {
    // A schema change the sender has not caught up with. Sending a fragment
    // would be worse than sending nothing.
    expect(renderNotification("appointment.rescheduled", full)).toBeNull();
    expect(isTemplate("appointment.rescheduled")).toBe(false);
  });

  it("fits every message into one text message", () => {
    for (const template of TEMPLATES) {
      const body = renderNotification(template, full)!;
      expect(body.length, `${template} is ${body.length} characters`).toBeLessThanOrEqual(
        SEGMENT,
      );
    }
  });

  it("uses no accented characters, which would cut the limit to 70", () => {
    for (const template of TEMPLATES) {
      const body = renderNotification(template, full)!;
      expect(body, template).toMatch(/^[\x20-\x7e]*$/);
    }
  });

  it("gives the time in the cabinet's zone, not the reader's", () => {
    // 14:00 UTC is 15:00 in Casablanca for most of the year.
    expect(renderNotification("appointment.confirmed", full)).toContain("14/06 a 15:00");
  });

  it("follows Morocco back to UTC for Ramadan", () => {
    // Morocco sits on UTC+1 year-round but returns to UTC for Ramadan, so the
    // same instant is reported an hour apart either side of it. A hard-coded
    // +01:00 — or a server whose time-zone data is stale, which is what
    // PostgreSQL had here — gets one of these two wrong, and a reminder an
    // hour out is worse than no reminder.
    const inside = renderNotification("appointment.confirmed", {
      ...full,
      start_at: "2026-03-14T14:00:00Z",
    });
    const after = renderNotification("appointment.confirmed", {
      ...full,
      start_at: "2026-03-25T14:00:00Z",
    });
    expect(inside).toContain("14/03 a 14:00");
    expect(after).toContain("25/03 a 15:00");
  });

  it("keeps the name, shortening it rather than overflowing the segment", () => {
    const body = renderNotification("appointment.requested", {
      ...full,
      patient_name: "Abdessamad Ait Benhaddou El Fassi Fihri",
    })!;
    expect(body.length).toBeLessThanOrEqual(SEGMENT);
    expect(body).toContain("Abdessamad Ait Benhaddou El.");
  });

  it("still says something useful when a name is missing", () => {
    // A patient who booked before filling in their name.
    expect(
      renderNotification("appointment.requested", { start_at: startAt, patient_name: null }),
    ).toContain("Un patient");
    expect(
      renderNotification("appointment.confirmed", { start_at: startAt, doctor_name: null }),
    ).toContain("votre praticien");
  });

  it("does not print Invalid Date when the payload is wrong", () => {
    for (const payload of [{}, { start_at: "pas une date" }]) {
      const body = renderNotification("appointment.confirmed", payload)!;
      expect(body).not.toMatch(/Invalid|NaN|undefined|null/);
    }
  });
});
