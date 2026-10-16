/**
 * What state an appointment is in, and who may change it next.
 *
 * The database decides this: `guard_appointment_update` in
 * `supabase/schema.sql` refuses anything else, and it is the only thing
 * standing between a patient and a three-in-the-morning consultation. What
 * lives here is the matching view of the same rules, so the interface does
 * not offer a button the database is going to refuse — an action that fails
 * is worse than an action that was never offered.
 *
 * It is also where the English the enum is written in becomes the French a
 * cabinet reads. Showing `no_show` to a practitioner is a bug, not a detail.
 */

export const APPOINTMENT_STATUSES = [
  "requested",
  "confirmed",
  "cancelled",
  "completed",
  "no_show",
] as const;

export type AppointmentStatus = (typeof APPOINTMENT_STATUSES)[number];

export function isAppointmentStatus(value: string): value is AppointmentStatus {
  return (APPOINTMENT_STATUSES as readonly string[]).includes(value);
}

/** Endings. Past one of these, the row is a record and stops moving. */
const CLOSED: readonly AppointmentStatus[] = ["cancelled", "completed", "no_show"];

export function isClosed(status: AppointmentStatus): boolean {
  return CLOSED.includes(status);
}

interface Label {
  /** What the patient is told. */
  readonly patient: string;
  /** What the practitioner is told, which is not always the same thing. */
  readonly doctor: string;
  readonly tone: "pending" | "success" | "danger" | "neutral";
}

const LABELS: Record<AppointmentStatus, Label> = {
  requested: {
    patient: "En attente de confirmation",
    doctor: "À confirmer",
    tone: "pending",
  },
  confirmed: { patient: "Confirmé", doctor: "Confirmé", tone: "success" },
  cancelled: { patient: "Annulé", doctor: "Annulé", tone: "danger" },
  completed: { patient: "Consultation effectuée", doctor: "Effectuée", tone: "neutral" },
  // The patient is told they were marked absent rather than accused of it;
  // the practitioner sees the shorter word they clicked.
  no_show: { patient: "Noté comme absent", doctor: "Absent", tone: "danger" },
};

export function statusLabel(status: AppointmentStatus, side: "patient" | "doctor"): string {
  return LABELS[status][side];
}

export function statusTone(status: AppointmentStatus): Label["tone"] {
  return LABELS[status].tone;
}

/**
 * A patient may withdraw, and only withdraw, up to the minute the
 * consultation starts. A late cancellation is still far better for the
 * cabinet than silence, so there is no deadline before it.
 */
export function canPatientCancel(
  status: AppointmentStatus,
  startAt: Date,
  now: Date = new Date(),
): boolean {
  return !isClosed(status) && startAt.getTime() > now.getTime();
}

export type DoctorAction = "confirm" | "cancel" | "complete" | "no_show";

interface ActionDescription {
  readonly action: DoctorAction;
  readonly status: AppointmentStatus;
  readonly label: string;
  /** Shown under the button where the consequence is not obvious. */
  readonly hint?: string;
  readonly destructive: boolean;
}

/**
 * What the practitioner can do with this appointment right now.
 *
 * Attendance is an observation about a consultation that has begun: tomorrow's
 * patient has not failed to arrive yet, so "effectuée" and "absent" only
 * appear once the appointment has started.
 */
export function doctorActions(
  status: AppointmentStatus,
  startAt: Date,
  now: Date = new Date(),
): readonly ActionDescription[] {
  if (isClosed(status)) return [];

  const started = startAt.getTime() <= now.getTime();
  const actions: ActionDescription[] = [];

  if (status === "requested") {
    actions.push({
      action: "confirm",
      status: "confirmed",
      label: "Confirmer",
      hint: "Le patient voit son rendez-vous confirmé.",
      destructive: false,
    });
  }

  if (started) {
    actions.push({
      action: "complete",
      status: "completed",
      label: "Consultation effectuée",
      destructive: false,
    });
    actions.push({
      action: "no_show",
      status: "no_show",
      label: "Patient absent",
      destructive: true,
    });
  }

  actions.push({
    action: "cancel",
    status: "cancelled",
    label: status === "requested" ? "Refuser" : "Annuler",
    hint: "Prévenez le patient : rien ne lui est envoyé automatiquement.",
    destructive: true,
  });

  return actions;
}
