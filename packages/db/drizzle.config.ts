import { config } from "dotenv";
import { defineConfig } from "drizzle-kit";

config({ path: "../../.env" }); // root .env — cwd is packages/db when drizzle-kit runs

export default defineConfig({
  out: "./migrations",
  schema: "./schema",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
});
