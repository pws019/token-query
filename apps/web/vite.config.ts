import { reactRouter } from "@react-router/dev/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
  cacheDir: "node_modules/.vite",
  plugins: [
    {
      name: "ignore-chrome-devtools-probe",
      apply: "serve",
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (req.url === "/.well-known/appspecific/com.chrome.devtools.json") {
            res.statusCode = 204;
            res.end();
            return;
          }

          next();
        });
      },
    },
    tailwindcss(),
    reactRouter(),
  ],
  resolve: {
    tsconfigPaths: true,
  },
  ssr: {
    noExternal: ["@token-query/api", "@token-query/env", "@token-query/ui"],
    target: "webworker",
  },
  server: {
    proxy: {
      "/api": {
        target: process.env.WEB_API_PROXY_ORIGIN ?? "http://localhost:3000",
        changeOrigin: true,
      },
    },
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
