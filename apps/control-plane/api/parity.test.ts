import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {Workbench} from "../../../packages/workbench/src/index.ts";
import {listenControlPlane} from "./server.ts";

test("local recovery routes require exact stored approval and retain immutable previews",async t=>{
 const directory=await mkdtemp(join(tmpdir(),"nomo-api-recovery-"));
 const wb=new Workbench({NOMO_DATA_DIR:directory,NOMO_PERMISSION_MODE:"normal"},async url=>String(url).endsWith("/models")?Response.json({data:[{id:"fixture"}]}):Response.json({choices:[{message:{role:"assistant",content:"Done"}}]}));
 await wb.configure({baseUrl:"https://fixture.test/v1",apiKey:"fixture"});
 const session=await wb.start("Test","fixture"); await wb.settled();
 const first=await wb.editDocument(session.id,{path:"note",content:"one",expectedRevision:null});
 wb.close();
 const server=await listenControlPlane({env:{NOMO_DATA_DIR:directory,NOMO_PERMISSION_MODE:"normal"}});
 t.after(async()=>{await server.close();await rm(directory,{recursive:true,force:true});});
 const base=`http://127.0.0.1:${server.port}/api/sessions/${session.id}/recovery-jobs`;
 const post=(path:string,body:unknown)=>fetch(base+path,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});
 const request={jobId:"job",selection:{kind:"operations",operationIds:[first.revision]}};
 const response=await post("/plan",request); assert.equal(response.status,200);
 const plan=await response.json() as Awaited<ReturnType<Workbench["planRecoveryJob"]>>;assert.equal(plan.steps[0].operationId,first.revision);assert.deepEqual(plan.steps[0].resources,["document:note"]);
 assert.deepEqual(await(await fetch(base+"/job")).json(),plan);
 assert.equal((await post("/apply",{jobId:"job",planDigest:plan.planDigest,approved:false})).status,409);
 assert.equal((await post("/apply",{jobId:"job",planDigest:"bad",approved:true})).status,409);
 assert.equal((await post("/apply",{jobId:"job",planDigest:plan.planDigest,approved:true})).status,200);
 const denied=await fetch(base+"/plan",{method:"POST",headers:{origin:"https://hostile.test","content-type":"application/json"},body:JSON.stringify(request)}); assert.equal(denied.status,403);
 const compact=await fetch(`http://127.0.0.1:${server.port}/api/sessions/${session.id}/compact`,{method:"POST"});
 const body=await compact.json() as {session:{id:string};compaction:{omittedMessageCount:number}};assert.equal(body.session.id,session.id);assert.equal(typeof body.compaction.omittedMessageCount,"number");
});

test("local project and stop routes expose guarded additive capabilities",async t=>{
 const directory=await mkdtemp(join(tmpdir(),"nomo-api-project-"));
 const server=await listenControlPlane({env:{NOMO_DATA_DIR:directory}});
 t.after(async()=>{await server.close();await rm(directory,{recursive:true,force:true});});
 const origin=`http://127.0.0.1:${server.port}`;
 const post=(path:string,body:unknown)=>fetch(origin+path,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});
 const created=await post("/api/projects",{name:"Example",root:"/metadata"});assert.equal(created.status,200);
 const listed=await(await fetch(origin+"/api/projects")).json() as {items:unknown[];projects:unknown[]};assert.deepEqual(listed.items,listed.projects);assert.equal(listed.items.length,1);
 assert.equal((await post("/api/runs/missing/stop",{})).status,404);
 const capabilities=await(await fetch(origin+"/api/capabilities")).json() as Record<string, unknown>;
 assert.equal(capabilities.projects,true);assert.equal(capabilities.recoveryJobs,true);assert.equal(capabilities.contextCompaction,true);
 // `hooks` was `false` here while hooks fired on the local dispatch path at all
 // three run boundaries. A local workbench reports the capability it has; the
 // cloud Prime runtime, which has no hook execution, still reports false.
 assert.equal(capabilities.hooks,true);
 assert.equal((capabilities.limitations as string[]).some(l=>/hooks are not executable/i.test(l)),false);
 assert.equal((await fetch(origin+"/api/preferences",{method:"PATCH",headers:{"content-type":"application/json"},body:JSON.stringify({preferences:{permissionMode:"plan"}})})).status,409);
 assert.equal(capabilities.permissionMode,"read-only");
 assert.equal(capabilities.permissionModeAuthority,"server");
});
test("server read-only mode blocks direct document and recovery mutations",async t=>{
 const directory=await mkdtemp(join(tmpdir(),"nomo-api-readonly-"));
 const fetcher:typeof fetch=async url=>String(url).endsWith("/models")?Response.json({data:[{id:"fixture"}]}):Response.json({choices:[{message:{role:"assistant",content:"Done"}}]});
 const wb=new Workbench({NOMO_DATA_DIR:directory,NOMO_PERMISSION_MODE:"normal"},fetcher);
 await wb.configure({baseUrl:"https://fixture.test/v1",apiKey:"fixture"});
 const session=await wb.start("Test","fixture");await wb.settled();
 const document=await wb.editDocument(session.id,{path:"note",content:"one",expectedRevision:null});
 const plan=await wb.planRecoveryJob(session.id,{jobId:"job",selection:{kind:"operations",operationIds:[document.revision!]}});
 await wb.shutdown();
 const server=await listenControlPlane({env:{NOMO_DATA_DIR:directory}});
 t.after(async()=>{await server.close();await rm(directory,{recursive:true,force:true});});
 const origin=`http://127.0.0.1:${server.port}`;
 const patch=await fetch(`${origin}/api/sessions/${session.id}/documents`,{method:"PATCH",headers:{"content-type":"application/json"},body:JSON.stringify({path:"note",content:"two",expectedRevision:document.revision})});
 assert.equal(patch.status,409);
 const apply=await fetch(`${origin}/api/sessions/${session.id}/recovery-jobs/${plan.jobId}/apply`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({jobId:plan.jobId,planDigest:plan.planDigest,approved:true})});
 assert.notEqual(apply.status,200);
 const undo=await fetch(`${origin}/api/sessions/${session.id}/undo/${document.revision}`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({confirm:document.revision})});
 assert.notEqual(undo.status,200);
 const tools=await(await fetch(`${origin}/api/tools?session=${session.id}`)).json() as {tools:Array<{name:string}>};
 assert.deepEqual(tools.tools.map(tool=>tool.name),["void_workspace_list","void_workspace_read"]);
});

test("local agent API persists scoped profiles but cannot enable shell hooks",async t=>{
 const directory=await mkdtemp(join(tmpdir(),"nomo-api-agents-"));
 const server=await listenControlPlane({env:{NOMO_DATA_DIR:directory}});
 t.after(async()=>{await server.close();await rm(directory,{recursive:true,force:true});});
 const origin=`http://127.0.0.1:${server.port}`;
 const post=(path:string,body:unknown)=>fetch(origin+path,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});
 const profile={id:"custom",name:"Custom",systemPrompt:"Inspect",allowedTools:[],policyProfile:"default",maxTurns:2,maxContextTokens:8192};
 assert.equal((await post("/api/agents",profile)).status,200);
 const agents=await(await fetch(origin+"/api/agents")).json() as {profiles:unknown[];agents:Array<{id:string}>;hooksSupported:boolean};
 assert.deepEqual(agents.profiles,[profile]);assert.ok(agents.agents.some(a=>a.id==="reviewer"));assert.equal(agents.hooksSupported,false);
 // `hooksSupported` is derived from the operator allowlist, so it has to be
 // pinned in both directions: false with nothing allowlisted (the line above),
 // and true once a command is — otherwise the flag could be hardcoded and no
 // assertion here would notice.
 const allowed=await listenControlPlane({env:{NOMO_DATA_DIR:directory,NOMO_HOOK_COMMANDS:JSON.stringify(["echo done"])}});
 t.after(async()=>{await allowed.close();});
 const allowedOrigin=`http://127.0.0.1:${allowed.port}`;
 assert.equal((await fetch(allowedOrigin+"/api/agents").then(r=>r.json() as Promise<{hooksSupported:boolean}>)).hooksSupported,true);
 assert.equal((await post("/api/agents",{...profile,policyProfile:"bypass"})).status,409);
 assert.equal((await post("/api/hooks",{id:"hook",event:"before-run",command:"echo done; other",enabled:true})).status,409);
 const capabilities=await(await fetch(origin+"/api/capabilities")).json() as {customAgents:boolean};assert.equal(capabilities.customAgents,true);
});

test("local branch route strictly validates and delegates to Workbench.branch",async t=>{
 const directory=await mkdtemp(join(tmpdir(),"nomo-api-branch-"));
 const fetcher:typeof fetch=async url=>String(url).endsWith("/models")?Response.json({data:[{id:"fixture"}]}):Response.json({choices:[{message:{role:"assistant",content:"Done"}}]});
 const wb=new Workbench({NOMO_DATA_DIR:directory},fetcher);
 await wb.configure({baseUrl:"https://fixture.test/v1",apiKey:"fixture"});
 const parent=await wb.start("Branch fixture","fixture"); await wb.settled(); wb.close();
 // Seeding a branch copies managed documents, which is a durable document
 // write. The control plane defaults to read-only, so this route is exercised
 // in normal mode; the read-only refusal is asserted below instead of being
 // silently pinned as a passing 201.
 const server=await listenControlPlane({env:{NOMO_DATA_DIR:directory,NOMO_PERMISSION_MODE:"normal"}});
 // The read-only phase below reopens the same data directory, so the first
 // server has to be closed first; the hook stays idempotent either way.
 let firstServerClosed=false;
 t.after(async()=>{if(!firstServerClosed)await server.close();await rm(directory,{recursive:true,force:true});});
 const origin=`http://127.0.0.1:${server.port}`;
 const post=(body:unknown)=>fetch(`${origin}/api/sessions/${parent.id}/branches`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});
 for (const body of [null,{}, {seq:"1"}, {seq:1,unknown:true}, {seq:1,prompt:""}, {seq:1,prompt:"ok",snapshotDocuments:"yes"}, {seq:1}])
   assert.equal((await post(body)).status,400,JSON.stringify(body));
 const body={seq:1,prompt:"Edited branch",snapshotDocuments:true,idempotencyKey:"api-branch-key"};
 const response=await post(body);
 assert.equal(response.status,201);
 const result=await response.json() as {session:{id:string;status:string;parentId?:string}};
 assert.match(result.session.id,/^[a-f0-9-]{36}$/);
 assert.equal(result.session.parentId,parent.id);
 assert.equal(result.session.status,"idle");
 const retry=await post(body);
 assert.equal((await retry.json() as {session:{id:string}}).session.id,result.session.id);
 assert.equal((await post({...body,prompt:"Changed"})).status,409);
 firstServerClosed=true;await server.close();
 // The same route in the default read-only mode: branching without a document
 // snapshot still works, seeding a branch is refused.
 const readOnly=await listenControlPlane({env:{NOMO_DATA_DIR:directory}});
 const readOnlyOrigin=`http://127.0.0.1:${readOnly.port}`;
 const postReadOnly=(b:unknown)=>fetch(`${readOnlyOrigin}/api/sessions/${parent.id}/branches`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(b)});
 assert.equal((await postReadOnly({seq:2,idempotencyKey:"api-branch-readonly"})).status,201);
 assert.equal((await postReadOnly({seq:2,snapshotDocuments:true,idempotencyKey:"api-branch-readonly-snapshot"})).status,409);
 await readOnly.close();
});
