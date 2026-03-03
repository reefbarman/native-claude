import { describe, it, expect, beforeAll, afterEach } from "vitest";
import * as path from "path";
import {
  initTreeSitter,
  isTreeSitterSupported,
  treeSitterChunkFile,
  setChunkGranularity,
} from "./treeSitterChunker.js";

// WASM files live in two places during tests:
// - Core parser: node_modules/web-tree-sitter/web-tree-sitter.wasm
// - Grammar WASMs: node_modules/@vscode/tree-sitter-wasm/wasm/tree-sitter-*.wasm
// We set up a temp dir that symlinks/copies both into one flat directory.

const CORE_WASM = path.resolve("node_modules/web-tree-sitter");
const GRAMMAR_DIR = path.resolve("node_modules/@vscode/tree-sitter-wasm/wasm");

// For tests, we need a single directory containing both tree-sitter.wasm and
// all grammar .wasm files. We'll create a temp dir with symlinks.
import { mkdtempSync, symlinkSync, readdirSync, existsSync } from "fs";
import { tmpdir } from "os";

let wasmDir: string;

beforeAll(async () => {
  // Create temp dir with all WASM files accessible
  wasmDir = mkdtempSync(path.join(tmpdir(), "ts-wasm-"));

  // Symlink core parser WASM
  const coreWasm = path.join(CORE_WASM, "web-tree-sitter.wasm");
  if (existsSync(coreWasm)) {
    symlinkSync(coreWasm, path.join(wasmDir, "web-tree-sitter.wasm"));
  }

  // Symlink all grammar WASMs (skip tree-sitter.wasm — already linked from core)
  for (const f of readdirSync(GRAMMAR_DIR)) {
    if (f.endsWith(".wasm") && f !== "tree-sitter.wasm") {
      symlinkSync(path.join(GRAMMAR_DIR, f), path.join(wasmDir, f));
    }
  }

  await initTreeSitter(wasmDir);
});

describe("isTreeSitterSupported", () => {
  it("returns true for supported extensions", () => {
    expect(isTreeSitterSupported("foo.ts")).toBe(true);
    expect(isTreeSitterSupported("bar.py")).toBe(true);
    expect(isTreeSitterSupported("baz.rs")).toBe(true);
    expect(isTreeSitterSupported("main.go")).toBe(true);
    expect(isTreeSitterSupported("app.jsx")).toBe(true);
    expect(isTreeSitterSupported("style.css")).toBe(true);
  });

  it("returns false for unsupported extensions", () => {
    expect(isTreeSitterSupported("readme.txt")).toBe(false);
    expect(isTreeSitterSupported("image.svg")).toBe(false);
    expect(isTreeSitterSupported("data.yaml")).toBe(false);
    expect(isTreeSitterSupported("config.json")).toBe(false);
    expect(isTreeSitterSupported("doc.md")).toBe(false);
  });
});

describe("treeSitterChunkFile", () => {
  const fp = "/workspace/test.ts";
  const rp = "test.ts";

  it("returns empty array for empty content", async () => {
    expect(await treeSitterChunkFile("", fp, rp)).toEqual([]);
    expect(await treeSitterChunkFile("   \n  \n ", fp, rp)).toEqual([]);
  });

  it("returns single chunk for small files (≤30 lines)", async () => {
    const content = `import { foo } from "bar";

function hello() {
  console.log("hello");
}

export default hello;
`;
    const chunks = await treeSitterChunkFile(content, fp, rp);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].startLine).toBe(1);
    expect(chunks[0].filePath).toBe(fp);
    expect(chunks[0].relPath).toBe(rp);
  });

  it("sets embeddingContent on small file chunks", async () => {
    const content = `import { foo } from "bar";

function hello() {
  console.log("hello");
}

export default hello;
`;
    const chunks = await treeSitterChunkFile(content, fp, rp);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].embeddingContent).toBeDefined();
    // No parent scope for top-level small file → embeddingContent is just the content
    expect(chunks[0].embeddingContent).toContain(chunks[0].content);
  });

  it("returns empty array for unsupported extension", async () => {
    const chunks = await treeSitterChunkFile(
      "some content here that is long enough to chunk",
      "/workspace/readme.txt",
      "readme.txt",
    );
    expect(chunks).toEqual([]);
  });

  it("extracts function declarations as separate chunks", async () => {
    // Build a file with two functions, each >30 lines to avoid small-file shortcut
    const lines: string[] = [];
    lines.push('import { something } from "module";');
    lines.push("");

    // First function: ~20 lines
    lines.push("function alpha() {");
    for (let i = 0; i < 18; i++) {
      lines.push(`  const a${i} = ${i};`);
    }
    lines.push("}");
    lines.push("");

    // Second function: ~20 lines
    lines.push("function beta() {");
    for (let i = 0; i < 18; i++) {
      lines.push(`  const b${i} = ${i};`);
    }
    lines.push("}");
    lines.push("");

    const content = lines.join("\n");
    const chunks = await treeSitterChunkFile(content, fp, rp);

    // Should have at least 2 chunks (one per function), plus possibly a gap chunk for imports
    expect(chunks.length).toBeGreaterThanOrEqual(2);

    // Find the function chunks
    const alphaChunk = chunks.find((c) =>
      c.content.includes("function alpha"),
    );
    const betaChunk = chunks.find((c) =>
      c.content.includes("function beta"),
    );
    expect(alphaChunk).toBeDefined();
    expect(betaChunk).toBeDefined();

    // They should be separate chunks with correct line ranges
    expect(alphaChunk!.startLine).toBeLessThan(betaChunk!.startLine);
  });

  it("sets embeddingContent with context on all chunks", async () => {
    const lines: string[] = [];
    lines.push('import { something } from "module";');
    lines.push("");

    lines.push("function alpha() {");
    for (let i = 0; i < 18; i++) {
      lines.push(`  const a${i} = ${i};`);
    }
    lines.push("}");
    lines.push("");

    lines.push("function beta() {");
    for (let i = 0; i < 18; i++) {
      lines.push(`  const b${i} = ${i};`);
    }
    lines.push("}");
    lines.push("");

    const content = lines.join("\n");
    const chunks = await treeSitterChunkFile(content, fp, rp);

    for (const chunk of chunks) {
      expect(chunk.embeddingContent).toBeDefined();
      expect(chunk.embeddingContent).toContain(chunk.content);
    }
  });

  it("emits gap chunks for imports and non-extractable code", async () => {
    const lines: string[] = [];
    // 10 lines of imports (gap)
    for (let i = 0; i < 10; i++) {
      lines.push(`import { mod${i} } from "module${i}";`);
    }
    lines.push("");

    // A function
    lines.push("function doWork() {");
    for (let i = 0; i < 20; i++) {
      lines.push(`  const x${i} = ${i};`);
    }
    lines.push("}");

    const content = lines.join("\n");
    const chunks = await treeSitterChunkFile(content, fp, rp);

    // Should have a gap chunk for imports and a chunk for the function
    expect(chunks.length).toBeGreaterThanOrEqual(2);

    const importChunk = chunks.find((c) =>
      c.content.includes('import { mod0 }'),
    );
    expect(importChunk).toBeDefined();
  });

  it("splits oversized nodes using char-based boundaries", async () => {
    // Create a single huge function (>1150 chars)
    const lines: string[] = [];
    lines.push('import { x } from "y";');
    lines.push("");
    lines.push("function hugeFunction() {");
    for (let i = 0; i < 200; i++) {
      lines.push(`  const val${i} = ${i} * 2;`);
    }
    lines.push("}");

    const content = lines.join("\n");
    const chunks = await treeSitterChunkFile(content, fp, rp);

    // The huge function should be split into multiple sub-chunks
    const funcChunks = chunks.filter((c) => c.content.includes("val"));
    expect(funcChunks.length).toBeGreaterThan(1);

    // All chunks should be under the effective max (~1150 chars)
    for (const chunk of funcChunks) {
      expect(chunk.content.length).toBeLessThanOrEqual(1200); // some tolerance for trimming
    }

    // All chunks should have valid line numbers
    for (const chunk of chunks) {
      expect(chunk.startLine).toBeGreaterThanOrEqual(1);
      expect(chunk.endLine).toBeGreaterThanOrEqual(chunk.startLine);
    }
  });

  it("splits oversized classes at method boundaries", async () => {
    // Create a class with multiple methods, total >1150 chars
    const lines: string[] = [];
    lines.push('import { Base } from "./base";');
    lines.push("");
    lines.push("class BigService {");
    // Method 1: ~300 chars
    lines.push("  methodOne() {");
    for (let i = 0; i < 10; i++) {
      lines.push(`    const a${i} = "value_${i}";`);
    }
    lines.push("    return a0;");
    lines.push("  }");
    lines.push("");
    // Method 2: ~300 chars
    lines.push("  methodTwo() {");
    for (let i = 0; i < 10; i++) {
      lines.push(`    const b${i} = "value_${i}";`);
    }
    lines.push("    return b0;");
    lines.push("  }");
    lines.push("");
    // Method 3: ~300 chars
    lines.push("  methodThree() {");
    for (let i = 0; i < 10; i++) {
      lines.push(`    const c${i} = "value_${i}";`);
    }
    lines.push("    return c0;");
    lines.push("  }");
    lines.push("");
    // Method 4: ~300 chars
    lines.push("  methodFour() {");
    for (let i = 0; i < 10; i++) {
      lines.push(`    const d${i} = "value_${i}";`);
    }
    lines.push("    return d0;");
    lines.push("  }");
    lines.push("}");
    lines.push("");

    // Pad to > 30 lines (already well above)
    const content = lines.join("\n");
    const chunks = await treeSitterChunkFile(content, fp, rp);

    // The class should be decomposed into multiple chunks + a multi-scale whole-class chunk
    const classChunks = chunks.filter(
      (c) =>
        c.content.includes("method") ||
        c.content.includes("BigService"),
    );
    expect(classChunks.length).toBeGreaterThan(1);

    // Sub-chunks (excluding multi-scale whole-class) should be within the limit
    const subChunks = classChunks.filter(
      (c) =>
        !(
          c.content.includes("methodOne") &&
          c.content.includes("methodFour")
        ),
    );
    for (const chunk of subChunks) {
      expect(chunk.content.length).toBeLessThanOrEqual(1200);
    }

    // Methods should be kept together (not split mid-method)
    // At least one chunk should contain a complete method
    const hasCompleteMethod = classChunks.some(
      (c) =>
        (c.content.includes("methodOne()") &&
          c.content.includes("return a0")) ||
        (c.content.includes("methodTwo()") &&
          c.content.includes("return b0")),
    );
    expect(hasCompleteMethod).toBe(true);
  });

  it("includes parent scope in embeddingContent for class sub-chunks", async () => {
    const lines: string[] = [];
    lines.push('import { Base } from "./base";');
    lines.push("");
    lines.push("class MyService {");
    for (let i = 0; i < 8; i++) {
      lines.push(`  method${i}() {`);
      for (let j = 0; j < 5; j++) {
        lines.push(`    const v${i}_${j} = "${i}_${j}";`);
      }
      lines.push(`    return v${i}_0;`);
      lines.push("  }");
      lines.push("");
    }
    lines.push("}");

    const content = lines.join("\n");
    const chunks = await treeSitterChunkFile(content, fp, rp);

    // Find chunks that came from splitting the class
    const classSubChunks = chunks.filter(
      (c) =>
        c.embeddingContent?.includes("class MyService") &&
        c.content.includes("method"),
    );

    // At least one sub-chunk should have parent scope in embeddingContent
    if (classSubChunks.length > 0) {
      expect(classSubChunks[0].embeddingContent).toMatch(
        /\/\/ class MyService/,
      );
    }
  });

  it("handles Python files", async () => {
    const lines: string[] = [];
    lines.push("import os");
    lines.push("import sys");
    lines.push("");

    lines.push("def process_data(items):");
    for (let i = 0; i < 20; i++) {
      lines.push(`    result_${i} = items[${i}]`);
    }
    lines.push("    return result_0");
    lines.push("");

    lines.push("class DataProcessor:");
    lines.push("    def __init__(self):");
    for (let i = 0; i < 8; i++) {
      lines.push(`        self.val_${i} = ${i}`);
    }
    lines.push("");

    const content = lines.join("\n");
    const pyFp = "/workspace/data.py";
    const pyRp = "data.py";

    const chunks = await treeSitterChunkFile(content, pyFp, pyRp);

    // Should extract the function and class as separate chunks
    expect(chunks.length).toBeGreaterThanOrEqual(2);

    const funcChunk = chunks.find((c) =>
      c.content.includes("def process_data"),
    );
    const classChunk = chunks.find((c) =>
      c.content.includes("class DataProcessor"),
    );
    expect(funcChunk).toBeDefined();
    expect(classChunk).toBeDefined();

    // Python chunks should also have embeddingContent
    expect(funcChunk!.embeddingContent).toBeDefined();
  });

  it("returns empty for supported language without extractable types (fallback signal)", async () => {
    // PowerShell is supported but has no EXTRACTABLE_TYPES → returns empty → caller uses line-based
    const lines: string[] = [];
    for (let i = 0; i < 40; i++) {
      lines.push(`Write-Host "line ${i}"`);
    }
    const content = lines.join("\n");

    const chunks = await treeSitterChunkFile(
      content,
      "/workspace/script.ps1",
      "script.ps1",
    );

    // No extractable types for powershell → empty array signals fallback
    expect(chunks).toEqual([]);
  });

  it("preserves correct 1-based line numbers", async () => {
    const lines: string[] = [];
    // 5 blank/import lines
    lines.push('import { a } from "a";');
    lines.push('import { b } from "b";');
    lines.push('import { c } from "c";');
    lines.push("");
    lines.push("// comment");
    lines.push("");

    // Function starting at line 7 (1-based)
    lines.push("function myFunc() {");
    for (let i = 0; i < 20; i++) {
      lines.push(`  doThing(${i});`);
    }
    lines.push("}");
    lines.push("");

    // Pad to >30 lines total
    for (let i = 0; i < 5; i++) {
      lines.push(`// trailing comment ${i}`);
    }

    const content = lines.join("\n");
    const chunks = await treeSitterChunkFile(content, fp, rp);

    const funcChunk = chunks.find((c) =>
      c.content.includes("function myFunc"),
    );
    expect(funcChunk).toBeDefined();
    // Function starts at line 7 (1-based)
    expect(funcChunk!.startLine).toBe(7);
  });

  it("decomposes small classes into individual methods", async () => {
    // Class is well under 1150 chars but should still be decomposed
    const lines: string[] = [];
    lines.push('import { Base } from "./base";');
    lines.push("");

    lines.push("class SmallService {");
    lines.push("  methodA(input: string): string {");
    lines.push('    const prefix = "result_a_";');
    lines.push("    return prefix + input;");
    lines.push("  }");
    lines.push("");
    lines.push("  methodB(input: string): string {");
    lines.push('    const prefix = "result_b_";');
    lines.push("    return prefix + input;");
    lines.push("  }");
    lines.push("");
    lines.push("  methodC(input: string): string {");
    lines.push('    const prefix = "result_c_";');
    lines.push("    return prefix + input;");
    lines.push("  }");
    lines.push("}");
    lines.push("");

    // Pad to >30 lines total
    for (let i = 0; i < 20; i++) {
      lines.push(`// padding line ${i}`);
    }

    const content = lines.join("\n");
    const chunks = await treeSitterChunkFile(content, fp, rp);

    // Multi-scale: whole class is also emitted as a chunk
    const wholeClassChunk = chunks.find(
      (c) =>
        c.content.includes("class SmallService") &&
        c.content.includes("methodA") &&
        c.content.includes("methodB") &&
        c.content.includes("methodC"),
    );
    expect(wholeClassChunk).toBeDefined();

    // Individual method chunks should also exist (decomposed)
    const methodChunks = chunks.filter((c) => c !== wholeClassChunk);
    const methodA = methodChunks.find((c) => c.content.includes("methodA"));
    const methodB = methodChunks.find((c) => c.content.includes("methodB"));
    const methodC = methodChunks.find((c) => c.content.includes("methodC"));

    expect(methodA).toBeDefined();
    expect(methodB).toBeDefined();
    expect(methodC).toBeDefined();

    // Methods should be in SEPARATE chunks
    // (at least 2 of the 3 should be in different chunks)
    const uniqueChunks = new Set([
      methodChunks.indexOf(methodA!),
      methodChunks.indexOf(methodB!),
      methodChunks.indexOf(methodC!),
    ]);
    expect(uniqueChunks.size).toBeGreaterThanOrEqual(2);

    // All method chunks should have parent scope context
    for (const mc of [methodA!, methodB!, methodC!]) {
      expect(mc.embeddingContent).toMatch(
        /\/\/ class SmallService/,
      );
    }
  });

  it("keeps normal-sized nodes whole (under 1150 chars)", async () => {
    // Create two functions, each ~500 chars — should NOT be split
    const lines: string[] = [];
    lines.push('import { util } from "./util";');
    lines.push("");

    lines.push("function funcA() {");
    for (let i = 0; i < 15; i++) {
      lines.push(`  const a${i} = "hello_${i}";`);
    }
    lines.push("}");
    lines.push("");

    lines.push("function funcB() {");
    for (let i = 0; i < 15; i++) {
      lines.push(`  const b${i} = "world_${i}";`);
    }
    lines.push("}");
    lines.push("");

    const content = lines.join("\n");
    const chunks = await treeSitterChunkFile(content, fp, rp);

    // Each function should be a single chunk
    const chunkA = chunks.find((c) => c.content.includes("function funcA"));
    const chunkB = chunks.find((c) => c.content.includes("function funcB"));
    expect(chunkA).toBeDefined();
    expect(chunkB).toBeDefined();

    // funcA should contain all its lines in one chunk
    expect(chunkA!.content).toContain("a0");
    expect(chunkA!.content).toContain("a14");
    // funcB likewise
    expect(chunkB!.content).toContain("b0");
    expect(chunkB!.content).toContain("b14");
  });

  it("decomposes exported classes (export class Foo)", async () => {
    const lines: string[] = [];
    lines.push('import { Base } from "./base";');
    lines.push("");

    lines.push("export class ExportedService {");
    lines.push("  handleRequest(req: string): string {");
    lines.push('    const prefix = "handled_";');
    lines.push("    return prefix + req;");
    lines.push("  }");
    lines.push("");
    lines.push("  processData(data: string): string {");
    lines.push('    const suffix = "_processed";');
    lines.push("    return data + suffix;");
    lines.push("  }");
    lines.push("}");
    lines.push("");

    // Pad to >30 lines
    for (let i = 0; i < 20; i++) {
      lines.push(`// padding line ${i}`);
    }

    const content = lines.join("\n");
    const chunks = await treeSitterChunkFile(content, fp, rp);

    // Methods should be individually extracted even through export wrapper
    const handleChunk = chunks.find((c) =>
      c.content.includes("handleRequest"),
    );
    const processChunk = chunks.find((c) =>
      c.content.includes("processData"),
    );
    expect(handleChunk).toBeDefined();
    expect(processChunk).toBeDefined();

    // Should have parent scope context
    expect(handleChunk!.embeddingContent).toMatch(
      /class ExportedService/,
    );
  });

  it("merges class header into first method chunk when header is small", async () => {
    const lines: string[] = [];
    lines.push('import { x } from "y";');
    lines.push("");

    lines.push("class Greeter {");
    lines.push("  greet(name: string): string {");
    lines.push('    const greeting = "Hello, ";');
    lines.push("    return greeting + name;");
    lines.push("  }");
    lines.push("}");
    lines.push("");

    // Pad to >30 lines
    for (let i = 0; i < 25; i++) {
      lines.push(`// padding line ${i}`);
    }

    const content = lines.join("\n");
    const chunks = await treeSitterChunkFile(content, fp, rp);

    // The class header "class Greeter {" is too small for its own chunk
    // It should be merged into the first method's chunk
    const greetChunk = chunks.find((c) =>
      c.content.includes("greet(name"),
    );
    expect(greetChunk).toBeDefined();
    // The chunk should include the class declaration line
    expect(greetChunk!.content).toContain("class Greeter");
    expect(greetChunk!.content).toContain("greet(name");
  });

  it("avoids tiny trailing chunks via re-balancing", async () => {
    // Create content that would produce a tiny last chunk without re-balancing
    const lines: string[] = [];
    lines.push('import { x } from "y";');
    lines.push("");

    // Create a function whose total size is just over EFFECTIVE_MAX (1150)
    // but where a naive split would leave a tiny remainder
    lines.push("function largeFunc() {");
    // Generate ~1100 chars of body, then a short trailing return
    for (let i = 0; i < 40; i++) {
      lines.push(`  const variable_${i} = "some_value_${i}";`);
    }
    lines.push('  return "done";');
    lines.push("}");

    const content = lines.join("\n");
    const chunks = await treeSitterChunkFile(content, fp, rp);

    // All chunks should be reasonably sized (no chunks < 50 chars)
    for (const chunk of chunks) {
      expect(chunk.content.length).toBeGreaterThanOrEqual(50);
    }
  });

  // --- Query-based extraction tests ---

  it("captures nested methods inside deeply nested structures", async () => {
    // Object literal with methods inside a variable declaration — the query
    // captures method_definition at any depth, not just top-level
    const lines: string[] = [];
    lines.push('import { Config } from "./config";');
    lines.push("");

    lines.push("const handlers = {");
    lines.push("  onConnect(socket: WebSocket) {");
    for (let i = 0; i < 8; i++) {
      lines.push(`    const step${i} = socket.readyState + ${i};`);
    }
    lines.push("    return step0;");
    lines.push("  },");
    lines.push("");
    lines.push("  onMessage(data: string) {");
    for (let i = 0; i < 8; i++) {
      lines.push(`    const parsed${i} = JSON.parse(data + "${i}");`);
    }
    lines.push("    return parsed0;");
    lines.push("  },");
    lines.push("");
    lines.push("  onClose(code: number) {");
    for (let i = 0; i < 8; i++) {
      lines.push(`    const reason${i} = code + ${i};`);
    }
    lines.push("    return reason0;");
    lines.push("  },");
    lines.push("};");
    lines.push("");

    // Pad to >30 lines
    for (let i = 0; i < 5; i++) {
      lines.push(`// trailing ${i}`);
    }

    const content = lines.join("\n");
    const chunks = await treeSitterChunkFile(content, fp, rp);

    // Query captures should find method_definition nodes inside the object
    const connectChunk = chunks.find((c) => c.content.includes("onConnect"));
    const messageChunk = chunks.find((c) => c.content.includes("onMessage"));
    const closeChunk = chunks.find((c) => c.content.includes("onClose"));

    expect(connectChunk).toBeDefined();
    expect(messageChunk).toBeDefined();
    expect(closeChunk).toBeDefined();
  });

  it("captures arrow functions assigned to const", async () => {
    const lines: string[] = [];
    lines.push('import { util } from "./util";');
    lines.push("");

    lines.push("const processItems = (items: string[]) => {");
    for (let i = 0; i < 15; i++) {
      lines.push(`  const result${i} = items[${i}];`);
    }
    lines.push("  return result0;");
    lines.push("};");
    lines.push("");

    lines.push("const formatOutput = (data: string) => {");
    for (let i = 0; i < 15; i++) {
      lines.push(`  const fmt${i} = data + "_${i}";`);
    }
    lines.push("  return fmt0;");
    lines.push("};");
    lines.push("");

    const content = lines.join("\n");
    const chunks = await treeSitterChunkFile(content, fp, rp);

    // Arrow functions in const declarations should be captured
    const processChunk = chunks.find((c) =>
      c.content.includes("processItems"),
    );
    const formatChunk = chunks.find((c) =>
      c.content.includes("formatOutput"),
    );

    expect(processChunk).toBeDefined();
    expect(formatChunk).toBeDefined();

    // Should have embeddingContent
    expect(processChunk!.embeddingContent).toBeDefined();
  });

  it("provides parent scope context for query-captured methods", async () => {
    // With query captures, methods are found directly — verify they still
    // get parent scope context from findParentScope()
    const lines: string[] = [];
    lines.push('import { Base } from "./base";');
    lines.push("");

    lines.push("class AuthManager {");
    lines.push("  authenticate(user: string, pass: string) {");
    for (let i = 0; i < 8; i++) {
      lines.push(`    const check${i} = user + pass + ${i};`);
    }
    lines.push("    return check0;");
    lines.push("  }");
    lines.push("");
    lines.push("  authorize(role: string) {");
    for (let i = 0; i < 8; i++) {
      lines.push(`    const perm${i} = role + "_${i}";`);
    }
    lines.push("    return perm0;");
    lines.push("  }");
    lines.push("}");
    lines.push("");

    // Pad to >30 lines
    for (let i = 0; i < 10; i++) {
      lines.push(`// padding ${i}`);
    }

    const content = lines.join("\n");
    const chunks = await treeSitterChunkFile(content, fp, rp);

    // Find method chunks
    const authChunk = chunks.find((c) =>
      c.content.includes("authenticate"),
    );
    const authzChunk = chunks.find((c) =>
      c.content.includes("authorize"),
    );

    expect(authChunk).toBeDefined();
    expect(authzChunk).toBeDefined();

    // Both should have parent scope "class AuthManager" in embeddingContent
    expect(authChunk!.embeddingContent).toMatch(
      /\/\/ class AuthManager/,
    );
    expect(authzChunk!.embeddingContent).toMatch(
      /\/\/ class AuthManager/,
    );
  });

  it("falls back to EXTRACTABLE_TYPES for languages without queries", async () => {
    // Bash has EXTRACTABLE_TYPES but no LANGUAGE_QUERIES entry
    const lines: string[] = [];
    lines.push("#!/bin/bash");
    lines.push("");

    lines.push("setup_environment() {");
    for (let i = 0; i < 15; i++) {
      lines.push(`  export VAR_${i}="value_${i}"`);
    }
    lines.push("}");
    lines.push("");

    lines.push("run_tasks() {");
    for (let i = 0; i < 15; i++) {
      lines.push(`  echo "Running task ${i}"`);
    }
    lines.push("}");
    lines.push("");

    const content = lines.join("\n");
    const chunks = await treeSitterChunkFile(
      content,
      "/workspace/deploy.sh",
      "deploy.sh",
    );

    // Bash fallback should still extract function_definition nodes
    expect(chunks.length).toBeGreaterThan(0);
    const setupChunk = chunks.find((c) =>
      c.content.includes("setup_environment"),
    );
    expect(setupChunk).toBeDefined();
    expect(setupChunk!.embeddingContent).toBeDefined();
  });

  it("handles Go files with methods on struct receivers", async () => {
    const lines: string[] = [];
    lines.push('package main');
    lines.push("");
    lines.push('import "fmt"');
    lines.push("");

    lines.push("type Server struct {");
    lines.push("    host string");
    lines.push("    port int");
    lines.push("}");
    lines.push("");

    lines.push("func (s *Server) Start() error {");
    for (let i = 0; i < 10; i++) {
      lines.push(`    step${i} := fmt.Sprintf("%s:%d", s.host, s.port+${i})`);
    }
    lines.push(`    return nil`);
    lines.push("}");
    lines.push("");

    lines.push("func (s *Server) Stop() error {");
    for (let i = 0; i < 10; i++) {
      lines.push(`    cleanup${i} := fmt.Sprintf("stop %d", ${i})`);
    }
    lines.push(`    return nil`);
    lines.push("}");
    lines.push("");

    const content = lines.join("\n");
    const goFp = "/workspace/server.go";
    const goRp = "server.go";

    const chunks = await treeSitterChunkFile(content, goFp, goRp);

    // Both methods should be captured
    const startChunk = chunks.find((c) => c.content.includes("func (s *Server) Start"));
    const stopChunk = chunks.find((c) => c.content.includes("func (s *Server) Stop"));
    expect(startChunk).toBeDefined();
    expect(stopChunk).toBeDefined();

    // Struct should also be captured
    const structChunk = chunks.find((c) => c.content.includes("type Server struct"));
    expect(structChunk).toBeDefined();
  });

  // --- Multi-scale chunking tests ---

  it("multi-scale: emits whole function AND sub-chunks for oversized functions", async () => {
    // Create a function ~800 chars (over EFFECTIVE_MAX 575 but under MULTI_SCALE_MAX 1500)
    const lines: string[] = [];
    lines.push('import { x } from "y";');
    lines.push("");

    lines.push("function mediumFunc(input: string) {");
    for (let i = 0; i < 25; i++) {
      lines.push(`  const step${i} = input + "_${i}";`);
    }
    lines.push("  return step0;");
    lines.push("}");
    lines.push("");

    // Pad to >30 lines
    for (let i = 0; i < 10; i++) {
      lines.push(`// padding ${i}`);
    }

    const content = lines.join("\n");
    const chunks = await treeSitterChunkFile(content, fp, rp);

    // Should have a whole-function chunk
    const wholeFunc = chunks.find(
      (c) =>
        c.content.includes("function mediumFunc") &&
        c.content.includes("return step0"),
    );
    expect(wholeFunc).toBeDefined();

    // Should ALSO have sub-chunks from splitByCharBoundaries
    const subChunks = chunks.filter(
      (c) => c !== wholeFunc && c.content.includes("step"),
    );
    expect(subChunks.length).toBeGreaterThanOrEqual(1);

    // Whole function should be the first chunk (among function chunks)
    const funcChunks = chunks.filter((c) => c.content.includes("step"));
    expect(funcChunks[0]).toBe(wholeFunc);
  });

  it("multi-scale: emits whole class AND decomposed methods", async () => {
    // Create a class ~900 chars with 3 methods
    const lines: string[] = [];
    lines.push('import { Base } from "./base";');
    lines.push("");

    lines.push("class MultiScaleService {");
    lines.push("  processA(data: string): string {");
    for (let i = 0; i < 6; i++) {
      lines.push(`    const a${i} = data + "_a${i}";`);
    }
    lines.push("    return a0;");
    lines.push("  }");
    lines.push("");
    lines.push("  processB(data: string): string {");
    for (let i = 0; i < 6; i++) {
      lines.push(`    const b${i} = data + "_b${i}";`);
    }
    lines.push("    return b0;");
    lines.push("  }");
    lines.push("");
    lines.push("  processC(data: string): string {");
    for (let i = 0; i < 6; i++) {
      lines.push(`    const c${i} = data + "_c${i}";`);
    }
    lines.push("    return c0;");
    lines.push("  }");
    lines.push("}");
    lines.push("");

    // Pad to >30 lines
    for (let i = 0; i < 5; i++) {
      lines.push(`// padding ${i}`);
    }

    const content = lines.join("\n");
    const chunks = await treeSitterChunkFile(content, fp, rp);

    // Should have a whole-class chunk containing all methods
    const wholeClass = chunks.find(
      (c) =>
        c.content.includes("class MultiScaleService") &&
        c.content.includes("processA") &&
        c.content.includes("processB") &&
        c.content.includes("processC"),
    );
    expect(wholeClass).toBeDefined();

    // Should also have individual method chunks
    const methodChunks = chunks.filter((c) => c !== wholeClass);
    expect(methodChunks.some((c) => c.content.includes("processA"))).toBe(
      true,
    );
    expect(methodChunks.some((c) => c.content.includes("processB"))).toBe(
      true,
    );
    expect(methodChunks.some((c) => c.content.includes("processC"))).toBe(
      true,
    );

    // Whole class should be FIRST (unshifted)
    const firstClassChunk = chunks.find((c) =>
      c.content.includes("MultiScaleService"),
    );
    expect(firstClassChunk).toBe(wholeClass);
  });

  it("multi-scale: skips whole-node emission for very large nodes (>1500 chars)", async () => {
    // Create a function >1500 chars — should NOT get whole-node emission
    const lines: string[] = [];
    lines.push('import { x } from "y";');
    lines.push("");

    lines.push("function veryLargeFunc() {");
    for (let i = 0; i < 80; i++) {
      lines.push(`  const variable_${i} = "some_long_value_${i}";`);
    }
    lines.push('  return "done";');
    lines.push("}");

    const content = lines.join("\n");
    const chunks = await treeSitterChunkFile(content, fp, rp);

    // Should have sub-chunks but NO single chunk containing the entire function
    const funcChunks = chunks.filter((c) => c.content.includes("variable_"));
    expect(funcChunks.length).toBeGreaterThan(1);

    // No chunk should contain both the start and end of the function
    const wholeFunc = chunks.find(
      (c) =>
        c.content.includes("function veryLargeFunc") &&
        c.content.includes('return "done"'),
    );
    expect(wholeFunc).toBeUndefined();
  });

  it("handles interfaces with method signatures", async () => {
    const lines: string[] = [];
    lines.push('import { Config } from "./config";');
    lines.push("");

    lines.push("interface DataService {");
    lines.push("  fetchData(url: string): Promise<string>;");
    lines.push("  saveData(key: string, value: string): Promise<void>;");
    lines.push("  deleteData(key: string): Promise<boolean>;");
    lines.push("}");
    lines.push("");

    lines.push("function helper() {");
    for (let i = 0; i < 15; i++) {
      lines.push(`  const h${i} = ${i};`);
    }
    lines.push("}");
    lines.push("");

    // Pad to >30 lines
    for (let i = 0; i < 10; i++) {
      lines.push(`// padding ${i}`);
    }

    const content = lines.join("\n");
    const chunks = await treeSitterChunkFile(content, fp, rp);

    // Interface should be extracted (either as single chunk or decomposed)
    const ifaceChunk = chunks.find((c) =>
      c.content.includes("interface DataService"),
    );
    expect(ifaceChunk).toBeDefined();
    expect(ifaceChunk!.embeddingContent).toBeDefined();
  });
});

describe("fine granularity", () => {
  const fp = "/workspace/test.ts";
  const rp = "test.ts";

  afterEach(() => {
    setChunkGranularity("standard");
  });

  it("produces more chunks in fine mode than standard", async () => {
    const lines: string[] = [];
    lines.push("// top-level comment for padding");
    lines.push("");
    lines.push("export function processData(input: string): string {");
    lines.push("  const cleaned = input.trim().toLowerCase();");
    lines.push("  const parts = cleaned.split(',');");
    lines.push("  const filtered = parts.filter(p => p.length > 0);");
    lines.push("  const mapped = filtered.map(p => p.toUpperCase());");
    lines.push("  const result = mapped.join(' | ');");
    lines.push('  console.log("Processed:", result);');
    lines.push("  return result;");
    lines.push("}");
    lines.push("");
    lines.push("export function transformArray(arr: number[]): number[] {");
    lines.push("  const doubled = arr.map(n => n * 2);");
    lines.push("  const filtered = doubled.filter(n => n > 10);");
    lines.push("  const sorted = filtered.sort((a, b) => a - b);");
    lines.push("  const unique = [...new Set(sorted)];");
    lines.push("  return unique;");
    lines.push("}");
    lines.push("");
    // Pad to >30 lines
    for (let i = 0; i < 15; i++) {
      lines.push(`// padding line ${i}`);
    }

    const content = lines.join("\n");

    const standardChunks = await treeSitterChunkFile(content, fp, rp);

    setChunkGranularity("fine");
    const fineChunks = await treeSitterChunkFile(content, fp, rp);

    expect(fineChunks.length).toBeGreaterThan(standardChunks.length);
  });

  it("includes statement-level chunks from function bodies", async () => {
    const lines: string[] = [];
    lines.push("// header comment for context");
    lines.push("");
    lines.push("export function buildReport(data: Record<string, number>): string {");
    lines.push("  const entries = Object.entries(data);");
    lines.push("  const sorted = entries.sort((a, b) => b[1] - a[1]);");
    lines.push("  const formatted = sorted.map(([key, val]) => `${key}: ${val}`);");
    lines.push("  const header = '=== Report ===';");
    lines.push("  const body = formatted.join('\\n');");
    lines.push("  const footer = `Total items: ${formatted.length}`;");
    lines.push("  return [header, body, footer].join('\\n');");
    lines.push("}");
    lines.push("");
    // Pad to >30 lines
    for (let i = 0; i < 25; i++) {
      lines.push(`// padding line ${i}`);
    }

    const content = lines.join("\n");

    setChunkGranularity("fine");
    const chunks = await treeSitterChunkFile(content, fp, rp);

    // Should have chunks containing individual statements
    const statementChunks = chunks.filter(
      (c) =>
        c.content.includes("const sorted") &&
        !c.content.includes("function buildReport"),
    );
    expect(statementChunks.length).toBeGreaterThanOrEqual(1);
  });

  it("standard mode is unchanged (regression)", async () => {
    const lines: string[] = [];
    lines.push("// some header");
    lines.push("");
    lines.push("export function simpleFunc(x: number): number {");
    lines.push("  const doubled = x * 2;");
    lines.push("  const tripled = doubled + x;");
    lines.push("  return tripled;");
    lines.push("}");
    lines.push("");
    for (let i = 0; i < 25; i++) {
      lines.push(`// padding ${i}`);
    }

    const content = lines.join("\n");

    // Run in standard mode
    setChunkGranularity("standard");
    const standardChunks1 = await treeSitterChunkFile(content, fp, rp);

    // Run again to ensure deterministic
    const standardChunks2 = await treeSitterChunkFile(content, fp, rp);

    expect(standardChunks1.length).toBe(standardChunks2.length);
    for (let i = 0; i < standardChunks1.length; i++) {
      expect(standardChunks1[i].content).toBe(standardChunks2[i].content);
    }
  });
});
