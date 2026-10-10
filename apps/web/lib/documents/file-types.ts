/**
 * What a patient may upload, and how that is decided.
 *
 * The type is settled by reading the first bytes of the file, never by trusting
 * the Content-Type the browser sent or the extension on the name. Both are
 * attacker-controlled, and the whole risk of a document feature is storing
 * something that is served back later and executed.
 *
 * SVG is deliberately absent despite being an image: it is a document format
 * that can carry script, and no medical workflow needs one.
 */

export interface AllowedType {
  readonly mimeType: string;
  readonly extension: string;
  readonly label: string;
}

/** 20 MB — enough for a scanned report or a set of CT slices. */
export const MAX_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_FILES_PER_UPLOAD = 10;

export const ALLOWED_TYPES: readonly AllowedType[] = [
  { mimeType: "application/pdf", extension: "pdf", label: "PDF" },
  { mimeType: "image/jpeg", extension: "jpg", label: "JPEG" },
  { mimeType: "image/png", extension: "png", label: "PNG" },
  { mimeType: "image/webp", extension: "webp", label: "WebP" },
  { mimeType: "image/heic", extension: "heic", label: "HEIC" },
  { mimeType: "image/tiff", extension: "tiff", label: "TIFF" },
  { mimeType: "application/dicom", extension: "dcm", label: "DICOM" },
];

/** For the file picker's `accept` attribute — a convenience, not a control. */
export const ACCEPT_ATTRIBUTE = ALLOWED_TYPES.map((t) => t.mimeType)
  .concat([".dcm", ".heic"])
  .join(",");

const BY_MIME = new Map(ALLOWED_TYPES.map((t) => [t.mimeType, t]));

export function isAllowedMimeType(mimeType: string): boolean {
  return BY_MIME.has(mimeType);
}

export function extensionFor(mimeType: string): string {
  return BY_MIME.get(mimeType)?.extension ?? "bin";
}

function startsWith(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
  if (bytes.length < offset + signature.length) return false;
  return signature.every((byte, i) => bytes[offset + i] === byte);
}

/**
 * Identifies a file from its leading bytes, or returns null when it is not one
 * of the accepted formats — which is how a renamed executable, or an HTML page
 * called `results.pdf`, gets refused.
 */
export function sniffMimeType(bytes: Uint8Array): string | null {
  // %PDF-
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return "application/pdf";

  // JPEG
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";

  // PNG
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";

  // RIFF....WEBP
  if (
    startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)
  ) {
    return "image/webp";
  }

  // TIFF, little- and big-endian.
  if (startsWith(bytes, [0x49, 0x49, 0x2a, 0x00])) return "image/tiff";
  if (startsWith(bytes, [0x4d, 0x4d, 0x00, 0x2a])) return "image/tiff";

  // ISO base media container: "ftyp" at offset 4, then a brand. HEIC is what
  // an iPhone produces by default, so patients send them constantly — but the
  // same container holds MP4 video, which the brand check keeps out.
  if (startsWith(bytes, [0x66, 0x74, 0x79, 0x70], 4)) {
    const brand = new TextDecoder("latin1").decode(bytes.slice(8, 12));
    return ["heic", "heix", "hevc", "heim", "heis", "mif1", "msf1"].includes(brand)
      ? "image/heic"
      : null;
  }

  // DICOM: "DICM" at offset 128.
  if (startsWith(bytes, [0x44, 0x49, 0x43, 0x4d], 128)) return "application/dicom";

  return null;
}

/**
 * Removes control characters by code point rather than by regex, so there is
 * no escaping to get subtly wrong. These have no place in a stored name or in
 * a Content-Disposition header, where a newline would let an uploader forge a
 * response header.
 */
function stripControlCharacters(value: string): string {
  let out = "";
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code >= 0x20 && code !== 0x7f) out += character;
  }
  return out;
}

/**
 * Reduces a client-supplied filename to something safe to store and to echo
 * back on download.
 *
 * Path separators and control characters go; the extension is replaced with
 * the one matching the sniffed type, so a file that claims to be `report.pdf`
 * but is really a photograph is labelled `report.jpg` and cannot mislead
 * whoever opens it later.
 */
export function sanitiseFilename(raw: string, mimeType: string): string {
  const base = stripControlCharacters(raw)
    .replace(/[\\/]/g, " ")
    .replace(/\.\.+/g, ".")
    .trim();

  // The extension is dropped before leading dots are stripped, so a name that
  // is nothing but an extension (".pdf") falls through to the default instead
  // of becoming "pdf.pdf".
  const stem = base
    .replace(/\.[A-Za-z0-9]{1,8}$/, "")
    .replace(/^[.\s]+/, "")
    .slice(0, 120)
    .trim();

  return `${stem || "document"}.${extensionFor(mimeType)}`;
}

export type RejectionReason = "EMPTY" | "TOO_LARGE" | "UNSUPPORTED_TYPE";

export interface AcceptedFile {
  readonly mimeType: string;
  readonly filename: string;
  readonly sizeBytes: number;
}

/**
 * The single decision point for an upload: either the file is acceptable and
 * its real type and safe name come back, or it is refused with a reason the
 * interface can translate.
 */
export function inspectUpload(
  bytes: Uint8Array,
  declaredFilename: string,
): { ok: true; file: AcceptedFile } | { ok: false; reason: RejectionReason } {
  if (bytes.byteLength === 0) return { ok: false, reason: "EMPTY" };
  if (bytes.byteLength > MAX_FILE_BYTES) return { ok: false, reason: "TOO_LARGE" };

  const mimeType = sniffMimeType(bytes);
  if (!mimeType || !isAllowedMimeType(mimeType)) {
    return { ok: false, reason: "UNSUPPORTED_TYPE" };
  }

  return {
    ok: true,
    file: {
      mimeType,
      filename: sanitiseFilename(declaredFilename, mimeType),
      sizeBytes: bytes.byteLength,
    },
  };
}

/** Human-readable size, in the reader's language. */
export function formatBytes(bytes: number, locale: "fr" | "ar" = "fr"): string {
  const units = locale === "ar" ? ["بايت", "ك.ب", "م.ب"] : ["o", "Ko", "Mo"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = value >= 10 || unit === 0 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded} ${units[unit]}`;
}
