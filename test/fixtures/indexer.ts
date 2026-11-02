import { ccc } from "@ckb-ccc/core";

/**
 * The cells of `cells` an indexer lists for `key`, as CKB applies a lock search:
 * the lock exactly (or by prefix), the filter's type script by prefix, and the
 * type script's length (33 + args bytes) and the data's length within their ranges.
 */
export function* indexerFind(cells: ccc.Cell[], keyLike: ccc.ClientIndexerSearchKeyLike): Generator<ccc.Cell> {
  const key = ccc.ClientIndexerSearchKey.from(keyLike);
  const f = key.filter;
  const inRange = (n: number, r?: [ccc.Num, ccc.Num]) => !r || (BigInt(n) >= r[0] && BigInt(n) < r[1]);
  const prefix = (s: ccc.Script | undefined, p: ccc.Script) =>
    !!s && s.codeHash === p.codeHash && s.hashType === p.hashType && s.args.startsWith(p.args);
  for (const c of cells) {
    const lock = c.cellOutput.lock;
    if (key.scriptSearchMode === "prefix" ? !prefix(lock, key.script) : !lock.eq(key.script)) continue;
    const type = c.cellOutput.type;
    if (f?.script && !prefix(type, f.script)) continue;
    if (!inRange(type ? type.occupiedSize : 0, f?.scriptLenRange)) continue;
    if (!inRange(ccc.bytesFrom(c.outputData).length, f?.outputDataLenRange)) continue;
    yield c;
  }
}
