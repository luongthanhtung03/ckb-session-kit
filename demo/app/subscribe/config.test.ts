import { ccc } from "@ckb-ccc/core";
import { describe, expect, it } from "vitest";
import { CREATOR } from "../read/config";
import { CHARGER, PAY_TO } from "./config";

/**
 * Audit (30 Oct): CHARGER_KEY sits in the Vercel environment, so it should hold
 * fee cells only. Today the charger address carries the same blake160 as the
 * creator's anyone-can-pay address (all paid reads and minutes) and as PAY_TO's
 * key part: one key, so whoever reads the server's environment can spend all of it.
 */
describe("the server-held charger key", () => {
  const client = new ccc.ClientPublicTestnet();
  const keyOf = async (a: string) => (await ccc.Address.fromString(a, client)).script.args.slice(0, 42);

  // FAILS today: the three share 0x23b41ee73f5c61428009dceca60d16bb94f0cc2d.
  it("is not the key that controls the creator's income or payout cells", async () => {
    const charger = await keyOf(CHARGER);
    expect(charger).not.toBe(await keyOf(CREATOR));
    expect(charger).not.toBe(await keyOf(PAY_TO));
  });
});
