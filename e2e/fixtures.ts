import { test as base, expect } from "@playwright/test";

/**
 * Console errors that are not the demo's. Each entry needs a reason; nothing from
 * the demo's own code belongs here. Empty today: the live pages log no errors.
 */
const ALLOWED_CONSOLE_ERRORS: { pattern: RegExp; reason: string }[] = [];

/**
 * Every test gets a page that records uncaught exceptions and console errors, and
 * fails at the end if there were any.
 */
export const test = base.extend<{ pageErrors: string[] }>({
  pageErrors: [
    async ({ page }, use) => {
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(`uncaught: ${e.message}`));
      page.on("console", (m) => {
        if (m.type() !== "error") return;
        const text = m.text();
        if (ALLOWED_CONSOLE_ERRORS.some((a) => a.pattern.test(text))) return;
        errors.push(`console.error: ${text}`);
      });
      await use(errors);
      expect(errors, "page errors").toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };
