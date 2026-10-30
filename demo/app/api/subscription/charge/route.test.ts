import { ccc } from "@ckb-ccc/core";
import { SessionBalanceError, SessionPolicyError } from "ckb-session-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CHARGER } from "../../../subscribe/config";

const charge = vi.hoisted(() => ({ error: undefined as unknown }));
vi.mock("ckb-session-kit", async (original) => ({
  ...(await original<typeof import("ckb-session-kit")>()),
  chargeSubscription: async () => {
    throw charge.error;
  },
}));
const { POST } = await import("./route");

const post = () =>
  POST(new Request("http://demo/api/subscription/charge", { method: "POST", body: JSON.stringify({ subscriber: "0x" + "ab".repeat(32) }) }));

afterEach(() => vi.restoreAllMocks());

describe("POST /api/subscription/charge", () => {
  process.env.CHARGER_KEY = "0x" + "42".repeat(32);

  async function status(error: unknown) {
    vi.spyOn(ccc.SignerCkbPrivateKey.prototype, "getRecommendedAddress").mockResolvedValue(CHARGER);
    charge.error = error;
    const res = await post();
    return { status: res.status, body: await res.json() };
  }

  it("answers 409 for the subscription's own state: not due, run dry", async () => {
    expect(await status(new SessionBalanceError("not a full period yet: next charge in 3 blocks"))).toMatchObject({ status: 409 });
  });

  // Review, 28 Oct: the creator's own missing cells are a server fault, worth a retry.
  // Told apart by the error's reason, not its message (30 Oct).
  it.each([
    ["no fee cell", "no-fee-cell"],
    ["no payout cell", "no-payout-cell"],
  ] as const)("answers 503 with retry when the creator has %s", async (_, reason) => {
    expect(await status(new SessionBalanceError("any wording", reason))).toEqual({
      status: 503,
      body: { error: "could not charge right now", retry: true },
    });
  });

  // 30 Oct: a PAY_TO that is not anyone-can-pay is the deployment's setup, not the subscription's.
  it("answers 503 without retry when PAY_TO is not anyone-can-pay", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await status(new SessionPolicyError("topUp needs an anyone-can-pay payTo", "payto-not-anyone-can-pay"))).toEqual({
      status: 503,
      body: { error: "charging is misconfigured on this deployment" },
    });
  });

  it("answers 409 for other policy errors: a subscription made for another charger", async () => {
    expect(await status(new SessionPolicyError("this signer is not the subscription's charger"))).toMatchObject({ status: 409 });
  });

  it("answers 409 for a message that merely reads like a creator fault, without the reason", async () => {
    expect(await status(new SessionBalanceError("payTo has no anyone-can-pay cell to top up"))).toMatchObject({ status: 409 });
  });
});
