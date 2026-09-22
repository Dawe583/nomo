import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {setTimeout as delay} from "node:timers/promises";
import {Workbench} from "./index.ts";
import {validateHook} from "./agents.ts";
import type {ModelMessage} from "./provider.ts";

const profile={id:"custom",name:"Custom",systemPrompt:"Only inspect",allowedTools:["void_workspace_list"],policyProfile:"default",maxTurns:2,maxContextTokens:8192};
async function fixture(t:import("node:test").TestContext,fetcher:typeof fetch){
 const directory=await mkdtemp(join(tmpdir(),"void-agent-profile-"));
 let app=new Workbench({VOID_DATA_DIR:directory},fetcher);
 await app.configure({baseUrl:"https://fixture.test/v1",apiKey:"fixture"});
 t.after(async()=>{await app.shutdown();await rm(directory,{recursive:true,force:true});});
 return {get app(){return app;},restart(){app.close();app=new Workbench({VOID_DATA_DIR:directory},fetcher);}};
}
const models=()=>Response.json({data:[{id:"fixture"}]});
const response=()=>Response.json({choices:[{message:{role:"assistant",content:"Done"}}]});

test("custom profiles retain immutable session snapshots and filter executable tools",async t=>{
 let messages:ModelMessage[]=[], tools:Array<{function:{description:string}}>=[];
 const f=await fixture(t,async(url,init)=>{
  if(String(url).endsWith("/models"))return models();
  const body=JSON.parse(String(init?.body));messages=body.messages;tools=body.tools;return response();
 });
 f.app.upsertAgent(profile);
 const session=await f.app.start("Inspect","fixture",undefined,undefined,"custom");await f.app.settled();
 assert.equal(tools.length,1);assert.match(tools[0]!.function.description,/^void_workspace_list:/);
 assert.match(messages[0]!.content!,/Only inspect/);
 f.app.upsertAgent({...profile,systemPrompt:"New instruction",allowedTools:["void_workspace_write"]});
 f.restart();f.app.send(session.id,"Continue");await f.app.settled();
 assert.equal(tools.length,1);assert.match(tools[0]!.function.description,/^void_workspace_list:/);
 assert.match(messages[0]!.content!,/Only inspect/);
 assert.equal(f.app.agents().profiles[0]?.systemPrompt,"New instruction");
 assert.throws(()=>f.app.upsertAgent({...profile,policyProfile:"bypass"}),/policy/i);
 assert.throws(()=>f.app.upsertAgent({...profile,allowedTools:["not-configured"]}),/tool/i);
 assert.throws(()=>f.app.upsertAgent({...profile,maxTurns:21}),/maxTurns/i);
 const copy=f.app.agents().profiles[0]!;copy.allowedTools.push("unauthorized");
 assert.equal(f.app.agents().profiles[0]?.allowedTools.includes("unauthorized"),false);
});

test("custom turn and context bounds stop before extra provider calls",async t=>{
 let calls=0;
 const f=await fixture(t,async(url,init)=>{
  if(String(url).endsWith("/models"))return models();
  calls++;const body=JSON.parse(String(init?.body));
  return Response.json({choices:[{message:{role:"assistant",content:null,tool_calls:[{id:"read",type:"function",function:{name:body.tools[0].function.name,arguments:"{}"}}]}}]});
 });
 f.app.upsertAgent({...profile,maxTurns:1});
 const session=await f.app.start("Inspect","fixture",undefined,undefined,"custom");await f.app.settled();
 assert.equal(calls,1);assert.equal(f.app.get(session.id)?.status,"failed");
 assert.match(f.app.get(session.id)!.events.find(e=>e.kind==="error")!.text,/1-turn/);
 f.app.upsertAgent({...profile,id:"tiny",maxContextTokens:4096});
 const tiny=await f.app.start("Inspect","fixture",undefined,undefined,"tiny");await f.app.settled();
 assert.equal(calls,1);assert.equal(f.app.get(tiny.id)?.status,"failed");
 assert.match(f.app.get(tiny.id)!.events.find(e=>e.kind==="error")!.text,/context/i);
});

test("custom document mutations still require existing policy approval",async t=>{
 let calls=0;
 const f=await fixture(t,async(url,init)=>{
  if(String(url).endsWith("/models"))return models();
  if(++calls>1)return response();
  const body=JSON.parse(String(init?.body));return Response.json({choices:[{message:{role:"assistant",content:null,tool_calls:[{id:"write",type:"function",function:{name:body.tools[0].function.name,arguments:JSON.stringify({path:"note",content:"requested"})}}]}}]});
 });
 f.app.upsertAgent({...profile,allowedTools:["void_workspace_write"]});
 const session=await f.app.start("Write","fixture",undefined,undefined,"custom");
 for(let attempt=0;attempt<100&&!f.app.pending().length&&f.app.get(session.id)?.status==="running";attempt++)await delay(5);
 assert.equal(f.app.pending().length,1);assert.equal(f.app.document(session.id,"note").content,null);
 const hold=f.app.pending()[0]!;assert.equal(f.app.decide(hold.holdId,{kind:"denied",by:"test-operator"}),true);
 await f.app.settled();assert.equal(f.app.document(session.id,"note").content,null);
});

test("hook validation requires an exact explicit command allowlist",()=>{
 const hook={id:"hook",event:"after-run",command:"echo done",enabled:true};
 assert.throws(()=>validateHook(hook),/allowlist/);
 assert.deepEqual(validateHook(hook,["echo done"]),hook);
 assert.throws(()=>validateHook({...hook,command:"echo done; other"},["echo done"]),/allowlist/);
 assert.throws(()=>validateHook(hook,["echo"]),/allowlist/);
});

test("compaction metadata survives restart without rewriting ledger evidence",async t=>{
 const f=await fixture(t,async url=>String(url).endsWith("/models")?models():response());
 const session=await f.app.start("One","fixture");await f.app.settled();
 f.app.send(session.id,"Two");await f.app.settled();
 const evidence=await f.app.ledger(session.workspace),result=f.app.compact(session.id);
 f.restart();assert.deepEqual(f.app.get(session.id)?.compaction,result);
 assert.equal(f.app.get(session.id)?.contextMessages,4);
 assert.equal(f.app.list()[0]?.contextMessages,4);
 assert.equal(f.app.sessionPage(new URLSearchParams()).items[0]?.contextMessages,4);
 assert.deepEqual(await f.app.ledger(session.workspace),evidence);
});
