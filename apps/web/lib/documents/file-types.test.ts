import { describe, expect, it } from "vitest";
import {
  MAX_FILE_BYTES,
  extensionFor,
  formatBytes,
  inspectUpload,
  isAllowedMimeType,
  sanitiseFilename,
  sniffMimeType,
} from "./file-types";

/**
 * Upload validation stands between a patient's document folder and an attacker
 * storing something that gets served back later, so it is tested against the
 * shapes an attacker would actually try, not only the happy path.
 */

const PDF = Buffer.from("%PDF-1.7\nbody");
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);

function isoContainer(brand: string): Buffer {
  const buffer = Buffer.alloc(32);
  buffer.write("ftyp", 4, "latin1");
  buffer.write(brand, 8, "latin1");
  return buffer;
}

function dicom(): Buffer {
  const buffer = Buffer.alloc(140);
  buffer.write("DICM", 128, "latin1");
  return buffer;
}

describe("sniffMimeType", () => {
  it("recognises the formats patients actually send", () => {
    expect(sniffMimeType(PDF)).toBe("application/pdf");
    expect(sniffMimeType(JPEG)).toBe("image/jpeg");
    expect(sniffMimeType(PNG)).toBe("image/png");
    expect(sniffMimeType(isoContainer("heic"))).toBe("image/heic");
    expect(sniffMimeType(dicom())).toBe("application/dicom");
  });

  it("recognises WebP by its RIFF container", () => {
    const webp = Buffer.alloc(16);
    webp.write("RIFF", 0, "latin1");
    webp.write("WEBP", 8, "latin1");
    expect(sniffMimeType(webp)).toBe("image/webp");
  });

  it("recognises TIFF in both byte orders", () => {
    expect(sniffMimeType(Buffer.from([0x49, 0x49, 0x2a, 0x00]))).toBe("image/tiff");
    expect(sniffMimeType(Buffer.from([0x4d, 0x4d, 0x00, 0x2a]))).toBe("image/tiff");
  });

  it("rejects HTML however it is named", () => {
    expect(sniffMimeType(Buffer.from("<html><script>alert(1)</script>"))).toBeNull();
    expect(sniffMimeType(Buffer.from("<!DOCTYPE html>"))).toBeNull();
  });

  it("rejects SVG, which carries script and has no medical use here", () => {
    expect(sniffMimeType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>')))
      .toBeNull();
  });

  it("rejects executables and archives", () => {
    expect(sniffMimeType(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))).toBeNull(); // ELF
    expect(sniffMimeType(Buffer.from([0x4d, 0x5a, 0x90, 0x00]))).toBeNull(); // PE
    expect(sniffMimeType(Buffer.from([0x50, 0x4b, 0x03, 0x04]))).toBeNull(); // ZIP
  });

  it("rejects video sharing HEIC's container", () => {
    expect(sniffMimeType(isoContainer("mp42"))).toBeNull();
    expect(sniffMimeType(isoContainer("isom"))).toBeNull();
  });

  it("rejects an empty or truncated file rather than guessing", () => {
    expect(sniffMimeType(Buffer.alloc(0))).toBeNull();
    expect(sniffMimeType(Buffer.from([0x25, 0x50]))).toBeNull();
  });

  it("ignores a signature that appears too late in the file", () => {
    expect(sniffMimeType(Buffer.concat([Buffer.from("junk"), PDF]))).toBeNull();
  });
});

describe("isAllowedMimeType", () => {
  it("accepts the documented formats and nothing else", () => {
    expect(isAllowedMimeType("application/pdf")).toBe(true);
    expect(isAllowedMimeType("image/svg+xml")).toBe(false);
    expect(isAllowedMimeType("text/html")).toBe(false);
  });
});

describe("sanitiseFilename", () => {
  it("strips directory traversal", () => {
    expect(sanitiseFilename("../../etc/passwd.pdf", "application/pdf")).toBe("etc passwd.pdf");
    expect(sanitiseFilename("..\\..\\system32.pdf", "application/pdf")).not.toContain("..");
  });

  it("removes control characters that could forge a response header", () => {
    const injected = `report${String.fromCharCode(13)}${String.fromCharCode(10)}X-Evil: 1.pdf`;
    const result = sanitiseFilename(injected, "application/pdf");
    expect(result).not.toContain(String.fromCharCode(13));
    expect(result).not.toContain(String.fromCharCode(10));
  });

  it("names the file for its real content, not its claimed extension", () => {
    expect(sanitiseFilename("analyse.pdf", "image/png")).toBe("analyse.png");
    expect(sanitiseFilename("scan.exe", "image/jpeg")).toBe("scan.jpg");
  });

  it("keeps Arabic and accented names intact", () => {
    expect(sanitiseFilename("تحليل الدم.pdf", "application/pdf")).toBe("تحليل الدم.pdf");
    expect(sanitiseFilename("échographie.jpg", "image/jpeg")).toBe("échographie.jpg");
  });

  it("falls back to a generic name when nothing usable is left", () => {
    expect(sanitiseFilename("   ", "application/pdf")).toBe("document.pdf");
    expect(sanitiseFilename("...", "application/pdf")).toBe("document.pdf");
    expect(sanitiseFilename(".pdf", "application/pdf")).toBe("document.pdf");
  });

  it("caps the length so a huge name cannot bloat a header", () => {
    expect(sanitiseFilename("a".repeat(500) + ".pdf", "application/pdf").length)
      .toBeLessThanOrEqual(130);
  });

  it("never returns a name containing a path separator", () => {
    for (const raw of ["a/b.pdf", "a\\b.pdf", "/etc/x.pdf", "..//..//x.pdf"]) {
      const result = sanitiseFilename(raw, "application/pdf");
      expect(result).not.toContain("/");
      expect(result).not.toContain("\\");
    }
  });
});

describe("inspectUpload", () => {
  it("accepts a real document and reports what it is", () => {
    const result = inspectUpload(PDF, "analyse sanguine.pdf");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.file.mimeType).toBe("application/pdf");
    expect(result.file.filename).toBe("analyse sanguine.pdf");
    expect(result.file.sizeBytes).toBe(PDF.byteLength);
  });

  it("refuses an empty file", () => {
    const result = inspectUpload(Buffer.alloc(0), "vide.pdf");
    expect(result).toEqual({ ok: false, reason: "EMPTY" });
  });

  it("refuses a file past the size limit", () => {
    const huge = Buffer.concat([PDF, Buffer.alloc(MAX_FILE_BYTES)]);
    expect(inspectUpload(huge, "enorme.pdf")).toEqual({ ok: false, reason: "TOO_LARGE" });
  });

  it("refuses content that is not a medical document format", () => {
    const html = Buffer.from("<html><script>alert(1)</script></html>");
    expect(inspectUpload(html, "page.pdf")).toEqual({ ok: false, reason: "UNSUPPORTED_TYPE" });
  });

  it("corrects the extension when the name lies about the content", () => {
    const result = inspectUpload(JPEG, "radio-thorax.pdf");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.file.filename).toBe("radio-thorax.jpg");
  });
});

describe("extensionFor", () => {
  it("maps every accepted type to a sensible extension", () => {
    expect(extensionFor("application/pdf")).toBe("pdf");
    expect(extensionFor("application/dicom")).toBe("dcm");
    expect(extensionFor("application/unknown")).toBe("bin");
  });
});

describe("formatBytes", () => {
  it("reads naturally in both languages", () => {
    expect(formatBytes(512)).toBe("512 o");
    expect(formatBytes(2048)).toBe("2 Ko");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5 Mo");
    expect(formatBytes(2048, "ar")).toContain("ك.ب");
  });
});

describe("limits", () => {
  it("allow a file large enough for real medical imaging", () => {
    expect(MAX_FILE_BYTES).toBeGreaterThanOrEqual(10 * 1024 * 1024);
  });
});
