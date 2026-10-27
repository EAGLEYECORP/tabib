import { MOROCCO_TIME_ZONE } from "../booking/slots";

/**
 * Turning a queued notification into a sentence.
 *
 * The database stores a template name and a payload, never a rendered
 * message, and the rendering happens here for the same reason wall-clock
 * times are converted here: Morocco sits on UTC+1 but returns to UTC for
 * Ramadan, and the PostgreSQL this was developed against reports
 * `Africa/Casablanca` as a flat UTC+0 for every date. A reminder that says
 * 14:00 for a 15:00 consultation is worse than no reminder, so the message is
 * formatted by the same `Intl` that renders the time on the page.
 *
 * Text messages are charged by the segment — 160 characters for plain GSM-7,
 * and 70 once an accented character pushes it to UCS-2. Every message below
 * is written to fit one segment with a realistic name in it, and a test holds
 * them to it.
 */

export const TEMPLATES = [
  "appointment.requested",
  "appointment.confirmed",
  "appointment.cancelled_by_doctor",
  "appointment.cancelled_by_patient",
  "appointment.reminder",
  "closure.affected",
] as const;

export type NotificationTemplate = (typeof TEMPLATES)[number];

export function isTemplate(value: string): value is NotificationTemplate {
  return (TEMPLATES as readonly string[]).includes(value);
}

export interface NotificationPayload {
  readonly start_at?: string;
  readonly doctor_name?: string | null;
  readonly patient_name?: string | null;
}

/** 14/03 à 15:30, in the cabinet's time zone rather than the reader's. */
function when(startAt: string | undefined): string {
  if (!startAt) return "";
  const date = new Date(startAt);
  if (Number.isNaN(date.getTime())) return "";
  const day = new Intl.DateTimeFormat("fr-FR", {
    timeZone: MOROCCO_TIME_ZONE,
    day: "2-digit",
    month: "2-digit",
  }).format(date);
  const time = new Intl.DateTimeFormat("fr-FR", {
    timeZone: MOROCCO_TIME_ZONE,
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
  return `${day} a ${time}`;
}

/**
 * Names are shortened rather than dropped, because a message with no name in
 * it is hard to act on, and one that overflows into a second segment costs
 * twice as much to send.
 */
function shorten(name: string | null | undefined, fallback: string, limit = 28): string {
  const trimmed = (name ?? "").trim();
  if (!trimmed) return fallback;
  return trimmed.length <= limit ? trimmed : `${trimmed.slice(0, limit - 1)}.`;
}

/**
 * The French of each message is deliberately unaccented. An accented
 * character moves a text message from 160 characters to 70, which would split
 * every one of these in two — and "a 15:30" costs nothing a patient cannot
 * read, where a message arriving in two charged pieces does.
 */
export function renderNotification(
  template: string,
  payload: NotificationPayload,
): string | null {
  const at = when(payload.start_at);
  const doctor = shorten(payload.doctor_name, "votre praticien");
  const patient = shorten(payload.patient_name, "Un patient");

  switch (template) {
    case "appointment.requested":
      return `Tabib.ma : nouvelle demande de ${patient}, le ${at}. A confirmer sur tabib.ma/pro`;

    case "appointment.confirmed":
      return `Tabib.ma : votre rendez-vous avec ${doctor} le ${at} est confirme.`;

    case "appointment.cancelled_by_doctor":
      return `Tabib.ma : votre rendez-vous avec ${doctor} du ${at} est annule par le cabinet. Reprenez rendez-vous sur tabib.ma`;

    case "appointment.cancelled_by_patient":
      return `Tabib.ma : ${patient} annule son rendez-vous du ${at}. Le creneau est de nouveau libre.`;

    case "appointment.reminder":
      return `Tabib.ma : rappel, rendez-vous avec ${doctor} le ${at}. Pour annuler : tabib.ma`;

    case "closure.affected":
      return `Tabib.ma : ${doctor} a ferme son agenda le ${at}. Le cabinet va vous contacter au sujet de votre rendez-vous.`;

    default:
      // An unknown template is a schema change the sender has not caught up
      // with. Sending nothing is better than sending a fragment, and the row
      // stays pending rather than being marked sent.
      return null;
  }
}
