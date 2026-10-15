import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  outDir: "dist",
  target: "es2022",
  external: ["@tradejs/core", "@tradejs/strategy-kit", "@tradejs/types"],
});
