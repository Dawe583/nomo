import { homedir } from 'node:os';
import { join } from 'node:path';
import { U as UpstreamStartError, P as PolicyStartupError$1, a as ProxyStartupError, d as dataDir, r as runProxy, A as ApprovalBroker } from './dispatch.mjs';
import 'node:fs';
import 'node:util';
import 'node:child_process';
import 'node:crypto';
import 'node:fs/promises';
import './env-keys.mjs';
import 'node:sqlite';
import 'node:timers/promises';
import 'node:assert/strict';
import '@modelcontextprotocol/sdk/server/stdio.js';
import '@modelcontextprotocol/sdk/server/index.js';
import '@modelcontextprotocol/sdk/types.js';
import 'yaml';
import 'node:url';
import 'pg';
import 'node:readline/promises';
import 'node:perf_hooks';
import 'node:buffer';
import 'node:process';
import '@aws-sdk/credential-provider-node';
import 'node-sql-parser';

/**
 * The proxy owns pumping because approval expiry is part of request routing,
 * not policy. A directory watcher must also wake the pump while a request is
 * blocked on a hold; polling only between input reads would deadlock approval.
 */


                                                                                    
                                                                    
                                                             

                             
                             
  

                            
                                                    
                                                               
                            
  

                                                                                                                        
                                   
                                   
                                              
  

function pumpApprovals(
  broker                ,
  clock                = { now: () => Date.now() },
  options                      = {},
)               {
  let active                                                                                 = null;

  let stopped = false;
  const failClosed = (error         )       => {
    active?.queue.close();
    try { broker.expire(Infinity); } catch { /* Queue closure must survive a broken disk. */ }
    try { options.onError?.(error); } catch { /* Diagnostics cannot undo a refusal. */ }
  };
  const poll = (dueAt = clock.now())                            => {
    if (stopped) return [];
    try {
      const expired = broker.expire(dueAt);
      broker.consumeDecisions();
      return expired;
    } catch (error) {
      failClosed(error);
      return [];
    }
  };
  const watcher = broker.stateDirectory === undefined ? undefined :
    (options.watch ?? watchDecisions)(join(broker.stateDirectory, "decisions"), () => { poll(); }, failClosed);

  return {
    onHold(queue) {
      if (stopped || active !== null) throw new Error("approval pump cannot attach another queue");
      const originalHold = queue.hold;
      const runHold = originalHold.bind(queue);
      const restore = ()       => {
        if (active === null || active.queue !== queue) return;
        queue.hold = originalHold;
        active = null;
      };
      queue.hold = ((
        call                                               ,
        seconds        ,
        signal              ,
      ) => {
        const promise = runHold(call, seconds, signal);
        const held = newestHold(queue, call.tool);
        broker.register(queue, policyCallFromHeld(held));
        void promise.then((resolution) => {
          if (resolution.outcome.kind === "cancelled") broker.cancel(resolution.id);
          else poll();
        });
        return promise;
      })                     ;
      active = { queue, originalHold };
      return restore;
    },
    poll,
    stop() {
      stopped = true;
      watcher?.close();
      if (active === null) { broker.close(); return; }
      active.queue.close();
      try { broker.expire(Infinity); } catch { /* Shutdown still closes the queue when persistence fails. */ }
      active.queue.hold = active.originalHold;
      active = null;
      broker.close();
    },
  };
}

function newestHold(queue           , tool        )           {
  const matches = queue.list().filter((call) => call.tool === tool);
  const latest = matches.at(-1);
  if (latest === undefined) throw new Error(`hold queue did not retain ${tool}`);
  return latest;
}

function policyCallFromHeld(held          )             {
  // Args stay on the HeldCall and live in this process only: approval state
  // is durable, and call arguments can carry secrets, so the record a later
  // reader sees must not reproduce what the call was handed. The approve.test
  // fixture pins that boundary by asserting the persisted bytes never contain
  // the arguments it handed the hold.
  return {
    tool: held.tool,
    connector: connectorFromTool(held.tool),
    workspace: undefined,
    klass: held.klass,
    blastRadius: held.blastRadius,
  };
}

function connectorFromTool(tool        )         {
  const dot = tool.indexOf(".");
  return dot === -1 ? tool : tool.slice(0, dot);
}

function watchDecisions(_dir        , changed            , _failed                          )                    {
  // Polling avoids fs.watch backend limits (EMFILE was reproduced on macOS)
  // and lost notifications on mounted filesystems. Reads still fail closed.
  const timer = setInterval(changed, 100);
  timer.unref();
  return { close() { clearInterval(timer); } };
}


//# sourceURL=packages/proxy/src/approval-loop.ts

const args = process.argv.slice(2);

function readFlag(name) {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function usage() {
  return "usage: nomo-proxy --policy path [--transport stdio|http] [--upstream cmd] [--args a,b] [--upstream-url url] [--facts path] [--posture fail-closed|observe] [--ledger-dir dir] [--workspace name] [--approvals-dir dir]";
}

async function main() {
  const upstream = readFlag("--upstream");
  const policy = readFlag("--policy");
  const rawArgs = readFlag("--args");
  const facts = readFlag("--facts");
  const posture = readFlag("--posture") ?? "fail-closed";
  const ledgerDir = readFlag("--ledger-dir");
  const workspace = readFlag("--workspace") ?? "default";
  const transport = readFlag("--transport") ?? "stdio";
  const upstreamUrl = readFlag("--upstream-url");
  const approvalsDir = readFlag("--approvals-dir") ?? process.env.NOMO_APPROVALS_DIR;

  if (policy === undefined) throw new Error(usage());
  if (transport !== "stdio" && transport !== "http") throw new Error("--transport must be stdio or http");
  if (transport === "stdio" && upstream === undefined) throw new Error(usage());
  if (posture !== "fail-closed" && posture !== "observe") throw new Error("--posture must be fail-closed or observe");

  if (!/^[a-zA-Z0-9_-]+$/.test(workspace)) throw new Error("invalid workspace");
  const stateDir = approvalsDir ?? join(dataDir(homedir()), "approvals", workspace);
  let pump;
  const upstreamArgs = rawArgs === undefined || rawArgs === "" ? [] : rawArgs.split(",");
  try {
    await runProxy({
      upstreamCommand: upstream === undefined ? undefined : [upstream, ...upstreamArgs],
      transport,
      upstreamUrl,
      policyPath: policy,
      factsPath: facts,
      posture,
      ledgerDir,
      workspace,
      onHold(queue) {
        const broker = new ApprovalBroker({ stateDir });
        try {
          pump = pumpApprovals(broker, { now: Date.now }, {
            onError() { console.error("approval channel failed; pending calls expired"); },
          });
          pump.onHold(queue);
        } catch (error) { broker.close(); throw error; }
        return () => pump.stop();
      },
    });
  } finally { pump?.stop(); }
}

try {
  await main();
  process.exitCode = 0;
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  if (error instanceof UpstreamStartError) process.exitCode = 2;
  else if (error instanceof PolicyStartupError$1 || error instanceof ProxyStartupError) process.exitCode = 1;
  else process.exitCode = 1;
}
