# Retired legacy browser assertions

All legacy assertion groups are assigned in `../browser/migration.json`.
Behavior runs once per native version in Playwright; fixed visual states belong
to the shared theme sweep. The legacy browser task and driver are retired;
`deno task test:migration --audit --require-no-legacy --require-no-old-driver-consumers`
enforces their retirement.
