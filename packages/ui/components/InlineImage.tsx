// SPDX-License-Identifier: LGPL-3.0-only
import "./InlineImage.css" with { type: "text" };
import {
  createEffect,
  createMemo,
  createSignal,
  createUniqueId,
  type Element,
  Show,
  useContext,
} from "solid-js";
import {
  type ActionControl,
  type ClientImageFailure,
  type ImageFactLease,
  imageFactsLine,
  imageReason,
  type ImageSource,
  imageSource,
  inlineImageUrl,
} from "@otk/client";
import type { InlineImageFact } from "@otk/protocol";
import type { FileTarget } from "../features/file-paths.tsx";
import { useContentIdentity } from "../features/transcript-context.tsx";
import { useCommandPorts } from "../keyboard/context.tsx";
import ActionButton from "./ActionButton.tsx";
import PathLink, { FilePathServices, PathContext } from "./PathLink.tsx";
import { contextTarget } from "./context-target.ts";

type ImageFact = Extract<InlineImageFact, { status: "image" }>;
type Failed =
  | Extract<InlineImageFact, { status: "unavailable" }>
  | ClientImageFailure;
type LocalSource = Extract<ImageSource, { kind: "local" }>;
const loadFailed: ClientImageFailure = {
  status: "unavailable",
  reason: "load-failed",
};
const unsupported: ClientImageFailure = {
  status: "unavailable",
  reason: "unsupported",
};

function Unavailable(
  props: { alt: string; source: string; local?: LocalSource; fact: Failed },
) {
  const reason = () => imageReason(props.fact);
  return (
    <span class="otk-inline-image-unavailable" title={props.source}>
      <span
        class="otk-inline-image-label"
        role="img"
        aria-label={`${props.alt || "Image"}: ${reason()}`}
      >
        <svg
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          aria-hidden="true"
        >
          <rect x="2.4" y="3" width="11.2" height="10" rx="1.25" />
          <circle cx="6" cy="6" r="1" />
          <path d="m3 11 3-2.5 2 1L13 5m1-3L2 14" />
        </svg>
        <span class="otk-inline-image-copy">
          <span class="otk-inline-image-alt">{props.alt || "Image"}</span>
          <span class="otk-inline-image-reason">{reason()}</span>
        </span>
      </span>
      <Show when={props.local}>
        {(local) => (
          <code class="otk-inline-image-path">
            <PathLink mention={local().mention}>{props.source}</PathLink>
          </code>
        )}
      </Show>
    </span>
  );
}

function Picture(props: {
  src: string;
  alt: string;
  name: string;
  file?: ImageFact;
  target?: FileTarget;
  action: ActionControl;
  failed(): void;
}) {
  const id = `inline-image-${createUniqueId()}`;
  const bind = props.target &&
    contextTarget(() => ({ kind: "file", data: props.target! }));
  return (
    <ActionButton
      id={id}
      class="otk-inline-image"
      inline={{ popup: "dialog" }}
      label={`Open image: ${props.alt || props.name}`}
      title={props.file?.resolved ?? props.name}
      ref={bind}
      action={props.action}
    >
      <img
        src={props.src}
        alt={props.alt}
        width={props.file?.width}
        height={props.file?.height}
        loading="lazy"
        decoding="async"
        crossorigin={props.target ? "use-credentials" : undefined}
        onError={() => props.failed()}
      />
    </ActionButton>
  );
}

export default function InlineImage(
  props: { src: string; alt: string },
): Element {
  const identity = useContentIdentity();
  const paths = useContext(PathContext);
  const services = useContext(FilePathServices);
  const { commands } = useCommandPorts();
  const source = createMemo(() => imageSource(props.src, paths?.style));
  const sidecarId = () => identity.sidecarId ?? "local";
  const [lease, setLease] = createSignal<ImageFactLease>();
  const [failedSrc, setFailedSrc] = createSignal<string>();
  const local = createMemo(() => {
    const value = source();
    return value?.kind === "local" ? value : undefined;
  });
  const external = () => {
    const value = source();
    return value && value.kind !== "local" && failedSrc() !== props.src
      ? value
      : undefined;
  };
  createEffect(() => {
    const mention = local()?.mention;
    const sessionID = identity.sessionID;
    if (!mention || !sessionID || !services || paths?.streaming) return;
    return { path: mention.path, id: sidecarId(), sessionID };
  }, (input) => {
    const value = input &&
      services?.facts(input.id).image(input.sessionID, input.path);
    setLease(() => value);
    return value?.release;
  });
  const fact = () =>
    local() && (!services?.api || !identity.sessionID)
      ? unsupported
      : lease()?.();
  const target = (): FileTarget | undefined => {
    const current = fact();
    const mention = local()?.mention;
    const sessionID = identity.sessionID;
    if (
      current?.status !== "image" || !mention || !sessionID || !services?.api
    ) return;
    const { path, resolved, name, size } = current;
    return {
      sidecarId: sidecarId(),
      sessionID,
      mention,
      fact: { path, status: "file", resolved, size, preview: "image" },
      image: {
        url: inlineImageUrl(services.api(sidecarId()), sessionID, path),
        name,
        facts: imageFactsLine(current),
      },
    };
  };
  const openImage = (name: string, url: string, file?: FileTarget) =>
    commands.control(
      file ? "file.open" : "dialog.open",
      file ?? { id: "image", input: { name, url } },
      {
        target: {
          label: name,
          sidecarId: sidecarId(),
          sessionID: identity.sessionID,
        },
        shown: () => true,
        unshown: "The image preview did not open.",
        recovery: "Try opening the image again.",
      },
    );
  const fail = () => {
    const value = local();
    if (value && identity.sessionID) {
      services?.facts(sidecarId()).imageFailed(
        identity.sessionID,
        value.mention.path,
      );
    } else setFailedSrc(props.src);
  };
  return (
    <Show
      when={local()}
      fallback={
        <Show
          when={external()}
          fallback={
            <Unavailable alt={props.alt} source={props.src} fact={loadFailed} />
          }
        >
          {(value) => (
            <Picture
              src={value().href}
              alt={props.alt}
              name={props.alt || "Image"}
              action={openImage(props.alt || "Image", value().href)}
              failed={fail}
            />
          )}
        </Show>
      }
    >
      {(value) => (
        <Show
          when={target()}
          fallback={
            <Show
              when={fact()?.status === "unavailable"
                ? fact() as Failed
                : undefined}
              fallback={
                <span
                  class="otk-inline-image is-pending"
                  aria-hidden="true"
                />
              }
            >
              {(unavailable) => (
                <Unavailable
                  alt={props.alt}
                  source={props.src}
                  local={value()}
                  fact={unavailable()}
                />
              )}
            </Show>
          }
        >
          {(file) => (
            <Picture
              src={file().image!.url}
              alt={props.alt}
              name={file().image!.name}
              file={fact() as ImageFact}
              target={file()}
              action={openImage(file().image!.name, file().image!.url, file())}
              failed={fail}
            />
          )}
        </Show>
      )}
    </Show>
  );
}
