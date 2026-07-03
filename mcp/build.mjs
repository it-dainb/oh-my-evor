#!/usr/bin/env node
/**
 * Build script — bundles mcp/src/index.ts → mcp/dist/index.cjs via esbuild.
 *
 * Output is a self-contained CJS bundle so `node mcp/dist/index.cjs` works
 * without any node_modules present in the dist directory.
 */

import { build } from "esbuild";
import { mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

mkdirSync(resolve(__dirname, "dist"), { recursive: true });

await build({
  entryPoints: [resolve(__dirname, "src/index.ts")],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  outfile: resolve(__dirname, "dist/index.cjs"),
  // Externalize only node built-ins; bundle all npm deps including MCP SDK + zod
  external: [
    "fs", "path", "os", "child_process", "crypto", "stream",
    "events", "util", "net", "http", "https", "url", "assert",
    "buffer", "string_decoder", "querystring", "readline", "tty",
    "worker_threads", "v8", "vm", "module", "perf_hooks",
  ],
  sourcemap: false,
  minify: false,
  logLevel: "info",
  banner: {
    js: "#!/usr/bin/env node",
  },
});

console.log("Build complete: mcp/dist/index.cjs");
