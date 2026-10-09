// SPDX-License-Identifier: LGPL-3.0-only
/** A filesystem candidate is a match only while its metadata is readable. */
export async function statMatch(
  path: string,
): Promise<Deno.FileInfo | undefined> {
  try {
    return await Deno.stat(path);
  } catch {
    return undefined;
  }
}
