// SPDX-License-Identifier: LGPL-3.0-only
/** Completion of finite I/O readiness; contains no scheduler or database work. */
export async function finiteResponse(value: Response): Promise<Response> {
  const body = await value.arrayBuffer();
  const headers = new Headers(value.headers);
  headers.delete("content-encoding");
  headers.delete("content-length");
  return new Response([204, 205, 304].includes(value.status) ? null : body, {
    status: value.status,
    headers,
  });
}
