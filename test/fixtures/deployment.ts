/**
 * A deployment whose code cell a mocked client can serve, for unit tests that open
 * sessions or subscriptions: `openSession` and `openSubscription` check that the
 * deployment's cell dep is live and holds its code (audit round 2, 31 Oct). The
 * real binary is only there after a build, so these tests use a stand-in code
 * whose hash is the deployment's codeHash; the out point is the testnet one.
 */
import { ccc } from "@ckb-ccc/core";
import { TESTNET_DEPLOYMENT, type SessionLockDeployment } from "../../src/lock.js";

export const FAKE_CODE = ccc.hexFrom("0x7f454c46" + "00".repeat(60));

export const TEST_DEPLOYMENT: SessionLockDeployment = { ...TESTNET_DEPLOYMENT, codeHash: ccc.hashCkb(FAKE_CODE) };

/** The cell the node holds at the deployment's out point. */
export const CODE_CELL = ccc.Cell.from({
  outPoint: TEST_DEPLOYMENT.cellDep.outPoint,
  cellOutput: { lock: { codeHash: "0x" + "00".repeat(32), hashType: "data", args: "0x" }, capacity: 100_000n * 100_000_000n },
  outputData: FAKE_CODE,
});

/** `CODE_CELL` at its out point, else undefined: what a `getCellLive` mock returns. */
export const codeCellAt = (op: ccc.OutPointLike): ccc.Cell | undefined =>
  CODE_CELL.outPoint.eq(ccc.OutPoint.from(op)) ? CODE_CELL : undefined;
