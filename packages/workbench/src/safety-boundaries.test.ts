import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { rm, rename } from "node:fs/promises";
import { join } from "node:path";
import { isolatedWorkbench } from "./test-fixture.ts";
import { LocalStorage } from "./storage.ts";
import { activity } from "./gui.ts";

async function fixture(t:TestContext) {
 let calls=0;
 const fetcher:typeof fetch=async url=>{
  if(String(url).endsWith("/models"))return Response.json({data:[{id:"fixture"}]});
  calls++;return Response.json({choices:[{message:{role:"assistant",content:"Done"}}]});
 };
 const f=await isolatedWorkbench(t,fetcher,{},{prefix:"void-undo-boundary-"});
 const session=await f.app.start("Review","fixture");await f.app.settled();
 return {get app(){return f.app;},directory:f.root,session,calls:()=>calls,restart(options?:{keepOpen?:boolean}){return f.restart(options);}};
}
async function paused(t:TestContext) {
 const f=await fixture(t);
 const document=await f.app.editDocument(f.session.id,{path:"note",content:"one",expectedRevision:null});
 const plan=await f.app.planRecoveryJob(f.session.id,{jobId:"paused",selection:{kind:"operations",operationIds:[document.revision!]}});
 const vault=join(f.directory,"recovery","vault"),backup=join(f.directory,"saved-vault");await rename(vault,backup);
 assert.equal((await f.app.applyRecoveryJob(f.session.id,{jobId:plan.jobId,planDigest:plan.planDigest,approved:true})).status,"paused");
 await rm(vault,{recursive:true,force:true});await rename(backup,vault);
 return {...f,document,plan};
}
test("unknown single Undo blocks same-document writes and sends through Stop and restart",async t=>{
 const f=await fixture(t),id=f.session.id;
 const document=await f.app.editDocument(id,{path:"note",content:"one",expectedRevision:null});
 const save=LocalStorage.prototype.save;let failures=0;
 const mock=t.mock.method(LocalStorage.prototype,"save",function(this:LocalStorage,value:unknown){
  const state=value as {documents:Record<string,{operations:Array<{kind:string}>}>};
  if(!failures&&state.documents[f.session.workspace]?.operations.some(op=>op.kind==="undo")){failures++;throw new Error("Injected inverse receipt failure");}
  return save.call(this,value);
 });
 await assert.rejects(f.app.undo(id,document.revision!,"tui-operator"),/unknown/i);mock.mock.restore();assert.equal(failures,1);
 assert.equal(f.app.get(id)?.status,"unknown");f.app.stopRun(id);f.app.cancel(id);assert.equal(f.app.get(id)?.status,"unknown");
 await assert.rejects(f.app.editDocument(id,{path:"note",content:"Unsafe",expectedRevision:document.revision}),/settle|reconcil|unknown/i);
 assert.throws(()=>f.app.send(id,"Unsafe"),/unknown/i);assert.equal(f.app.document(id,"note").content,"one");
 await f.app.shutdown();assert.equal(f.app.get(id)?.status,"unknown");f.restart({keepOpen:true});assert.equal(f.app.get(id)?.status,"unknown");
 await assert.rejects(f.app.editDocument(id,{path:"note",content:"Unsafe after restart",expectedRevision:document.revision}),/settle|reconcil|unknown/i);
 assert.throws(()=>f.app.send(id,"Unsafe after restart"),/unknown/i);assert.equal(f.calls(),1);
});
test("single Undo and writes cannot bypass the owning paused job after vault repair",async t=>{
 const f=await paused(t),id=f.session.id;
 await assert.rejects(f.app.undo(id,f.document.revision!,"tui-operator"),/settle|recovery|reconcil/i);
 await assert.rejects(f.app.editDocument(id,{path:"note",content:"Unsafe",expectedRevision:f.document.revision}),/settle|recovery|reconcil/i);
 assert.equal(f.app.document(id,"note").content,"one");
 const status=await f.app.recoveryJobStatus(id,f.plan.jobId);assert.ok("checkpoint" in status);assert.equal(status.checkpoint,0);
 assert.equal((await f.app.applyRecoveryJob(id,{jobId:f.plan.jobId,planDigest:f.plan.planDigest,approved:true})).status,"restored");
 assert.equal(f.app.document(id,"note").content,null);
});
test("an independent branch does not inherit its parent recovery owner or queued prompt",async t=>{
 const f=await paused(t),id=f.session.id;
 const child=await f.app.branch(id,{seq:f.app.get(id)!.events.find(event=>event.kind==="user")!.seq,idempotencyKey:"paused-recovery-branch"});
 f.app.send(child.id,"Continue independently");await f.app.settled();assert.equal(f.app.get(child.id)?.status,"idle");
 assert.equal(f.app.get(id)?.status,"paused");assert.equal(f.app.document(id,"note").content,"one");
 const saved=new LocalStorage(f.directory).read<{sessions:Array<{view:{id:string};recoveryBlock?:unknown;queuedPrompt?:unknown}>}>()!;
 const stored=saved.sessions.find(session=>session.view.id===child.id)!;assert.equal(stored.recoveryBlock,undefined);assert.equal(stored.queuedPrompt,undefined);
 await assert.rejects(f.app.recoveryJobStatus(child.id,f.plan.jobId),/not found/i);
});
test("Stop projects stopping on every live surface until the provider settles",async t=>{
 let release!:()=>void;
 const blocked=new Promise<void>(resolve=>{release=resolve;});
 const {app}=await isolatedWorkbench(t,async url=>{
  if(String(url).endsWith("/models"))return Response.json({data:[{id:"fixture"}]});
  await blocked;return Response.json({choices:[{message:{role:"assistant",content:"Late"}}]});
 },{},{prefix:"void-stopping-view-",beforeShutdown:release});
 const session=await app.start("Review","fixture");app.stopRun(session.id);
 assert.equal(app.running(),true);assert.equal(app.runs()[0]?.state,"stopping");
 assert.equal(activity(app.allViews()).runs[0]?.state,"stopping");
 assert.equal((app.get(session.id) as {state?:string})?.state,"stopping");assert.equal((app.list()[0] as {state?:string})?.state,"stopping");
 release();await app.settled();assert.equal(app.runs()[0]?.state,"stopped");
});
