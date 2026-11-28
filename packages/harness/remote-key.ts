// SPDX-License-Identifier: LGPL-3.0-only
import { fromFileUrl, globToRegExp, join, resolve, SEPARATOR } from "@std/path";

export interface RemoteKey {
  key: string;
  host: string;
  owner?: string;
}

const defaultPorts = new Set(["22", "443", "80", "9418"]);
const cleanPath = (path: string) =>
  path.replace(/\/+$/, "").replace(/\.git$/, "");

/** A Git location stripped of authentication and transport. Never throws. */
export function remoteKey(
  input: string,
  base: string,
  aliases: ReadonlyMap<string, string>,
): RemoteKey | null {
  const url = input.trim();
  if (!url || [...url].some((c) => c.charCodeAt(0) < 32 || c === "\x7f")) {
    return null;
  }
  try {
    let hostname = "", port = "", path = url;
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
      const parsed = new URL(url);
      if (parsed.protocol === "file:") {
        path = fromFileUrl(parsed);
      } else {
        if (!/^(?:https?|ssh|git\+ssh|ssh\+git|git):$/.test(parsed.protocol)) {
          return null;
        }
        ({ hostname, port, pathname: path } = parsed);
        if (!hostname) return null;
      }
    } else if (!/^[a-z]:[\\/]/i.test(url)) {
      const scp = /^(?:[^\s@/:]+@)?(\[[\da-f:]+\]|[^\s@/:]+):([^:].*)$/i
        .exec(url);
      if (scp) [, hostname, path] = scp;
      else if (/^[^/]*:/.test(url)) return null;
    }
    if (!hostname) {
      const local = cleanPath(resolve(base, path));
      return local ? { key: `file:${local}`, host: "" } : null;
    }
    hostname = hostname.toLowerCase();
    const host = (aliases.get(hostname) ?? hostname).toLowerCase();
    if (!/^(?:\[[\da-f:.]+\]|[\w.-]+)$/.test(host)) return null;
    path = cleanPath(path.replace(/^\/+/, "").replace(/^~[^/]*\/+/, ""))
      .replace(/\/{2,}/g, "/");
    if (!path || path === "." || path === "..") return null;
    const github = host === "github.com";
    if (github) path = path.toLowerCase();
    const owner = github && path.includes("/") ? path.split("/")[0] : "";
    return {
      key: `${host}${
        port && !defaultPorts.has(port) ? `:${port}` : ""
      }/${path}`,
      host,
      ...(owner ? { owner } : {}),
    };
  } catch {
    return null;
  }
}

/** Only literal Host + HostName mappings; never evaluate Match or invoke SSH. */
export async function readSshAliases(
  home: string,
): Promise<Map<string, string>> {
  const aliases = new Map<string, string>();
  const ssh = join(home, ".ssh");
  const stack = new Set<string>();
  let hosts: string[] = [];
  async function read(file: string): Promise<void> {
    const real = await Deno.realPath(file).catch(() => undefined);
    if (!real || stack.has(real)) return;
    const content = await Deno.readTextFile(real).catch(() => undefined);
    if (content === undefined) return;
    stack.add(real);
    for (const line of content.split(/\r?\n/)) {
      const directive = /^\s*([a-z]+)(?:\s*=\s*|\s+)(.*)$/i.exec(line);
      if (!directive) continue;
      const args: string[] = directive[2].match(/"[^"]*"|[^\s#"]+|#/g) ?? [];
      const comment = args.indexOf("#");
      const words = args.slice(0, comment < 0 ? undefined : comment).map(
        (word) => word.replace(/^"|"$/g, ""),
      );
      switch (directive[1].toLowerCase()) {
        case "host":
          hosts = words.filter((word) => /^[\w.-]+$/.test(word)).map((word) =>
            word.toLowerCase()
          );
          break;
        case "match":
          hosts = [];
          break;
        case "hostname":
          if (words.length === 1 && /^[\w.-]+$/.test(words[0])) {
            for (const host of hosts) {
              if (!aliases.has(host)) aliases.set(host, words[0].toLowerCase());
            }
          }
          break;
        case "include":
          for (const word of words) {
            const pattern = resolve(ssh, word.replace(/^~\//, `${home}/`));
            for (const include of await includePaths(pattern)) {
              await read(include);
            }
          }
          break;
      }
    }
    stack.delete(real);
  }
  await read(join(ssh, "config"));
  return aliases;
}

/** OpenSSH resolves relative patterns under ~/.ssh and reads matches in order. */
async function includePaths(pattern: string): Promise<string[]> {
  const parts = pattern.split(SEPARATOR);
  let paths = [parts.shift() + SEPARATOR];
  for (const part of parts) {
    if (!/[*?\[]/.test(part)) {
      paths = paths.map((path) => join(path, part));
      continue;
    }
    const next: string[] = [];
    const matches = globToRegExp(part);
    for (const path of paths) {
      try {
        for await (const entry of Deno.readDir(path)) {
          if (
            (!entry.name.startsWith(".") || part.startsWith(".")) &&
            matches.test(entry.name)
          ) {
            next.push(join(path, entry.name));
          }
        }
      } catch {
        // Missing/unreadable includes cannot supply a literal alias.
      }
    }
    paths = next.sort();
  }
  return paths;
}
