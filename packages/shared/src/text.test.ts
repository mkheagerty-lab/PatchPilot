import { describe, expect, it } from "vitest";
import { sanitizeDbText, sanitizeDbTextBounded } from "./text.js";

/** U+0000, built here rather than escaped so no invisible byte sits in this source. */
const NUL = String.fromCharCode(0);

/** Encodes ASCII the way a Windows process writing UTF-16LE to stdout arrives:
 *  every character followed by a NUL. This is the shape that broke the job writes. */
const asUtf16leBytes = (ascii: string): string => ascii.split("").join(NUL) + NUL;

describe("sanitizeDbText", () => {
  it("strips NUL, the one codepoint Postgres refuses in a text column", () => {
    expect(sanitizeDbText(`before${NUL}after`)).toBe("beforeafter");
    expect(sanitizeDbText(`${NUL}${NUL}${NUL}`)).toBe("");
  });

  it("recovers readable text from UTF-16LE-mangled device output", () => {
    expect(sanitizeDbText(asUtf16leBytes("PuTTY 0.84"))).toBe("PuTTY 0.84");
  });

  it("replaces lone surrogates, which throw when encoded to UTF-8", () => {
    expect(sanitizeDbText("a\uD800b")).toBe("a�b");
    expect(sanitizeDbText("a\uDC00b")).toBe("a�b");
  });

  it("leaves valid surrogate pairs and ordinary control characters intact", () => {
    expect(sanitizeDbText("done \u{1F600}")).toBe("done \u{1F600}");
    // Newlines/tabs/CR are legal in a text column and matter to a transcript.
    expect(sanitizeDbText("line1\r\n\tline2")).toBe("line1\r\n\tline2");
  });

  it("passes clean text through unchanged", () => {
    expect(sanitizeDbText("Script exit 0.")).toBe("Script exit 0.");
    expect(sanitizeDbText("")).toBe("");
  });
});

describe("sanitizeDbTextBounded", () => {
  it("does not touch output within the ceiling", () => {
    const text = "x".repeat(100);
    expect(sanitizeDbTextBounded(text, 100)).toBe(text);
  });

  it("truncates a runaway transcript and says how much was dropped", () => {
    const result = sanitizeDbTextBounded("x".repeat(150), 100);
    expect(result.startsWith("x".repeat(100))).toBe(true);
    expect(result).toContain("truncated 50 more characters");
  });

  it("measures the ceiling after sanitizing, not before", () => {
    // 10 real characters padded out to 20 by NULs: under the ceiling once cleaned.
    expect(sanitizeDbTextBounded(asUtf16leBytes("abcdefghij"), 15)).toBe("abcdefghij");
  });
});
