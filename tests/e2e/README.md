# Retired legacy browser assertions

All legacy assertion groups are assigned in `../browser/migration.json`.
Behavior runs once per native version in Playwright; fixed visual states belong
to the shared theme sweep. `deno task test:e2e:legacy` has no active assertions.
