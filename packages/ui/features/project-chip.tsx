// SPDX-License-Identifier: LGPL-3.0-only
import { createSignal, onCleanup, onSettled } from "solid-js";
import {
  createProjectEditor,
  type DirectoryCatalogLease,
  type FailureValue,
  failureValue,
} from "@otk/client";
import ProjectChip from "../components/ProjectChip.tsx";
import { useShellPorts } from "../shell/context.tsx";
import { useCommandPorts } from "../keyboard/context.tsx";
import { solidState } from "../state/binding.ts";

/** A thin binding over the existing per-directory catalog owner. */
export default function ProjectLocation(props: {
  directory: string;
  sidecarId?: string;
  catalog?: DirectoryCatalogLease;
}) {
  const lease = props.catalog;
  const shell = useShellPorts(), { commands } = useCommandPorts();
  const [error, setError] = createSignal<FailureValue>("");
  const controller = new AbortController();
  const connection = () =>
    props.sidecarId ? shell?.connection(props.sidecarId) : undefined;
  const project = lease?.view("project"),
    repository = lease?.view("repository");
  onCleanup(() => {
    controller.abort();
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
      project={project?.state.value?.[0]}
      repository={repository?.state.value?.[0]}
      feedback={error() || project?.state.error || repository?.state.error}
      onEdit={shell?.servers().find((server) => server.id === props.sidecarId)
          ?.capabilities.includes("projectEdit")
        ? (ready) => {
          const rpc = connection()!.rpc, directory = props.directory;
          setError({ kind: "pending", text: "Loading project settings..." });
          void rpc.call("project.settings", { directory }, controller.signal)
            .then((snapshot) => {
              controller.signal.throwIfAborted();
              setError("");
              const editor = createProjectEditor({
                snapshot,
                factory: solidState,
                update: async (target, patch) => {
                  await rpc.call("project.update", { ...target, patch });
                },
                refresh: async () => {
                  const snapshot = await rpc.call("project.settings", {
                    directory,
                  });
                  await project?.refresh();
                  return snapshot;
                },
              });
              ready();
              return commands.run("dialog.open", {
                id: "project-settings",
                input: {
                  name: project?.state.value?.[0]?.name ||
                    directory.split("/").at(-1) || directory,
                  editor,
                },
              });
            }).catch((cause) => {
              if (controller.signal.aborted) return;
              setError(
                failureValue(cause, {
                  actionLabel: "Opening project settings",
                  target: { directory },
                  recovery: "Reopen the project menu and try again.",
                }),
              );
            });
        }
        : undefined}
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
