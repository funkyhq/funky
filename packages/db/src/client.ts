import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

export function createDb(pool: Pool) {
  return drizzle({ client: pool });
}

export type Db = ReturnType<typeof createDb>;
export * as tables from "./schema";
