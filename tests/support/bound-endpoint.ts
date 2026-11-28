// SPDX-License-Identifier: LGPL-3.0-only
import type { ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { bounded } from "./resources.ts";

/** Learn the port from the owning process, not by probing a guessed address. */
export async function announcedEndpoint(
  child: ChildProcess,
  stream: "stdout" | "stderr",
  parse: (line: string) => string | undefined,
  timeout = 60_000,
): Promise<URL> {
  const endpoint = Promise.withResolvers<URL>();
  const output = child[stream]!;
  const decoder = new StringDecoder();
  let pending = "";
  const exited = () =>
    endpoint.reject(
      new Error(
        `Process exited before announcing its listener: ${child.exitCode}/${child.signalCode}`,
      ),
    );
  child.once("close", exited);
  child.once("error", endpoint.reject);
  const data = (chunk: Parameters<StringDecoder["write"]>[0]) => {
    const lines = (pending + decoder.write(chunk)).split("\n");
    pending = lines.pop()!;
    for (const line of lines) {
      const address = parse(line.replace(/\r$/, ""));
      if (!address) continue;
      const url = new URL(address);
      if (url.port && Number(url.port) > 0) endpoint.resolve(url);
    }
  };
  output.on("data", data);
  try {
    if (child.exitCode !== null || child.signalCode !== null) exited();
    return await bounded(
      "owned listener announcement",
      endpoint.promise,
      timeout,
    );
  } finally {
    child.off("close", exited);
    child.off("error", endpoint.reject);
    // Only detach this observer. Closing a readline wrapper pauses the shared
    // pipe and prevents the process log owner from seeing later diagnostics.
    output.off("data", data);
  }
}

/** The shipped HTTP listener logs its actual address on stderr after activation. */
export function otkEndpoint(child: ChildProcess): Promise<URL> {
  return announcedEndpoint(
    child,
    "stderr",
    (line) =>
      /^Listening on (http:\/\/(?:[\w.-]+|\[[\w:.%]+\]):\d+)\/$/.exec(line)
        ?.[1],
  );
}
