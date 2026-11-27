// SPDX-License-Identifier: LGPL-3.0-only
import "./WorkLog.css" with { type: "text" };
import type { Element } from "solid-js";
import { retainedWorkDisclosure } from "../features/transcript-context.tsx";
import ChromeMeta from "./ChromeMeta.tsx";
import { WorkLogIcon } from "./ChromeIcons.tsx";
import { TreeNode } from "./Tree.tsx";
import type { Preferences } from "@otk/protocol";
import Disclosure from "./Disclosure.tsx";
import { useRecordKindsRegion } from "./RecordKinds.tsx";

export default function WorkLog(
  props: {
    owner: string;
    prefs?: Preferences;
    required?: boolean;
    meta?(): Element;
    body(): Element;
  },
): Element {
  const work = retainedWorkDisclosure(
    () => props.owner,
    () => props.prefs ?? {},
    () => !!props.required,
  );
  const regionId = useRecordKindsRegion();
  return (
    <section class="otk-work-log">
      <Disclosure
        kind="work"
        identity={work.identity()}
        input={work.input}
        variant="label"
        class="otk-work-fold"
        label="Work log"
        labelContent={() => (
          <ChromeMeta class="otk-work-label">Work log</ChromeMeta>
        )}
        lead={() => <WorkLogIcon />}
        hasContent={() => true}
        regionId={regionId}
        layout={({ trigger, region, open, frame }) => (
          <TreeNode
            ref={frame}
            trigger={{ variant: "span", element: trigger }}
            bodyVisible={open()}
            trail={props.meta}
            region={region}
          />
        )}
      >
        {() => <div class="otk-work-body">{props.body()}</div>}
      </Disclosure>
    </section>
  );
}
