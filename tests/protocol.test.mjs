import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';

test('advertises bounded history through the real authenticated MCP transport without a Discord login', async () => {
  const reservation = createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const child = spawn(process.execPath, ['build/index.js'], { stdio: 'ignore', env: {
    ...process.env, DISCORD_TOKEN: '', MCP_BEARER_TOKEN: 'test-only-mcp-token', PORT: String(port),
  } });
  const origin = `http://127.0.0.1:${port}`;
  try {
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      try { ready = (await fetch(`${origin}/health`)).ok; } catch {}
      if (ready) break;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.ok(ready, 'MCP fixture server starts');
    assert.equal((await fetch(`${origin}/mcp`, { method: 'POST' })).status, 401);
    const call = async (method, params, id) => {
      const response = await fetch(`${origin}/mcp`, { method: 'POST', headers: {
        authorization: 'Bearer test-only-mcp-token', 'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      }, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) });
      assert.equal(response.status, 200);
      const body = await response.text();
      const data = response.headers.get('content-type').includes('event-stream')
        ? JSON.parse(body.split('\n').find(line => line.startsWith('data:')).slice(5)) : JSON.parse(body);
      assert.equal(data.id, id);
      return data.result;
    };
    const initialized = await call('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'contract-test', version: '1' } }, 1);
    assert.equal(initialized.protocolVersion, '2025-03-26');
    const tools = (await call('tools/list', {}, 2)).tools;
    assert.ok(tools.some(tool => tool.name === 'read_messages')); // Existing clients retain their contract.
    const history = tools.find(tool => tool.name === 'read_messages_page');
    assert.equal(history.inputSchema.properties.max_bytes.maximum, 65536);
    assert.equal(history.inputSchema.properties.limit.default, 20);
    assert.ok(history.inputSchema.required.includes('since'));
    const invalid = await call('tools/call', { name: 'read_messages_page', arguments: {
      guild_id: '123456789012345678', channel_id: '223456789012345678',
      since: '2020-01-01T00:00:00Z', until: '2020-02-01T00:00:00Z',
    } }, 3);
    assert.equal(invalid.isError, true);
    assert.match(invalid.content[0].text, /historical backfills are disabled/);
  } finally {
    const stopped = once(child, 'exit');
    child.kill('SIGTERM');
    await stopped;
  }
});
