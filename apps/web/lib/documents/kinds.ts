/**
 * Document vocabulary, shared by the server and the browser.
 *
 * Kept free of any Supabase import so a client component can show a label
 * without pulling the database client into the browser bundle.
 */

export const DOCUMENT_KINDS = {
  analysis: { fr: "Analyses biologiques", ar: "تحاليل بيولوجية" },
  imaging: { fr: "Imagerie (radio, échographie, IRM)", ar: "تصوير طبي" },
  prescription: { fr: "Ordonnance", ar: "وصفة طبية" },
  report: { fr: "Compte rendu", ar: "تقرير طبي" },
  insurance: { fr: "Document de prise en charge", ar: "وثيقة التغطية الصحية" },
  referral: { fr: "Lettre d'orientation", ar: "رسالة توجيه" },
  other: { fr: "Autre document", ar: "وثيقة أخرى" },
} as const;

export type DocumentKind = keyof typeof DOCUMENT_KINDS;

export function isDocumentKind(value: string): value is DocumentKind {
  return value in DOCUMENT_KINDS;
}

export function kindLabel(kind: DocumentKind, locale: "fr" | "ar" = "fr"): string {
  return DOCUMENT_KINDS[kind][locale];
}

/** A document as the interface needs it. */
export interface DocumentRow {
  readonly id: string;
  readonly patient_id: string;
  readonly appointment_id: string | null;
  readonly uploaded_by: string;
  readonly storage_path: string;
  readonly filename: string;
  readonly mime_type: string;
  readonly size_bytes: number;
  readonly kind: DocumentKind;
  readonly note: string | null;
  readonly created_at: string;
}

export const DOCUMENTS_BUCKET = "medical-documents";
