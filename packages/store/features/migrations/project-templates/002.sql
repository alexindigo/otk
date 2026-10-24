-- SPDX-License-Identifier: LGPL-3.0-only
INSERT INTO project_templates(position, template)
SELECT 0, '~/Projects/{project}' WHERE NOT EXISTS (SELECT 1 FROM project_templates);
