/**
 * A paywall with no database: the chain is the record of who paid for what.
 *
 *   CREATOR=ckt1… npx tsx examples/paywall-server.ts
 *   POST http://localhost:8787/article  { "id": "hello", "proof": AccessProof }
 *
 * The reader pays with
 *   spendInSession(session, client, deployment, binding,
 *                  { to: CREATOR, amount: PRICE, topUp: true, memo: paymentMemo("read:hello") })
 * and, once that is committed, asks with
 *   signAccess(session, txHash, paymentMemo("read:hello")).
 * The server releases the text only to the key that paid, for that article,
 * and one payment buys one article.
 */
import { ccc } from "@ckb-ccc/core";
import { createServer } from "node:http";
import { paymentMemo, verifyAccess, type AccessProof } from "ckb-session-kit";

const CKB = 100_000_000n;
const PRICE = 1n * CKB;
const ARTICLES = new Map([["hello", "Paid for with a session key, released after an on-chain check."]]);

const client = new ccc.ClientPublicTestnet();

createServer(async (req, res) => {
  const reply = (status: number, body: object) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (req.method !== "POST" || req.url !== "/article") return reply(404, { error: "not found" });

  let id: unknown, proof: AccessProof;
  try {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    ({ id, proof } = JSON.parse(raw));
  } catch {
    return reply(400, { error: "bad request" });
  }
  const text = typeof id === "string" ? ARTICLES.get(id) : undefined;
  if (!text) return reply(404, { error: "no such article" });

  try {
    const { script: creator } = await ccc.Address.fromString(process.env.CREATOR ?? "", client);
    const check = await verifyAccess(client, proof, { to: creator, minAmount: PRICE, memo: paymentMemo(`read:${id}`) });
    if (!check.ok) return reply(402, { error: check.reason });
  } catch {
    return reply(400, { error: "malformed proof" });
  }
  reply(200, { text });
}).listen(8787, () => console.log("paywall on http://localhost:8787/article"));
