import { describe, expect, it } from "vitest";
import {
  canPatientCancel,
  doctorActions,
  isAppointmentStatus,
  isClosed,
  statusLabel,
  APPOINTMENT_STATUSES,
} from "./status";

/**
 * These mirror `guard_appointment_update` in `supabase/schema.sql`. The
 * database is what actually enforces them — what is checked here is that the
 * interface does not offer a button the database will refuse, because an
 * action that fails is worse than one that was never offered.
 */

const now = new Date("2026-03-10T09:00:00Z");
const tomorrow = new Date("2026-03-11T09:00:00Z");
const anHourAgo = new Date("2026-03-10T08:00:00Z");

describe("reading a status back", () => {
  it("has French for every value the enum can hold", () => {
    for (const status of APPOINTMENT_STATUSES) {
      for (const side of ["patient", "doctor"] as const) {
        const label = statusLabel(status, side);
        expect(label).not.toBe("");
        // The surest sign of a missing translation is the enum itself
        // reaching the page.
        expect(label).not.toContain("_");
        expect(label).not.toBe(status);
      }
    }
  });

  it("tells the patient they were marked absent rather than naming them a no-show", () => {
    expect(statusLabel("no_show", "patient")).toBe("Noté comme absent");
    expect(statusLabel("no_show", "doctor")).toBe("Absent");
  });

  it("rejects a value that is not a status", () => {
    expect(isAppointmentStatus("confirmed")).toBe(true);
    expect(isAppointmentStatus("CONFIRMED")).toBe(false);
    expect(isAppointmentStatus("pending")).toBe(false);
  });

  it("treats cancelled, completed and absent as endings", () => {
    expect(isClosed("requested")).toBe(false);
    expect(isClosed("confirmed")).toBe(false);
    expect(isClosed("cancelled")).toBe(true);
    expect(isClosed("completed")).toBe(true);
    expect(isClosed("no_show")).toBe(true);
  });
});

describe("whether the patient is offered a cancel button", () => {
  it("is offered right up to the start, with no deadline before it", () => {
    expect(canPatientCancel("confirmed", tomorrow, now)).toBe(true);
    expect(
      canPatientCancel("confirmed", new Date("2026-03-10T09:01:00Z"), now),
    ).toBe(true);
  });

  it("is withdrawn once the consultation has begun", () => {
    expect(canPatientCancel("confirmed", anHourAgo, now)).toBe(false);
    expect(canPatientCancel("confirmed", now, now)).toBe(false);
  });

  it("is withdrawn once there is an outcome", () => {
    expect(canPatientCancel("cancelled", tomorrow, now)).toBe(false);
    expect(canPatientCancel("completed", tomorrow, now)).toBe(false);
    expect(canPatientCancel("no_show", tomorrow, now)).toBe(false);
  });
});

describe("what the practitioner is offered", () => {
  const labels = (...args: Parameters<typeof doctorActions>) =>
    doctorActions(...args).map((a) => a.action);

  it("offers confirming or refusing a fresh request", () => {
    expect(labels("requested", tomorrow, now)).toEqual(["confirm", "cancel"]);
  });

  it("calls it refusing before confirmation and cancelling after", () => {
    expect(doctorActions("requested", tomorrow, now).at(-1)?.label).toBe("Refuser");
    expect(doctorActions("confirmed", tomorrow, now).at(-1)?.label).toBe("Annuler");
  });

  it("does not offer attendance before the consultation starts", () => {
    expect(labels("confirmed", tomorrow, now)).toEqual(["cancel"]);
  });

  it("offers attendance once it has started", () => {
    expect(labels("confirmed", anHourAgo, now)).toEqual(["complete", "no_show", "cancel"]);
  });

  it("still lets a request that was never answered be recorded afterwards", () => {
    // A walk-in the cabinet saw without clicking confirm first.
    expect(labels("requested", anHourAgo, now)).toEqual([
      "confirm",
      "complete",
      "no_show",
      "cancel",
    ]);
  });

  it("offers nothing once an outcome is recorded", () => {
    for (const status of ["cancelled", "completed", "no_show"] as const) {
      expect(doctorActions(status, anHourAgo, now)).toEqual([]);
    }
  });

  it("marks the actions that cannot be undone", () => {
    const destructive = doctorActions("confirmed", anHourAgo, now)
      .filter((a) => a.destructive)
      .map((a) => a.action);
    expect(destructive).toEqual(["no_show", "cancel"]);
  });

  it("warns that cancelling tells the patient nothing", () => {
    const cancel = doctorActions("confirmed", tomorrow, now).find((a) => a.action === "cancel");
    expect(cancel?.hint).toMatch(/automatiquement/);
  });
});
