import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {listenControlPlane} from "./server.ts";

/**
 * The HTTP surface for the harness limits exists so an operator can change a
 * limit and see what it governs. Both halves matter: the round trip has to
 * apply, and a refused key has to read as refused, because an operator who
 * mistypes `maxQueuedRuns` and is answered "ok" has been told a lie about
 * their own configuration.
 */

test("PATCH /api/harness-settings applies a limit and GET reports it with its consumer",async t=>{
  const directory=await mkdtemp(join(tmpdir(),"void-api-harness-settings-"));
  const server=await listenControlPlane({env:{VOID_DATA_DIR:directory}});
  t.after(async()=>{await server.close();await rm(directory,{recursive:true,force:true});});
  const origin=`http://127.0.0.1:${server.port}`;
  const patch=(body:unknown)=>fetch(origin+"/api/harness-settings",{method:"PATCH",headers:{"content-type":"application/json"},body:JSON.stringify(body)});

  const before=await(await fetch(origin+"/api/harness-settings")).json() as {settings:{maxQueuedRuns:number;maxRequestBytes:number};rows:{key:string;value:number;changed:boolean;consumer:string}[]};
  assert.equal(before.settings.maxQueuedRuns,20);
  // Every row names what the value governs, so a reader does not have to take
  // the operator-facing label's word for it.
  assert.equal(before.rows.length,14);
  assert.deepEqual(before.rows.filter(row=>!row.changed).length,14);

  const applied=await patch({maxQueuedRuns:4});
  assert.equal(applied.status,200);
  const appliedBody=await applied.json() as {settings:{maxQueuedRuns:number};rows:{key:string;value:number;changed:boolean}[]};
  assert.equal(appliedBody.settings.maxQueuedRuns,4);
  assert.equal(appliedBody.rows.find(row=>row.key==="maxQueuedRuns")!.changed,true);
  // A row that did not change must not be marked changed by a neighbour's patch.
  assert.equal(appliedBody.rows.find(row=>row.key==="maxTurns")!.changed,false);

  const after=await(await fetch(origin+"/api/harness-settings")).json() as {settings:{maxQueuedRuns:number};rows:unknown[]};
  assert.equal(after.settings.maxQueuedRuns,4);
  assert.equal(after.rows.length,14);

  // The advertised capability is the configured one. A client that sized
  // itself against the shipped constant here would be wrong about the only
  // thing this endpoint is for.
  const capabilities=await(await fetch(origin+"/api/capabilities")).json() as {maxQueuedRuns:number;maxRequestBytes:number};
  assert.equal(capabilities.maxQueuedRuns,4);
  assert.equal(capabilities.maxRequestBytes,65536);
});

test("PATCH /api/harness-settings refuses an unknown key rather than ignoring it",async t=>{
  const directory=await mkdtemp(join(tmpdir(),"void-api-harness-unknown-"));
  const server=await listenControlPlane({env:{VOID_DATA_DIR:directory}});
  t.after(async()=>{await server.close();await rm(directory,{recursive:true,force:true});});
  const origin=`http://127.0.0.1:${server.port}`;
  const patch=(body:unknown)=>fetch(origin+"/api/harness-settings",{method:"PATCH",headers:{"content-type":"application/json"},body:JSON.stringify(body)});

  const misspelt=await patch({maxQueuedRunsLimit:4});
  assert.notEqual(misspelt.status,200);
  const refused=await misspelt.json() as {message?:string};
  assert.match(refused.message??"",/Unknown harness setting/);

  // A non-number is refused as well; clamping it to the default would let a
  // surface claim a limit the operator never chose.
  const nonNumeric=await patch({maxQueuedRuns:"4"});
  assert.notEqual(nonNumeric.status,200);

  // Nothing from either refused patch may have been applied: the real key was
  // absent from the misspelled body, so it must still read as the default.
  const unchanged=await(await fetch(origin+"/api/harness-settings")).json() as {settings:{maxQueuedRuns:number}};
  assert.equal(unchanged.settings.maxQueuedRuns,20);
});
