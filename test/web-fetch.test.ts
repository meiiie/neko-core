import { expect, test } from "bun:test";

import { htmlToMarkdown, paginateWeb } from "../src/core/tool-runtime.ts";

test("htmlToMarkdown: HTML -> compact markdown (headings/links/lists kept; scripts/nav/footer dropped)", () => {
  const html = `<html><head><style>x{color:red}</style></head><body>
    <nav>MENU_JUNK home about</nav>
    <article>
      <h2>Title Here</h2>
      <p>Some <strong>bold</strong> text and a <a href="https://x.io/a">the link</a> in a sentence that is
      long enough to make the article region exceed two hundred characters so the readable extractor keeps it
      as the main content region rather than falling back.</p>
      <ul><li>one</li><li>two</li></ul>
      <script>evilExfil()</script>
    </article>
    <footer>FOOTER_JUNK copyright</footer>
  </body></html>`;
  const md = htmlToMarkdown(html);
  expect(md).toContain("## Title Here");           // heading kept
  expect(md).toContain("[the link](https://x.io/a)"); // link preserved (a flat strip would lose the URL)
  expect(md).toContain("- one");                    // list items
  expect(md).toContain("- two");
  expect(md).toContain("**bold**");                 // emphasis
  expect(md).not.toContain("evilExfil");            // <script> dropped
  expect(md).not.toContain("MENU_JUNK");            // <nav> dropped
  expect(md).not.toContain("FOOTER_JUNK");          // <footer> dropped
  expect(md).not.toContain("<");                    // no raw tags remain
});

test("paginateWeb: small page whole; large page split with a next-page footer (no truncation/content loss)", () => {
  // small -> returned as-is
  expect(paginateWeb("short content", 1)).toBe("short content");
  // large (> MAX_READ_CHARS=100k) -> paginated, footer tells how to get more, nothing dropped
  const big = "A".repeat(100_000) + "B".repeat(60_000); // 160k -> 2 pages
  const p1 = paginateWeb(big, 1);
  expect(p1).toContain("page 1/2");
  expect(p1).toContain("page:2");        // tells the model how to continue
  expect(p1.startsWith("A")).toBe(true);
  const p2 = paginateWeb(big, 2);
  expect(p2).toContain("page 2/2");
  expect(p2).toContain("last page");
  expect(p2.includes("B")).toBe(true);   // the tail that truncation would have LOST is reachable
});
