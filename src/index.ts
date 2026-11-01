import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import express, { Request, Response } from "express";
import { Client, GatewayIntentBits, type TextBasedChannel } from "discord.js";
import { createHistoryReader, HISTORY_TOOLS } from "./history.js";

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

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

const str = (description: string) => ({ type: "string", description });
const TOOLS = [
  ...HISTORY_TOOLS,
  {
    name: "ping_discord",
    description: "Check if the Discord bot is online and reachable",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "list_channels",
    description: "List guilds the bot is in and their text channels (id, name). Use to find a channel_id.",
    inputSchema: { type: "object", properties: { guild_id: str("Optional: only this guild") } },
  },
  {
    name: "send_message",
    description: "Send a message to a Discord text channel.",
    inputSchema: {
      type: "object",
      properties: {
        channel_id: str("Target channel ID"),
        content: str("Message text (max 2000 chars)"),
        reply_to: str("Optional message ID to reply to"),
      },
      required: ["channel_id", "content"],
    },
  },
  {
    name: "read_messages",
    description: "Read the most recent messages of a text channel.",
    inputSchema: {
      type: "object",
      properties: {
        channel_id: str("Channel ID"),
        limit: { type: "number", description: "1-100, default 20" },
      },
      required: ["channel_id"],
    },
  },
];

async function historyChannel(id: string) {
  if (!discordClient.isReady()) throw new Error("Discord bot is not connected");
  const ch = await discordClient.channels.fetch(id, { force: true, cache: false });
  if (!ch || !ch.isTextBased() || !('guildId' in ch) || ![0, 5].includes(ch.type))
    throw new Error("Expected a guild text or announcement channel");
  return ch;
}
const history = createHistoryReader({
  channel: async (id) => {
    const ch = await historyChannel(id);
    return { id: ch.id, guild_id: ch.guildId, name: ch.name, type: ch.type };
  },
  messages: async (id, options) => {
    const ch = await historyChannel(id);
    const messages = await ch.messages.fetch({ ...options, cache: false });
    return [...messages.values()].map((message) => ({
      id: message.id, channel_id: message.channelId, guild_id: ch.guildId,
      author: { id: message.author.id, username: message.author.username },
      content: message.content, timestamp: message.createdAt.toISOString(),
      edited_timestamp: message.editedAt?.toISOString() ?? null, type: message.type,
      embeds: message.embeds.map((embed) => embed.toJSON()),
      attachments: [...message.attachments.values()].map((a) => ({ id: a.id, filename: a.name, url: a.url })),
      ...(message.reference ? { message_reference: { message_id: message.reference.messageId } } : {}),
    }));
  },
});

async function textChannel(id: unknown): Promise<TextBasedChannel> {
  if (typeof id !== "string" || !id) throw new Error("channel_id is required");
  if (!discordClient.isReady()) throw new Error("Discord bot is not connected (check DISCORD_TOKEN)");
  const ch = await discordClient.channels.fetch(id);
  if (!ch || !ch.isTextBased()) throw new Error(`Channel ${id} not found or not a text channel`);
  return ch;
}

async function callTool(name: string, a: Record<string, any>): Promise<string> {
  switch (name) {
    case "get_channel":
      return JSON.stringify(await history.channel(a));
    case "read_messages_page":
      return JSON.stringify(await history.read(a));
    case "ping_discord":
      return `Discord bot status: ${discordClient.isReady() ? "Ready" : "Disconnected"}`;
    case "list_channels": {
      if (!discordClient.isReady()) throw new Error("Discord bot is not connected (check DISCORD_TOKEN)");
      const guilds = [...discordClient.guilds.cache.values()].filter((g) => !a.guild_id || g.id === a.guild_id);
      return JSON.stringify(
        guilds.map((g) => ({
          guild: { id: g.id, name: g.name },
          channels: [...g.channels.cache.values()]
            .filter((c) => c.isTextBased() && !c.isThread())
            .map((c) => ({ id: c.id, name: c.name })),
        })),
        null,
        2
      );
    }
    case "send_message": {
      const ch = await textChannel(a.channel_id);
      if (!("send" in ch)) throw new Error("Channel does not support sending");
      if (typeof a.content !== "string" || !a.content) throw new Error("content is required");
      const msg = await ch.send({
        content: a.content.slice(0, 2000),
        ...(a.reply_to ? { reply: { messageReference: String(a.reply_to) } } : {}),
      });
      return `Sent message ${msg.id} to channel ${a.channel_id}`;
    }
    case "read_messages": {
      const ch = await textChannel(a.channel_id);
      const limit = Math.min(Math.max(Number(a.limit) || 20, 1), 100);
      const msgs = await ch.messages.fetch({ limit });
      return JSON.stringify(
        [...msgs.values()].reverse().map((m) => ({
          id: m.id,
          author: m.author.username,
          content: m.content,
          timestamp: m.createdAt.toISOString(),
        })),
        null,
        2
      );
    }
    default:
      throw new Error(`Tool not found: ${name}`);
  }
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
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const args = (request.params.arguments ?? {}) as Record<string, any>;
    try {
      return text(await callTool(request.params.name, args));
    } catch (err) {
      return { isError: true, ...text(`Error: ${err instanceof Error ? err.message : String(err)}`) };
    }
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
