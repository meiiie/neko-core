import { expect, test } from "bun:test";

import { htmlToMarkdown } from "../src/core/tool-runtime.ts";

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
