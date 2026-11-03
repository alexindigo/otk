// SPDX-License-Identifier: LGPL-3.0-only
import { serve } from "./http.ts";
import { resources } from "./resources.ts";
import { helperParent } from "./helper-parent.ts";
import type { OpencodeTest } from "./opencode.ts";
import type { Profile } from "./fixture-control.ts";

/** Observe/hold actual stock HTTP/SSE; never synthesize a successful outcome. */
export async function nativeMessageScenario(
  oc: OpencodeTest,
  profile: Profile,
) {
  const helper = profile === "messages-helper-pages"
    ? await helperParent(oc)
    : undefined;
  let sessionID: string | undefined,
    holding = !!helper,
    streamCount = 0,
    lost = 0,
    deltas = 0,
    childReads = 0,
    fail = profile.endsWith("-retry");
  const reads: string[] = [],
    points: string[] = [],
    snapshots: string[] = [],
    assistants = new Set<string>(),
    streams = new Set<TransformStreamDefaultController<string>>();
  const held = Promise.withResolvers<void>();
  const mutations: string[] = [];
  const mutationDetails: string[] = [];
  let mutationGate: PromiseWithResolvers<void> | undefined;
  let mutationPath: string | undefined;
  let rejectRevert = false;
  const release = () => {
    holding = false;
    held.resolve();
    mutationGate?.resolve();
  };
  resources().defer("release native message read", release);
  const proxy = serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    async (req) => {
      const url = new URL(req.url);
      reads.push(url.pathname);
      if (profile === "revert-native") {
        const operation = url.pathname.split("/").at(-1)!;
        if (
          req.method === "DELETE" ||
          (req.method === "POST" &&
            ["abort", "revert", "unrevert", "summarize"].includes(operation))
        ) mutationDetails.push(`${req.method} ${url.pathname}`);
        if (operation === "summarize" && rejectRevert) {
          return Response.json({
            name: "CompactFailure",
            data: { message: "Compact refused" },
          }, { status: 500 });
        }
        if (
          req.method === "POST" &&
          ["abort", "revert", "unrevert"].includes(operation)
        ) {
          mutations.push(operation);
          if (operation === mutationPath) await mutationGate?.promise;
          if (operation === "revert" && rejectRevert) {
            return Response.json({
              _tag: "SessionBusyError",
              sessionID: url.pathname.split("/")[2],
            }, { status: 409 });
          }
        }
        return await fetch(
          new Request(new URL(url.pathname + url.search, oc.url), req),
        );
      }
      if (
        helper && holding &&
        url.pathname === `/session/${helper.child.nativeID}/message`
      ) {
        childReads++;
        await held.promise;
      }
      const point = sessionID &&
        url.pathname.startsWith(`/session/${sessionID}/message/`) &&
        req.method === "GET";
      if (point) {
        points.push(url.pathname);
        if (fail) {
          fail = false;
          return Response.json({ message: "Checkpoint unavailable" }, {
            status: 503,
          });
        }
      }
      const response = await fetch(
        new Request(new URL(url.pathname + url.search, oc.url), req),
      );
      if (point) {
        const snapshot = await response.clone().json();
        snapshots.push(
          snapshot.parts.filter((p: { type: string }) => p.type === "text").map(
            (p: { text: string }) => p.text,
          ).join("").trim(),
        );
      }
      if (
        helper || url.pathname !== "/global/event" || !response.body
      ) return response;
      streamCount++;
      let pending = "";
      const headers = new Headers(response.headers);
      headers.delete("content-encoding");
      headers.delete("content-length");
      return new Response(
        response.body.pipeThrough(new TextDecoderStream()).pipeThrough(
          new TransformStream<string, string>({
            start(c) {
              streams.add(c);
            },
            transform(chunk, c) {
              pending += chunk;
              let end: number;
              while ((end = pending.indexOf("\n\n")) >= 0) {
                const frame = pending.slice(0, end);
                pending = pending.slice(end + 2);
                const data = frame.split("\n").filter((l) =>
                  l.startsWith("data:")
                ).map((l) => l.slice(5).trim()).join("\n");
                let drop = false;
                if (data) {
                  const envelope = JSON.parse(data),
                    event = envelope.payload ?? envelope,
                    part = event.properties?.part,
                    info = event.properties?.info;
                  if (
                    event.type === "message.updated" &&
                    info?.role === "assistant"
                  ) assistants.add(info.id);
                  if (
                    event.type === "message.part.updated" &&
                    part?.sessionID === sessionID &&
                    assistants.has(part.messageID) &&
                    (part.type === "text" || part.type === "reasoning")
                  ) {
                    lost++;
                    drop = true;
                  }
                  if (
                    event.type === "message.part.delta" &&
                    event.properties?.sessionID === sessionID
                  ) deltas++;
                }
                if (!drop) {
                  c.enqueue(frame + "\n\n");
                }
              }
            },
            flush(c) {
              streams.delete(c);
            },
          }),
        ).pipeThrough(new TextEncoderStream()),
        { status: response.status, headers },
      );
    },
  );
  resources().defer("native message proxy", () => proxy.shutdown());
  return {
    port: proxy.addr.port,
    url: `http://127.0.0.1:${proxy.addr.port}`,
    observe: () => ({
      helper,
      reads,
      holding,
      streamCount,
      lost,
      deltas,
      points,
      snapshots,
      childReads,
      mutations,
      mutationDetails,
    }),
    release,
    control(action: "hold" | "release" | "freeze" | "thaw", id?: string) {
      if (profile === "revert-native") {
        if (action === "hold") {
          if (!["revert", "unrevert"].includes(id ?? "")) {
            throw new Error("Unknown revert gate");
          }
          mutationPath = id;
          mutationGate = Promise.withResolvers<void>();
        } else if (action === "release") {
          mutationGate?.resolve();
          mutationPath = undefined;
        } else if (action === "freeze") rejectRevert = true;
        else if (action === "thaw") rejectRevert = false;
        return;
      }
      if (action === "release") release();
      else if (action === "hold") sessionID = id;
      else if (action === "freeze") {
        for (const stream of streams) stream.terminate();
        streams.clear();
      } else throw new Error("Unsupported native message action");
    },
  };
}
