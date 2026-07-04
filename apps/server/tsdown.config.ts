import { defineConfig } from "tsdown";

export default defineConfig({
  entry: {
    index: "./src/index.ts",
    lambda: "./src/lambda.ts",
    "app.lambda": "./src/app.lambda.ts",
  },
  format: "esm",
  outDir: "./dist",
  clean: true,
  noExternal: [/.*/],
});
