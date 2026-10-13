import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Every name src/index.ts exports must appear in docs/API.md in backticks.
describe("docs/API.md", () => {
  const index = readFileSync("src/index.ts", "utf8");
  const docs = readFileSync("docs/API.md", "utf8");
  const names = [...index.matchAll(/export (?:type )?\{([^}]*)\}/g)].flatMap((m) =>
    m[1].split(",").map((n) => n.trim()).filter(Boolean),
  );

  it("finds the exports", () => {
    expect(names.length).toBeGreaterThan(30);
  });

  it.each(names)("documents %s", (name) => {
    expect(docs).toMatch(new RegExp("`" + name + "[`(\s]"));
  });
});
