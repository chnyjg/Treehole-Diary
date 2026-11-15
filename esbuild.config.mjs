import esbuild from "esbuild";
import process from "process";
import { builtinModules } from "module";

const builtins = builtinModules.map((m) => m.replace(/^node:/, ""));

const prod = process.argv[2] === "production";

esbuild
  .build({
    entryPoints: ["src/main.ts"],
    bundle: true,
    external: ["obsidian", "electron", ...builtins],
    platform: "node",
    format: "cjs",
    target: "es2020",
    logLevel: "info",
    sourcemap: prod ? false : "inline",
    treeShaking: true,
    outfile: "main.js",
  })
  .catch(() => process.exit(1));
