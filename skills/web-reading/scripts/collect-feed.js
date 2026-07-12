async (page) => {
  const target = 20;
  const seen = new Map();
  let noGrowth = 0;
  const hash = (value) => {
    let h = 2166136261;
    for (let i = 0; i < value.length; i++) h = Math.imul(h ^ value.charCodeAt(i), 16777619);
    return (h >>> 0).toString(36);
  };

  for (let round = 0; round < 40 && seen.size < target && noGrowth < 8; round++) {
    const batch = await page.locator("article, [role=article], [data-virtualized]").evaluateAll((nodes) => nodes.flatMap((node) => {
      const box = node.getBoundingClientRect();
      if (box.bottom <= 0 || box.top >= innerHeight) return [];
      const text = (node.innerText || "").replace(/\s+/g, " ").trim().slice(0, 4000);
      if (text.length < 20) return [];
      if (node.hasAttribute("data-virtualized") && node.querySelectorAll("button, [role=button]").length < 3) return [];
      const link = node.querySelector('a[href*="/posts/"], a[href*="story_fbid"], a[href*="/permalink/"], a[href*="/reel/"], a[href*="/videos/"]');
      const heading = node.querySelector("h1,h2,h3,h4,h5,h6,[role=heading]");
      const time = node.querySelector("time");
      return [{
        id: node.getAttribute("data-post-id") || "",
        url: link ? link.href : "",
        author: heading ? (heading.textContent || "").trim() : "",
        time: time ? (time.getAttribute("datetime") || time.textContent || "").trim() : "",
        text,
      }];
    }));
    const before = seen.size;
    for (const row of batch) {
      const key = row.id || row.url || hash(`${row.author}|${row.time}|${row.text}`);
      if (!seen.has(key)) seen.set(key, { ...row, id: row.id || key });
    }
    noGrowth = seen.size === before ? noGrowth + 1 : 0;
    if (seen.size >= target || noGrowth >= 8) break;
    await page.evaluate(() => scrollBy(0, Math.max(400, Math.floor(innerHeight * 0.8))));
    await page.waitForTimeout(900);
  }

  const rows = [...seen.values()].slice(0, target);
  return { source: page.url(), count: rows.length, target, complete: rows.length === target, firstId: rows[0]?.id, lastId: rows.at(-1)?.id, rows };
}
