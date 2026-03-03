import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  define: {
    __DEV_BUILD__: "true",
  },
  resolve: {
    alias: {
      vscode: path.resolve(__dirname, "src/__mocks__/vscode.ts"),
    },
  },
  test: {
    include: ["src/**/*.test.ts"],
  },
});
