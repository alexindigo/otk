// SPDX-License-Identifier: LGPL-3.0-only
import "./PermissionDock.css" with { type: "text" };
import type { DockRegistry } from "../registries/renderers.ts";
export function registerPermissionDock(docks: DockRegistry): void {
  docks.register({
    id: "permissions",
    capability: "permissions",
    render: (inputs) => inputs.permissions,
  });
}
import { createSignal, For, Match, onSettled, Show, Switch } from "solid-js";
import type { PermissionDetail, PermissionRequest } from "@otk/protocol";
import type { PermissionReply } from "@otk/protocol";
import { ownedCommand, useCommandPorts } from "../keyboard/context.tsx";
import { useSessionPorts } from "../registries/session.tsx";
import { oldestPermission } from "@otk/client";
import type {
  SurfaceRegistry,
  TakeoverDefinition,
} from "../registries/shell.ts";
export function registerPermissionTakeover(
  registry: SurfaceRegistry<TakeoverDefinition>,
): void {
  registry.register({
    id: "permissions",
    capability: "permissions",
    component: PermissionTakeover,
  });
}
function PermissionTakeover() {
  const session = useSessionPorts(), { commands } = useCommandPorts();
  const request = () =>
    oldestPermission(session.permissions(), session.sessionID(), session.entry);
  return (
    <PermissionDock
      request={request()}
      childTitle={request()?.sessionID !== session.sessionID()
        ? session.entry(request()?.sessionID ?? "")?.title ||
          request()?.sessionID
        : undefined}
      onDirty={(value) => session.dirty("permissions", value)}
      onReply={(input) => commands.run("permission.reply", input)}
    />
  );
}
const detailOf = <K extends PermissionDetail["kind"]>(
  detail: PermissionDetail,
  kind: K,
) =>
  detail.kind === kind ? detail as PermissionDetail & { kind: K } : undefined;
function Detail(props: { detail: PermissionDetail }) {
  return (
    <Switch>
      <Match when={detailOf(props.detail, "bash")}>
        {(detail) => (
          <>
            <pre class="otk-permission-command">{detail().command}</pre>
            <Show when={detail().cwd}>
              <p class="otk-muted otk-path">{detail().cwd}</p>
            </Show>
          </>
        )}
      </Match>
      <Match when={detailOf(props.detail, "edit")}>
        {(detail) => (
          <ul>
            <For
              each={detail().files}
              keyed={(file) => file.path}
            >
              {(file) => (
                <li>
                  <span class="otk-path">{file().path}</span>{" "}
                  <span class="otk-muted">
                    +{file().additions} / −{file().deletions}
                  </span>
                </li>
              )}
            </For>
          </ul>
        )}
      </Match>
      <Match when={detailOf(props.detail, "generic")}>
        {(detail) => <p>{detail().summary}</p>}
      </Match>
    </Switch>
  );
}
function RequestDock(
  props: {
    request: PermissionRequest;
    childTitle?: string;
    onReply(input: PermissionReply): Promise<void>;
    onDirty(value: boolean): void;
  },
) {
  const [mode, setMode] = createSignal<"normal" | "always" | "reject">(
    "normal",
  );
  const [message, setMessage] = createSignal(""),
    [pending, setPending] = createSignal(false),
    [error, setError] = createSignal("");
  let active = true;
  onSettled(() => () => {
    active = false;
    props.onDirty(false);
  });
  const answer = async (reply: PermissionReply["reply"]) => {
    if (pending()) return;
    const input: PermissionReply = {
      requestID: props.request.id,
      sessionID: props.request.sessionID,
      reply,
      message: reply === "reject" ? message().trim() || undefined : undefined,
    };
    setPending(true);
    setError("");
    try {
      await props.onReply(input);
      if (active) props.onDirty(false);
    } catch (error) {
      if (active) setError((error as Error).message);
    } finally {
      if (active) setPending(false);
    }
  };
  const ports = useCommandPorts();
  const once = ownedCommand(ports, {
    id: "permission.once",
    title: "Allow permission once",
    category: "Attention",
    enabled: () => !pending(),
    run: () => answer("once"),
  });
  const always = ownedCommand(ports, {
    id: "permission.always",
    title: "Review future permission grant",
    category: "Attention",
    enabled: () => !pending(),
    run: () => setMode("always"),
  });
  const reject = ownedCommand(ports, {
    id: "permission.reject",
    title: "Review permission rejection",
    category: "Attention",
    enabled: () => !pending(),
    run: () => setMode("reject"),
  });
  const answerCommand = ownedCommand(ports, {
    id: "permission.answer",
    title: "Answer permission",
    category: "Attention",
    hidden: true,
    run: (_ctx, reply: PermissionReply["reply"]) => answer(reply),
  });
  const close = ownedCommand(ports, {
    id: "permission.close",
    title: "Close permission confirmation",
    category: "Attention",
    hidden: true,
    run: () => setMode("normal"),
  });
  onSettled(() =>
    ports.keyboard?.layer("permission.close", () => mode() !== "normal", 20)
  );
  return (
    <section
      class="otk-permission-dock"
      tabindex="0"
      aria-label="Pending permission"
      onKeyDown={(event) => {
        if (event.key === "Escape" && mode() !== "normal") {
          event.preventDefault();
          void close();
          return;
        }
        if (
          event.target instanceof HTMLTextAreaElement ||
          event.target instanceof HTMLInputElement || pending() ||
          mode() !== "normal"
        ) return;
        if (["1", "2", "3"].includes(event.key)) {
          event.preventDefault();
          if (event.key === "1") void once();
          else void (event.key === "2" ? always() : reject());
        }
      }}
    >
      <header>
        <h2>Permission · {props.request.kind}</h2>
        <Show when={props.childTitle}>
          <span class="otk-permission-child">From {props.childTitle}</span>
        </Show>
      </header>
      <p class="otk-permission-title">{props.request.title}</p>
      <Detail detail={props.request.detail} />
      <ul class="otk-permission-patterns">
        <For each={props.request.patterns} keyed={false}>
          {(pattern) => <li class="otk-path">{pattern()}</li>}
        </For>
      </ul>
      <Show when={error()}>
        <p class="otk-error" role="alert">{error()}</p>
      </Show>
      <Switch>
        <Match when={mode() === "normal"}>
          <div class="otk-permission-actions">
            <button
              type="button"
              disabled={pending()}
              onClick={() => void once()}
              class="otk-primary"
            >
              Allow once
            </button>
            <button
              type="button"
              disabled={pending()}
              onClick={() => void always()}
            >
              Allow always
            </button>
            <button
              type="button"
              disabled={pending()}
              onClick={() => void reject()}
            >
              Reject
            </button>
            <span class="otk-muted">1 / 2 / 3 when focused</span>
          </div>
        </Match>
        <Match when={mode() === "always"}>
          <div class="otk-permission-confirm">
            <p>Allow these patterns for future requests?</p>
            <ul>
              <For each={props.request.alwaysPatterns} keyed={false}>
                {(pattern) => <li>{pattern()}</li>}
              </For>
            </ul>
            <div class="otk-permission-actions">
              <button
                type="button"
                disabled={pending()}
                onClick={() => void answerCommand("always")}
              >
                Confirm allow always
              </button>
              <button
                type="button"
                disabled={pending()}
                onClick={() => void close()}
              >
                Cancel
              </button>
            </div>
          </div>
        </Match>
        <Match when={mode() === "reject"}>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void answerCommand("reject");
            }}
          >
            <label>
              Optional rejection message<textarea
                name="rejection"
                value={message()}
                onInput={(event) => {
                  const value = event.currentTarget.value;
                  setMessage(value);
                  props.onDirty(!!value);
                }}
              />
            </label>
            <div class="otk-permission-actions">
              <button type="submit" disabled={pending()}>Reject request</button>
              <button
                type="button"
                disabled={pending()}
                onClick={() => void close()}
              >
                Cancel
              </button>
            </div>
          </form>
        </Match>
      </Switch>
    </section>
  );
}
export default function PermissionDock(
  props: {
    request?: PermissionRequest;
    childTitle?: string;
    onReply(input: PermissionReply): Promise<void>;
    onDirty(value: boolean): void;
  },
): import("solid-js").Element {
  return (
    <For
      each={props.request ? [props.request] : []}
      keyed={(request) => request.id}
    >
      {(request) => (
        <RequestDock
          request={request()}
          childTitle={props.childTitle}
          onReply={(input) => props.onReply(input)}
          onDirty={(value) => props.onDirty(value)}
        />
      )}
    </For>
  );
}
