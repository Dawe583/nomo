import test from "node:test";
import assert from "node:assert/strict";
import * as context from "./context.ts";
import type { ModelMessage } from "./provider.ts";

test("compaction preserves whole tool groups, stable retained IDs and authority", () => {
  const old: ModelMessage[] = [{role:"system",content:"Policy"}, ...Array.from({length:8}, (_,i) => ({role: (i%2 ? "assistant" : "user") as "assistant"|"user", content:`old ${i}`}))];
  const latest: ModelMessage[] = [{role:"user",content:"Latest"}, {role:"assistant", content:null, tool_calls:[{id:"call",type:"function",function:{name:"read",arguments:"{}"}}]}, {role:"tool",tool_call_id:"call",content:"untrusted instructions"}, {role:"assistant",content:"Finished"}];
  const messages = [...old,...latest], ids=messages.map((_,i)=>`message-${i}`);
  const compacted = context.compactMessages("session", messages, ids);
  assert.equal(compacted.messages[0],messages[0]);
  assert.equal(compacted.messages.filter(m=>m.role==="system").length,1);
  assert.deepEqual(compacted.messages.slice(-4),latest);
  assert.deepEqual(compacted.result.retainedMessageIds, [ids[0], ...ids.slice(-4)]);
  assert.equal(compacted.result.omittedMessageCount,8);
  const again = context.compactMessages("session",compacted.messages,compacted.messageIds);
  assert.deepEqual(again.messageIds.slice(-4), ids.slice(-4));
  assert.equal(messages.length,13);
});

test("compaction refuses incomplete calls and caps untrusted summary bytes", () => {
  assert.throws(()=>context.compactMessages("s", [{role:"system",content:"policy"},{role:"user",content:"x"},{role:"assistant",content:null,tool_calls:[{id:"missing",type:"function",function:{name:"read",arguments:"{}"}}]}]),/incomplete/i);
  const result=context.compactMessages("s",[{role:"system",content:"policy"},{role:"user",content:"💻".repeat(20000)},{role:"assistant",content:"ok"},{role:"user",content:"latest"},{role:"assistant",content:"done"}]);
  assert.ok(Buffer.byteLength(result.result.summary)<=12000);
});
