/**
 * Offline evaluation of deterministic arm policies with inverse propensity
 * scoring (R8). No model is trained and no arm is deployed. A score exists
 * only where the logging policy gave the candidate arm positive probability;
 * an arm with no support is unmeasured rather than zero.
 */
export const OFFLINE_POLICY_SCHEMA = "nomo.offline-policy.v1";

export type LoggedBanditRound = {
  readonly armId: string;
  readonly reward: number;
  /** Probability that the logging policy chose `armId` in this round. */
  readonly propensity: number;
};

export type OfflineArmEstimate = {
  readonly armId: string;
  readonly matchedRounds: number;
  readonly coverage: number;
  readonly estimate: number | null;
  readonly effectiveSamples: number;
};

export type OfflinePolicyReport = {
  readonly schema: typeof OFFLINE_POLICY_SCHEMA;
  readonly rounds: number;
  readonly arms: readonly OfflineArmEstimate[];
  readonly unmeasured: readonly string[];
};

function validateRound(round: LoggedBanditRound, index: number): void {
  if (!round.armId.trim()) throw new TypeError(`offline-policy round ${index}: armId is required`);
  if (!Number.isFinite(round.reward) || round.reward < 0 || round.reward > 1)
    throw new TypeError(`offline-policy round ${index}: reward must be in [0, 1]`);
  if (!Number.isFinite(round.propensity) || round.propensity <= 0 || round.propensity > 1)
    throw new TypeError(`offline-policy round ${index}: propensity must be in (0, 1]`);
}

/** Evaluate every named deterministic arm against the same logged rounds. */
export function evaluateOfflinePolicy(
  rounds: readonly LoggedBanditRound[],
  candidateArmIds: readonly string[],
): OfflinePolicyReport {
  if (rounds.length === 0) throw new RangeError("offline-policy: at least one logged round is required");
  rounds.forEach(validateRound);
  const candidates = [...new Set(candidateArmIds.filter((id) => id.trim()))];
  if (!candidates.length) throw new RangeError("offline-policy: at least one candidate arm is required");
  const arms = candidates.map((armId) => {
    let weightedReward = 0;
    let weightSum = 0;
    let weightSquares = 0;
    let matchedRounds = 0;
    for (const round of rounds) {
      if (round.armId !== armId) continue;
      const weight = 1 / round.propensity;
      matchedRounds += 1;
      weightedReward += weight * round.reward;
      weightSum += weight;
      weightSquares += weight * weight;
    }
    return {
      armId,
      matchedRounds,
      coverage: matchedRounds / rounds.length,
      estimate: matchedRounds === 0 ? null : weightedReward / rounds.length,
      effectiveSamples: weightSum === 0 ? 0 : (weightSum * weightSum) / weightSquares,
    };
  });
  return {
    schema: OFFLINE_POLICY_SCHEMA,
    rounds: rounds.length,
    arms,
    unmeasured: arms.filter((arm) => arm.estimate === null).map((arm) => arm.armId),
  };
}
