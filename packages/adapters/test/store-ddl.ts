import { readFileSync } from "node:fs";

export const storeDdl = ["20260820000000_init", "20260827000000_agent_config_versions"]
  .map((name) =>
    readFileSync(new URL(`../migrations/${name}/migration.sql`, import.meta.url), "utf8"),
  )
  .join("\n");
