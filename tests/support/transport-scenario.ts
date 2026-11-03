// SPDX-License-Identifier: LGPL-3.0-only
import { serve } from "./http.ts";
import { resources } from "./resources.ts";
import { FreezeProxy } from "./freeze-proxy.ts";
import type { OpencodeTest } from "./opencode.ts";
import type { Profile } from "./fixture-control.ts";

/** Native-side faults belong to the Deno fixture, never browser routing. */
export function transportScenario(oc: OpencodeTest, profile: Profile) {
  const freeze = profile === "transport-freeze"
    ? new FreezeProxy(oc.port)
    : undefined;
  let sessionID: string | undefined;
  let held = Promise.withResolvers<void>();
  let holding = false, entered = false, reads = 0, effects = 0;
  let shellReceipt: unknown;
  let clockAborts = 0, stripped = 0, permissionAcceptedAt: number | undefined;
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
        const url = new URL(request.url);
        if (
          profile === "transport-deleted-seen" && holding &&
          request.method === "GET" &&
          url.pathname === `/session/${sessionID}` &&
          !url.searchParams.has("directory")
        ) {
          // Identity validation has no cached-directory query. Hold before the
          // real native read so DELETE wins and the released lookup returns 404.
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
          url.pathname === `/session/${sessionID}/message`
        ) {
          reads++;
          entered = true;
          await held.promise;
        }
        const response = await fetch(
          new Request(oc.url + url.pathname + url.search, request),
        );
        if (
          (profile === "transport-shell" ||
            profile === "transport-errors-late") &&
          holding &&
          request.method === "POST" && url.pathname.endsWith("/shell")
        ) {
          effects++;
          const bytes = await response.arrayBuffer();
          shellReceipt = {
            status: response.status,
            body: new TextDecoder().decode(bytes).slice(0, 8192),
            headers: [...response.headers],
          };
          entered = true;
          await held.promise;
          // Fetch exposed decoded bytes. A new Response must describe those bytes,
          // not the native wire's gzip representation/length (large cwd crosses it).
          const headers = new Headers(response.headers);
          headers.delete("content-encoding");
          headers.delete("content-length");
          return new Response(bytes, { status: response.status, headers });
        }
        if (profile === "transport-enrichment") {
          if (
            request.method === "GET" &&
            url.pathname.startsWith(`/session/${sessionID}/message/`)
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
  };
}
