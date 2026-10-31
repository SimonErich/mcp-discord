import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
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

const server = new Server(
  {
    name: "mcp-discord",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Define tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "ping_discord",
        description: "Check if the Discord bot is online and reachable",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === "ping_discord") {
    const isReady = discordClient.isReady();
    return {
      content: [
        {
          type: "text",
          text: `Discord bot status: ${isReady ? "Ready" : "Disconnected"}`,
        },
      ],
    };
  }
  throw new Error(`Tool not found: ${request.params.name}`);
});

const app = express();

// 1. MUST include body parsers for JSON POST requests
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;

// Auth Middleware
app.use((req: Request, res: Response, next) => {
  if (req.path === "/health") return next();
  const authHeader = req.headers.authorization;
  const expectedToken = process.env.MCP_BEARER_TOKEN || "jlABHidjfBWufdhfd88dffdGsgkfa";
  if (authHeader === `Bearer ${expectedToken}`) return next();
  res.setHeader("WWW-Authenticate", 'Bearer realm="mcp"');
  return res.status(401).json({ error: "Unauthorized" });
});

// 2. Multi-session storage to map sessionId to its transport
const transports = new Map<string, SSEServerTransport>();

app.get("/sse", async (req: Request, res: Response) => {
  console.log("New MCP SSE connection handshake initiated");
  
  // Initialize SSE transport specifying the post endpoint path
  const transport = new SSEServerTransport("/message", res);
  transports.set(transport.sessionId, transport);

  transport.onclose = () => {
    transports.delete(transport.sessionId);
  };

  await server.connect(transport);
});

app.post("/message", async (req: Request, res: Response) => {
  const sessionId = req.query.sessionId as string;
  const transport = transports.get(sessionId);

  if (transport) {
    // Pass req.body as the 3rd argument if req body stream has been parsed
    await transport.handlePostMessage(req, res, req.body);
  } else {
    res.status(400).send(`Session not found: ${sessionId}`);
  }
});

app.get("/health", (req: Request, res: Response) => {
  res.status(200).send("OK");
});

app.listen(PORT, () => {
  console.log(`Discord MCP Server running on HTTP port ${PORT}`);
});
