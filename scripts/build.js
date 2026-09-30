// Bündelt den Server (und mit --test die Tests) zu einer Datei.
// Der Netzwerkplaner-Teil kommt aus dem App-Code: NETZWERKPLANER_DIR (Standard: ./netzwerkplaner, sonst ../netzwerkplaner).
import * as esbuild from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const kandidaten = [process.env.NETZWERKPLANER_DIR, path.join(ROOT, "netzwerkplaner"), path.join(ROOT, "..", "netzwerkplaner")].filter(Boolean);
const np = kandidaten.find((d) => fs.existsSync(path.join(d, "src", "shared", "intents.js")));
if (!np) { console.error(`Netzwerkplaner-Code nicht gefunden (gesucht: ${kandidaten.join(", ")}). NETZWERKPLANER_DIR setzen.`); process.exit(1); }

const gemeinsam = { bundle: true, platform: "node", format: "esm", target: "node20", external: ["ws"], alias: { "@netzwerkplaner": path.join(np, "src", "shared") }, logLevel: "warning" };
await esbuild.build({ ...gemeinsam, entryPoints: [path.join(ROOT, "src", "server.js")], outfile: path.join(ROOT, "dist", "server.js") });

if (process.argv.includes("--test")) {
  const out = path.join(ROOT, "dist-test");
  fs.rmSync(out, { recursive: true, force: true });
  const tests = fs.readdirSync(path.join(ROOT, "test")).filter((f) => f.endsWith(".test.js")).map((f) => path.join(ROOT, "test", f));
  await esbuild.build({ ...gemeinsam, entryPoints: tests, outdir: out, outExtension: { ".js": ".mjs" }, alias: { ...gemeinsam.alias, "@np-root": np } });
}
console.log(`Gebaut mit Netzwerkplaner aus ${np}`);
