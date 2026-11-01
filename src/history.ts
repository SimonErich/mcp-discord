import { z } from "zod";

const snowflake = z.string().regex(/^\d{15,22}$/);
const date = z.string().datetime({ offset: true });
const hour = 3_600_000;
export const historyInputSchema = z.object({
  guild_id: snowflake,
  channel_id: snowflake,
  since: date,
  until: date,
  before: snowflake.optional(),
  limit: z.number().int().min(1).max(50).default(20),
  max_bytes: z.number().int().min(2048).max(65536).default(32768),
}).strict();
export type ChannelIdentity = { id: string; guild_id: string; name: string; type: number };
export type HistoryMessage = {
  id: string; channel_id: string; guild_id: string;
  author: { id: string; username: string };
  content: string; timestamp: string; edited_timestamp: string | null; type: number;
  embeds: unknown[];
  attachments: { id: string; filename: string; url: string }[];
  message_reference?: { message_id?: string };
};
type Dependencies = {
  channel: (id: string) => Promise<ChannelIdentity>;
  messages: (id: string, options: { limit: number; before: string }) => Promise<HistoryMessage[]>;
  now?: () => Date;
};
type Page = {
  channel: ChannelIdentity;
  messages: HistoryMessage[];
  complete: boolean;
  next_before: string | null;
  stop_reason: "page" | "bytes" | "history" | "window";
};
const cursorAt = (time: number) => (BigInt(time) - 1420070400000n) << 22n;

export function createHistoryReader(deps: Dependencies) {
  async function channel(input: unknown) {
    const expected = z.object({ guild_id: snowflake, channel_id: snowflake }).strict().parse(input);
    const actual = await deps.channel(expected.channel_id);
    if (actual.id !== expected.channel_id || actual.guild_id !== expected.guild_id || ![0, 5].includes(actual.type))
      throw new Error("Expected a text or announcement channel in the specified guild");
    return actual;
  }
  return {
    channel,
    async read(input: unknown): Promise<Page> {
      const args = historyInputSchema.parse(input);
      const since = Date.parse(args.since), until = Date.parse(args.until);
      const now = (deps.now?.() ?? new Date()).getTime();
      // Seven days plus one hour for a digest crossing the weekly boundary.
      if (since >= until || until - since > 7 * 24 * hour + hour || since < now - 8 * 24 * hour || until > now + 5 * 60_000)
        throw new Error("Use a recent window of at most seven days plus one hour; historical backfills are disabled");
      const before = args.before ? BigInt(args.before) : cursorAt(until);
      if (before > cursorAt(until) || before < cursorAt(since))
        throw new Error("Pagination cursor must stay inside the requested time window");
      const identity = await channel({ guild_id: args.guild_id, channel_id: args.channel_id });
      if (before === cursorAt(since))
        return { channel: identity, messages: [], complete: true, next_before: null, stop_reason: "window" };
      const fetched = await deps.messages(identity.id, { before: before.toString(), limit: args.limit });
      if (fetched.length > args.limit) throw new Error("Discord returned more messages than requested");
      const ordered = [...fetched].sort((a, b) => BigInt(a.id) > BigInt(b.id) ? -1 : 1);
      const result: Page = { channel: identity, messages: [], complete: false, next_before: null, stop_reason: "page" };
      let previous = before;
      for (const message of ordered) {
        const messageId = BigInt(snowflake.parse(message.id));
        const at = Date.parse(date.parse(message.timestamp));
        if (message.channel_id !== identity.id || message.guild_id !== identity.guild_id || messageId >= previous || at >= until)
          throw new Error("Discord returned an inconsistent channel, cursor or timestamp");
        previous = messageId;
        if (at < since) {
          result.complete = true;
          result.stop_reason = "window";
          result.next_before = null;
          return result;
        }
        if (!message.content && !message.embeds.length && !message.attachments.length && [0, 19].includes(message.type))
          throw new Error("Discord message content is unavailable; check message-content permission");
        const next: Page = { ...result, messages: [...result.messages, message], next_before: message.id };
        // Reserve the longest completion label too; metadata must fit the same byte cap.
        if (Buffer.byteLength(JSON.stringify({ ...next, stop_reason: "history" }), "utf8") > args.max_bytes) {
          if (!result.messages.length) throw new Error("One complete message exceeds max_bytes; increase the explicit budget or review it separately");
          result.stop_reason = "bytes";
          return result;
        }
        result.messages.push(message);
        result.next_before = message.id;
      }
      if (fetched.length < args.limit) {
        result.complete = true;
        result.stop_reason = "history";
        result.next_before = null;
      }
      return result;
    },
  };
}

const idProperty = { type: "string", pattern: "^\\d{15,22}$" };
export const HISTORY_TOOLS = [
  {
    name: "get_channel",
    description: "Read fresh identity metadata for one text channel in an explicitly specified guild. No messages are read.",
    inputSchema: { type: "object", additionalProperties: false,
      properties: { guild_id: idProperty, channel_id: idProperty }, required: ["guild_id", "channel_id"] },
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  {
    name: "read_messages_page",
    description: "Read one bounded page of recent complete messages with embeds, attachments and provenance. Requires since/until, at most seven days plus one hour. Newest first; follow next_before only when complete=false. Never follow cursors automatically. Keep max_bytes and page counts small to control AI context. No historical backfills.",
    inputSchema: { type: "object", additionalProperties: false, properties: {
      guild_id: idProperty, channel_id: idProperty,
      since: { type: "string", format: "date-time" }, until: { type: "string", format: "date-time" },
      before: idProperty,
      limit: { type: "integer", minimum: 1, maximum: 50, default: 20 },
      max_bytes: { type: "integer", minimum: 2048, maximum: 65536, default: 32768 },
    }, required: ["guild_id", "channel_id", "since", "until"] },
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
];
