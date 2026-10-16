// SPDX-License-Identifier: LGPL-3.0-only
import type { Element } from "solid-js";
function Icon(props: { children: Element }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.75"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      {props.children}
    </svg>
  );
}
export const FileIcon = () => (
  <Icon>
    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5" />
  </Icon>
);
export const EditIcon = () => (
  <Icon>
    <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z" />
  </Icon>
);
export const RunIcon = () => (
  <Icon>
    <path d="m5 17 5-5-5-5M12 19h7" />
  </Icon>
);
