"use client";

import { useCallback, useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { DOCUMENT_KINDS, type DocumentKind } from "../lib/documents/kinds";
import {
  ACCEPT_ATTRIBUTE,
  ALLOWED_TYPES,
  MAX_FILES_PER_UPLOAD,
  MAX_FILE_BYTES,
  formatBytes,
} from "../lib/documents/file-types";

/**
 * Uploading documents.
 *
 * Sent with XMLHttpRequest rather than fetch, because it is still the only way
 * to observe upload progress in a browser. That matters more here than it
 * usually would: a radiology image runs to tens of megabytes, and a patient on
 * mobile data who sees no movement assumes it has hung and starts again.
 */

export interface ShareTarget {
  readonly appointmentId: string;
  readonly label: string;
}

type Phase =
  | { readonly state: "idle" }
  | { readonly state: "uploading"; readonly percent: number }
  | { readonly state: "done"; readonly count: number }
  | { readonly state: "error"; readonly message: string };

const MESSAGES: Record<string, string> = {
  TOO_LARGE: "Fichier trop volumineux.",
  UNSUPPORTED_TYPE: "Format non accepté.",
  EMPTY: "Fichier vide.",
  STORAGE_FAILED: "L'envoi a échoué.",
  REJECTED: "Document refusé.",
  NOT_AUTHENTICATED: "Votre session a expiré. Reconnectez-vous.",
  FORBIDDEN: "Vous n'avez pas accès à ce rendez-vous.",
};

function messageFor(code: string): string {
  return MESSAGES[code] ?? "L'envoi a échoué. Réessayez.";
}

export function DocumentUploader({
  shareTargets = [],
  fixedAppointmentId,
  defaultKind = "analysis",
}: {
  shareTargets?: readonly ShareTarget[];
  /** When set, everything uploaded is attached to this appointment. */
  fixedAppointmentId?: string;
  defaultKind?: DocumentKind;
}) {
  const router = useRouter();
  const [files, setFiles] = useState<File[]>([]);
  const [kind, setKind] = useState<DocumentKind>(defaultKind);
  const [note, setNote] = useState("");
  const [appointmentId, setAppointmentId] = useState(fixedAppointmentId ?? "");
  const [dragging, setDragging] = useState(false);
  const [phase, setPhase] = useState<Phase>({ state: "idle" });

  const inputRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const fieldId = useId();

  const addFiles = useCallback((incoming: FileList | null) => {
    if (!incoming) return;

    // Snapshot the FileList now, before the state updater runs. The input is
    // cleared right after this call so the same file can be picked twice in a
    // row, and a FileList is live: reading it inside the updater, which React
    // may defer to render, would find it already empty.
    const picked = Array.from(incoming);
    if (picked.length === 0) return;

    setPhase({ state: "idle" });
    setFiles((current) => {
      const merged = [...current];
      for (const file of picked) {
        // Picking the same file twice is a common slip on a phone, and
        // uploading it twice wastes the patient's data allowance.
        if (merged.some((f) => f.name === file.name && f.size === file.size)) continue;
        if (merged.length >= MAX_FILES_PER_UPLOAD) break;
        merged.push(file);
      }
      return merged;
    });
  }, []);

  const oversize = files.some((file) => file.size > MAX_FILE_BYTES);

  function submit() {
    if (files.length === 0 || phase.state === "uploading") return;

    const body = new FormData();
    for (const file of files) body.append("files", file);
    body.append("kind", kind);
    if (note.trim()) body.append("note", note.trim());
    if (appointmentId) body.append("appointmentId", appointmentId);

    const request = new XMLHttpRequest();
    request.open("POST", "/api/documents");
    request.responseType = "json";

    request.upload.addEventListener("progress", (event) => {
      if (!event.lengthComputable) return;
      setPhase({ state: "uploading", percent: Math.round((event.loaded / event.total) * 100) });
    });

    request.addEventListener("load", () => {
      const payload = request.response as {
        uploaded?: unknown[];
        failed?: { filename: string; reason: string }[];
        error?: string;
      } | null;

      if (request.status === 201) {
        const count = payload?.uploaded?.length ?? 0;
        const rejected = payload?.failed ?? [];
        setFiles([]);
        setNote("");
        setPhase(
          rejected.length > 0
            ? {
                state: "error",
                message: `${count} envoyé(s). ${rejected
                  .map((f) => `${f.filename} : ${messageFor(f.reason)}`)
                  .join(" ")}`,
              }
            : { state: "done", count },
        );
        router.refresh();
        return;
      }

      setPhase({
        state: "error",
        message: messageFor(payload?.failed?.[0]?.reason ?? payload?.error ?? ""),
      });
    });

    request.addEventListener("error", () =>
      setPhase({ state: "error", message: "Connexion interrompue. Réessayez." }),
    );

    setPhase({ state: "uploading", percent: 0 });
    request.send(body);
  }

  return (
    <div className="uploader">
      {/* A label wrapping the input keeps the whole zone clickable and
          reachable from the keyboard without a click handler on a div. */}
      <label
        htmlFor={`${fieldId}-files`}
        className={`dropzone${dragging ? " dropzone-active" : ""}`}
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          addFiles(event.dataTransfer.files);
        }}
      >
        <strong>Glissez vos fichiers ici</strong>
        <span className="muted">ou parcourez votre appareil</span>
        <small className="muted">
          {ALLOWED_TYPES.map((t) => t.label).join(", ")} — {formatBytes(MAX_FILE_BYTES)} maximum
        </small>
        <input
          ref={inputRef}
          id={`${fieldId}-files`}
          type="file"
          multiple
          accept={ACCEPT_ATTRIBUTE}
          className="visually-hidden"
          onChange={(event) => {
            addFiles(event.target.files);
            event.target.value = "";
          }}
        />
      </label>

      {/* Photographing a paper result is how most documents arrive here, so
          the camera is a first-class action rather than something buried in
          the file picker. */}
      <div className="row">
        <button type="button" className="secondary" onClick={() => inputRef.current?.click()}>
          Choisir des fichiers
        </button>
        <button type="button" className="secondary camera" onClick={() => cameraRef.current?.click()}>
          Prendre une photo
        </button>
        <input
          ref={cameraRef}
          type="file"
          accept="image/*"
          capture="environment"
          className="visually-hidden"
          onChange={(event) => {
            addFiles(event.target.files);
            event.target.value = "";
          }}
        />
      </div>

      {files.length > 0 && (
        <>
          <ul className="filelist">
            {files.map((file, index) => (
              <li key={`${file.name}-${file.size}-${index}`}>
                <span className="filename">{file.name}</span>
                <span className={file.size > MAX_FILE_BYTES ? "danger" : "muted"}>
                  {formatBytes(file.size)}
                </span>
                <button
                  type="button"
                  aria-label={`Retirer ${file.name}`}
                  onClick={() => setFiles((current) => current.filter((_, i) => i !== index))}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>

          <div className="fields">
            <div>
              <label htmlFor={`${fieldId}-kind`}>Type de document</label>
              <select
                id={`${fieldId}-kind`}
                value={kind}
                onChange={(event) => setKind(event.target.value as DocumentKind)}
              >
                {(Object.keys(DOCUMENT_KINDS) as DocumentKind[]).map((code) => (
                  <option key={code} value={code}>
                    {DOCUMENT_KINDS[code].fr}
                  </option>
                ))}
              </select>
            </div>

            {!fixedAppointmentId && shareTargets.length > 0 && (
              <div>
                <label htmlFor={`${fieldId}-share`}>Partager avec un praticien</label>
                <select
                  id={`${fieldId}-share`}
                  value={appointmentId}
                  onChange={(event) => setAppointmentId(event.target.value)}
                >
                  <option value="">Ne pas partager pour l&apos;instant</option>
                  {shareTargets.map((target) => (
                    <option key={target.appointmentId} value={target.appointmentId}>
                      {target.label}
                    </option>
                  ))}
                </select>
              </div>
            )}

            <div className="wide">
              <label htmlFor={`${fieldId}-note`}>Note (facultatif)</label>
              <input
                id={`${fieldId}-note`}
                value={note}
                maxLength={500}
                placeholder="Ex. : bilan sanguin du 12 mars"
                onChange={(event) => setNote(event.target.value)}
              />
            </div>
          </div>
        </>
      )}

      {phase.state === "uploading" && (
        <div>
          <div
            className="progress"
            role="progressbar"
            aria-valuenow={phase.percent}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div className="progress-bar" style={{ width: `${phase.percent}%` }} />
          </div>
          <p className="muted">Envoi… {phase.percent}%</p>
        </div>
      )}

      {phase.state === "done" && (
        <p className="notice success" role="status">
          {phase.count === 1 ? "1 document ajouté" : `${phase.count} documents ajoutés`}
        </p>
      )}

      {phase.state === "error" && (
        <p className="notice danger" role="alert">
          {phase.message}
        </p>
      )}

      {files.length > 0 && (
        <button
          type="button"
          className="button"
          onClick={submit}
          disabled={phase.state === "uploading" || oversize}
        >
          {phase.state === "uploading" ? "Envoi…" : "Envoyer"}
        </button>
      )}
    </div>
  );
}
