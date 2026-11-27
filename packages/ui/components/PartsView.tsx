// SPDX-License-Identifier: LGPL-3.0-only
import type { Part } from "@otk/protocol";
import { Show } from "solid-js";
import {
  contentGeneration,
  ContentIdentityProvider,
  sourceRegion,
  useContentIdentity,
} from "../features/transcript-context.tsx";
import { useUiRegistries } from "../registries/context.tsx";
import type { PartProps } from "../registries/renderers.ts";
import { TreeItem } from "./Tree.tsx";
import { ContentWindow } from "./VirtualList.tsx";

function PartView(props: PartProps & { sourceID?: string }) {
  const { parts } = useUiRegistries();
  const identity = useContentIdentity();
  return (
    <Show when={parts.resolve(props.part)} keyed>
      {(Component) => (
        <ContentIdentityProvider value={{ ...identity, partID: props.part.id }}>
          <div
            ref={sourceRegion(() =>
              props.sourceID ?? identity.messageID!
            )}
          >
            <Component {...props} />
          </div>
        </ContentIdentityProvider>
      )}
    </Show>
  );
}

/** A stable keyed component boundary preserves source nodes during part updates. */
export default function PartsView(
  props: Omit<PartProps, "part" | "recordTime" | "failureTime"> & {
    parts: Part[];
    sourceID?(part: Part): string;
    recordTime?(part: Part): number | undefined;
    failureTime?(part: Part): number | undefined;
    tree?: boolean;
    after?: boolean;
  },
) {
  const generation = contentGeneration();
  return (
    <ContentWindow
      items={props.parts}
      key={(part) => generation(part.id)}
      label="Reply parts"
      render={(part) => {
        const content = () => (
          <PartView
            part={part()}
            prefs={props.prefs}
            directory={props.directory}
            permissions={props.permissions}
            onOpenChild={props.onOpenChild}
            user={props.user}
            streaming={props.streaming}
            pending={props.pending}
            sourceID={props.sourceID?.(part())}
            recordTime={props.recordTime?.(part())}
            failureTime={props.failureTime?.(part())}
            row={props.row}
          />
        );
        return (
          <Show when={props.tree} fallback={content()}>
            <TreeItem
              last={!props.after && part().id === props.parts.at(-1)?.id}
            >
              {content()}
            </TreeItem>
          </Show>
        );
      }}
    />
  );
}
