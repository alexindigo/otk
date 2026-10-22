// SPDX-License-Identifier: LGPL-3.0-only
import { resources } from "./resources.ts";
// Stateless streamable HTTP fixture: stock opencode owns the actual MCP client.
export class McpFixture {
  requests: { method: string; params?: Record<string, unknown> }[] = [];
  server: Deno.HttpServer;
  url: string;
  #stop: () => Promise<void>;
  constructor() {
    const scope = resources();
    this.server = Deno.serve(
      { hostname: "127.0.0.1", port: 0, onListen() {} },
      async (request) => {
        if (request.method !== "POST") {
          return new Response(null, {
            status: 405,
          });
        }
        const body = await request.json();
        this.requests.push(body);
        if (body.id === undefined) return new Response(null, { status: 202 });
        let result: unknown;
        switch (body.method) {
          case "initialize":
            result = {
              protocolVersion: body.params.protocolVersion,
              capabilities: { resources: {}, prompts: {}, tools: {} },
              serverInfo: { name: "OTK fixture", version: "1.0.0" },
            };
            break;
          case "tools/list":
            result = { tools: [] };
            break;
          case "resources/list":
            result = {
              resources: [{
                name: "specification",
                uri: "otk-fixture://specification",
                mimeType: "text/plain",
                description: "Fixture resource",
              }],
            };
            break;
          case "resources/templates/list":
            result = { resourceTemplates: [] };
            break;
          case "resources/read":
            result = {
              contents: [{
                uri: body.params.uri,
                mimeType: "text/plain",
                text: "MCP fixture specification bytes",
              }],
            };
            break;
          case "prompts/list":
            result = {
              prompts: [{
                name: "fixture-prompt",
                description: "Local MCP prompt",
                arguments: [{ name: "topic", required: true }],
              }],
            };
            break;
          case "prompts/get":
            result = {
              messages: [{
                role: "user",
                content: {
                  type: "text",
                  text: `MCP prompt topic: ${
                    body.params.arguments?.topic || ""
                  }`,
                },
              }],
            };
            break;
          case "ping":
            result = {};
            break;
          default:
            return Response.json({
              jsonrpc: "2.0",
              id: body.id,
              error: { code: -32601, message: "Unknown fixture method" },
            });
        }
        return Response.json({ jsonrpc: "2.0", id: body.id, result });
      },
    );
    this.url = `http://127.0.0.1:${
      (this.server.addr as Deno.NetAddr).port
    }/mcp`;
    this.#stop = scope.defer("MCP fixture", () => this.server.shutdown());
  }
  stop() {
    return this.#stop();
  }
}
