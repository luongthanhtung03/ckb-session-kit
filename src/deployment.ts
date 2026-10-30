import { ccc } from "@ckb-ccc/core";
import { TESTNET_LEGACY_DEPLOYMENTS, type SessionLockDeployment } from "./lock.js";
import { SessionPolicyError } from "./session.js";

/**
 * Checks run before any new cell goes under the session lock (audit round 2, 31 Oct).
 *
 * Only paths that CREATE cells under a deployment call this: `openSession`,
 * `openSubscription`. Spending, closing, recovering, charging and cancelling
 * still accept any deployment, legacy ones included, so funds already under an
 * old lock can always come back.
 */

/** Successful checks, per client and deployment: one lookup per process, not per call. */
const verified = new WeakMap<ccc.Client, Map<string, Promise<void>>>();

const keyOf = (d: SessionLockDeployment) => {
  const op = ccc.OutPoint.from(d.cellDep.outPoint);
  return [ccc.hexFrom(d.codeHash), ccc.hashTypeFrom(d.hashType), op.txHash, op.index, ccc.depTypeFrom(d.cellDep.depType)].join(":");
};

/**
 * Throws a `SessionPolicyError` unless new cells may go under `deployment` on
 * `client`'s network:
 *
 * - it is not one of `TESTNET_LEGACY_DEPLOYMENTS` (older code with fewer rules;
 *   the 13 Oct one cannot even spend a token session's 128/160-byte args);
 * - its `hashType` is not `data`: under CKB-VM version 0 the lock faults on
 *   load, owner mode included, so such cells could never be spent;
 * - its cell dep is live on this network and holds the code: the code cell's
 *   data hashes to `codeHash` (`data1`, `data2`) or its type script hashes to
 *   it (`type`). A `depGroup` cell dep is resolved and any member may match.
 *   This catches a testnet deployment on a mainnet client, a typo in
 *   `codeHash` and a wrong out point, any of which would leave funds under a
 *   lock no code can run.
 *
 * A passing check is remembered for that client and deployment; a failing one
 * is not, so the next call looks again.
 */
export async function assertCurrentDeployment(client: ccc.Client, deployment: SessionLockDeployment): Promise<void> {
  const codeHash = ccc.hexFrom(deployment.codeHash);
  if (TESTNET_LEGACY_DEPLOYMENTS.some((d) => ccc.hexFrom(d.codeHash) === codeHash)) {
    throw new SessionPolicyError(
      "this is an old deployment of the session lock: new sessions and subscriptions go under the current one " +
        "(old deployments are still accepted to spend, close, recover and cancel)",
    );
  }
  if (ccc.hashTypeFrom(deployment.hashType) === "data") {
    throw new SessionPolicyError(
      "the session lock cannot run under hash_type data (CKB-VM version 0): use data1 or data2 (or type)",
    );
  }
  let byKey = verified.get(client);
  if (!byKey) verified.set(client, (byKey = new Map()));
  const key = keyOf(deployment);
  let check = byKey.get(key);
  if (!check) {
    check = checkCode(client, deployment);
    byKey.set(key, check);
    check.catch(() => byKey.delete(key));
  }
  await check;
}

async function checkCode(client: ccc.Client, d: SessionLockDeployment): Promise<void> {
  const codeHash = ccc.hexFrom(d.codeHash);
  const byType = ccc.hashTypeFrom(d.hashType) === "type";
  const outPoint = ccc.OutPoint.from(d.cellDep.outPoint);
  const where = `${outPoint.txHash}:${Number(outPoint.index)}`;
  const dep = await client.getCellLive(outPoint, true);
  if (!dep) {
    throw new SessionPolicyError(
      `the session lock's cell dep ${where} is not a live cell on this network: a deployment for another ` +
        "network (TESTNET_DEPLOYMENT on mainnet?) or a wrong out point; no funds go under a lock with no code",
    );
  }
  let candidates = [dep];
  if (ccc.depTypeFrom(d.cellDep.depType) === "depGroup") {
    const members = depGroupMembers(dep.outputData);
    if (!members) throw new SessionPolicyError(`the session lock's dep group ${where} does not hold a list of out points`);
    candidates = (await Promise.all(members.map((m) => client.getCellLive(m, true)))).filter((c): c is ccc.Cell => !!c);
  }
  const holds = (c: ccc.Cell) => (byType ? c.cellOutput.type?.hash() === codeHash : ccc.hashCkb(c.outputData) === codeHash);
  if (!candidates.some(holds)) {
    throw new SessionPolicyError(
      `the session lock's cell dep ${where} does not hold code whose ${byType ? "type hash" : "data hash"} is ` +
        `${codeHash}: a typo in codeHash or a wrong out point; no funds go under a lock with no code`,
    );
  }
}

/** A dep group cell's data: a molecule OutPointVec (u32 LE count, then 36-byte out points). */
function depGroupMembers(data: ccc.HexLike): ccc.OutPoint[] | undefined {
  const b = ccc.bytesFrom(data);
  if (b.length < 4) return undefined;
  const n = Number(ccc.numLeFromBytes(b.slice(0, 4)));
  if (b.length !== 4 + 36 * n) return undefined;
  return Array.from({ length: n }, (_, i) => {
    const at = 4 + 36 * i;
    return ccc.OutPoint.from({ txHash: b.slice(at, at + 32), index: ccc.numLeFromBytes(b.slice(at + 32, at + 36)) });
  });
}
