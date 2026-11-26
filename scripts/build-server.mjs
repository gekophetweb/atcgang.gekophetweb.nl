import { build } from "esbuild";

await build({
  entryPoints: ["src/server/index.ts"],
  outfile: "dist/server/index.js",
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  packages: "external",
  sourcemap: true,
  alias: { "@shared": "./src/shared" },
});
console.log("server built");
