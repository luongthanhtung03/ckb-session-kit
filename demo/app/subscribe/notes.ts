/**
 * Server only: the members' notes, sent by /api/subscription while a
 * subscription is paid up. Never imported by the page.
 */
export const NOTES: { title: string; body: string }[] = [
  {
    title: "Why the creator holds the key",
    body:
      "A subscription here is an ordinary session-lock cell with the roles moved. You are the owner; " +
      "the creator's server holds the session key. The lock lets that key move at most the price, at " +
      "most once per period, and only to the creator's address. So the creator can charge you while " +
      "you are offline, and can never charge more, more often, or to anyone else.",
  },
  {
    title: "Why the first period is paid at once",
    body:
      "A new cell cannot be charged until it is a whole period old: the rate limit is a relative " +
      "since. If the opening paid nothing, you could subscribe, read, cancel before the first charge, " +
      "and repeat for free. So the transaction that opens the subscription also pays the first period.",
  },
  {
    title: "Why access follows payments, not the cell",
    body:
      "As the owner you can re-create the cell at any time, which resets its age and would put the next " +
      "charge off forever. So the server counts only cells created by a transaction that paid the creator " +
      "one price, and gives you access until that block plus one period.",
  },
  {
    title: "How you leave",
    body:
      "Cancel signs one owner-mode transaction that sweeps everything left back to your wallet. The " +
      "creator's signature is never needed, and nothing can stop it. Access ends at once.",
  },
];
