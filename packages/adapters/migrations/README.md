# Store migrations

The Postgres store's schema, one folder per migration (drizzle's v1 layout:
`<yyyyMMddHHmmss>_<name>/migration.sql`). The `migrate` entry applies the ones a
database hasn't seen, in folder-name order; compose runs it on every `up`.

## Shipped migrations never change

`20260820000000_init` was the schema's single description while nothing was
deployed, and it was edited in place. Databases now exist that were created from
it, so it is frozen, and so is every migration after it once it ships. Its
header still says nothing is deployed and that it stays the only migration; that
was true when it was written, and the header is frozen with the rest of it.

The migrator records a migration by its folder name and never reads a recorded
one again. An edit to a shipped file therefore reaches no existing database:
`migrate` reports the schema current, and code that expects the edit fails
against the old schema at its first read or write. `test/migrations.test.ts`
pins each migration's SHA-256, so CI refuses the edit instead.

## Changing the schema

1. Add a folder named for the current UTC time, so it sorts after every
   existing one, such as `20261026120000_add_session_titles/migration.sql`.
2. Write the change as a database at the previous migration needs it: `ALTER`,
   not a restated `CREATE`. Backfill a column before making it `NOT NULL`, and
   keep the comments a reader of the schema needs, as the init does.
3. Update `src/store/schema.ts` to match. The suites apply every migration in
   order (`test/migrate-store.ts`), so the store's tests run against the schema a
   migrated database has.
4. Pin the new folder in `test/migrations.test.ts`. The test's failure message
   gives the line to add.

The migrator applies every pending migration in one transaction, so a migration
can't use statements Postgres refuses inside one, such as
`CREATE INDEX CONCURRENTLY`.
