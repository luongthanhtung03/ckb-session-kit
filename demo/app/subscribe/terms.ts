import { ccc } from "@ckb-ccc/core";
import type { Subscription } from "ckb-session-kit";
import { demoToken } from "../tokens/token";
import { CHARGER, PAY_TO, PERIOD_BLOCKS, PRICE, TOKEN_PRICE } from "./config";

/** What a subscription is paid in: CKB, or the demo token. */
export type Asset = "ckb" | "token";
export const isAsset = (v: unknown): v is Asset => v === "ckb" || v === "token";

/** This demo's subscription for a subscriber: the terms are fixed, only the subscriber and the asset vary. */
export async function termsFor(client: ccc.Client, subscriberLockHash: ccc.Hex, asset: Asset = "ckb"): Promise<Subscription> {
  const [charger, payTo] = await Promise.all([CHARGER, PAY_TO].map((a) => ccc.Address.fromString(a, client)));
  const token = asset === "token" ? await demoToken(client) : undefined;
  return {
    subscriberLockHash,
    chargerLockHash: charger.script.hash(),
    payToLockHash: payTo.script.hash(),
    price: token ? TOKEN_PRICE : PRICE,
    periodBlocks: PERIOD_BLOCKS,
    ...(token && { token: { type: { codeHash: token.codeHash, hashType: token.hashType, args: token.args } } }),
  };
}

export const isHash = (v: unknown): v is ccc.Hex => typeof v === "string" && /^0x[0-9a-f]{64}$/i.test(v);
/** An account id the page generated: 32 random bytes, hex. */
export const isAccount = isHash;
