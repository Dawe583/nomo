/**
 * Scoring over the signed chain: what the harness is worth measuring.
 *
 * The port of the statistical apparatus is deliberate and its limits are not
 * borrowed from a benchmark harness. `omp` keeps the only honest scoring
 * machinery of the three repositories (`omp-src`, `ratchet/ratchet.ts`), and
 * two things from it transfer exactly: a confidence interval over *case means*
 * rather than over individual attempts, and guardrails that may not regress
 * outside noise. What does not transfer is the goal. A ratchet climbs a metric
 * a benchmark chose; this measures decisions that were made about safety, so
 * the guardrails carry more weight than the headline number and the headline
 * number is never the thing anybody reads first.
 *
 * Three properties are load-bearing and all three are enforced here rather
 * than left to the caller, because every one of them has a way of failing
 * quietly:
 *
 * - **Nothing here writes, and nothing here decides.** A score is a report.
 *   It must never reach `decide`, and the type surface is built so it cannot be
 *   passed where a `Rule` is expected: the only thing this module exports is
 *   data and pure functions over it. The same discipline `learned-rules.ts`
 *   uses, stated here because the temptation is stronger for a number that
 *   looks like a verdict.
 * - **A gap in the record is not a good score.** A turn that ended `unknown`,
 *   or was cut off by the run deadline, has no measured outcome. It is counted
 *   as unmeasured, never as a success, which is why `unmeasured` is a first
 *   class field rather than something folded into a denominator.
 * - **Two cases cannot carry an interval.** `half` is `null` below two cases,
 *   not zero. A zero half-width would read as "precisely measured" and would
 *   let a verdict be drawn from a sample too small to distinguish from noise.
 *
 * The Student-t table is the two-sided 95% critical value for df 1..30, copied
 * from the ratchet. Beyond df 30 the normal value is used, which is what that
 * harness does as well and is accurate enough there.
 */

/** A ledger entry, as far as this module reads it. Deliberately structural:
 * the miner does not need the chain type and must not depend on it, so a
 * rolled-back or truncated chain cannot make this module fail to load. */
                                        

                                                

                                                         

                           
                       
                                                                  
                         
                                     
                           
  

/**
 * Every metric this module can produce, and the direction that is better.
 *
 * The order is the order a reader should meet them in: what is costing a human
 * their time, then what is going wrong, then what is working. `cost_usd` is
 * last because it is the one metric an operator can act on without anyone
 * else's permission, and it is not the one that decides whether the harness is
 * healthy.
 */
const SCORE_METRICS   
                                                  
  = {
  hold_rate: {
    key: "hold_rate",
    label: "Calls waiting on a human",
    direction: "lower",
    unit: "ratio",
  },
  deny_rate: {
    key: "deny_rate",
    label: "Calls refused",
    direction: "lower",
    unit: "ratio",
  },
  unknown_tool_rate: {
    key: "unknown_tool_rate",
    label: "Calls we could not classify",
    direction: "lower",
    unit: "ratio",
  },
  first_pass_rate: {
    key: "first_pass_rate",
    label: "Calls needing no correction",
    direction: "higher",
    unit: "ratio",
  },
  median_approval_ms: {
    key: "median_approval_ms",
    label: "Median operator decision time",
    direction: "lower",
    unit: "ms",
  },
  recovery_success_rate: {
    key: "recovery_success_rate",
    label: "Recoveries that finished",
    direction: "higher",
    unit: "ratio",
  },
  rollback_count: {
    key: "rollback_count",
    label: "Rollbacks needed",
    direction: "lower",
    unit: "count",
  },
  cost_usd: {
    key: "cost_usd",
    label: "Spend",
    direction: "lower",
    unit: "usd",
  },
};

/**
 * Metrics that may not regress outside noise.
 *
 * The reason this list exists is a specific failure mode. `hold_rate` alone is
 * trivially optimisable to zero by letting everything through, and a harness
 * that scored well on it while refusals climbed would be scoring a policy
 * change as an improvement. `deny_rate`, `rollback_count` and
 * `unknown_tool_rate` are the three that would move if someone did exactly
 * that, so they are the three a verdict is conditional on.
 *
 * `first_pass_rate` is deliberately absent: it is a genuine objective signal
 * and making it a guardrail would mean optimising the thing being measured.
 */
const SCORE_GUARDRAILS                                = [
  "deny_rate",
  "rollback_count",
  "unknown_tool_rate",
];

                            
                                                    
                     
                               
                                                                            
                                                                    
                               
                                                                              
                              
  

                                                                                    

                          
                                                                                 
                             
                                                           
                                                              
                                 
                                                                          
                                                        
                                      
                               
  

/** Two-sided 95% Student-t critical values, df 1..30. */
const T_CRITICAL = [
  12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228, 2.201, 2.179, 2.16,
  2.145, 2.131, 2.12, 2.11, 2.101, 2.093, 2.086, 2.08, 2.074, 2.069, 2.064, 2.06, 2.056,
  2.052, 2.048, 2.045, 2.042,
];

const NORMAL_95 = 1.96;

function tCritical(df        )         {
  return df <= T_CRITICAL.length ? T_CRITICAL[df - 1] : NORMAL_95;
}

function summary(n        , mean               , half               , unmeasured        )               {
  return { n, mean, half, unmeasured };
}

/**
 * Summarise per-case means into a summary with an interval.
 *
 * `cases` is one array per case holding that case's attempts. The interval is
 * over the *case means*, not over the pooled attempts, because attempts within
 * a case are not independent: three retries of one call carry far less
 * information than three different calls, and pooling them would report a
 * precision the data does not have. This is the single most important line in
 * the file and it is why the input is grouped rather than flat.
 *
 * An empty case list yields `EMPTY`; a single case yields `half: null`.
 */
function summariseCases(
  cases                                ,
  unmeasured = 0,
)               {
  const means           = [];
  for (const attempts of cases) {
    if (attempts.length === 0) continue;
    let total = 0;
    for (const value of attempts) {
      if (!Number.isFinite(value)) continue;
      total += value;
    }
    const usable = attempts.filter((value) => Number.isFinite(value));
    if (usable.length === 0) continue;
    means.push(total / usable.length);
  }
  if (means.length === 0) return summary(0, null, null, unmeasured);

  let sum = 0;
  for (const mean of means) sum += mean;
  const mean = sum / means.length;

  if (means.length < 2) return summary(means.length, mean, null, unmeasured);

  let ss = 0;
  for (const value of means) ss += (value - mean) ** 2;
  const variance = ss / (means.length - 1);
  const sd = Math.sqrt(variance);
  const half = (tCritical(means.length - 1) * sd) / Math.sqrt(means.length);
  return summary(means.length, mean, half, unmeasured);
}

/** Whether `next` is worse than `before` by more than the interval allows.
 *
 * Two summaries whose intervals overlap are `flat`, which is the only honest
 * reading. Comparing means alone would call a 0.001 move on a noisy metric a
 * regression, and a harness that cries regression on noise gets switched off.
 */
function compareSplit(
  before              ,
  next              ,
  direction                ,
)               {
  if (before.mean === null || next.mean === null) return "insufficient-data";
  if (before.n < 2 || next.n < 2) return "insufficient-data";
  const delta = next.mean - before.mean;
  const slack = (before.half ?? 0) + (next.half ?? 0);
  if (Math.abs(delta) <= slack) return "flat";
  const improved = direction === "higher" ? delta > 0 : delta < 0;
  return improved ? "improving" : "declining";
}

function body(entry       )                                 {
  const value = entry.body;
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value                           ;
}

function str(record                         , key        )         {
  const value = record[key];
  return typeof value === "string" ? value : "";
}

function num(record                         , key        )                     {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Decisions that count towards a rate, split by outcome.
 *
 * `execute:unknown` is unmeasured rather than a failure for the reason
 * `learned-rules.ts` gives: the tool ran and we do not know what happened. That
 * is a gap in our knowledge, and counting it as a bad outcome would make an
 * instrumentation failure look like a model that misbehaves.
 */
                                                                                                 

function emptyTally()        {
  return { allow: 0, hold: 0, deny: 0, attempts: 0, unmeasured: 0 };
}

function tally(entries                  )        {
  const out = emptyTally();
  for (const entry of entries) {
    const record = body(entry);
    if (record === null) continue;
    const tool = str(record, "tool");
    if (tool.startsWith("harness.")) continue;
    if (tool) out.attempts += 1;
    const decision = str(record, "decision");
    if (!decision) {
      out.unmeasured += 1;
      continue;
    }
    if (decision.startsWith("deny")) {
      out.deny += 1;
      continue;
    }
    if (decision.startsWith("hold")) {
      // An expired hold is a distinct outcome from an operator saying no: it
      // means nobody answered. Both cost a human, neither is a refusal.
      out.hold += 1;
      continue;
    }
    if (decision === "execute:unknown") {
      out.unmeasured += 1;
      continue;
    }
    if (decision === "proxy") {
      out.unmeasured += 1;
      continue;
    }
    if (decision.startsWith("execute")) {
      out.allow += 1;
      continue;
    }
    out.unmeasured += 1;
  }
  return out;
}

function rate(part        , whole        )         {
  return whole === 0 ? 0 : part / whole;
}

/**
 * Measure the board over one chain.
 *
 * `cases` groups attempts by case so the interval means what it says. The
 * caller supplies the grouping because only the caller knows what a case is , 
 * a workspace, a model run, a day, and this module must not guess: a wrong
 * grouping produces a confident number about the wrong thing.
 */
function measureBoard(
  cases                               ,
  generatedAt        ,
)             {
  const flat          = [];
  for (const entries of cases) flat.push(...entries);

  const totals = tally(flat);
  const decided = totals.allow + totals.hold + totals.deny;

  const holdCases             = [];
  const denyCases             = [];
  const approvalCases             = [];
  const rollbackCases             = [];
  const recoveryCases             = [];
  const costCases             = [];
  const unknownCases             = [];
  let unknownUnmeasuredTotal = 0;
  let caseCount = 0;

  for (const entries of cases) {
    const local = tally(entries);
    if (local.attempts > 0) caseCount += 1;
    const localDecided = local.allow + local.hold + local.deny;
    // A case contributes a sample only when something in it was decided.
    // `rate(0, 0)` is 0, and a zero is a measurement: `execute:unknown` and
    // `proxy` are unmeasured precisely because nobody proved what happened, so
    // letting them in would report missing evidence as a failed run.
    if (localDecided > 0) {
      holdCases.push([rate(local.hold, localDecided)]);
      denyCases.push([rate(local.deny, localDecided)]);
    }

    const approvals           = [];
    const rollbacks           = [];
    const recoveries           = [];
    const costs           = [];
    let unknownCount = 0;
    let hasClassification = false;
    let localUnclassifiedUnmeasured = 0;
    for (const entry of entries) {
      const record = body(entry);
      if (record === null) continue;
      const tool = str(record, "tool");
      const isAttempt = tool !== "" && !tool.startsWith("harness.");
      const approval = num(record, "approvalMs");
      if (approval !== undefined) approvals.push(approval);
      if (str(record, "event") === "rollback") rollbacks.push(1);
      if (str(record, "event") === "recovery") {
        const ok = record.ok === true;
        recoveries.push(ok ? 1 : 0);
      }
      const cost = num(record, "costUsd");
      if (cost !== undefined) {
        costs.push(cost);
      }
      if (Object.prototype.hasOwnProperty.call(record, "classification")) {
        hasClassification = true;
        if (str(record, "classification") === "unclassified") unknownCount += 1;
      } else if (isAttempt) {
        localUnclassifiedUnmeasured += 1;
      }
    }
    approvalCases.push(approvals);
    rollbackCases.push(localDecided > 0 ? [rollbacks.length] : []);
    recoveryCases.push(recoveries);
    costCases.push(costs);
    // A case is measured only when at least one record actually carried a
    // classification outcome. Chains written before that field existed, or
    // chains with no connector call, stay unmeasured rather than reporting a
    // measured zero that nobody observed.
    unknownCases.push(
      localDecided > 0 && hasClassification ? [unknownCount] : [],
    );
    unknownUnmeasuredTotal += localUnclassifiedUnmeasured;
  }

  const unmeasured = totals.unmeasured;

  // Decisions alone do not prove either correction history or tool classification.
  const metrics                               = {
    hold_rate: summariseCases(holdCases, unmeasured),
    deny_rate: summariseCases(denyCases, unmeasured),
    unknown_tool_rate: summariseCases(unknownCases, unknownUnmeasuredTotal),
    first_pass_rate: summariseCases([], totals.attempts),
    median_approval_ms: summariseCases(approvalCases, unmeasured),
    recovery_success_rate: summariseCases(recoveryCases, 0),
    rollback_count: summariseCases(rollbackCases, unmeasured),
    cost_usd: summariseCases(costCases, unmeasured),
  };

  const guardrails                               = {};
  for (const key of SCORE_GUARDRAILS) guardrails[key] = metrics[key];

  const reasons           = [];
  let verdict               = "insufficient-data";
  if (decided === 0) {
    reasons.push("no decided call in the chain, so nothing was measured");
  } else if (holdCases.length < 2) {
    reasons.push("fewer than two cases, so no interval can be computed");
  } else {
    verdict = "flat";
    reasons.push("no baseline was supplied, so there is nothing to compare against");
  }

  return { caseCount, metrics, guardrails, verdict, reasons, generatedAt };
}

/**
 * Compare two boards and produce a verdict with its guardrail conditions.
 *
 * The guardrail check runs first and can veto an otherwise improving verdict.
 * That ordering is the whole point: a change that improves `first_pass_rate`
 * while `deny_rate` moves outside noise has not improved the harness, and a
 * verdict that said it had would be the exact failure this module exists to
 * prevent.
 */
function compareBoards(
  before            ,
  next            ,
)                                                                 {
  const breaches           = [];
  for (const key of SCORE_GUARDRAILS) {
    const metric = SCORE_METRICS[key];
    const verdict = compareSplit(before.guardrails[key], next.guardrails[key], metric.direction);
    if (verdict === "declining") breaches.push(`${key} regressed outside noise`);
  }

  const primary = compareSplit(before.metrics.first_pass_rate, next.metrics.first_pass_rate, "higher");
  const reasons = [...next.reasons];
  if (breaches.length) {
    reasons.unshift(`withheld: ${breaches.join("; ")}`);
  }
  if (primary === "insufficient-data") {
    return { ...next, verdict: "insufficient-data", reasons, guardrailBreaches: breaches };
  }
  if (breaches.length) {
    // Not "declining": the headline did not get worse, the conditions under
    // which it counts did. Collapsing the two would hide which one failed.
    return { ...next, verdict: "flat", reasons, guardrailBreaches: breaches };
  }
  return { ...next, verdict: primary, reasons, guardrailBreaches: breaches };
}

/** Metrics that carry no measurement at all, named for a surface to show. */
/**
 * Group a chain's entries by the call shape they name.
 *
 * The board is measured over cases, and only the caller knows what a case is.
 * The CLI reads one ledger (one workspace), so a per-workspace case would
 * leave it with a single sample and no interval. A case here is a call
 * shape, the same tool in the same class, which is the granularity the
 * chain's own records carry and the one that gives a single ledger enough
 * samples to say whether a metric moved.
 */
function scoreCases(
  entries                                       ,
)                                                     {
  const byShape = new Map                                      ();
  for (const entry of entries) {
    const record =
      entry.body !== null && typeof entry.body === "object" && !Array.isArray(entry.body)
        ? (entry.body                           )
        : null;
    const tool = typeof record?.tool === "string" ? record.tool : "";
    if (!tool) continue;
    const klass = typeof record?.klass === "string" ? record.klass : "";
    const key = `${tool}|${klass}`;
    const list = byShape.get(key) ?? [];
    list.push(entry);
    byShape.set(key, list);
  }
  return [...byShape.values()];
}

function unmeasuredMetrics(board            )                       {
  return (Object.keys(board.metrics)                        ).filter(
    (key) => board.metrics[key].n === 0,
  );
}


//# sourceURL=packages/workbench/src/harness-scores.ts

export { SCORE_GUARDRAILS, SCORE_METRICS, compareBoards, compareSplit, measureBoard, scoreCases, summariseCases, unmeasuredMetrics };
