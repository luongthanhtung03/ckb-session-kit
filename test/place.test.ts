import { ccc } from "@ckb-ccc/core";
import { describe, expect, it } from "vitest";
import {
  applyPlacements,
  checkPlacement,
  decodePlacement,
  encodePlacement,
  PLACE_BOARD,
  placementMemo,
  placementPrice,
  PlaceMemoError,
  type Placement,
} from "../src/place.js";

const CKB = 100_000_000n;
const hex = (bytes: number[]) => ccc.hexFrom(new Uint8Array(bytes));
const PX1 = [0x70, 0x78, 0x31];

describe("encodePlacement / decodePlacement", () => {
  it("round-trips, in order", () => {
    const pixels = [
      { x: 0, y: 0, colour: 0 },
      { x: 31, y: 31, colour: 15 },
      { x: 3, y: 7, colour: 9 },
    ];
    const memo = encodePlacement(pixels);
    expect(memo).toBe(hex([...PX1, 0, 0, 0, 31, 31, 15, 3, 7, 9]));
    expect(decodePlacement(memo)).toEqual(pixels);
  });

  it("refuses to encode nothing, too much, or off the board", () => {
    expect(() => encodePlacement([])).toThrow(PlaceMemoError);
    const many = Array.from({ length: 33 }, (_, i) => ({ x: i % 32, y: 0, colour: 1 }));
    expect(() => encodePlacement(many)).toThrow(/at most 32/);
    expect(() => encodePlacement([{ x: 32, y: 0, colour: 0 }])).toThrow(PlaceMemoError);
    expect(() => encodePlacement([{ x: 0, y: -1, colour: 0 }])).toThrow(PlaceMemoError);
    expect(() => encodePlacement([{ x: 0, y: 0, colour: 16 }])).toThrow(PlaceMemoError);
    expect(() => encodePlacement([{ x: 1.5, y: 0, colour: 0 }])).toThrow(PlaceMemoError);
  });

  it("encodes exactly maxPixels", () => {
    const full = Array.from({ length: 32 }, (_, i) => ({ x: i, y: i, colour: i % 16 }));
    expect(decodePlacement(encodePlacement(full))).toEqual(full);
  });

  it("refuses a board that does not fit in bytes", () => {
    expect(() => encodePlacement([{ x: 0, y: 0, colour: 0 }], { ...PLACE_BOARD, width: 257 })).toThrow(PlaceMemoError);
    expect(() => encodePlacement([{ x: 0, y: 0, colour: 0 }], { ...PLACE_BOARD, price: 0n })).toThrow(PlaceMemoError);
  });

  it.each([
    ["empty", "0x"],
    ["magic only", hex(PX1)],
    ["wrong magic", hex([0x70, 0x78, 0x32, 1, 1, 1])],
    ["a partial triple", hex([...PX1, 1, 1, 1, 2, 2])],
    ["x off the board", hex([...PX1, 32, 0, 0])],
    ["y off the board", hex([...PX1, 0, 200, 0])],
    ["a colour outside the palette", hex([...PX1, 0, 0, 16])],
    ["one pixel too many", hex([...PX1, ...Array.from({ length: 33 }, () => [1, 1, 1]).flat()])],
    ["a UTF-8 label", ccc.hexFrom(ccc.bytesFrom("read:since", "utf8"))],
    ["odd-length hex", "0x701"],
    ["not hex at all", "hello"],
  ])("rejects %s", (_, memo) => {
    expect(decodePlacement(memo)).toBeUndefined();
  });

  it("rejects a whole memo when one pixel is bad", () => {
    expect(decodePlacement(hex([...PX1, 1, 1, 1, 2, 2, 99]))).toBeUndefined();
  });

  it("keeps duplicates: each is paid for, the later wins", () => {
    expect(decodePlacement(hex([...PX1, 1, 1, 1, 1, 1, 2]))).toEqual([
      { x: 1, y: 1, colour: 1 },
      { x: 1, y: 1, colour: 2 },
    ]);
  });

  it("decodes against the board it is given", () => {
    const tiny = { ...PLACE_BOARD, width: 2, height: 2, colours: 2, maxPixels: 1 };
    expect(decodePlacement(hex([...PX1, 1, 1, 1]), tiny)).toEqual([{ x: 1, y: 1, colour: 1 }]);
    expect(decodePlacement(hex([...PX1, 2, 1, 1]), tiny)).toBeUndefined();
    expect(decodePlacement(hex([...PX1, 1, 1, 1, 0, 0, 0]), tiny)).toBeUndefined();
    expect(decodePlacement(hex([...PX1, 1, 1, 1]), { ...tiny, width: 0 })).toBeUndefined();
  });
});

describe("placementPrice", () => {
  it("is price × pixels", () => {
    expect(placementPrice(1)).toBe(CKB / 10n);
    expect(placementPrice(32)).toBe(32n * (CKB / 10n));
  });
});

/**
 * A placement as spendInSession builds it: session cell in, one of the board's
 * cells in and out (+amount), key cell in and out, the memo in the key cell's witness.
 */
function payment(opts: { paid?: bigint; memo?: ccc.Hex; memoAt?: number; extra?: { lock: ccc.Script; capacity: bigint } } = {}) {
  const lock = (b: string) => ccc.Script.from({ codeHash: "0x" + b.repeat(32), hashType: "type", args: "0x01" });
  const board = lock("bb");
  const session = lock("dd");
  const key = lock("ee");
  const inputs = [
    { lock: session, capacity: 200n * CKB },
    { lock: board, capacity: 61n * CKB },
    { lock: key, capacity: 100n * CKB },
    ...(opts.extra ? [opts.extra] : []),
  ];
  const memo = opts.memo ?? encodePlacement([{ x: 1, y: 2, colour: 3 }, { x: 4, y: 5, colour: 6 }]);
  const tx = ccc.Transaction.from({
    inputs: inputs.map((_, i) => ({ previousOutput: { txHash: "0x" + "01".repeat(32), index: i } })),
    outputs: [
      { lock: board, capacity: 61n * CKB + (opts.paid ?? 2n * (CKB / 10n)) },
      { lock: session, capacity: 199n * CKB },
      { lock: key, capacity: 100n * CKB - 1000n },
    ],
    outputsData: ["0x", "0x", "0x"],
  });
  tx.setWitnessArgsAt(opts.memoAt ?? 2, { inputType: memo, lock: "0x" + "00".repeat(65) });
  return { tx, inputs, board, key };
}

describe("checkPlacement", () => {
  it("accepts a placement that paid price × pixels", () => {
    const { tx, inputs, board } = payment();
    expect(checkPlacement(tx, inputs, board)).toEqual({
      ok: true,
      paid: 2n * (CKB / 10n),
      pixels: [
        { x: 1, y: 2, colour: 3 },
        { x: 4, y: 5, colour: 6 },
      ],
    });
  });

  it("accepts an overpayment, reporting what was paid", () => {
    const { tx, inputs, board } = payment({ paid: 1n * CKB });
    expect(checkPlacement(tx, inputs, board)).toMatchObject({ ok: true, paid: 1n * CKB });
  });

  it("rejects an underpayment", () => {
    const { tx, inputs, board } = payment({ paid: 2n * (CKB / 10n) - 1n });
    expect(checkPlacement(tx, inputs, board)).toMatchObject({ ok: false, reason: expect.stringMatching(/below/) });
  });

  it("counts the board's net gain, not its outputs", () => {
    // The board's 61 CKB cell is spent and recreated with 61: nothing paid.
    const { tx, inputs, board } = payment({ paid: 0n });
    expect(checkPlacement(tx, inputs, board).ok).toBe(false);
  });

  it("counts every board cell on both sides", () => {
    // A second board cell spent and not recreated: the gain is negative.
    const { tx, inputs, board } = payment({ paid: 1n * CKB, extra: { lock: ccc.Script.from({ codeHash: "0x" + "bb".repeat(32), hashType: "type", args: "0x01" }), capacity: 61n * CKB } });
    expect(checkPlacement(tx, inputs, board).ok).toBe(false);
  });

  it("rejects a payment to someone else", () => {
    const { tx, inputs } = payment();
    const other = ccc.Script.from({ codeHash: "0x" + "cc".repeat(32), hashType: "type", args: "0x01" });
    expect(checkPlacement(tx, inputs, other)).toMatchObject({ ok: false, reason: expect.stringMatching(/below/) });
  });

  it("rejects a memo that is not a placement", () => {
    const { tx, inputs, board } = payment({ memo: ccc.hexFrom(ccc.bytesFrom("read:since", "utf8")) });
    expect(checkPlacement(tx, inputs, board)).toEqual({ ok: false, reason: "no valid placement memo" });
  });

  it("rejects two memos", () => {
    const { tx, inputs, board } = payment();
    tx.setWitnessArgsAt(0, { inputType: encodePlacement([{ x: 0, y: 0, colour: 0 }]) });
    expect(checkPlacement(tx, inputs, board)).toEqual({ ok: false, reason: "no valid placement memo" });
  });

  it("rejects a memo in the board's own witness: no signature covers it", () => {
    const { tx, inputs, board } = payment({ memoAt: 1 });
    expect(checkPlacement(tx, inputs, board)).toEqual({ ok: false, reason: "the memo is in the board's own witness" });
  });

  it("rejects a memo outside the first witness of its lock group", () => {
    const { tx, inputs, board, key } = payment({ memoAt: 3, extra: { lock: ccc.Script.from({ codeHash: "0x" + "ee".repeat(32), hashType: "type", args: "0x01" }), capacity: 61n * CKB } });
    expect(key.eq(inputs[3].lock)).toBe(true);
    expect(checkPlacement(tx, inputs, board)).toMatchObject({ ok: false, reason: expect.stringMatching(/first witness/) });
  });

  it("rejects a memo in a witness past the inputs", () => {
    const { tx, inputs, board } = payment({ memoAt: 5 });
    expect(checkPlacement(tx, inputs, board)).toEqual({ ok: false, reason: "no valid placement memo" });
  });

  it("rejects unresolved inputs", () => {
    const { tx, inputs, board } = payment();
    expect(checkPlacement(tx, inputs.slice(1), board)).toEqual({ ok: false, reason: "inputs not resolved" });
  });

  it("skips witnesses that are not WitnessArgs", () => {
    const { tx, inputs, board } = payment();
    tx.witnesses[0] = "0x1234";
    expect(checkPlacement(tx, inputs, board).ok).toBe(true);
  });
});

describe("placementMemo", () => {
  it("finds the memo without resolving inputs", () => {
    const { tx } = payment();
    expect(placementMemo(tx)).toMatchObject({ index: 2 });
  });

  it("is undefined with no memo", () => {
    expect(placementMemo(ccc.Transaction.from({}))).toBeUndefined();
  });
});

describe("applyPlacements", () => {
  const h = (n: number) => ccc.hexFrom(new Uint8Array(32).fill(n));
  const at = (txHash: ccc.Hex, blockNumber: bigint, txIndex: number, colour: number, x = 0, y = 0): Placement => ({
    txHash,
    blockNumber,
    txIndex,
    pixels: [{ x, y, colour }],
  });

  it("is empty with nothing placed", () => {
    const s = applyPlacements([]);
    expect(s).toHaveLength(32 * 32);
    expect(s.every((p) => p === undefined)).toBe(true);
  });

  it("applies in chain order whatever the input order: last write wins", () => {
    const s = applyPlacements([at(h(3), 10n, 2, 3), at(h(1), 9n, 5, 1), at(h(2), 10n, 1, 2)]);
    expect(s[0]).toEqual({ colour: 3, txHash: h(3), blockNumber: 10n });
  });

  it("orders by block before position in the block", () => {
    const s = applyPlacements([at(h(1), 100n, 1, 1), at(h(2), 99n, 9, 2)]);
    expect(s[0]?.colour).toBe(1);
  });

  it("applies one memo in order", () => {
    const p: Placement = { txHash: h(1), blockNumber: 1n, txIndex: 1, pixels: [{ x: 2, y: 3, colour: 4 }, { x: 2, y: 3, colour: 5 }] };
    expect(applyPlacements([p])[3 * 32 + 2]?.colour).toBe(5);
  });

  it("places row-major", () => {
    const s = applyPlacements([at(h(1), 1n, 1, 7, 31, 1)]);
    expect(s[1 * 32 + 31]?.colour).toBe(7);
  });

  it("counts a transaction listed twice once", () => {
    const s = applyPlacements([at(h(1), 1n, 1, 1), at(h(2), 2n, 1, 2), at(h(1), 1n, 1, 1)]);
    expect(s[0]?.colour).toBe(2);
  });

  it("skips pixels off the board", () => {
    const s = applyPlacements([at(h(1), 1n, 1, 1, 40, 0)]);
    expect(s.every((p) => p === undefined)).toBe(true);
  });

  it("does not reorder its input", () => {
    const list = [at(h(2), 2n, 0, 2), at(h(1), 1n, 0, 1)];
    applyPlacements(list);
    expect(list[0].txHash).toBe(h(2));
  });
});
