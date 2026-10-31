import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { ListToolsRequestSchema, CallToolRequestSchema, InitializeRequestSchema } from "@modelcontextprotocol/sdk/types.js";
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

const transports = new Map<string, SSEServerTransport>();

app.get("/sse", async (req: Request, res: Response) => {
  console.log("New MCP SSE connection handshake initiated");
  
  const transport = new SSEServerTransport("/message", res);
  transports.set(transport.sessionId, transport);

  transport.onclose = () => {
    console.log(`Transport closed for session: ${transport.sessionId}`);
    transports.delete(transport.sessionId);
  };

  try {
    await server.connect(transport);
  } catch (err) {
    console.error("Error connecting server to transport:", err);
  }
});

app.post("/message", async (req: Request, res: Response) => {
  const sessionId = req.query.sessionId as string;
  const transport = transports.get(sessionId);

  if (!transport) {
    console.error(`Session not found for ID: ${sessionId}`);
    return res.status(400).send(`Session not found: ${sessionId}`);
  }

  try {
    await transport.handlePostMessage(req, res, req.body);
  } catch (error) {
    console.error("Error handling POST message:", error);
    if (!res.headersSent) {
      res.status(500).json({ error: "Internal server error handling message" });
    }
  }
});

app.get("/health", (req: Request, res: Response) => {
  res.status(200).send("OK");
});

app.listen(PORT, () => {
  console.log(`Discord MCP Server running on HTTP port ${PORT}`);
});
