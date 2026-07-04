import { reactRouter } from "@react-router/dev/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
  cacheDir: "node_modules/.vite",
  plugins: [tailwindcss(), reactRouter()],
  resolve: {
    tsconfigPaths: true,
  },
  ssr: {
    noExternal: true,
    target: "webworker",
  },
  server: {
    watch: {
      usePolling: true,
      interval: 250,
      ignored: [
        "**/.git/**",
        "**/.react-router/**",
        "**/.turbo/**",
        "**/build/**",
        "**/coverage/**",
        "**/dist/**",
        "**/node_modules/**",
      ],
    },
  },
});
