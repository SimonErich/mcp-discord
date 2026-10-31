import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import express from "express";
import { Client, GatewayIntentBits } from "discord.js";

// 1. Initialize Discord Client
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

// 2. Initialize MCP Server instance
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

// Define your MCP tools / prompts here
// Example tool registration:
// server.setRequestHandler(...)

// 3. Set up Express HTTP Web Server for Dokploy / Traefik
const app = express();
const PORT = process.env.PORT || 3000;

let transport: SSEServerTransport | null = null;

// Endpoint for establishing SSE connection
app.get("/sse", async (req, res) => {
  console.log("New SSE connection received");
  transport = new SSEServerTransport("/message", res);
  await server.connect(transport);
});

// Endpoint for receiving client messages
app.post("/message", async (req, res) => {
  if (transport) {
    await transport.handlePostMessage(req, res);
  } else {
    res.status(400).send("No active SSE session found");
  }
});

// Health check endpoint for Dokploy
app.get("/health", (req, res) => {
  res.status(200).send("OK");
});

app.listen(PORT, () => {
  console.log(`Discord MCP Server listening on HTTP port ${PORT}`);
});
