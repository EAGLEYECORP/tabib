"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { DOCUMENT_KINDS, type DocumentRow } from "../lib/documents/kinds";
import { formatBytes } from "../lib/documents/file-types";
import { createClient } from "../lib/supabase/client";

/**
 * A patient's documents, with the controls that act on them.
 *
 * Downloads are ordinary links to the authenticated route, so the browser's
 * own download handling applies and the link still works with JavaScript off.
 * Sharing and deleting need a round trip, so they are buttons.
 */

export interface ShareTarget {
  readonly appointmentId: string;
  readonly label: string;
}

export interface DocumentListItem extends DocumentRow {
  /** Present when the document is attached to an appointment. */
  readonly sharedWith: string | null;
  readonly fromDoctor: string | null;
}

export function DocumentList({
  documents,
  shareTargets = [],
  readOnly = false,
}: {
  documents: readonly DocumentListItem[];
  shareTargets?: readonly ShareTarget[];
  /** The practitioner's view: a doctor never edits a patient's record. */
  readOnly?: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function share(documentId: string, appointmentId: string) {
    setBusy(documentId);
    setError(null);
    const supabase = createClient();
    // Goes through the patient's own session, so the policies decide whether
    // this attachment is allowed — a document can only ever be attached to an
    // appointment the patient actually has.
    const { error: updateError } = await supabase
      .from("documents")
      .update({ appointment_id: appointmentId || null })
      .eq("id", documentId);

    setBusy(null);
    if (updateError) {
      setError("Le partage a échoué.");
      return;
    }
    router.refresh();
  }

  async function remove(documentId: string) {
    setBusy(documentId);
    setError(null);
    const response = await fetch(`/api/documents/${documentId}`, { method: "DELETE" });
    setBusy(null);
    if (!response.ok) {
      setError("La suppression a échoué.");
      return;
    }
    router.refresh();
  }

  if (documents.length === 0) {
    return (
      <div className="card empty">
        <p>
          <strong>Aucun document pour le moment.</strong>
        </p>
        <p className="muted">
          Ajoutez vos analyses ou vos radios pour les avoir sous la main en consultation.
        </p>
      </div>
    );
  }

  return (
    <>
      {error && (
        <p className="notice danger" role="alert">
          {error}
        </p>
      )}
      <ul className="documents">
        {documents.map((document) => (
          <li key={document.id} className="card">
            <div className="doc-head">
              <div>
                <strong className="filename">{document.filename}</strong>
                <p className="muted">
                  {DOCUMENT_KINDS[document.kind]?.fr ?? document.kind} ·{" "}
                  {formatBytes(document.size_bytes)} ·{" "}
                  {new Date(document.created_at).toLocaleDateString("fr-FR")}
                </p>
                {document.note && <p className="muted">{document.note}</p>}
                <p className="chips">
                  {document.fromDoctor ? (
                    <span className="chip accent">Envoyé par {document.fromDoctor}</span>
                  ) : (
                    <span className="chip">Ajouté par vous</span>
                  )}
                  {document.sharedWith ? (
                    <span className="chip success">Partagé avec {document.sharedWith}</span>
                  ) : (
                    <span className="chip">Non partagé</span>
                  )}
                </p>
              </div>

              <div className="doc-actions">
                <a className="secondary" href={`/api/documents/${document.id}`}>
                  Télécharger
                </a>
                {!readOnly && (
                  <button
                    type="button"
                    className="danger-button"
                    disabled={busy === document.id}
                    onClick={() => remove(document.id)}
                  >
                    Supprimer
                  </button>
                )}
              </div>
            </div>

            {!readOnly && shareTargets.length > 0 && (
              <div className="doc-share">
                <label htmlFor={`share-${document.id}`}>Partager avec un praticien</label>
                <select
                  id={`share-${document.id}`}
                  defaultValue={document.appointment_id ?? ""}
                  disabled={busy === document.id}
                  onChange={(event) => share(document.id, event.target.value)}
                >
                  <option value="">Ne pas partager</option>
                  {shareTargets.map((target) => (
                    <option key={target.appointmentId} value={target.appointmentId}>
                      {target.label}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </li>
        ))}
      </ul>
    </>
  );
}
