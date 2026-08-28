import { readFileSync } from "node:fs";

/** The shipped schema itself — tests apply the migration, never a copy of it. */
export const storeDdl = readFileSync(
  new URL("../migrations/20260820000000_init/migration.sql", import.meta.url),
  "utf8",
);
