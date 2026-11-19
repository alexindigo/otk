// SPDX-License-Identifier: LGPL-3.0-only
import { onCleanup, onSettled } from "solid-js";
import type { DirectoryCatalogLease } from "@otk/client";
import ProjectChip from "../components/ProjectChip.tsx";

/** A thin binding over the existing per-directory catalog owner. */
export default function ProjectLocation(props: {
  directory: string;
  serverLabel?: string;
  catalog?: DirectoryCatalogLease;
}) {
  const lease = props.catalog;
  const project = lease?.view("project"),
    repository = lease?.view("repository");
  onCleanup(() => {
    project?.dispose();
    repository?.dispose();
    lease?.release();
  });
  onSettled(() => {
    void project?.ready().catch(() => {});
  });
  return (
    <ProjectChip
      directory={props.directory}
      serverLabel={props.serverLabel}
      project={project?.state.value?.[0]}
      repository={repository?.state.value?.[0]}
      feedback={project?.state.error || repository?.state.error}
      onOpen={() => {
        if (repository?.state.available) {
          void repository.refresh().catch(
            () => {},
          );
        }
      }}
    />
  );
}
