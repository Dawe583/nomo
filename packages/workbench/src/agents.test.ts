import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,rm,readFile,writeFile,access} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {setTimeout as delay} from "node:timers/promises";
import {Workbench} from "./index.ts";
import {validateHook} from "./agents.ts";
import * as agents from "./agents.ts";
import type {ModelMessage} from "./provider.ts";

const profile={id:"custom",name:"Custom",systemPrompt:"Only inspect",allowedTools:["void_workspace_list"],policyProfile:"default",maxTurns:2,maxContextTokens:8192};
async function fixture(t:import("node:test").TestContext,fetcher:typeof fetch,hookCommands:string[]=[],hookTimeoutMs?:number){
 const directory=await mkdtemp(join(tmpdir(),"nomo-agent-profile-"));
 // The allowlist is supplied the way an operator supplies it: in the runtime
 // environment the launcher passes, never on the workbench API surface.
 const env:{NOMO_DATA_DIR:string;NOMO_HOOK_COMMANDS:string;NOMO_HOOK_TIMEOUT_MS?:string}={
  NOMO_DATA_DIR:directory,
  NOMO_HOOK_COMMANDS:JSON.stringify(hookCommands),
  ...(hookTimeoutMs===undefined?{}:{NOMO_HOOK_TIMEOUT_MS:String(hookTimeoutMs)}),
 };
 let app=new Workbench(env,fetcher);
 await app.configure({baseUrl:"https://fixture.test/v1",apiKey:"fixture"});
 t.after(async()=>{await app.shutdown();await rm(directory,{recursive:true,force:true});});
 return {get app(){return app;},restart(){app.close();app=new Workbench(env,fetcher);}};
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
 // Wait for the hold on a wall-clock deadline, not a fixed iteration count.
 // Reaching the hold costs an ed25519 keygen, a signed ledger append and a
 // policy decision, which costs ~370ms on an idle machine and grows with CPU
 // contention; a 100 x 5ms budget expires first under load, and the assertion
 // below then reports a policy refusal that never happened. The property under
 // test is that the mutation stops at the hold, not that it stops quickly, so
 // the wait is bounded generously and the assertions themselves are unchanged.
 const holdDeadline=Date.now()+10000;
 while(!f.app.pending().length&&f.app.get(session.id)?.status==="running"&&Date.now()<holdDeadline)await delay(5);
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

// A hook is a real process, so these tests spawn real ones. Each command is a
// Node script written into the fixture directory; the marker file it touches is
// how a test proves a process ran, and its absence is how a test proves one
// did not — an assertion on a thrown Error alone would pass just as well
// against an implementation that never spawns anything at all.
async function hookScript(directory:string,name:string,body:string){
 const path=join(directory,`${name}.mjs`);
 await writeFile(path,body);
 // Quoted, because `hookArgv` splits on whitespace unless a path is quoted and a
// stock Windows Node lives under `C:\Program Files\nodejs`. Unquoted, this
// helper only works on a host whose Node path happens to contain no space.
 return `"${process.execPath}" ${path}`;
}
const marker=(path:string)=>`import{writeFileSync}from"node:fs";writeFileSync(${JSON.stringify(path)},"ran");`;
async function wasRun(path:string){return access(path).then(()=>true,()=>false);}

test("only an allowlisted hook command executes, and its stdout reaches the caller",async t=>{
 const directory=await mkdtemp(join(tmpdir(),"nomo-hook-allowlist-"));
 const ran=join(directory,"ran.txt"),blocked=join(directory,"blocked.txt");
 // The allowlisted command writes a marker and prints a token; the command
 // that is NOT on the allowlist writes a different marker, so a test can tell
 // "rejected" apart from "rejected and quietly executed anyway".
 const allowed=await hookScript(directory,"allowed",`${marker(ran)}process.stdout.write("hook-said-hello");`);
 const denied=await hookScript(directory,"denied",marker(blocked));
 t.after(()=>rm(directory,{recursive:true,force:true}));
 const f=await fixture(t,async url=>String(url).endsWith("/models")?models():response(),[allowed,denied].slice(0,1));
 assert.deepEqual(f.app.agents().hookCommands,[allowed]);
 // The refused command is rejected at the door and never becomes a process.
 assert.throws(()=>f.app.upsertHook({id:"denied",event:"before-run",command:denied,enabled:true}),/allowlist/);
 assert.equal(await wasRun(blocked),false);
 // The allowlisted one is accepted, persists, and reports hooksSupported.
 f.app.upsertHook({id:"allowed",event:"after-run",command:allowed,enabled:true});
 assert.equal(f.app.agents().hooksSupported,true);
 assert.equal(f.app.agents().hooks[0]?.command,allowed);
 const result=await agents.runHook(f.app.agents().hooks[0]!);
 assert.equal(result.outcome,"exited");
 assert.equal(result.stdout,"hook-said-hello");
 assert.equal(await wasRun(ran),true);
 // The caller cannot widen the allowlist by asking, or by sending one in the
 // request body: the list is the runtime's and the request is only ever
 // validated against it.
 assert.throws(()=>f.app.upsertHook({id:"self",event:"after-run",command:"rm -rf /",enabled:true,hookCommands:["rm -rf /"]}),/allowlist/);
 assert.deepEqual(f.app.agents().hookCommands,[allowed]);
});

test("a before-run hook that exits non-zero prevents the run",async t=>{
 const directory=await mkdtemp(join(tmpdir(),"nomo-hook-gate-"));
 const ran=join(directory,"ran.txt");
 const command=await hookScript(directory,"refuse",`${marker(ran)}process.stderr.write("policy check failed");process.exit(3);`);
 t.after(()=>rm(directory,{recursive:true,force:true}));
 let providerCalls=0;
 const f=await fixture(t,async url=>{
  if(String(url).endsWith("/models"))return models();
  providerCalls++;return response();
 },[command]);
 f.app.upsertHook({id:"gate",event:"before-run",command,enabled:true});
 const session=await f.app.start("Run","fixture");await f.app.settled();
 // The direction chosen is fail closed: a gate that did not open does not
 // become a pass. The run never reaches the provider, the session ends
 // "failed", and the refusal names the hook rather than reading as success.
 assert.equal(providerCalls,0);
 assert.equal(await wasRun(ran),true);
 assert.equal(f.app.get(session.id)?.status,"failed");
 assert.match(f.app.get(session.id)!.events.find(e=>e.kind==="error")!.text,/Hook gate refused this run/);
 assert.equal(f.app.get(session.id)!.events.some(e=>e.type==="hook.result"),true);
});

test("a disabled hook does not execute",async t=>{
 const directory=await mkdtemp(join(tmpdir(),"nomo-hook-disabled-"));
 const ran=join(directory,"ran.txt");
 const command=await hookScript(directory,"off",marker(ran));
 t.after(()=>rm(directory,{recursive:true,force:true}));
 const f=await fixture(t,async url=>String(url).endsWith("/models")?models():response(),[command]);
 f.app.upsertHook({id:"off",event:"before-run",command,enabled:false});
 const session=await f.app.start("Run","fixture");await f.app.settled();
 assert.equal(await wasRun(ran),false);
 assert.equal(f.app.get(session.id)?.status,"idle");
 // The refusal is in the runner as well as at the call site, so no caller can
 // run a disabled hook by accident.
 assert.equal((await agents.runHook({id:"off",event:"before-run",command,enabled:false})).outcome,"disabled");
});

test("a hook that never exits is killed and does not hang the run",async t=>{
 const directory=await mkdtemp(join(tmpdir(),"nomo-hook-timeout-"));
 // The child never ends on its own; there is no event to await and no fake
 // clock that can kill a real process. The bound under test is the runner's
 // own wall-clock kill, so a real deadline is the thing being exercised.
 const command=await hookScript(directory,"hang","setInterval(()=>{},1000);");
 t.after(()=>rm(directory,{recursive:true,force:true}));
 const f=await fixture(t,async url=>String(url).endsWith("/models")?models():response(),[command],300);
 f.app.upsertHook({id:"hang",event:"before-run",command,enabled:true});
 const began=Date.now();
 const session=await f.app.start("Run","fixture");await f.app.settled();
 const elapsed=Date.now()-began;
 // Bounded twice over: the operator's 300ms applies to the run, and the
 // assertion proves the loop returned on its own rather than waiting on a
 // process that will never end. The generous ceiling is a flake guard, not
 // the expected value — a hung runner would sit here until node's own timeout.
 assert.equal(f.app.get(session.id)?.status,"failed");
 assert.ok(elapsed<15_000,`run took ${elapsed}ms`);
 const result=await agents.runHook({id:"hang",event:"before-run",command,enabled:true},{},{timeoutMs:150});
 assert.equal(result.outcome,"timeout");
 assert.ok(result.durationMs<10_000,`hook ran ${result.durationMs}ms`);
});

test("an after-tool hook receives the tool name, the decision and the outcome",async t=>{
 const directory=await mkdtemp(join(tmpdir(),"nomo-hook-aftertool-"));
 const seen=join(directory,"seen.json");
 // The hook reads its context from stdin and writes it back, so the assertion
 // is on what the hook actually received rather than on what we meant to send.
 const command=await hookScript(directory,"observe",
   `import{writeFileSync}from"node:fs";let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>writeFileSync(${JSON.stringify(seen)},b));`);
 t.after(()=>rm(directory,{recursive:true,force:true}));
 let calls=0;
 const f=await fixture(t,async(url,init)=>{
  if(String(url).endsWith("/models"))return models();
  if(++calls>1)return response();
  const body=JSON.parse(String(init?.body));
  return Response.json({choices:[{message:{role:"assistant",content:null,tool_calls:[{id:"read",type:"function",function:{name:body.tools[0].function.name,arguments:"{}"}}]}}]});
 },[command]);
 f.app.upsertAgent({...profile,id:"observer",maxTurns:2});
 f.app.upsertHook({id:"watch",event:"after-tool",command,enabled:true});
 await f.app.start("Read","fixture",undefined,undefined,"observer");await f.app.settled();
 const context=JSON.parse(await readFile(seen,"utf8")) as Record<string,unknown>;
 assert.equal(context.tool,"void_workspace_list");
 assert.equal(context.NOMO_HOOK_TOOL,"void_workspace_list");
 assert.equal(context.NOMO_HOOK_EVENT,"after-tool");
 // The decision and the outcome are both present and both meaningful: a
 // reader downstream can tell a refusal from a completion without guessing.
 assert.equal(typeof context.decision,"string");
 assert.equal(context.NOMO_HOOK_DECISION,context.decision);
 assert.equal(context.outcome,"completed");
 assert.equal(context.NOMO_HOOK_OUTCOME,"completed");
});
