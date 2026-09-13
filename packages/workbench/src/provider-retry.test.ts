import test from 'node:test';
import assert from 'node:assert/strict';
import { CompatibleProvider, ProviderRequestError } from './provider.ts';
import { DEFAULT_MODEL_ID, TOKENROUTER_URL } from './provider-defaults.ts';
const config = { baseUrl: TOKENROUTER_URL, apiKey: 'fixture-secret' };
const answer = () => Response.json({ choices: [{ message: { role: 'assistant', content: 'Ready' }, finish_reason: 'stop' }] });

test('free TokenRouter retries transient rejection with identical model, messages and tools', async () => {
  const bodies: string[] = [];
  const p = new CompatibleProvider(config, async (_url, options) => {
    bodies.push(String(options?.body));
    return bodies.length < 3 ? new Response('secret upstream details', { status: bodies.length === 1 ? 503 : 429, headers: { 'retry-after': '0' } }) : answer();
  });
  const result = await p.complete(DEFAULT_MODEL_ID, [{ role: 'user', content: 'Hello' }], [{ type: 'function', function: { name: 'write', parameters: { type: 'object' } } }], new AbortController().signal);
  assert.equal(result.message.content, 'Ready');
  assert.equal(bodies.length, 3);
  assert.equal(new Set(bodies).size, 1);
  assert.equal(JSON.parse(bodies[0]!).model, DEFAULT_MODEL_ID);
});

test('retry is bounded and excludes paid models, other providers, auth errors and long Retry-After', async () => {
  for (const scenario of [
    { status: 503, expected: 3 },
    { status: 401, expected: 1 },
    { status: 403, expected: 1 },
    { status: 400, expected: 1 },
    { status: 429, wait: '12', expected: 1 },
    { status: 503, model: 'z-ai/glm-5.3', expected: 1 },
    { status: 503, baseUrl: 'https://other.example/v1', expected: 1 },
  ]) {
    let calls = 0;
    const p = new CompatibleProvider({ ...config, baseUrl: scenario.baseUrl ?? config.baseUrl }, async () => {
      calls++;
      return new Response('fixture-secret', { status: scenario.status, headers: { 'retry-after': scenario.wait ?? '0' } });
    });
    await assert.rejects(p.complete(scenario.model ?? DEFAULT_MODEL_ID, [], [], new AbortController().signal), e => e instanceof ProviderRequestError && e.status === scenario.status && !e.message.includes('fixture-secret'));
    assert.equal(calls, scenario.expected);
  }
});

test('cancellation interrupts backoff without a second request', async () => {
  const controller = new AbortController();
  let calls = 0;
  const p = new CompatibleProvider(config, async () => {
    calls++;
    setTimeout(() => controller.abort(), 10);
    return new Response('', { status: 503, headers: { 'retry-after': '5' } });
  });
  await assert.rejects(p.complete(DEFAULT_MODEL_ID, [], [], controller.signal), { name: 'AbortError' });
  assert.equal(calls, 1);
});

test('lost connection and partial streams are never retried', async () => {
  for (const streamed of [false, true]) {
    let calls = 0;
    let visible = '';
    const p = new CompatibleProvider(config, async () => {
      calls++;
      if (!streamed) throw new Error('connection lost');
      return new Response('data: {"choices":[{"delta":{"content":"Partial"}}]}\n\n', { headers: { 'content-type': 'text/event-stream' } });
    });
    await assert.rejects(p.complete(DEFAULT_MODEL_ID, [], [], new AbortController().signal, text => { visible += text; }));
    assert.equal(calls, 1);
    assert.equal(visible, streamed ? 'Partial' : '');
  }
});

test('JSON truncation and reasoning-only answers cannot succeed or dispatch tools', async () => {
  for (const choice of [
    { finish_reason: 'length', message: { role: 'assistant', content: null, tool_calls: [{ id: 'x', type: 'function', function: { name: 'write', arguments: '{}' } }] } },
    { finish_reason: 'content_filter', message: { role: 'assistant', content: 'Partial' } },
    { finish_reason: 'stop', message: { role: 'assistant', content: null, reasoning_content: 'Not an answer' } },
  ]) {
    let calls = 0;
    const p = new CompatibleProvider(config, async () => { calls++; return Response.json({ choices: [choice] }); });
    await assert.rejects(p.complete(DEFAULT_MODEL_ID, [], [], new AbortController().signal), /truncated|no answer/);
    assert.equal(calls, 1);
  }
});
