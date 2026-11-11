// SPDX-License-Identifier: LGPL-3.0-only
import { serve } from "./http.ts";
import { resources } from "./resources.ts";
import { FreezeProxy } from "./freeze-proxy.ts";
import { type BrowserNative, browserScenarioPath } from "./browser-native.ts";
import type { Profile } from "./fixture-control.ts";

/** Native-side faults belong to the Deno fixture, never browser routing. */
export function transportScenario(oc: BrowserNative, profile: Profile) {
  const freeze = ["transport-freeze", "transport-reconnect"].includes(profile)
    ? new FreezeProxy(oc.port)
    : undefined;
  let sessionID: string | undefined;
  let held = Promise.withResolvers<void>();
  let holding = false, entered = false, reads = 0, effects = 0;
  let shellReceipt: unknown;
  let clockAborts = 0, stripped = 0, permissionAcceptedAt: number | undefined;
  const assistantMessages = new Set<string>();
  const release = () => {
    holding = false;
    held.resolve();
    freeze?.thaw();
  };
  resources().defer("release native transport scenario", release);
  const proxy = [
      "transport-page",
      "transport-deleted-seen",
      "transport-shell",
      "transport-errors-http",
      "transport-errors-late",
      "transport-enrichment",
    ].includes(profile)
    ? serve(
      { hostname: "127.0.0.1", port: 0, onListen() {} },
      async (request) => {
        const actual = new URL(request.url), url = new URL(request.url);
        url.pathname = browserScenarioPath(oc, url.pathname, request.method);
        if (
          profile === "transport-deleted-seen" && holding && !entered &&
          request.method === "GET" &&
          url.pathname === `/session/${sessionID}` &&
          !url.searchParams.has("directory")
        ) {
          // Hold one owned identity exchange, not every GET of this route:
          // V2 also uses it when preparing DELETE. The released read sees 404.
          reads++;
          entered = true;
          await held.promise;
        }
        if (
          profile === "transport-errors-http" && request.method === "POST" &&
          url.pathname.endsWith("/shell")
        ) {
          effects++;
          return Response.json({
            name: "ProxyFailure",
            data: {
              message: "The shell endpoint is unavailable at this proxy.",
              ref: "proxy-http-only",
            },
          }, { status: 503 });
        }
        if (
          profile === "transport-page" && holding &&
          request.method === "GET" &&
          url.pathname === `/session/${sessionID}/message` &&
          (oc.kind === "opencode-v1" ||
            new URL(request.url).searchParams.get("limit") === "10")
        ) {
          reads++;
          entered = true;
          await held.promise;
        }
        const response = await fetch(
          new Request(oc.url + actual.pathname + actual.search, request),
        );
        if (
          (profile === "transport-shell" ||
            profile === "transport-errors-late") &&
          holding &&
          request.method === "POST" &&
          (url.pathname.endsWith("/shell") ||
            profile === "transport-errors-late" &&
              url.pathname.endsWith("/prompt_async"))
        ) {
          effects++;
          const bytes = await response.arrayBuffer();
          shellReceipt = {
            status: response.status,
            body: new TextDecoder().decode(bytes).slice(0, 8192),
            headers: [...response.headers],
          };
          if (
            profile === "transport-errors-late" &&
            oc.kind === "opencode-v2-server"
          ) {
            const sid = url.pathname.split("/")[2];
            await oc.request(`/session/${sid}/prompt_async`, {
              method: "POST",
              body: {
                agent: "missing-late-http-agent",
                parts: [{ type: "text", text: "Fail at native selection" }],
              },
            });
          }
          entered = true;
          await held.promise;
          // Fetch exposed decoded bytes. A new Response must describe those bytes,
          // not the native wire's gzip representation/length (large cwd crosses it).
          const headers = new Headers(response.headers);
          headers.delete("content-encoding");
          headers.delete("content-length");
          return profile === "transport-errors-late" &&
              oc.kind === "opencode-v2-server"
            ? Response.json({
              message: "The native execution failed",
              ref: "proxy-late-http",
            }, { status: 500 })
            : new Response(response.status === 204 ? null : bytes, {
              status: response.status,
              headers,
            });
        }
        if (profile === "transport-enrichment") {
          if (
            request.method === "GET" &&
            url.pathname.startsWith(`/session/${sessionID}/message/`) &&
            (oc.kind === "opencode-v1" ||
              assistantMessages.has(url.pathname.split("/").at(-1)!))
          ) {
            reads++;
            entered = true;
            request.signal.addEventListener("abort", () => {
              if (holding) clockAborts++;
            }, { once: true });
            if (holding) await held.promise;
          }
          if (url.pathname === "/global/event" && response.body) {
            let pending = "";
            const headers = new Headers(response.headers);
            headers.delete("content-encoding");
            headers.delete("content-length");
            return new Response(
              response.body.pipeThrough(new TextDecoderStream()).pipeThrough(
                new TransformStream<string, string>({
                  transform(chunk, controller) {
                    pending += chunk;
                    let end: number;
                    while ((end = pending.indexOf("\n\n")) >= 0) {
                      const frame = pending.slice(0, end);
                      pending = pending.slice(end + 2);
                      const data = frame.split("\n").filter((line) =>
                        line.startsWith("data:")
                      ).map((line) => line.slice(5).trim()).join("\n");
                      if (!data) {
                        controller.enqueue(frame + "\n\n");
                        continue;
                      }
                      const envelope = JSON.parse(data),
                        event = envelope.payload ?? envelope,
                        part = event.properties?.part;
                      // V2's keyed user-input hydration is essential source I/O,
                      // not optional assistant-clock enrichment.
                      if (
                        event.type === "session.step.started" &&
                        event.data?.sessionID === sessionID &&
                        typeof event.data.assistantMessageID === "string"
                      ) assistantMessages.add(event.data.assistantMessageID);
                      if (event.type === "permission.asked") {
                        permissionAcceptedAt = performance.now();
                      }
                      if (
                        event.type === "message.part.updated" &&
                        part?.sessionID === sessionID &&
                        (part.type === "text" || part.type === "reasoning") &&
                        part.time?.end !== undefined
                      ) {
                        delete part.time.end;
                        stripped++;
                        controller.enqueue(
                          `data: ${JSON.stringify(envelope)}\n\n`,
                        );
                      } else controller.enqueue(frame + "\n\n");
                    }
                  },
                }),
              ).pipeThrough(new TextEncoderStream()),
              { status: response.status, headers },
            );
          }
        }
        return response;
      },
    )
    : undefined;
  if (proxy) {
    resources().defer("native transport proxy", () => proxy.shutdown());
  }
  return {
    port: proxy?.addr.port ?? freeze?.port,
    url: proxy
      ? `http://127.0.0.1:${proxy.addr.port}`
      : freeze
      ? `http://127.0.0.1:${freeze.port}`
      : oc.url,
    observe: () => ({
      holding,
      entered,
      reads,
      effects,
      shellReceipt,
      clockAborts,
      stripped,
      permissionAcceptedAt,
    }),
    control(action: "hold" | "release" | "freeze" | "thaw", id?: string) {
      if (action === "hold") {
        if (!proxy || holding) {
          throw new Error("Scenario cannot acquire another hold");
        }
        sessionID = id;
        held = Promise.withResolvers<void>();
        holding = true;
        entered = false;
      } else if (action === "release") release();
      else {
        if (!freeze) throw new Error("Scenario does not own a freeze proxy");
        if (action === "freeze") freeze.freeze();
        else freeze.thaw();
      }
    },
    release,
    disconnect() {
      if (profile !== "transport-reconnect" || !freeze) {
        throw new Error("Scenario does not own a controlled disconnect");
      }
      freeze.disconnect();
    },
  };
}
