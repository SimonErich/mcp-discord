import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
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

// Optional Bearer Token Validation Middleware matching Anthropic Vault
app.use((req: Request, res: Response, next) => {
  if (req.path === "/health") return next();
  
  const authHeader = req.headers.authorization;
  const expectedToken = process.env.MCP_BEARER_TOKEN || "jlABHidjfBWufdhfd88dffdGsgkfa";
  
  if (authHeader === `Bearer ${expectedToken}`) {
    return next();
  }
  
  // If unauthorized, return 401 with standard header challenge
  res.setHeader("WWW-Authenticate", 'Bearer realm="mcp"');
  return res.status(401).json({ error: "Unauthorized" });
});

// Store active SSE transports by session ID or globally for single-tenant
let activeTransport: SSEServerTransport | null = null;

app.get("/sse", async (req: Request, res: Response) => {
  console.log("New MCP SSE connection handshake initiated");
  try {
    activeTransport = new SSEServerTransport("/message", res);
    await server.connect(activeTransport);
  } catch (error) {
    console.error("Failed to connect MCP transport:", error);
    res.status(500).send("MCP Handshake Failed");
  }
});

app.post("/message", async (req: Request, res: Response) => {
  if (activeTransport) {
    await activeTransport.handlePostMessage(req, res);
  } else {
    res.status(400).send("No active SSE session found for message handling.");
  }
});

app.get("/health", (req: Request, res: Response) => {
  res.status(200).send("OK");
});

app.listen(PORT, () => {
  console.log(`Discord MCP Server running on HTTP port ${PORT}`);
});
