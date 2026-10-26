import { ccc } from "@ckb-ccc/core";
import type { Subscription } from "ckb-session-kit";
import { CHARGER, PAY_TO, PERIOD_BLOCKS, PRICE } from "./config";

/** This demo's subscription for a subscriber: the terms are fixed, only the subscriber varies. */
export async function termsFor(client: ccc.Client, subscriberLockHash: ccc.Hex): Promise<Subscription> {
  const [charger, payTo] = await Promise.all([CHARGER, PAY_TO].map((a) => ccc.Address.fromString(a, client)));
  return {
    subscriberLockHash,
    chargerLockHash: charger.script.hash(),
    payToLockHash: payTo.script.hash(),
    price: PRICE,
    periodBlocks: PERIOD_BLOCKS,
  };
}

export const isHash = (v: unknown): v is ccc.Hex => typeof v === "string" && /^0x[0-9a-f]{64}$/i.test(v);
/** An account id the page generated: 32 random bytes, hex. */
export const isAccount = isHash;
