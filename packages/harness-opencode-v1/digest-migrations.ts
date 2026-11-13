// SPDX-License-Identifier: LGPL-3.0-only
/** Structural contribution: the native package has no store dependency. */
export const opencodeV1DigestMigrations: {
  readonly feature: string;
  readonly migrations: readonly {
    readonly version: number;
    readonly sql: URL;
  }[];
} = {
  feature: "opencode-v1-digest",
  migrations: [{
    version: 1,
    sql: new URL("./digest-migrations/001.sql", import.meta.url),
  }, {
    version: 2,
    sql: new URL("./digest-migrations/002.sql", import.meta.url),
  }, {
    version: 3,
    sql: new URL("./digest-migrations/003.sql", import.meta.url),
  }, {
    version: 4,
    sql: new URL("./digest-migrations/004.sql", import.meta.url),
  }, {
    version: 5,
    sql: new URL("./digest-migrations/005.sql", import.meta.url),
  }],
};
