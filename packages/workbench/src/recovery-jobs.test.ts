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
 return {directory,session,get app(){return app;},restart(){app.close();app=new Workbench({VOID_DATA_DIR:directory},fetcher);}};
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
 assert.equal(f.app.document(id,"note").content,"one");
 await rm(vault,{recursive:true,force:true});await rename(backup,vault);
 assert.equal((await f.app.applyRecoveryJob(id,approval)).status,"restored");
 assert.equal(f.app.document(id,"note").content,null);
 const count=f.app.workspace(id).operations.length;
 assert.equal((await f.app.applyRecoveryJob(id,approval)).status,"restored");
 assert.equal(f.app.workspace(id).operations.length,count);
});
