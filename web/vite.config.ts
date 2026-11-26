import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  // MapLibre's worker is an ES module that imports a shared chunk
  worker: { format: "es" },
  build: { target: "es2022" },
});
