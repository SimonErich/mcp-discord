# Discord MCP server

Authenticated HTTP MCP service for Discord. Node 20+ and a Discord bot with View
Channel, Read Message History and Message Content access are required. Sending
also requires Send Messages permission.

## Run

```sh
npm ci
npm run build
node --env-file=.env build/index.js
```

Configure `DISCORD_TOKEN`, `MCP_BEARER_TOKEN`, and optionally `PORT` (default 3000).
The service refuses to start without an MCP Bearer token. Do not put secrets in
URLs, source files or logs. Docker receives secrets through environment variables;
it runs as the non-root `node` user.

- `POST /mcp`: stateless Streamable HTTP, the recommended application endpoint.
- `GET /sse` and `POST /message?sessionId=…`: legacy SSE clients.
- `GET /health`: public liveness only.

MCP requests require `Authorization: Bearer <MCP_BEARER_TOKEN>`. URL username/password
Basic authentication is not supported. Use an HTTPS reverse proxy when hosting.
This server does not implement stdio transport.

## Tools

Existing tools retain their contracts:

- `ping_discord`: bot connectivity status.
- `list_channels`: guild and text-channel names/IDs; optional `guild_id`.
- `read_messages`: recent compact text messages, default 20, maximum 100. This
  legacy tool is not a complete history export.
- `send_message`: explicit channel/content and optional reply target. This task
  did not change its behavior or send any messages; consumers must separately
  control posting authority and mention handling.

Two opt-in tools support complete, bounded collection:

### `get_channel`

Requires `guild_id` and `channel_id`. Returns freshly fetched `id`, `guild_id`,
`name` and `type`. Only standard guild text and announcement channels are accepted.
A mismatched guild is rejected before message retrieval.

### `read_messages_page`

```json
{
  "guild_id": "123456789012345678",
  "channel_id": "223456789012345678",
  "since": "2026-10-25T12:00:00Z",
  "until": "2026-11-01T12:00:00Z",
  "limit": 20,
  "max_bytes": 32768
}
```

Use current timestamps: an interval may span at most seven days plus one hour,
start no earlier than eight days ago, and end no more than five minutes in the
future. The extra hour supports a weekly digest crossing a boundary, not an
archive backfill. Invalid dates, limits, IDs or escaped cursors fail before
message IO. The example dates above are illustrative, not a permanent query.

Each call fetches **one page only**, default 20 messages, hard maximum 50. Results
are newest first. `max_bytes` limits the complete serialized JSON response to
32 KiB by default (2–64 KiB allowed). Messages include stable author IDs, content,
edit timestamps, embeds, attachment metadata and reply references. Attachment
bodies are never downloaded. Messages outside the interval are not returned.

The result contains `channel`, `messages`, `complete`, `next_before` and
`stop_reason` (`page`, `bytes`, `history`, or `window`). When `complete` is false,
pass `next_before` as `before` with the same interval to request another page.
A byte boundary retains whole messages; a single message that cannot fit produces
an explicit error. Empty user/reply messages without embeds or attachments are
rejected because missing Message Content permission can masquerade as empty data.

Clients must impose their own total page/message/byte budgets and must never
interpret a limited page as a complete digest. The server never recursively reads
history and never sends content to an LLM. For AI tools, inspect metadata first,
request small windows, and avoid loading unnecessary old message bodies into context.

## Tests and local image

```sh
npm test
docker build -t discord-mcp:bounded-history .
```

Tests use synthetic messages and an isolated HTTP fixture server without a Discord
bot token. They cover pagination, provenance, byte budgets, old/future windows,
guild identity, duplicate cursors, content permission and the authenticated MCP
transport. A network-isolated, read-only production image was also verified locally.
No real Discord history, send operation or paid AI request is part of these checks.

The reader extension is prepared in this checkout. Rebuild/redeploy the hosted
service separately to expose `get_channel` and `read_messages_page`. Consumers
should verify those tool names before enabling automatic collection; do not fall
back silently to `read_messages`.

Protocol references: [MCP Streamable HTTP](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports)
and [initialization](https://modelcontextprotocol.io/specification/2025-03-26/basic/lifecycle).
