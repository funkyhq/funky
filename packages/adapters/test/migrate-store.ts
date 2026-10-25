import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { Pool } from "pg";

const migrationsFolder = fileURLToPath(new URL("../migrations", import.meta.url));

/** The shipped migrations as drizzle's migrator reads them — name, SQL
 *  chunks and recorded hash, in the order it applies them. */
export const migrations = readMigrationFiles({ migrationsFolder });

/** Brings a fresh database to the shipped schema. A Postgres pool gets
 *  drizzle's node-postgres migrator, the one `src/store/migrate.ts` runs;
 *  a reset between runs must drop the `drizzle` schema too, or the
 *  migrator skips what it recorded there.
 *
 *  PGlite can't take drizzle's PGlite migrator: that one sends each chunk
 *  as a prepared statement, which refuses more than one command, and the
 *  init is a single chunk. node-postgres sends a parameterless query over
 *  the simple protocol, so PGlite gets the same thing here — every chunk,
 *  in order, in one transaction — minus the bookkeeping row. */
export const migrateStore = async (client: PGlite | Pool): Promise<void> => {
  if (!(client instanceof PGlite)) {
    await migrate(drizzle({ client }), { migrationsFolder });
    return;
  }
  await client.transaction(async (tx) => {
    for (const migration of migrations) {
      for (const chunk of migration.sql) await tx.exec(chunk);
    }
  });
};
