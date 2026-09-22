import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,rm,rename} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {Workbench} from "./index.ts";
import {filterRows} from "./gui.ts";

async function fixture(t:import("node:test").TestContext){
 const directory=await mkdtemp(join(tmpdir(),"void-workbench-jobs-"));
 const fetcher:typeof fetch=async url=>String(url).endsWith("/models")?Response.json({data:[{id:"fixture"}]}):Response.json({choices:[{message:{role:"assistant",content:"Done"}}]});
 let app=new Workbench({VOID_DATA_DIR:directory},fetcher);
 t.after(async()=>{await app.shutdown();await rm(directory,{recursive:true,force:true});});
 await app.configure({baseUrl:"https://fixture.test/v1",apiKey:"fixture"});
 const session=await app.start("Test","fixture");await app.settled();
 return {directory,session,get app(){return app;},restart(reload=false){if(!reload)app.close();app=new Workbench({VOID_DATA_DIR:directory},fetcher);}};
}

test("managed jobs preserve exact run selection and IDs across restart and repeated apply",async t=>{
 const f=await fixture(t), id=f.session.id, runId=f.app.get(id)!.runId!;
 const first=await f.app.editDocument(id,{path:"note",content:"one",expectedRevision:null});
 const second=await f.app.editDocument(id,{path:"note",content:"two",expectedRevision:first.revision});
 const plan=await f.app.planRecoveryJob(id,{jobId:"job",selection:{kind:"run",runId}});
 assert.deepEqual(plan.steps.map(step=>step.operationId),[second.revision,first.revision]);
 assert.deepEqual(plan.steps[0]!.resources,["document:note"]);
 assert.match(plan.planDigest,/^[a-f0-9]{64}$/);
 const proof=await f.app.ledger(f.session.workspace);
 f.restart(); assert.deepEqual(await f.app.recoveryJobStatus(id,"job"),plan);
 await assert.rejects(f.app.applyRecoveryJob(id,{jobId:"job",planDigest:"f".repeat(64),approved:true}),/digest/i);
 await assert.rejects(f.app.applyRecoveryJob(id,{jobId:"job",planDigest:plan.planDigest,approved:false}),/approv/i);
 assert.equal((await f.app.applyRecoveryJob(id,{jobId:"job",planDigest:plan.planDigest,approved:true})).status,"restored");
 const operations=f.app.workspace(id).operations.length;
 assert.equal(f.app.document(id,"note").content,null);
 assert.equal((await f.app.applyRecoveryJob(id,{jobId:"job",planDigest:plan.planDigest,approved:true})).status,"restored");
 assert.equal(f.app.workspace(id).operations.length,operations);
 await assert.rejects(f.app.applyRecoveryJob(id,{jobId:"job",planDigest:"a".repeat(64),approved:true}),/digest/i);
 assert.deepEqual((await f.app.ledger(f.session.workspace))!.entries.slice(0,proof!.entries.length),proof!.entries);
});

test("managed preview stays immutable after human edits and stale apply refuses",async t=>{
 const f=await fixture(t),id=f.session.id;
 const first=await f.app.editDocument(id,{path:"note",content:"one",expectedRevision:null});
 const request={jobId:"preview",selection:{kind:"operations" as const,operationIds:[first.revision!,"missing"]}};
 const plan=await f.app.planRecoveryJob(id,request);
 assert.deepEqual(plan.residuals,[{operationId:"missing",status:"missing"}]);
 await f.app.editDocument(id,{path:"note",content:"human",expectedRevision:first.revision});
 assert.deepEqual(await f.app.planRecoveryJob(id,request),plan);
 await assert.rejects(f.app.applyRecoveryJob(id,{jobId:"preview",planDigest:plan.planDigest,approved:true}),/stale/i);
 assert.equal(f.app.document(id,"note").content,"human");
 await assert.rejects(f.app.planRecoveryJob(id,{...request,selection:{kind:"operations",operationIds:["different"]}}),/selection/i);
});

test("state filters keep unknown runs separate from failed legacy status",()=>{
 const rows=[{state:"unknown",status:"unknown"},{state:"failed",status:"failed"}];
 assert.deepEqual(filterRows(rows,new URLSearchParams("state=unknown")),[rows[0]]);
 assert.deepEqual(filterRows(rows,new URLSearchParams("status=failed")),[rows[1]]);
});

test("explicit apply resumes a paused job after artifact repair without replaying completed work",async t=>{
 const f=await fixture(t),id=f.session.id;
 const edit=await f.app.editDocument(id,{path:"note",content:"one",expectedRevision:null});
 const plan=await f.app.planRecoveryJob(id,{jobId:"repair",selection:{kind:"operations",operationIds:[edit.revision!]}});
 const vault=join(f.directory,"recovery","vault"),backup=join(f.directory,"vault-backup");
 await rename(vault,backup);
 const approval={jobId:plan.jobId,planDigest:plan.planDigest,approved:true};
 assert.equal((await f.app.applyRecoveryJob(id,approval)).status,"paused");
 assert.equal(f.app.get(id)?.status,"paused");
 assert.throws(()=>f.app.send(id,"Do not dispatch"),/recovery/i);
 f.app.cancel(id);assert.equal(f.app.get(id)?.status,"paused");
 f.restart();assert.throws(()=>f.app.send(id,"Still blocked"),/recovery/i);
 const other=await f.app.start("Independent workspace","fixture",undefined,undefined,undefined,true);await f.app.settled();
 assert.equal(f.app.get(other.id)?.status,"idle");
 assert.equal(f.app.document(id,"note").content,"one");
 await rm(vault,{recursive:true,force:true});await rename(backup,vault);
 assert.equal((await f.app.applyRecoveryJob(id,approval)).status,"restored");
 assert.equal(f.app.document(id,"note").content,null);
 const count=f.app.workspace(id).operations.length;
 assert.equal((await f.app.applyRecoveryJob(id,approval)).status,"restored");
 assert.equal(f.app.workspace(id).operations.length,count);
 f.app.send(id,"Explicit continuation after this exact job settled");await f.app.settled();assert.equal(f.app.get(id)?.status,"idle");
});

test("unknown recovery blocks its session across restart and never replays the inverse",async t=>{
 const {LocalStorage}=await import("./storage.ts");
 const f=await fixture(t),id=f.session.id;
 const edit=await f.app.editDocument(id,{path:"note",content:"one",expectedRevision:null});
 const plan=await f.app.planRecoveryJob(id,{jobId:"unknown",selection:{kind:"operations",operationIds:[edit.revision!]}});
 const save=LocalStorage.prototype.save;let failures=0;
 const mock=t.mock.method(LocalStorage.prototype,"save",function(this:InstanceType<typeof LocalStorage>,value:unknown){
  const state=value as {documents:Record<string,{operations:Array<{kind:string}>}>};
  if(!failures&&state.documents[f.session.workspace]?.operations.some(op=>op.kind==="undo")){failures++;throw new Error("Injected inverse receipt failure");}
  return save.call(this,value);
 });
 const approval={jobId:plan.jobId,planDigest:plan.planDigest,approved:true};
 assert.equal((await f.app.applyRecoveryJob(id,approval)).status,"unknown");mock.mock.restore();
 assert.equal(failures,1);assert.equal(f.app.get(id)?.status,"unknown");assert.equal(f.app.runs().find(run=>run.sessionId===id)?.reconcileRequired,true);
 assert.throws(()=>f.app.send(id,"Do not continue"),/unknown|recovery/i);
 f.restart();assert.equal(f.app.get(id)?.status,"unknown");assert.throws(()=>f.app.send(id,"No restart replay"),/unknown|recovery/i);
 const operations=f.app.workspace(id).operations.length;
 assert.equal((await f.app.applyRecoveryJob(id,approval)).status,"unknown");assert.equal(f.app.workspace(id).operations.length,operations);
});

test("unrelated restored recovery cannot clear an existing forward unknown",async t=>{
 const {LocalStorage}=await import("./storage.ts");
 const f=await fixture(t),id=f.session.id;
 const edit=await f.app.editDocument(id,{path:"note",content:"one",expectedRevision:null});
 f.app.close();const storage=new LocalStorage(f.directory),state=storage.read<{sessions:Array<{view:{id:string;status:string}}>}>()!;
 state.sessions.find(session=>session.view.id===id)!.view.status="unknown";storage.save(state);
 // Restart from the retained unknown without allowing the old instance to overwrite it.
 f.restart(true);const wb=f.app;
 const plan=await wb.planRecoveryJob(id,{jobId:"unrelated",selection:{kind:"operations",operationIds:[edit.revision!]}});
 assert.equal((await wb.applyRecoveryJob(id,{jobId:plan.jobId,planDigest:plan.planDigest,approved:true})).status,"restored");
 assert.equal(wb.get(id)?.status,"unknown");assert.throws(()=>wb.send(id,"Do not clear uncertainty"),/unknown/i);
 await wb.shutdown();
});

test("session recovery metadata exposes only the current or last approved job",async t=>{
 const f=await fixture(t),id=f.session.id;
 const edit=await f.app.editDocument(id,{path:"note",content:"one",expectedRevision:null});
 const plan=await f.app.planRecoveryJob(id,{jobId:"visible-job",selection:{kind:"operations",operationIds:[edit.revision!]}});
 const view=()=>f.app.get(id) as {lastRecoveryJob?:{jobId:string}};
 assert.equal(view().lastRecoveryJob,undefined);
 await assert.rejects(f.app.applyRecoveryJob(id,{jobId:plan.jobId,planDigest:"f".repeat(64),approved:true}),/digest/i);
 assert.equal(view().lastRecoveryJob,undefined);
 const vault=join(f.directory,"recovery","vault"),backup=join(f.directory,"metadata-vault-backup");await rename(vault,backup);
 const approval={jobId:plan.jobId,planDigest:plan.planDigest,approved:true};
 assert.equal((await f.app.applyRecoveryJob(id,approval)).status,"paused");
 assert.deepEqual(view().lastRecoveryJob,{jobId:plan.jobId});assert.equal("recoveryJobId" in view(),false);
 assert.equal("recoveryBlock" in view(),false);assert.equal("previousStatus" in view(),false);
 const copy=view().lastRecoveryJob!;copy.jobId="cannot-change-owner";assert.equal(view().lastRecoveryJob?.jobId,plan.jobId);
 const {LocalStorage}=await import("./storage.ts");f.app.close();
 const storage=new LocalStorage(f.directory),saved=storage.read<{sessions:Array<{view:{id:string;lastRecoveryJob?:unknown}}>}>()!;
 saved.sessions.find(session=>session.view.id===id)!.view.lastRecoveryJob={jobId:"older-job",privateCapture:"never-public"};storage.save(saved);
 f.restart(true);assert.deepEqual(view().lastRecoveryJob,{jobId:plan.jobId});assert.equal("recoveryJobId" in view(),false);
 assert.deepEqual(f.app.patchSession(id,{title:"Keep the recovery owner"}).lastRecoveryJob,{jobId:plan.jobId});
 await rm(vault,{recursive:true,force:true});await rename(backup,vault);
 assert.equal((await f.app.applyRecoveryJob(id,approval)).status,"restored");
 assert.deepEqual(view().lastRecoveryJob,{jobId:plan.jobId});assert.equal("recoveryJobId" in view(),false);
 f.restart();assert.deepEqual(view().lastRecoveryJob,{jobId:plan.jobId});assert.equal("recoveryJobId" in view(),false);
 const child=await f.app.branch(id,{seq:f.app.get(id)!.events.find(event=>event.kind==="user")!.seq});
 const childView=f.app.get(child.id) as {lastRecoveryJob?:unknown;recoveryJobId?:unknown};
 assert.equal(childView.lastRecoveryJob,undefined);assert.equal(childView.recoveryJobId,undefined);
});
