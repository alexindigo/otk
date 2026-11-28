// SPDX-License-Identifier: LGPL-3.0-only
import { createSignal } from "solid-js";
import RecordList from "../../components/RecordList.tsx";
import VirtualList from "../../components/VirtualList.tsx";

export default function Scene() {
  const [rows, setRows] = createSignal([{ id: "retained", revision: 0 }]);
  return (
    <>
      <button
        type="button"
        onClick={() =>
          setRows(
            rows().map((row) => ({
              ...row,
              revision: row.revision + 1,
            })),
          )}
      >
        Update record facts
      </button>
      <VirtualList
        keys={["interval"]}
        label="Record lifetime"
        render={() => (
          <RecordList
            items={rows()}
            key={(row) => row.id}
            scope="retained-records"
            revision={(row) => row.revision}
            render={(row) => {
              // Like SessionView's identity-dispatched Message factory, content
              // construction reads its key before returning reactive bindings.
              const id = row().id;
              return (
                <article tabindex="-1" data-record-lifetime={id}>
                  Record revision {row().revision}
                </article>
              );
            }}
          />
        )}
      />
    </>
  );
}
