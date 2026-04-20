import { resolve } from "path";
import { defineConfig } from "vitest/config";
import vue from "@vitejs/plugin-vue";

export default defineConfig({
  plugins: [vue()],
  test: {
    environment: "happy-dom",
    include: ["tests/unit/**/*.test.ts"],
  },
  resolve: {
    alias: {
      "@shared": resolve(__dirname, "src/shared"),
      "@renderer": resolve(__dirname, "src/renderer/src"),
    },
  },
});
