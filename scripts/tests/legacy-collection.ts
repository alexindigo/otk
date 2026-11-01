// SPDX-License-Identifier: LGPL-3.0-only
/** Registration-only collector. Test bodies never run in this process. */
export interface LegacyCase {
  file: string;
  title: string;
}
export async function collectLegacy(files: string[]): Promise<LegacyCase[]> {
  const child = await new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", import.meta.filename!, "--collect", ...files],
    signal: AbortSignal.timeout(120_000),
    stdout: "piped",
    stderr: "inherit",
  }).output();
  if (!child.success) throw new Error("Legacy registration collection failed");
  return JSON.parse(new TextDecoder().decode(child.stdout));
}
if (import.meta.main && Deno.args[0] === "--collect") {
  const cases: LegacyCase[] = [];
  let file = "";
  const register = (...args: unknown[]) => {
    const first = args[0];
    if (
      first && typeof first === "object" &&
      ((first as { ignore?: boolean }).ignore ||
        (first as { only?: boolean }).only)
    ) {
      throw new Error(`Ignored/exclusive legacy proof: ${file}`);
    }
    const title = typeof first === "string"
      ? first
      : typeof first === "function"
      ? first.name
      : (first as { name?: string })?.name;
    if (!title) throw new Error(`Unnamed legacy assertion group: ${file}`);
    cases.push({ file, title });
  };
  Object.defineProperty(Deno, "test", { value: register });
  for (file of Deno.args.slice(1)) {
    await import(new URL(file, `file://${Deno.cwd()}/`).href);
  }
  console.log(JSON.stringify(cases));
}
