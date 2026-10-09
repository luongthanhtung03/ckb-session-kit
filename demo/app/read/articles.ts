/**
 * What anyone can see before paying. The article text itself lives in
 * bodies.ts, which only the server route imports: it is sent after the payment
 * has been checked on-chain.
 */
export interface Article {
  id: string;
  title: string;
  teaser: string;
}

export const ARTICLES: Article[] = [
  {
    id: "occupied-capacity",
    title: "Why a 1 CKB payment needs someone else's cell",
    teaser: "On CKB, every byte of state is paid for in CKB. That rule makes small payments harder than they look.",
  },
  {
    id: "since",
    title: "What a lock script cannot know",
    teaser: "A script can prove that time has passed. It can never prove that it has not.",
  },
  {
    id: "delegation",
    title: "A lock with no cryptography in it",
    teaser: "The session lock never checks a signature. It lets other locks do that.",
  },
];
