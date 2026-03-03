import { describe, it, expect, afterEach } from "vitest";
import { chunkFile, setChunkGranularity } from "./chunker.js";

describe("chunkFile", () => {
  const fp = "/workspace/test.ts";
  const rp = "test.ts";

  it("returns empty array for empty content", () => {
    expect(chunkFile("", fp, rp)).toEqual([]);
    expect(chunkFile("   \n  \n ", fp, rp)).toEqual([]);
  });

  it("returns empty array for content shorter than minimum chars", () => {
    expect(chunkFile("ab", fp, rp)).toEqual([]);
  });

  it("returns single chunk for small files (≤100 lines)", () => {
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`);
    const content = lines.join("\n");
    const chunks = chunkFile(content, fp, rp);

    expect(chunks).toHaveLength(1);
    expect(chunks[0].startLine).toBe(1);
    expect(chunks[0].endLine).toBe(50);
    expect(chunks[0].filePath).toBe(fp);
    expect(chunks[0].relPath).toBe(rp);
  });

  it("returns single chunk for exactly 50 lines", () => {
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`);
    const content = lines.join("\n");
    const chunks = chunkFile(content, fp, rp);

    expect(chunks).toHaveLength(1);
    expect(chunks[0].endLine).toBe(50);
  });

  it("produces multiple chunks for large files", () => {
    const lines = Array.from({ length: 300 }, (_, i) => `const x${i} = ${i};`);
    const content = lines.join("\n");
    const chunks = chunkFile(content, fp, rp);

    expect(chunks.length).toBeGreaterThan(1);
    // First chunk starts at line 1
    expect(chunks[0].startLine).toBe(1);
    // Last chunk ends at the end of the file
    expect(chunks[chunks.length - 1].endLine).toBe(300);
  });

  it("splits on blank lines when available", () => {
    // Create a file with a blank line right near the ~20 line boundary
    const lines: string[] = [];
    for (let i = 0; i < 200; i++) {
      if (i === 18) {
        lines.push(""); // blank line near boundary
      } else {
        lines.push(`const line${i} = "${i}";`);
      }
    }
    const content = lines.join("\n");
    const chunks = chunkFile(content, fp, rp);

    // First chunk should end at or near the blank line (line 19)
    expect(chunks[0].endLine).toBeGreaterThanOrEqual(15);
    expect(chunks[0].endLine).toBeLessThanOrEqual(25);
  });

  it("chunks have overlap", () => {
    const lines = Array.from({ length: 200 }, (_, i) => `const x${i} = ${i};`);
    const content = lines.join("\n");
    const chunks = chunkFile(content, fp, rp);

    expect(chunks.length).toBeGreaterThan(1);
    // Second chunk should start before the first chunk ends (overlap)
    if (chunks.length >= 2) {
      expect(chunks[1].startLine).toBeLessThan(chunks[0].endLine + 1);
    }
  });

  it("handles files with only blank lines beyond threshold", () => {
    const lines = Array.from({ length: 150 }, () => "");
    const content = lines.join("\n");
    const chunks = chunkFile(content, fp, rp);

    // All blank → trimmed content is empty → no chunks
    expect(chunks).toEqual([]);
  });

  it("covers the entire file without gaps", () => {
    const lines = Array.from({ length: 250 }, (_, i) => `line ${i + 1}`);
    const content = lines.join("\n");
    const chunks = chunkFile(content, fp, rp);

    // First chunk starts at 1, last chunk ends at 250
    expect(chunks[0].startLine).toBe(1);
    expect(chunks[chunks.length - 1].endLine).toBe(250);
  });

  it("splits at indentation decrease boundaries", () => {
    // Simulate a class-like structure with indentation changes near boundary
    const lines: string[] = [];
    for (let i = 0; i < 200; i++) {
      if (i >= 40 && i < 77) {
        lines.push(`    nested code line ${i}`);
      } else if (i === 77) {
        lines.push("}"); // indentation decrease
      } else {
        lines.push(`top level line ${i}`);
      }
    }
    const content = lines.join("\n");
    const chunks = chunkFile(content, fp, rp);

    // Should produce multiple chunks
    expect(chunks.length).toBeGreaterThan(1);
  });

  it("splits at boundary tokens (function, class, etc.)", () => {
    const lines: string[] = [];
    for (let i = 0; i < 200; i++) {
      if (i === 79) {
        lines.push("function nextSection() {");
      } else {
        lines.push(`  statement_${i};`);
      }
    }
    const content = lines.join("\n");
    const chunks = chunkFile(content, fp, rp);

    expect(chunks.length).toBeGreaterThan(1);
  });

  it("preserves correct line numbers", () => {
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`);
    const content = lines.join("\n");
    const chunks = chunkFile(content, fp, rp);

    expect(chunks).toHaveLength(1);
    // Content should contain the actual lines
    expect(chunks[0].content).toContain("line 1");
    expect(chunks[0].content).toContain("line 50");
  });
});

describe("chunkFile fine granularity", () => {
  const fp = "/workspace/test.ts";
  const rp = "test.ts";

  afterEach(() => {
    setChunkGranularity("standard");
  });

  it("produces more chunks in fine mode", () => {
    const lines = Array.from({ length: 300 }, (_, i) => `const x${i} = ${i};`);
    const content = lines.join("\n");

    const standardChunks = chunkFile(content, fp, rp);

    setChunkGranularity("fine");
    const fineChunks = chunkFile(content, fp, rp);

    expect(fineChunks.length).toBeGreaterThan(standardChunks.length);
  });
});
