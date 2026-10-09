// SPDX-License-Identifier: LGPL-3.0-only
// Stock opencode speaks LSP over this fixture's framed stdio transport.
const diagnostic = {
  severity: 1,
  message: "fixture diagnostic",
  range: { start: { line: 0, character: 2 }, end: { line: 0, character: 5 } },
};
async function send(message: unknown) {
  const body = new TextEncoder().encode(JSON.stringify(message));
  const header = new TextEncoder().encode(
    `Content-Length: ${body.length}\r\n\r\n`,
  );
  await Deno.stdout.write(header);
  await Deno.stdout.write(body);
}
let buffer = new Uint8Array();
const chunk = new Uint8Array(65536);
while (true) {
  const n = await Deno.stdin.read(chunk);
  if (n === null) break;
  const next = new Uint8Array(buffer.length + n);
  next.set(buffer);
  next.set(chunk.subarray(0, n), buffer.length);
  buffer = next;
  while (true) {
    const headerEnd = new TextDecoder().decode(buffer).indexOf("\r\n\r\n");
    if (headerEnd < 0) break;
    const header = new TextDecoder().decode(buffer.subarray(0, headerEnd));
    const length = Number(/Content-Length:\s*(\d+)/i.exec(header)![1]);
    if (buffer.length < headerEnd + 4 + length) break;
    const message = JSON.parse(
      new TextDecoder().decode(
        buffer.subarray(headerEnd + 4, headerEnd + 4 + length),
      ),
    );
    buffer = buffer.slice(headerEnd + 4 + length);
    if (message.id !== undefined) {
      const result = message.method === "initialize"
        ? {
          capabilities: {
            textDocumentSync: 1,
            diagnosticProvider: {
              interFileDependencies: false,
              workspaceDiagnostics: false,
            },
          },
        }
        : message.method === "textDocument/diagnostic"
        ? { kind: "full", items: [diagnostic] }
        : null;
      await send({ jsonrpc: "2.0", id: message.id, result });
    } else if (
      message.method === "textDocument/didOpen" ||
      message.method === "textDocument/didChange"
    ) {
      await send({
        jsonrpc: "2.0",
        method: "textDocument/publishDiagnostics",
        params: {
          uri: message.params.textDocument.uri,
          diagnostics: [diagnostic],
        },
      });
    } else if (message.method === "exit") Deno.exit();
  }
}
