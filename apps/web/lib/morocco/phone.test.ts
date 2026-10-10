import { describe, expect, it } from "vitest";
import { formatNational, maskNational, parseMoroccanMobile } from "./phone";

/**
 * The phone number is the patient's identity, so the thing that matters most
 * is that every way of writing one number lands on the same account.
 */

describe("parseMoroccanMobile", () => {
  it("folds every shape of the same number into one identity", () => {
    const shapes = [
      "0612345678",
      "06 12 34 56 78",
      "06-12-34-56-78",
      "06.12.34.56.78",
      "+212612345678",
      "+212 6 12 34 56 78",
      "00212612345678",
      "212612345678",
      "  0612345678  ",
    ];
    for (const shape of shapes) {
      const parsed = parseMoroccanMobile(shape);
      expect(parsed.ok, shape).toBe(true);
      if (parsed.ok) expect(parsed.e164, shape).toBe("+212612345678");
    }
  });

  it("accepts the 07 mobile range", () => {
    const parsed = parseMoroccanMobile("0712345678");
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.e164).toBe("+212712345678");
  });

  it("accepts Arabic-Indic digits from an Arabic keyboard", () => {
    const parsed = parseMoroccanMobile("٠٦١٢٣٤٥٦٧٨");
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.e164).toBe("+212612345678");
  });

  it("refuses a landline, which cannot receive the code", () => {
    expect(parseMoroccanMobile("0522123456")).toEqual({ ok: false, reason: "NOT_MOBILE" });
  });

  it("refuses a special-rate number", () => {
    expect(parseMoroccanMobile("0801234567")).toEqual({ ok: false, reason: "NOT_MOBILE" });
  });

  it("refuses numbers of the wrong length", () => {
    expect(parseMoroccanMobile("061234567")).toEqual({ ok: false, reason: "LENGTH" });
    expect(parseMoroccanMobile("06123456789")).toEqual({ ok: false, reason: "LENGTH" });
  });

  it("refuses an empty entry", () => {
    expect(parseMoroccanMobile("   ")).toEqual({ ok: false, reason: "EMPTY" });
  });

  it("refuses text, so a mistyped email never becomes a phone number", () => {
    expect(parseMoroccanMobile("patient@example.ma")).toEqual({ ok: false, reason: "CHARSET" });
  });

  it("refuses a foreign number", () => {
    expect(parseMoroccanMobile("+33612345678").ok).toBe(false);
  });
});

describe("display", () => {
  it("writes the national form as it appears on a business card", () => {
    expect(formatNational("612345678")).toBe("06 12 34 56 78");
  });

  it("masks the middle digits without losing the ends", () => {
    const masked = maskNational("612345678");
    expect(masked).toBe("06 •• •• •• 78");
    expect(masked).not.toContain("1234");
  });
});
