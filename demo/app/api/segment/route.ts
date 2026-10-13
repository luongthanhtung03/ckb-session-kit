import { ccc } from "@ckb-ccc/core";
import { release } from "../../listen/release";

const client = new ccc.ClientPublicTestnet();

/**
 * Releases one minute of a track only to the key that paid for that minute
 * (see listen/release.ts). Nothing is stored: the chain is the record of who
 * paid for what, and the score is composed on request.
 */
export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "bad request" }, { status: 400 });
  }
  const { status, body: out } = await release(client, body);
  return Response.json(out, { status });
}
