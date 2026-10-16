// SPDX-License-Identifier: LGPL-3.0-only
import type { OtkDb } from "../db.ts";
import type { FeatureMigrations } from "../migrations.ts";
import { MetadataChanges, ordered } from "./metadata.ts";
export const projectTemplatesMigrations: FeatureMigrations = {
  feature: "project-templates",
  migrations: [{
    version: 1,
    sql: new URL("./migrations/project-templates/001.sql", import.meta.url),
  }],
};
/** Server-scoped settings; filesystem expansion belongs to the server feature. */
export class ProjectTemplates extends MetadataChanges {
  constructor(readonly db: OtkDb) {
    super();
  }
  list(): string[] {
    return this.db.connection.prepare(
      "SELECT template FROM project_templates ORDER BY position",
    ).all().map((r) => String(r.template));
  }
  set(templates: string[]): string[] {
    ordered(templates);
    this.db.connection.exec("BEGIN IMMEDIATE");
    try {
      this.db.connection.exec("DELETE FROM project_templates");
      templates.forEach((template, i) =>
        this.db.connection.prepare("INSERT INTO project_templates VALUES(?,?)")
          .run(i, template)
      );
      this.db.connection.exec("COMMIT");
    } catch (error) {
      this.db.connection.exec("ROLLBACK");
      throw error;
    }
    this.changed();
    return this.list();
  }
}
