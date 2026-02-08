import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { NextFunction, Request, Response } from "express";
import type { McpServer } from "skybridge/server";

/**
 * Express middleware that handles the /mcp endpoint using StreamableHTTP.
 *
 * Stateless mode (sessionIdGenerator: undefined) — the SDK requires
 * calling close() on the previous transport before reconnecting.
 */
export const mcp =
  (server: McpServer) => {
    // Track the current transport so we can close it before reconnecting
    let currentTransport: StreamableHTTPServerTransport | null = null;

    return async (req: Request, res: Response, next: NextFunction) => {
      if (req.path !== "/mcp") {
        return next();
      }

      if (req.method === "POST") {
        try {
          // Close previous transport if exists (SDK requires this)
          if (currentTransport) {
            try {
              await currentTransport.close();
            } catch {
              // Ignore close errors on stale transports
            }
          }

          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: undefined,
          });
          currentTransport = transport;

          await server.connect(transport);
          await transport.handleRequest(req, res, req.body);
        } catch (error) {
          console.error("[MCP] Error handling request:", error);
          if (!res.headersSent) {
            res.status(500).json({
              jsonrpc: "2.0",
              error: { code: -32603, message: "Internal server error" },
              id: null,
            });
          }
        }
      } else if (req.method === "GET" || req.method === "DELETE") {
        res.writeHead(405).end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32000, message: "Method not allowed." },
            id: null,
          }),
        );
      } else {
        next();
      }
    };
  };
