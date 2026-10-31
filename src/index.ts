import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import express, { Request, Response, NextFunction } from "express";
import { Client, GatewayIntentBits } from "discord.js";

const discordClient = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

const token = process.env.DISCORD_TOKEN;
if (!token) {
  console.error("Error: DISCORD_TOKEN environment variable is missing.");
  process.exit(1);
}

discordClient.login(token);

discordClient.once("ready", () => {
  console.log(`Discord bot is ready! Logged in as ${discordClient.user?.tag}`);
});

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

const app = express();
const PORT = process.env.PORT || 3000;

// Bearer Token Authentication Middleware for Anthropic Vault
app.use((req: Request, res: Response, next: NextFunction) => {
  if (req.path === "/health") {
    return next(); // Keep health check open for Dokploy monitoring
  }
  
  const authHeader = req.headers.authorization;
  const expectedToken = process.env.MCP_BEARER_TOKEN || "jlABHidjfBWufdhfd88dffdGsgkfa";
  
  if (authHeader === `Bearer ${expectedToken}`) {
    return next();
  }
  
  return res.status(401).json({ error: "Unauthorized: Invalid or missing Bearer token" });
});

let transport: SSEServerTransport | null = null;

app.get("/sse", async (req: Request, res: Response) => {
  console.log("New SSE connection received");
  transport = new SSEServerTransport("/message", res);
  await server.connect(transport);
});

app.post("/message", async (req: Request, res: Response) => {
  if (transport) {
    await transport.handlePostMessage(req, res);
  } else {
    res.status(400).send("No active SSE session found");
  }
});

app.get("/health", (req: Request, res: Response) => {
  res.status(200).send("OK");
});

app.listen(PORT, () => {
  console.log(`Discord MCP Server listening on HTTP port ${PORT}`);
});
