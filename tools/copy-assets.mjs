// tsc only emits JavaScript. The schema and the dashboard assets have to be
// copied into dist so a built deploy is self-contained.
import { cpSync, mkdirSync } from "node:fs";

mkdirSync("dist/src/db", { recursive: true });
cpSync("src/db/schema.sql", "dist/src/db/schema.sql");

mkdirSync("dist/src/server/ui", { recursive: true });
cpSync("src/server/ui", "dist/src/server/ui", { recursive: true });

console.log("[build] copied schema.sql and dashboard assets into dist/");
