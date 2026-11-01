import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHistoryReader } from '../build/history.js';

const now = new Date('2026-11-01T12:00:00Z');
const guild = '772397418091511858', channel = '1566045907097493655';
const snowflake = (date) => ((BigInt(Date.parse(date)) - 1420070400000n) << 22n).toString();
const identity = { id: channel, guild_id: guild, name: '🧠-ai-consulting', type: 0 };
const input = { guild_id: guild, channel_id: channel, since: '2026-10-25T12:00:00Z', until: now.toISOString(), limit: 2 };
const message = (date, content) => ({ id: snowflake(date), channel_id: channel, guild_id: guild,
  author: { id: '123456789012345678', username: 'fixture-bot' }, content, timestamp: date,
  edited_timestamp: null, type: 0, embeds: [{ description: 'Embedded evidence', fields: [{ name: 'Source', value: 'https://example.test/source' }] }],
  attachments: [{ id: '223456789012345678', filename: 'reference.txt', url: 'https://example.test/reference' }],
  message_reference: { message_id: '323456789012345678' },
});

test('pages a bounded interval with full provenance and never returns older message bodies', async () => {
  const rows = [message('2026-10-31T10:03:00Z', 'Third'), message('2026-10-31T10:02:00Z', 'Second'),
    message('2026-10-31T10:01:00Z', 'First'), message('2026-10-01T00:00:00Z', 'OLD CONTENT MUST STAY OUT')];
  const calls = [];
  const reader = createHistoryReader({ now: () => now, channel: async () => identity,
    messages: async (_id, options) => { calls.push(options); return rows.filter(row => BigInt(row.id) < BigInt(options.before)).slice(0, options.limit); } });
  const first = await reader.read(input);
  assert.equal(first.complete, false);
  assert.equal(first.next_before, rows[1].id);
  assert.equal(first.messages[0].author.id, '123456789012345678');
  assert.equal(first.messages[0].embeds[0].description, 'Embedded evidence');
  assert.equal(first.messages[0].attachments[0].filename, 'reference.txt');
  assert.equal(first.messages[0].message_reference.message_id, '323456789012345678');
  assert.equal(first.channel.name, identity.name);
  const second = await reader.read({ ...input, before: first.next_before });
  assert.equal(second.complete, true);
  assert.equal(second.stop_reason, 'window');
  assert.deepEqual(second.messages.map(row => row.content), ['First']);
  assert.equal(second.next_before, null);
  assert.ok(!JSON.stringify(second).includes('OLD CONTENT'));
  assert.ok(calls.every(call => call.limit === 2));
});

test('bounds serialized output without clipping a message, and resumes after the last complete message', async () => {
  const rows = [message('2026-10-31T10:02:00Z', 'A'.repeat(1000)), message('2026-10-31T10:01:00Z', 'B'.repeat(1000))];
  const reader = createHistoryReader({ now: () => now, channel: async () => identity,
    messages: async (_id, options) => rows.filter(row => BigInt(row.id) < BigInt(options.before)).slice(0, options.limit) });
  const first = await reader.read({ ...input, max_bytes: 2048 });
  assert.equal(first.stop_reason, 'bytes');
  assert.equal(first.complete, false);
  assert.equal(first.messages.length, 1);
  assert.equal(first.messages[0].content.length, 1000);
  assert.ok(Buffer.byteLength(JSON.stringify(first)) <= 2048);
  const second = await reader.read({ ...input, max_bytes: 2048, before: first.next_before });
  assert.equal(second.complete, true);
  assert.equal(second.messages[0].content, 'B'.repeat(1000));
  rows[0].content = 'X'.repeat(3000);
  await assert.rejects(reader.read({ ...input, max_bytes: 2048 }), /One complete message/);
});

test('rejects wide, old, future and escaped-cursor reads before Discord IO', async () => {
  let calls = 0;
  const reader = createHistoryReader({ now: () => now, channel: async () => { calls++; return identity; }, messages: async () => [] });
  for (const change of [
    { since: '2026-10-01T00:00:00Z' },
    { since: '2026-10-01T00:00:00Z', until: '2026-10-02T00:00:00Z' },
    { until: '2026-11-02T00:00:00Z' },
    { before: snowflake('2026-10-01T00:00:00Z') },
    { before: snowflake('2026-11-02T00:00:00Z') },
    { limit: 100 }, { limit: -1 }, { max_bytes: 1000000 }, { extra: true },
  ]) await assert.rejects(reader.read({ ...input, ...change }));
  assert.equal(calls, 0);
});

test('rejects wrong guilds and repeated cursors rather than presenting a complete digest', async () => {
  let reads = 0;
  const denied = createHistoryReader({ now: () => now,
    channel: async () => ({ ...identity, guild_id: '123456789012345678' }),
    messages: async () => { reads++; return []; } });
  await assert.rejects(denied.read(input), /specified guild/);
  assert.equal(reads, 0);
  const repeated = message('2026-10-31T10:00:00Z', 'Duplicate');
  const inconsistent = createHistoryReader({ now: () => now, channel: async () => identity,
    messages: async () => [repeated, repeated] });
  await assert.rejects(inconsistent.read(input), /inconsistent/);
});

test('refuses an apparently empty user message when content permission may be missing', async () => {
  const empty = { ...message('2026-10-31T10:00:00Z', ''), embeds: [], attachments: [] };
  const reader = createHistoryReader({ now: () => now, channel: async () => identity, messages: async () => [empty] });
  await assert.rejects(reader.read(input), /content.*unavailable/);
});
