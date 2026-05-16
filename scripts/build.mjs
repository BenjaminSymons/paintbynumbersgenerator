// Build / dev-server script powered by esbuild.
//
//   node scripts/build.mjs --web            bundle the browser app -> scripts/main.js
//   node scripts/build.mjs --cli            bundle the CLI         -> dist/cli.js
//   node scripts/build.mjs --web --cli      bundle both
//   node scripts/build.mjs --serve          build web + static dev server on :10001
//   node scripts/build.mjs --serve --watch  same, rebuilding on source changes
//
// Replaces the old requirejs/tsc(outFile)/lite-server toolchain.

import * as esbuild from "esbuild";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = new Set(process.argv.slice(2));

const PORT = Number(process.env.PORT) || 10001;

/** @type {import("esbuild").BuildOptions} */
const webConfig = {
  entryPoints: [path.join(root, "src", "main.ts")],
  outfile: path.join(root, "scripts", "main.js"),
  bundle: true,
  format: "iife",
  target: ["es2020", "chrome90", "firefox90", "safari14"],
  platform: "browser",
  sourcemap: true,
  minify: true,
  logLevel: "info",
};

/** @type {import("esbuild").BuildOptions} */
const cliConfig = {
  entryPoints: [path.join(root, "src-cli", "main.ts")],
  outfile: path.join(root, "dist", "cli.js"),
  bundle: true,
  format: "esm",
  platform: "node",
  target: ["node20"],
  // Native / heavy runtime deps stay external and are resolved from
  // node_modules. pdfkit must stay external too: it loads its built-in AFM
  // font metrics from its own package directory via fs at runtime, which an
  // esbuild bundle would break.
  external: ["canvas", "sharp", "pdfkit", "svg-to-pdfkit"],
  banner: { js: "#!/usr/bin/env node\nimport{createRequire}from'node:module';const require=createRequire(import.meta.url);" },
  sourcemap: true,
  logLevel: "info",
};

async function run() {
  const wantWeb = args.has("--web") || args.has("--serve");
  const wantCli = args.has("--cli");
  const watch = args.has("--watch");
  const serve = args.has("--serve");

  if (!wantWeb && !wantCli) {
    console.error("Nothing to do. Pass --web, --cli and/or --serve.");
    process.exit(1);
  }

  if (serve) {
    const ctx = await esbuild.context(webConfig);
    if (watch) await ctx.watch();
    const { hosts, port } = await ctx.serve({ servedir: root, port: PORT });
    const host = hosts.find((h) => h === "127.0.0.1") ?? hosts[0];
    console.log(`\n  Paint by numbers generator running at http://${host}:${port}/\n`);
    return; // keep process alive
  }

  const builds = [];
  if (wantWeb) builds.push(webConfig);
  if (wantCli) builds.push(cliConfig);

  if (watch) {
    for (const cfg of builds) {
      const ctx = await esbuild.context(cfg);
      await ctx.watch();
    }
    console.log("Watching for changes...");
    return;
  }

  await Promise.all(builds.map((cfg) => esbuild.build(cfg)));
  console.log("Build complete.");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
