import test from 'node:test';
import assert from 'node:assert/strict';
import { CompatibleProvider } from './provider.ts';
test('Anthropic models, native tool messages and usage share the agent interface', async () => {
  let requestBody: Record<string, unknown> = {};
  const provider = new CompatibleProvider({ baseUrl: 'https://api.anthropic.com/v1', apiKey: 'secret', kind: 'anthropic' }, async (url, options) => {
    assert.equal((options?.headers as Record<string, string>)['x-api-key'], 'secret');
    assert.equal((options?.headers as Record<string, string>).authorization, undefined);
    if (new URL(String(url)).pathname.endsWith('/models')) return Response.json({ data: [{ id: 'claude-fixture', type: 'model', display_name: 'Claude fixture' }], has_more: false, last_id: 'claude-fixture' });
    assert.ok(String(url).endsWith('/messages'));
    requestBody = JSON.parse(String(options?.body));
    return Response.json({ content: [{ type: 'text', text: 'Writing.' }, { type: 'tool_use', id: 'toolu_1', name: 'tool_0', input: { path: 'plan.md', content: 'Plan' } }], stop_reason: 'tool_use', usage: { input_tokens: 20, output_tokens: 10 } });
  });
  assert.equal((await provider.models())[0]?.name, 'Claude fixture');
  const result = await provider.complete('claude-fixture', [
    { role: 'system', content: 'Respect NOMO.' }, { role: 'user', content: 'Write a plan.' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'old', type: 'function', function: { name: 'tool_0', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'old', content: 'Done' },
  ], [{ type: 'function', function: { name: 'tool_0', description: 'Write', parameters: { type: 'object' } } }], new AbortController().signal);
  assert.equal(requestBody.stream, undefined);
  assert.equal(requestBody.system, 'Respect NOMO.');
  assert.deepEqual((requestBody.messages as Array<{ content: unknown }>).at(-1)?.content, [{ type: 'tool_result', tool_use_id: 'old', content: 'Done' }]);
  assert.equal(result.message.tool_calls?.[0]?.function.arguments, '{"path":"plan.md","content":"Plan"}');
  assert.equal(result.usage?.total_tokens, 30);
});
test('Anthropic streams text, fragmented tool input and final usage through the agent interface', async () => {
  const events = [
    { type: 'message_start', message: { content: [], usage: { input_tokens: 12, output_tokens: 0 } } },
    { type: 'ping' },
    { type: 'future_event', metadata: 'ignored safely' },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hel' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'lo fixture-' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'secret' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_stream', name: 'read_file', input: {} } },
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"path":' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '"README.md"}' } },
    { type: 'content_block_stop', index: 1 },
    { type: 'content_block_start', index: 2, content_block: { type: 'thinking', thinking: '' } },
    { type: 'content_block_delta', index: 2, delta: { type: 'thinking_delta', thinking: 'hidden reasoning' } },
    { type: 'content_block_delta', index: 2, delta: { type: 'signature_delta', signature: 'hidden signature' } },
    { type: 'content_block_stop', index: 2 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 4 } },
    { type: 'message_stop' },
  ];
  const payload = events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
  let requestBody: Record<string, unknown> = {};
  let acceptHeader: string | undefined;
  const provider = new CompatibleProvider(
    { baseUrl: 'https://api.anthropic.com/v1', apiKey: 'fixture-secret', kind: 'anthropic' },
    async (url, options) => {
      assert.ok(String(url).endsWith('/messages'));
      requestBody = JSON.parse(String(options?.body));
      acceptHeader = (options?.headers as Record<string, string>).accept;
      return new Response(payload, { headers: { 'content-type': 'text/event-stream' } });
    },
  );
  const deltas: string[] = [];
  const result = await provider.complete(
    'claude-fixture',
    [{ role: 'user', content: 'Read the file.' }],
    [{ type: 'function', function: { name: 'read_file', description: 'Read', parameters: { type: 'object' } } }],
    new AbortController().signal,
    text => { deltas.push(text); },
  );

  assert.equal(requestBody.stream, true);
  assert.equal(acceptHeader, 'text/event-stream');
  assert.equal(deltas.join(''), 'Hello [redacted]');
  assert.equal(result.message.content, 'Hello fixture-secret');
  assert.deepEqual(result.message.tool_calls, [{
    id: 'toolu_stream',
    type: 'function',
    function: { name: 'read_file', arguments: '{"path":"README.md"}' },
  }]);
  assert.deepEqual(result.usage, { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 });
});
test('Anthropic rejects streamed truncation and streams without message_stop', async () => {
  const response = (payload: string) => new Response(payload, { headers: { 'content-type': 'text/event-stream' } });
  const createProvider = (payload: string) => new CompatibleProvider(
    { baseUrl: 'https://api.anthropic.com/v1', apiKey: 'fixture-secret', kind: 'anthropic' },
    async () => response(payload),
  );
  const truncated = [
    { type: 'message_start', message: { content: [], usage: { input_tokens: 1, output_tokens: 0 } } },
    { type: 'message_delta', delta: { stop_reason: 'max_tokens' }, usage: { output_tokens: 2 } },
    { type: 'message_stop' },
  ].map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
  await assert.rejects(
    createProvider(truncated).complete('claude-fixture', [{ role: 'user', content: 'Continue.' }], [], new AbortController().signal, () => {}),
    /max_tokens|truncated/i,
  );

  const incomplete = `event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { content: [], usage: { input_tokens: 1, output_tokens: 0 } } })}\n\n`;
  await assert.rejects(
    createProvider(incomplete).complete('claude-fixture', [{ role: 'user', content: 'Continue.' }], [], new AbortController().signal, () => {}),
    /stream failed|message_stop/i,
  );
  const errorEvent = `event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'Provider detail.' } })}\n\n`;
  await assert.rejects(
    createProvider(errorEvent).complete('claude-fixture', [{ role: 'user', content: 'Continue.' }], [], new AbortController().signal, () => {}),
    error => error instanceof Error && error.message === 'Anthropic stream failed before completion.',
  );

  const lateContent = [
    { type: 'message_start', message: { content: [], usage: { input_tokens: 1, output_tokens: 0 } } },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'late content' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_stop' },
  ].map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
  await assert.rejects(
    createProvider(lateContent).complete('claude-fixture', [{ role: 'user', content: 'Answer.' }], [], new AbortController().signal, () => {}),
    /stream failed|message_stop/i,
  );
});

test('Anthropic stream cancellation interrupts a pending body read', async () => {
  const controller = new AbortController();
  let readStarted!: () => void;
  const pendingRead = new Promise<void>(resolve => { readStarted = resolve; });
  const provider = new CompatibleProvider(
    { baseUrl: 'https://api.anthropic.com/v1', apiKey: 'fixture-secret', kind: 'anthropic' },
    async (_url, options) => {
      const requestSignal = options?.signal as AbortSignal;
      const body = new ReadableStream<Uint8Array>({
        start(stream) {
          requestSignal.addEventListener('abort', () => stream.error(new Error('transport aborted')), { once: true });
        },
        pull() {
          readStarted();
        },
      });
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
    },
  );
  const pending = provider.complete(
    'claude-fixture',
    [{ role: 'user', content: 'Cancel this request.' }],
    [],
    controller.signal,
    () => {},
  );
  await pendingRead;
  controller.abort();
  await assert.rejects(pending, /Session cancelled/);
});

test('Anthropic groups ordered results for multiple tool calls into one user message', async () => {
  let requestBody: Record<string, unknown> = {};
  const provider = new CompatibleProvider(
    { baseUrl: 'https://api.anthropic.com/v1', apiKey: 'fixture-secret', kind: 'anthropic' },
    async (url, options) => {
      assert.ok(String(url).endsWith('/messages'));
      requestBody = JSON.parse(String(options?.body));
      return Response.json({
        content: [{ type: 'text', text: 'Finished.' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 2, output_tokens: 1 },
      });
    },
  );

  await provider.complete(
    'claude-fixture',
    [
      { role: 'user', content: 'Find both.' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'call-a', type: 'function', function: { name: 'lookup_a', arguments: '{"key":"a"}' } },
          { id: 'call-b', type: 'function', function: { name: 'lookup_b', arguments: '{"key":"b"}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'call-a', content: 'First result.' },
      { role: 'tool', tool_call_id: 'call-b', content: 'Second result.' },
    ],
    [],
    new AbortController().signal,
  );

  assert.deepEqual(requestBody.messages, [
    { role: 'user', content: 'Find both.' },
    {
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 'call-a', name: 'lookup_a', input: { key: 'a' } },
        { type: 'tool_use', id: 'call-b', name: 'lookup_b', input: { key: 'b' } },
      ],
    },
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'call-a', content: 'First result.' },
        { type: 'tool_result', tool_use_id: 'call-b', content: 'Second result.' },
      ],
    },
  ]);
});

test('Anthropic rejects max-token responses instead of returning truncated text or tool calls', async () => {
  const provider = new CompatibleProvider(
    { baseUrl: 'https://api.anthropic.com/v1', apiKey: 'fixture-secret', kind: 'anthropic' },
    async () => Response.json({
      content: [
        { type: 'text', text: 'Partial answer' },
        { type: 'tool_use', id: 'partial-call', name: 'lookup', input: { key: 'unfinished' } },
      ],
      stop_reason: 'max_tokens',
      usage: { input_tokens: 2, output_tokens: 3 },
    }),
  );

  await assert.rejects(
    provider.complete('claude-fixture', [{ role: 'user', content: 'Answer and use tools if needed.' }], [], new AbortController().signal),
    /max_tokens|truncat/i,
  );
});

test('Anthropic rejects responses that exceeded the model context window', async () => {
  const provider = new CompatibleProvider(
    { baseUrl: 'https://api.anthropic.com/v1', apiKey: 'fixture-secret', kind: 'anthropic' },
    async () => Response.json({
      content: [{ type: 'text', text: 'Incomplete answer' }],
      stop_reason: 'model_context_window_exceeded',
    }),
  );

  await assert.rejects(
    provider.complete('claude-fixture', [{ role: 'user', content: 'Answer this.' }], [], new AbortController().signal),
    /model_context_window_exceeded|context window/i,
  );
});
test('Anthropic rejects pause_turn responses that require a continuation round-trip', async () => {
  const provider = new CompatibleProvider(
    { baseUrl: 'https://api.anthropic.com/v1', apiKey: 'fixture-secret', kind: 'anthropic' },
    async () => Response.json({
      content: [
        { type: 'text', text: 'Partial answer' },
        { type: 'tool_use', id: 'continuation-call', name: 'lookup', input: { key: 'unfinished' } },
      ],
      stop_reason: 'pause_turn',
    }),
  );

  await assert.rejects(
    provider.complete('claude-fixture', [{ role: 'user', content: 'Answer this.' }], [], new AbortController().signal),
    /pause_turn|paused|incomplete/i,
  );
});

test('Anthropic rejects missing or unrecognized terminal stop reasons', async () => {
  for (const result of [
    { content: [{ type: 'text', text: 'Complete-looking answer' }] },
    { content: [{ type: 'text', text: 'Complete-looking answer' }], stop_reason: 'future_reason' },
  ]) {
    const provider = new CompatibleProvider(
      { baseUrl: 'https://api.anthropic.com/v1', apiKey: 'fixture-secret', kind: 'anthropic' },
      async () => Response.json(result),
    );

    await assert.rejects(
      provider.complete('claude-fixture', [{ role: 'user', content: 'Answer this.' }], [], new AbortController().signal),
      /stop_reason|terminal/i,
    );
  }
});

test('an OpenAI-compatible stream keeps the cost the provider reports', async () => {
  // The harness always streams, so a cost mapped only in the buffered path
  // would leave the score board unmeasured on the path it actually uses.
  const frames = [
    { choices: [{ index: 0, delta: { content: 'ready' }, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    { choices: [], usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6, cost: 0.0011 } },
  ];
  const payload = frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join('') + 'data: [DONE]\n\n';
  const provider = new CompatibleProvider(
    { baseUrl: 'https://zen.test/v1', apiKey: 'fixture-secret', kind: 'compatible' },
    async () => new Response(payload, { headers: { 'content-type': 'text/event-stream' } }),
  );
  const deltas: string[] = [];
  const result = await provider.complete(
    'muse-spark-1.3-contributor-free',
    [{ role: 'user', content: 'say ready' }],
    [],
    new AbortController().signal,
    (text) => { deltas.push(text); },
  );

  assert.equal(deltas.join(''), 'ready');
  assert.equal(result.usage?.total_tokens, 6);
  assert.equal(result.usage?.cost_usd, 0.0011);
});
