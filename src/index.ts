import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import express, { Request, Response } from "express";
import { Client, GatewayIntentBits } from "discord.js";

const discordClient = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

const token = process.env.DISCORD_TOKEN;
if (token) {
  discordClient.login(token);
}

// A Server instance can only be bound to ONE transport at a time. Connecting a
// shared instance to a second transport silently replaces the first, so earlier
// sessions lose their response channel. Hence: one Server per connection.
function createServer(): Server {
  const server = new Server(
    { name: "mcp-discord", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  // Initialize is handled by the SDK itself; only tool handlers are registered.
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "ping_discord",
        description: "Check if the Discord bot is online and reachable",
        inputSchema: { type: "object", properties: {} },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name === "ping_discord") {
      return {
        content: [
          {
            type: "text",
            text: `Discord bot status: ${discordClient.isReady() ? "Ready" : "Disconnected"}`,
          },
        ],
      };
    }
    throw new Error(`Tool not found: ${request.params.name}`);
  });

  return server;
}

const app = express();
const PORT = process.env.PORT || 3000;

const expectedToken = process.env.MCP_BEARER_TOKEN;
if (!expectedToken) {
  console.error("MCP_BEARER_TOKEN is not set; refusing to start unauthenticated.");
  process.exit(1);
}

app.get("/health", (_req: Request, res: Response) => {
  res.status(200).send("OK");
});

// Auth Middleware
app.use((req: Request, res: Response, next) => {
  if (req.headers.authorization === `Bearer ${expectedToken}`) return next();
  res.setHeader("WWW-Authenticate", 'Bearer realm="mcp"');
  return res.status(401).json({ error: "Unauthorized" });
});

// --- Streamable HTTP (current MCP transport), stateless: POST /mcp ---
// No body parser here: the transport parses the raw request itself.
app.post("/mcp", express.json(), async (req: Request, res: Response) => {
  const server = createServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    transport.close();
    server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("Error handling /mcp request:", err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

const methodNotAllowed = (_req: Request, res: Response) => {
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed." },
    id: null,
  });
};
app.get("/mcp", methodNotAllowed);
app.delete("/mcp", methodNotAllowed);

// --- Legacy HTTP+SSE: GET /sse + POST /message?sessionId=... ---
const transports = new Map<string, SSEServerTransport>();

app.get("/sse", async (_req: Request, res: Response) => {
  // Stop Traefik/nginx from buffering the event stream.
  res.setHeader("X-Accel-Buffering", "no");
  res.setHeader("Cache-Control", "no-cache, no-transform");

  const transport = new SSEServerTransport("/message", res);
  const server = createServer();
  transports.set(transport.sessionId, transport);
  console.log(`SSE session opened: ${transport.sessionId}`);

  res.on("close", () => {
    console.log(`SSE session closed: ${transport.sessionId}`);
    transports.delete(transport.sessionId);
    server.close();
  });

  try {
    await server.connect(transport); // starts the stream and sends the endpoint event
  } catch (err) {
    console.error("Error connecting server to SSE transport:", err);
    transports.delete(transport.sessionId);
  }
});

// Must NOT be preceded by a body parser: handlePostMessage reads the raw stream.
// (If a parser is added globally, pass req.body as the third argument instead.)
app.post("/message", async (req: Request, res: Response) => {
  const sessionId = req.query.sessionId as string;
  const transport = transports.get(sessionId);

  if (!transport) {
    console.error(`Session not found for ID: ${sessionId}`);
    return res.status(404).send(`Session not found: ${sessionId}`);
  }

  try {
    await transport.handlePostMessage(req, res);
  } catch (error) {
    console.error("Error handling POST message:", error);
    if (!res.headersSent) {
      res.status(500).json({ error: "Internal server error handling message" });
    }
  }
});

app.listen(PORT, () => {
  console.log(`Discord MCP Server running on HTTP port ${PORT}`);
});
