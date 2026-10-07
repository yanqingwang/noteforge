/**
 * harness 专用打包配置：把 Obsidian 兼容层打成独立 ESM 包，供 Node + jsdom 加载。
 * 不参与应用构建（vite.config.ts 才是应用入口）。
 */
import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
  logLevel: "warn",
  build: {
    outDir: "dist-harness",
    emptyOutDir: true,
    minify: false,
    target: "es2022",
    lib: {
      entry: resolve(__dirname, "src/compat-entry.ts"),
      formats: ["es"],
      fileName: () => "obsidian-shim.mjs",
    },
    rollupOptions: {
      // jsdom 里跑，不需要 react 插件等应用侧东西
      external: [],
    },
  },
});
