import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {Workbench} from "../../../packages/workbench/src/index.ts";
import {listenControlPlane} from "./server.ts";

test("local recovery routes require exact stored approval and retain immutable previews",async t=>{
 const directory=await mkdtemp(join(tmpdir(),"void-api-recovery-"));
 const wb=new Workbench({VOID_DATA_DIR:directory},async url=>String(url).endsWith("/models")?Response.json({data:[{id:"fixture"}]}):Response.json({choices:[{message:{role:"assistant",content:"Done"}}]}));
 await wb.configure({baseUrl:"https://fixture.test/v1",apiKey:"fixture"});
 const session=await wb.start("Test","fixture"); await wb.settled();
 const first=await wb.editDocument(session.id,{path:"note",content:"one",expectedRevision:null});
 wb.close();
 const server=await listenControlPlane({env:{VOID_DATA_DIR:directory}});
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
 const directory=await mkdtemp(join(tmpdir(),"void-api-project-"));
 const server=await listenControlPlane({env:{VOID_DATA_DIR:directory}});
 t.after(async()=>{await server.close();await rm(directory,{recursive:true,force:true});});
 const origin=`http://127.0.0.1:${server.port}`;
 const post=(path:string,body:unknown)=>fetch(origin+path,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});
 const created=await post("/api/projects",{name:"Example",root:"/metadata"});assert.equal(created.status,200);
 const listed=await(await fetch(origin+"/api/projects")).json() as {items:unknown[];projects:unknown[]};assert.deepEqual(listed.items,listed.projects);assert.equal(listed.items.length,1);
 assert.equal((await post("/api/runs/missing/stop",{})).status,404);
 const capabilities=await(await fetch(origin+"/api/capabilities")).json() as Record<string,boolean>;
 assert.equal(capabilities.projects,true);assert.equal(capabilities.recoveryJobs,true);assert.equal(capabilities.contextCompaction,true);assert.equal(capabilities.hooks,false);
});

test("local agent API persists scoped profiles but cannot enable shell hooks",async t=>{
 const directory=await mkdtemp(join(tmpdir(),"void-api-agents-"));
 const server=await listenControlPlane({env:{VOID_DATA_DIR:directory}});
 t.after(async()=>{await server.close();await rm(directory,{recursive:true,force:true});});
 const origin=`http://127.0.0.1:${server.port}`;
 const post=(path:string,body:unknown)=>fetch(origin+path,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});
 const profile={id:"custom",name:"Custom",systemPrompt:"Inspect",allowedTools:[],policyProfile:"default",maxTurns:2,maxContextTokens:8192};
 assert.equal((await post("/api/agents",profile)).status,200);
 const agents=await(await fetch(origin+"/api/agents")).json() as {profiles:unknown[];agents:Array<{id:string}>;hooksSupported:boolean};
 assert.deepEqual(agents.profiles,[profile]);assert.ok(agents.agents.some(a=>a.id==="reviewer"));assert.equal(agents.hooksSupported,false);
 assert.equal((await post("/api/agents",{...profile,policyProfile:"bypass"})).status,409);
 assert.equal((await post("/api/hooks",{id:"hook",event:"before-run",command:"echo done; other",enabled:true})).status,409);
 const capabilities=await(await fetch(origin+"/api/capabilities")).json() as {customAgents:boolean};assert.equal(capabilities.customAgents,true);
});
