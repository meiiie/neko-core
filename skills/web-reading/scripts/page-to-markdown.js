// Compact page read for a RENDERED page (heavy SPA included): run this via the browser MCP's
// `browser_evaluate` AFTER the page has loaded (real Chrome renders the SPA; this reads it compactly).
// It walks the visible content and returns clean Markdown - headings, links, list items, paragraphs -
// instead of a 400K-char innerText blob or an empty [role=article] on an obfuscated DOM.
//
// Usage: browser_evaluate(<paste this whole IIFE>). Returns a string. For a feed, grab ONCE near the top;
// do NOT scroll-churn (scrolling unmounts virtualized items). Dedupe/slice on the returned markdown.
(() => {
  const root = document.querySelector("main, article, [role=main]") || document.body;
  const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "SVG", "NAV", "HEADER", "FOOTER", "ASIDE", "FORM", "TEMPLATE", "IFRAME"]);
  const out = [];
  const walk = (node) => {
    if (node.nodeType === 3) { const t = node.textContent.replace(/\s+/g, " "); if (t.trim()) out.push(t); return; }
    if (node.nodeType !== 1) return;
    const tag = node.tagName;
    if (SKIP.has(tag)) return;
    if (node.getAttribute && node.getAttribute("aria-hidden") === "true") return;
    if (/^H[1-6]$/.test(tag)) { out.push("\n\n" + "#".repeat(+tag[1]) + " " + node.textContent.replace(/\s+/g, " ").trim() + "\n"); return; }
    if (tag === "A") { const href = node.getAttribute("href") || ""; const txt = node.textContent.replace(/\s+/g, " ").trim(); if (txt) out.push(href ? "[" + txt + "](" + href + ")" : txt); return; }
    if (tag === "BR") { out.push("\n"); return; }
    if (tag === "LI") out.push("\n- ");
    else if (tag === "BLOCKQUOTE") out.push("\n> ");
    for (const c of node.childNodes) walk(c);
    if (/^(P|DIV|SECTION|UL|OL|LI|TR|TABLE|BLOCKQUOTE|PRE|ARTICLE)$/.test(tag)) out.push("\n\n");
  };
  walk(root);
  return out.join(" ").replace(/[ \t]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
})();
