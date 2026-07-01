---
name: web-reading
description: Read/extract content from a web page or feed EFFICIENTLY - posts, articles, listings, comments, search results - ESPECIALLY heavy JavaScript SPAs (Facebook, X/Twitter, LinkedIn, Instagram, Reddit, Xiaohongshu) where naive DOM scraping returns empty, thrashes, and burns minutes + tokens. Plan the read first, prefer the accessibility snapshot or a compact markdown/structured extract over raw querySelectorAll, grab ONCE near a loaded state (don't scroll-churn a virtualized feed), extract compact fields at the source, and stop after a couple of failed attempts instead of trying a 7th selector. For "luot/doc/thu thap/scrape/trich noi dung web, feed, bai viet, binh luan, ket qua tim kiem". (doc va trich noi dung trang web mot cach hieu qua, khong lan man).
---

# Skill: Web reading (extract page/feed content efficiently, no thrashing)

Reading a web page's *content* (not testing a UI you built - that's `browser-visual-qa`) has one failure
mode that wastes almost all the time: **flailing** - trying selector after selector on a heavy SPA whose
DOM is virtualized/obfuscated, pulling giant raw blobs, and scroll-churning a feed that unmounts old items
as you scroll. The fix is a PLAN, not more attempts. A good read of a feed is ~30-60s and a few k tokens;
the same read done by flailing is 10-15 min and 70k+ tokens for the same result.

## Rule 0 - PLAN before you touch the page (the biggest win)
Name the site type first, then pick the strategy:
- **Simple/static page** (blog, docs, article, most e-commerce): the DOM is real - `browser_snapshot`
  (a11y tree) or one `browser_evaluate` returning structured fields is enough. Done.
- **Heavy SPA / infinite feed** (Facebook Comet, X, LinkedIn, Instagram, Reddit, Xiaohongshu): the DOM is
  **virtualized + obfuscated**. `document.querySelectorAll('[role=article]')` is often EMPTY or `innerText`
  is blank because content lives in nested components / shadow-ish trees. **Do NOT start with DOM scraping.**
  Use the accessibility snapshot or a markdown extract, and grab once (see below).

## The reliable read (in priority order - use the FIRST that works, don't "upgrade" away from it)
1. **A markdown / structured extract tool if the browser MCP has one** (`*_markdown`, `*_extract`,
   `*_interactive_elements`). This is the ideal: the page comes back as compact readable text. Prefer it.
2. **The accessibility snapshot** (`browser_snapshot`). It renders the *content* (author + text of posts)
   even on Comet-style SPAs where the raw DOM does not. If the FIRST snapshot already has the data - **parse
   THAT.** Do not abandon a working snapshot for a "cleaner" DOM approach and then circle back to it 12
   minutes later. (This exact mistake is the classic time sink.)
3. **`browser_evaluate` that returns COMPACT structured data** - only when 1-2 don't fit. The JS must do the
   extraction and return `[{author, time, text: text.slice(0,300)}]`, NOT `document.body.innerText` (that
   returns 400K chars of mixed sidebar/chat noise and blows the token budget). Extract at the source.

## Virtualized feeds: grab ONCE, do NOT scroll-churn
On FB/X/etc, scrolling **unmounts** the items you already have - so scroll-then-collect *destroys* your
data instead of accumulating it, and each `scroll + await 2s` step x20-30 is where the minutes go.
- Load the feed, let it settle (one wait), then grab everything currently rendered in ONE pass.
- Want more than one screen holds? Accept the realistic limit. "Latest 5-7 posts from the loaded view" is
  the honest answer; **churning for an arbitrary "10" is net-negative.** State the limit plainly.

## Extract compact, at the source (LLM extracts, code computes)
Never return a giant raw blob and parse it in a second step. Have the extraction step return only the
fields you need. Dedupe by a content signature (e.g. first 40 chars) as you collect. Drop sponsored/ad
rows explicitly. This is the same "LLM extracts verbatim, code computes" discipline applied to the web.

## Stop-thrashing rule (self-discipline; the harness also nudges you)
If **2 extraction attempts in a row return empty or fail**, STOP varying the selector. Step back to the
priority list above (usually: fall back to the accessibility snapshot / markdown). A 3rd, 4th, 7th selector
almost never works on an obfuscated SPA - the *approach* is wrong, not the selector.

## Windows / encoding gotchas (this environment)
- Vietnamese/unicode content: **write it to a UTF-8 file**, don't print it to the terminal (Windows
  console is cp1252 -> Python `print` throws `UnicodeEncodeError`, and it mojibakes).
- Use **bash** syntax in the Bash tool (`2>/dev/null`, forward slashes), not cmd (`2>nul`, `dir`) - the
  cmd forms fail here.

## Accounts, ToS, and honesty (important)
- Automating a logged-in social account (Facebook, Instagram, X, LinkedIn) **violates their ToS** and can
  get the account **checkpointed (phone/ID verification) or banned** - a non-standard browser fingerprint
  can make this *more* likely, not less. Prefer official APIs, RSS, or logged-out/public views. If the user
  asks to read their own feed, do it minimally, and warn them of the account risk rather than churning.
- Report honestly what you could and couldn't get, and WHY (virtualization, login wall, rate limit) - never
  pad or invent posts to hit a requested count.

## Anti-pattern checklist (what went wrong the slow way - don't repeat)
- [ ] Started with `querySelectorAll` / `innerText` on a Comet SPA -> empty -> 6 more selector variants.
- [ ] Saw the content in the FIRST snapshot, then abandoned it for DOM scraping, then came back to snapshots.
- [ ] Scrolled 20-30 times on a virtualized feed (which unmounts old posts) chasing more items.
- [ ] Pulled `body.innerText` (400K chars) and tried to parse a giant blob.
- [ ] Kept trying to hit an arbitrary count instead of taking the loaded view + stating the limit.
