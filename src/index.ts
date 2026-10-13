import { getDb, logEvent } from "./db/index.js";
import { config } from "./config.js";
import { startScheduler, stopScheduler } from "./engine/scheduler.js";
import { startServer } from "./server/http.js";

function main(): void {
  // Opening the database also applies the schema, so a fresh deploy is
  // immediately usable with no migration step.
  getDb();

  console.log(`[autopilot] model=${config.model} db=${config.databasePath}`);
  logEvent("system.start", "Autopilot started");

  startServer();
  startScheduler();

  const shutdown = (signal: string) => {
    console.log(`[autopilot] ${signal} received, shutting down`);
    stopScheduler();
    logEvent("system.stop", `Stopped on ${signal}`);
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main();
