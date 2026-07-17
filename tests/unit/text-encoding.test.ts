import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const sourceExtensions = new Set([".ts", ".tsx", ".js", ".jsx"]);
const mojibakeMarkers = [
  0x7e3a, 0x7e67, 0x8700, 0x8b41, 0x86f9, 0x9015, 0x879f, 0x83a8, 0x8373, 0x8b5b,
  0x96d5, 0x965c, 0x8b16, 0x9a5f, 0x8fda, 0x9aef, 0x87c6, 0x9082, 0x96cb, 0x8b17, 0x7e5d,
].map((codePoint) => String.fromCodePoint(codePoint));

function sourceFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) return sourceFiles(target);
    return sourceExtensions.has(path.extname(entry.name)) ? [target] : [];
  });
}

describe("source text encoding", () => {
  it("contains neither replacement characters nor common UTF-8 mojibake markers", () => {
    const failures: string[] = [];
    const currentFile = path.normalize("tests/unit/text-encoding.test.ts");
    for (const file of ["src", "server", "tests"].flatMap(sourceFiles)) {
      if (path.normalize(file) === currentFile) continue;
      const text = readFileSync(file, "utf8");
      const marker = mojibakeMarkers.find((candidate) => text.includes(candidate));
      if (text.includes(String.fromCodePoint(0xfffd)) || marker) failures.push(file);
    }
    expect(failures).toEqual([]);
  });
});
