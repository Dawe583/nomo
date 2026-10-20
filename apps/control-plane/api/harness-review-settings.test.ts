import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {listenControlPlane} from "./server.ts";

/**
 * The HTTP surface for the reviewer model selection exists so an operator can
 * name the model a review is paid for. The refusal half matters as much as
 * the round trip: a selection is a name that goes into a provider request, so
 * a misspelled or malformed one has to read as refused rather than as a
 * stored value the run path will later try to spend.
 */

test("PATCH /api/harness-review-settings applies a model and GET reports it with its consumer",async t=>{
  const directory=await mkdtemp(join(tmpdir(),"void-api-harness-review-"));
  const server=await listenControlPlane({env:{NOMO_DATA_DIR:directory}});
  t.after(async()=>{await server.close();await rm(directory,{recursive:true,force:true});});
  const origin=`http://127.0.0.1:${server.port}`;
  const patch=(body:unknown)=>fetch(origin+"/api/harness-review-settings",{method:"PATCH",headers:{"content-type":"application/json"},body:JSON.stringify(body)});

  const before=await(await fetch(origin+"/api/harness-review-settings")).json() as {settings:{refinementModel:string};rows:{key:string;value:string;changed:boolean;consumer:string}[]};
  // Nothing is selected by default, so the conversation's own model pays for
  // a review until an operator says otherwise.
  assert.equal(before.settings.refinementModel,"");
  assert.equal(before.rows.length,1);
  assert.equal(before.rows[0]!.key,"refinementModel");
  assert.equal(before.rows[0]!.consumer,"serveHarnessBoundary");
  assert.equal(before.rows[0]!.changed,false);

  const applied=await patch({refinementModel:"vendor/model-v2:1"});
  assert.equal(applied.status,200);
  const appliedBody=await applied.json() as {settings:{refinementModel:string};rows:{key:string;value:string;changed:boolean}[]};
  assert.equal(appliedBody.settings.refinementModel,"vendor/model-v2:1");
  assert.equal(appliedBody.rows.find(row=>row.key==="refinementModel")!.changed,true);

  const after=await(await fetch(origin+"/api/harness-review-settings")).json() as {settings:{refinementModel:string}};
  assert.equal(after.settings.refinementModel,"vendor/model-v2:1");
});

test("PATCH /api/harness-review-settings refuses an unknown key and a malformed model",async t=>{
  const directory=await mkdtemp(join(tmpdir(),"void-api-harness-review-unknown-"));
  const server=await listenControlPlane({env:{NOMO_DATA_DIR:directory}});
  t.after(async()=>{await server.close();await rm(directory,{recursive:true,force:true});});
  const origin=`http://127.0.0.1:${server.port}`;
  const patch=(body:unknown)=>fetch(origin+"/api/harness-review-settings",{method:"PATCH",headers:{"content-type":"application/json"},body:JSON.stringify(body)});

  const misspelt=await patch({reviewerModel:"vendor/model-v2:1"});
  assert.notEqual(misspelt.status,200);
  const refused=await misspelt.json() as {message?:string};
  assert.match(refused.message??"",/Unknown harness selection reviewerModel/);

  const malformed=await patch({refinementModel:"bad id"});
  assert.notEqual(malformed.status,200);
  const malformedBody=await malformed.json() as {message?:string};
  assert.match(malformedBody.message??"",/Invalid refinementModel/);

  // Nothing from either refused patch may have been applied.
  const unchanged=await(await fetch(origin+"/api/harness-review-settings")).json() as {settings:{refinementModel:string}};
  assert.equal(unchanged.settings.refinementModel,"");
});
