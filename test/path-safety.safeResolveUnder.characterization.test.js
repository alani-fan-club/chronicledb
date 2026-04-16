import { describe, it, expect } from "vitest";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { safeResolveUnder } = require("../server-plugin/path-safety.js");

describe("safeResolveUnder characterization", () => {
  it("resolves safe leaf names under base directory", () => {
    const base = path.resolve("C:/tmp/chronicledb-tests");
    const out = safeResolveUnder(base, "chat.jsonl");
    expect(out).toBe(path.resolve(base, "chat.jsonl"));
  });

  it("rejects empty or non-string names", () => {
    expect(() => safeResolveUnder("C:/tmp/chronicledb-tests", "")).toThrow("filename required");
    expect(() => safeResolveUnder("C:/tmp/chronicledb-tests", null)).toThrow("filename required");
  });

  it("rejects obvious traversal tokens", () => {
    expect(() => safeResolveUnder("C:/tmp/chronicledb-tests", "../chat.jsonl")).toThrow("unsafe filename");
    expect(() => safeResolveUnder("C:/tmp/chronicledb-tests", "subdir/chat.jsonl")).toThrow("unsafe filename");
    expect(() => safeResolveUnder("C:/tmp/chronicledb-tests", "subdir\\chat.jsonl")).toThrow("unsafe filename");
    expect(() => safeResolveUnder("C:/tmp/chronicledb-tests", `bad${String.fromCharCode(0)}name`)).toThrow("unsafe filename");
  });

  it("rejects absolute, UNC, and scheme-based payloads", () => {
    const base = "C:/tmp/chronicledb-tests";
    const payloads = [
      "C:/Windows/win.ini",
      "\\\\evil-host\\drop\\loot.txt",
      "file:///etc/passwd",
      "/etc/passwd",
    ];

    for (const p of payloads) {
      expect(() => safeResolveUnder(base, p)).toThrow("unsafe filename");
    }
  });

  it("rejects URL-decoded traversal payloads (route-param style)", () => {
    const base = "C:/tmp/chronicledb-tests";
    const encoded = [
      "%2e%2e%2fsecret.jsonl",
      "%2e%2e%5csecret.jsonl",
      "%2fetc%2fpasswd",
    ];

    for (const e of encoded) {
      const decoded = decodeURIComponent(e);
      expect(() => safeResolveUnder(base, decoded)).toThrow("unsafe filename");
    }
  });

  it("treats non-decoded encoded traversal as a literal filename under base", () => {
    const base = path.resolve("C:/tmp/chronicledb-tests");
    const literal = "%2e%2e%2fsecret.jsonl";
    const out = safeResolveUnder(base, literal);

    expect(out).toBe(path.resolve(base, literal));
  });
});
