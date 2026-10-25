import { readdirSync, readFileSync } from "node:fs";

const MIGRATIONS = new URL("../migrations/", import.meta.url);

/** The shipped migrations' folder names, in the order the migrator applies
 *  them: drizzle sorts the folders by name, so the timestamp prefix is the
 *  order. */
export const migrationNames = readdirSync(MIGRATIONS, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort((a, b) => a.localeCompare(b));

/** One migration's SQL, as shipped. */
export const migrationSql = (name: string) =>
  readFileSync(new URL(`${name}/migration.sql`, MIGRATIONS), "utf8");

/** The shipped schema itself — every migration, in the migrator's order.
 *  Tests apply the migrations, never a copy of them, so a schema change
 *  reaches the suites the way it reaches a deployed database. */
export const storeDdl = migrationNames.map(migrationSql).join("\n");
