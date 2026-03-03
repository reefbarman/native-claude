import * as esbuild from "esbuild";
import * as path from "path";
import { copyFileSync, mkdirSync, readdirSync, readFileSync } from "fs";

const watch = process.argv.includes("--watch");

// Load .env.local if it exists (for DEV_BUILD=true opt-in)
let devBuild = false;
try {
  const envLocal = readFileSync(".env.local", "utf-8");
  devBuild = /^DEV_BUILD\s*=\s*true$/m.test(envLocal);
} catch {
  // No .env.local — dev tools disabled (default)
}

/** @type {esbuild.BuildOptions} */
const extensionOptions = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "dist/extension.js",
  external: ["vscode"],
  format: "cjs",
  platform: "node",
  target: "node20",
  sourcemap: true,
  minify: false,
  define: {
    __DEV_BUILD__: JSON.stringify(devBuild),
  },
};

/** @type {esbuild.BuildOptions} */
const webviewBase = {
  bundle: true,
  outdir: "dist",
  format: "esm",
  platform: "browser",
  target: "es2022",
  sourcemap: true,
  minify: true,
  jsx: "automatic",
  jsxImportSource: "preact",
  define: {
    __DEV_BUILD__: JSON.stringify(devBuild),
  },
};

/** @type {esbuild.BuildOptions} */
const sidebarOptions = {
  ...webviewBase,
  entryPoints: ["src/sidebar/webview/index.tsx"],
  entryNames: "sidebar",
};

/** @type {esbuild.BuildOptions} */
const approvalOptions = {
  ...webviewBase,
  entryPoints: ["src/approvals/webview/index.tsx"],
  entryNames: "approval",
};

/** @type {esbuild.BuildOptions} */
const frPreviewOptions = {
  ...webviewBase,
  entryPoints: ["src/findReplace/webview/index.tsx"],
  entryNames: "fr-preview",
};

/** @type {esbuild.BuildOptions} */
const indexerOptions = {
  entryPoints: ["src/indexer/worker.ts"],
  bundle: true,
  outfile: "dist/indexer-worker.js",
  external: ["vscode"],
  format: "cjs",
  platform: "node",
  target: "node20",
  sourcemap: true,
  minify: false,
  define: {
    __DEV_BUILD__: JSON.stringify(devBuild),
  },
  // Force web-tree-sitter to resolve its CJS entry (uses __filename/__dirname)
  // instead of the ESM entry (uses import.meta.url which is undefined in CJS bundles)
  alias: {
    "web-tree-sitter": path.resolve(
      "node_modules/web-tree-sitter/web-tree-sitter.cjs",
    ),
  },
};

if (watch) {
  const [extCtx, sideCtx, appCtx, frCtx, idxCtx] = await Promise.all([
    esbuild.context(extensionOptions),
    esbuild.context(sidebarOptions),
    esbuild.context(approvalOptions),
    esbuild.context(frPreviewOptions),
    esbuild.context(indexerOptions),
  ]);
  await Promise.all([
    extCtx.watch(),
    sideCtx.watch(),
    appCtx.watch(),
    frCtx.watch(),
    idxCtx.watch(),
  ]);
  console.log("Watching for changes...");
} else {
  await Promise.all([
    esbuild.build(extensionOptions),
    esbuild.build(sidebarOptions),
    esbuild.build(approvalOptions),
    esbuild.build(frPreviewOptions),
    esbuild.build(indexerOptions),
  ]);
  // Copy codicon assets to dist
  copyFileSync(
    "node_modules/@vscode/codicons/dist/codicon.css",
    "dist/codicon.css",
  );
  copyFileSync(
    "node_modules/@vscode/codicons/dist/codicon.ttf",
    "dist/codicon.ttf",
  );
  // Copy tree-sitter WASM files to dist/wasm/
  const wasmDestDir = "dist/wasm";
  mkdirSync(wasmDestDir, { recursive: true });
  // Core parser WASM
  copyFileSync(
    "node_modules/web-tree-sitter/web-tree-sitter.wasm",
    path.join(wasmDestDir, "web-tree-sitter.wasm"),
  );
  // Language grammar WASMs from @vscode/tree-sitter-wasm
  const wasmSrcDir = "node_modules/@vscode/tree-sitter-wasm/wasm";
  for (const f of readdirSync(wasmSrcDir)) {
    if (f.endsWith(".wasm") && f.startsWith("tree-sitter-")) {
      copyFileSync(path.join(wasmSrcDir, f), path.join(wasmDestDir, f));
    }
  }

  console.log("Build complete.");
}
