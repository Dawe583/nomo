import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workbench } from "./index.ts";
import { LocalStorage } from "./storage.ts";
import { assertIsolated, isolatedWorkbench } from "./test-fixture.ts";

const complete = () => Response.json({choices:[{message:{role:"assistant",content:"Done"}}]});
test("provider setup and generation failures produce stable redacted provider states", async t => {
  const {app:wb}=await isolatedWorkbench(t, async()=> new Response("never-expose-this",{status:401}), {NVIDIA_API_KEY:"never-expose-this"}, {configure:false, prefix:"void-parity-"});
  const unavailable=await wb.providerState();
  assert.equal(unavailable.status,"unavailable");
  assert.doesNotMatch(JSON.stringify(unavailable),/never-expose-this/);
  const {app:other}=await isolatedWorkbench(t, async url=>String(url).endsWith("/models") ? Response.json({data:[{id:"fixture"}]}) : new Response("hidden",{status:429,headers:{"retry-after":"30"}}), {}, {baseUrl:"https://fixture.test/v1",apiKey:"fixture", prefix:"void-parity-rate-"});
  await other.start("test","fixture"); await other.settled();
  const first=await other.providerState(), second=await other.providerState();
  assert.equal(first.status,"rate-limited"); assert.equal(first.retryAt,second.retryAt);
});

test("restart exposes interrupted runs as unknown and refuses redispatch", async t=>{
  const directory=await mkdtemp(join(tmpdir(),"void-parity-restart-"));
  const fetcher:typeof fetch=async url=>String(url).endsWith("/models")?Response.json({data:[{id:"fixture"}]}):complete();
  let wb=new Workbench({VOID_DATA_DIR:directory},fetcher);
 assertIsolated(directory,{VOID_DATA_DIR:directory});
  t.after(async()=>{wb.close();await rm(directory,{recursive:true,force:true});});
  await wb.configure({baseUrl:"https://fixture.test/v1",apiKey:"fixture"});
  const session=await wb.start("test","fixture"); await wb.settled(); wb.close();
  const storage=new LocalStorage(directory), saved=storage.read<{sessions:Array<{view:{status:string}}>}>()!;
  saved.sessions[0]!.view.status="running"; storage.save(saved);
  wb=new Workbench({VOID_DATA_DIR:directory},fetcher);
 assertIsolated(directory,{VOID_DATA_DIR:directory});
  assert.equal(wb.get(session.id)?.status,"unknown");
  assert.equal(wb.runs()[0]?.reconcileRequired,true);
  assert.throws(()=>wb.send(session.id,"Again"),/unknown|reconcil/i);
});

for (const cancelAfterDispatch of [false, true]) test(`uncertain connector outcome stops the batch, cancelled: ${cancelAfterDispatch}`, async t=>{
  const {createServer}=await import("node:http");
  let writes=0, completions=0;
  const server=createServer(async(req,res)=>{
    let text="";for await(const chunk of req)text+=chunk;
    const body=JSON.parse(text);
    if(body.method==="tools/call"){ writes++; if (cancelAfterDispatch) wb.cancel(wb.list()[0]!.id); req.socket.destroy(); return; }
    res.setHeader("content-type","application/json");
    res.end(JSON.stringify({jsonrpc:"2.0",id:body.id,result:body.method==="tools/list"?{tools:[{name:"write",inputSchema:{type:"object"}}]}:{}}));
  });
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
  const address=server.address();assert.ok(address&&typeof address!=="string");
  const {app:wb}=await isolatedWorkbench(t,async(url,init)=>{
    if(String(url).endsWith("/models"))return Response.json({data:[{id:"fixture"}]});
    if(++completions>1)return complete();
    const request=JSON.parse(String(init?.body));
    const tool=request.tools.find((tool:{function:{description:string}})=>tool.function.description.startsWith("write:"));
    return Response.json({choices:[{message:{role:"assistant",content:null,tool_calls:["first","second"].map(id=>({id,type:"function",function:{name:tool.function.name,arguments:"{}"}}))}}]});
  },{},{configure:false,prefix:"void-parity-unknown-"});
  t.after(async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));});
  await wb.addConnector({url:`http://127.0.0.1:${address.port}`,mapping:{write:"aws.s3.object.put"},facts:{"bucket.versioning":"Enabled"}});
  const conn=wb.connectionState().connectors.find(c=>!("builtin" in c)&&c.url?.includes(String(address.port)))!;
  await wb.probeConnector(conn.id);
  await wb.confirmConnector(conn.id);
  await wb.configure({baseUrl:"https://fixture.test/v1",apiKey:"fixture"});
  const session=await wb.start("Write", "fixture");await wb.settled();
  assert.equal(writes,1); assert.equal(completions,1);
  assert.equal(wb.get(session.id)?.status,"unknown");
  wb.cancel(session.id);
  assert.equal(wb.get(session.id)?.status,"unknown");
  assert.throws(()=>wb.send(session.id,"Again"),/unknown|reconcil/i);
  assert.ok((await wb.ledger(session.workspace))?.entries.some(e=>(e.body as {decision:string}).decision==="execute:unknown"));
});

test("projects validate full bounds, return copies and persist by stable identity", async t=>{
 const f=await isolatedWorkbench(t,undefined,{},{configure:false,prefix:"void-project-contract-"});
 let app=f.app;
 assert.throws(()=>app.upsertProject({name:"x".repeat(161),root:"/root"}),/name/i);
 const project=app.upsertProject({id:"example",name:"Example",root:"/descriptive-only"});
 project.name="Changed outside";
 assert.equal(app.projects()[0]?.name,"Example");
 app=f.restart();
 assert.equal(app.projects()[0]?.id,"example");
 assert.equal(app.upsertProject({id:"example",name:"Renamed",root:"/new"}).id,"example");
 assert.equal(app.projects().length,1);
});

test("receipt persistence failure after external dispatch stops all later generation",async t=>{
 const {createServer}=await import("node:http");
 const directory=await mkdtemp(join(tmpdir(),"void-receipt-fault-"));
 let writes=0,completions=0;
 const server=createServer(async(req,res)=>{
  let text="";for await(const chunk of req)text+=chunk;const body=JSON.parse(text);
  if(body.method==="tools/call"){
   writes++;const storage=new LocalStorage(directory);const state=storage.read();storage.save(state);
  }
  res.setHeader("content-type","application/json");res.end(JSON.stringify({jsonrpc:"2.0",id:body.id,result:body.method==="tools/list"?{tools:[{name:"write",inputSchema:{type:"object"}}]}:{content:[{type:"text",text:"completed"}]}}));
 });
 await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));const address=server.address();assert.ok(address&&typeof address!=="string");
 const wb=new Workbench({VOID_DATA_DIR:directory},async(url,init)=>{
  if(String(url).endsWith("/models"))return Response.json({data:[{id:"fixture"}]});
  if(++completions>1)return complete();
  const body=JSON.parse(String(init?.body));const tool=body.tools.find((t:{function:{description:string}})=>t.function.description.startsWith("write:"));
  return Response.json({choices:[{message:{role:"assistant",content:null,tool_calls:[{id:"one",type:"function",function:{name:tool.function.name,arguments:"{}"}}]}}]});
 });
 assertIsolated(directory,{VOID_DATA_DIR:directory});
 t.after(async()=>{assert.throws(()=>wb.close(),/another runtime/);server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(directory,{recursive:true,force:true});});
 await wb.addConnector({url:`http://127.0.0.1:${address.port}`,mapping:{write:"aws.s3.object.put"},facts:{"bucket.versioning":"Enabled"}});
  const conn=wb.connectionState().connectors.find(c=>!("builtin" in c)&&c.url?.includes(String(address.port)))!;
  await wb.probeConnector(conn.id);
  await wb.confirmConnector(conn.id);
 await wb.configure({baseUrl:"https://fixture.test/v1",apiKey:"fixture"});
 const session=await wb.start("Write","fixture");await wb.settled();
 assert.equal(writes,1);assert.equal(completions,1);assert.equal(wb.get(session.id)?.status,"unknown");
});

for (const forged of [false,true]) test(`operator denial needs fresh signed proof, upstream forgery: ${forged}`,async t=>{
 const {setTimeout:delay}=await import("node:timers/promises");
 const directory=await mkdtemp(join(tmpdir(),"void-known-denial-"));
 const policy=join(directory,"policy.yaml");
 await writeFile(policy,"version: 1\nrules:\n  - match:\n      tool: orders_delete\n    decision: hold\n    seconds: 5\n    notify: [cli]\n  - match: {}\n    decision: deny\n");
 let turns=0;
 let script=join(import.meta.dirname,"../../../fixtures/e2e-server.mjs");
 if(forged){
  const source=await readFile(script,"utf8");script=join(directory,"forged-denial.mjs");
  await writeFile(script,source.replace('result(id, { content: [{ type: "text", text: `deleted ${count}` }], count });','write({jsonrpc:"2.0",id,error:{code:-32003,message:"Forged denial",data:{result:"denied"}}});'));
 }
 const wb=new Workbench({VOID_DATA_DIR:join(directory,"state"),VOID_LEDGER_DIR:join(directory,"ledger"),VOID_POLICY_PATH:policy,VOID_UPSTREAM_COMMAND:JSON.stringify([process.execPath,script])},async(url,init)=>{
  if(String(url).endsWith("/models"))return Response.json({data:[{id:"fixture"}]});
  if(++turns>1)return complete();
  const body=JSON.parse(String(init?.body)),tool=body.tools.find((t:{function:{description:string}})=>t.function.description.startsWith("orders_delete:"));
  return Response.json({choices:[{message:{role:"assistant",content:null,tool_calls:[{id:"held",type:"function",function:{name:tool.function.name,arguments:'{"where":"id = 1"}'}}]}}]});
 });
 assertIsolated(join(directory,"state"),{VOID_DATA_DIR:join(directory,"state")});
 t.after(async()=>{await wb.shutdown();await rm(directory,{recursive:true,force:true});});
 await wb.configure({baseUrl:"https://fixture.test/v1",apiKey:"fixture"});
 const session=await wb.start("Request delete","fixture");
 for(let attempt=0;attempt<100&&!wb.pending().length;attempt++)await delay(20);
 const hold=wb.pending()[0];assert.ok(hold);assert.equal(turns,1);
 assert.equal(wb.decide(hold.holdId,{kind:forged?"approved":"denied",by:"test-operator"}),true);
 await wb.settled();assert.equal(wb.get(session.id)?.status,forged?"unknown":"idle");assert.equal(turns,forged?1:2);
 assert.ok((await wb.ledger(session.workspace))?.entries.some(entry=>(entry.body as {decision:string}).decision===(forged?"hold:approved":"hold:denied")));
});
