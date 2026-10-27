import { expect, test } from "./fixtures.js";

// Every page, its title line, and the button a visitor starts from.
const PAGES = [
  { path: "/", heading: "self-custody sessions" },
  { path: "/read", heading: "1 CKB per article" },
  { path: "/tokens", heading: "2 tokens per article" },
  { path: "/place", heading: "0.1 CKB a pixel" },
  { path: "/listen", heading: "0.5 CKB a minute" },
  { path: "/subscribe", heading: "2 CKB per 60 blocks" },
];

for (const { path, heading } of PAGES) {
  test(`${path} loads, reads testnet, offers a wallet`, async ({ page }) => {
    const res = await page.goto(path);
    expect(res?.status()).toBe(200);
    await expect(page.getByRole("heading", { level: 1 })).toContainText(heading);
    // The live tip in the title bar: the page reached the testnet RPC.
    await expect(page.getByText(/^testnet #[\d,]+$/)).toBeVisible();
    // Present, never clicked: these checks do not touch a wallet.
    await expect(page.getByRole("button", { name: /connect wallet/ })).toBeVisible();
  });
}

test("/read lists the articles, locked until a session pays", async ({ page }) => {
  await page.goto("/read");
  const articles = page.getByRole("article");
  await expect(articles.first()).toBeVisible();
  const n = await articles.count();
  expect(n).toBeGreaterThan(0);
  // Each one has a title and a teaser; the body stays server-side until paid for.
  await expect(articles.getByRole("heading", { level: 3 })).toHaveCount(n);
  await expect(articles.getByRole("button", { name: "open a session to read" })).toHaveCount(n);
});

test("/place rebuilds the board from chain data", async ({ page }) => {
  await page.goto("/place");
  // The board is replayed from the board's transactions on testnet: slow on a cold RPC.
  const status = page.getByText(/# \d+ placement\(s\) · \d+\/1024 squares painted/);
  await expect(status).toBeVisible({ timeout: 75_000 });
  const [, placements, painted] = (await status.innerText()).match(/(\d+) placement\(s\) · (\d+)\//)!;
  expect(Number(placements)).toBeGreaterThan(0);
  expect(Number(painted)).toBeGreaterThan(0);
  const squares = page.locator(".board > .px");
  await expect(squares).toHaveCount(1024);
  // The painted count is what the board draws.
  const coloured = await squares.evaluateAll((els) => els.filter((e) => (e as HTMLElement).style.background).length);
  expect(coloured).toBe(Number(painted));
});

test("/subscribe switches between CKB and the demo token", async ({ page }) => {
  await page.goto("/subscribe");
  const payIn = page.locator("dt", { hasText: "pay in" }).locator("+ dd");
  // CKB is selected (plain text), the token is the button.
  await expect(payIn.getByRole("button", { name: "CKB", exact: true })).toHaveCount(0);
  await payIn.getByRole("button", { name: "demo token" }).click();
  await expect(payIn).toContainText("no CKB ever leaves the cell");
  await expect(payIn.getByRole("button", { name: "demo token" })).toHaveCount(0);
  await payIn.getByRole("button", { name: "CKB", exact: true }).click();
  await expect(payIn).not.toContainText("no CKB ever leaves the cell");
});
