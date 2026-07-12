---
name: web-reach
description: Read or search a SPECIFIC internet platform the right way - YouTube (transcripts, not the page), Twitter/X, Reddit, Facebook/Instagram feeds, GitHub repos/issues, Bilibili, XiaoHongShu, LinkedIn, RSS, podcasts - by ROUTING to the best FREE backend instead of blindly scraping the SPA. Recognize the platform from the URL or the ask, pick the specialized tool (yt-dlp for YouTube subs, gh for GitHub, agent-reach for login/social), and only fall back to web_fetch markdown for a generic page. For "doc/lay/tom tat/tim tren youtube, twitter/X, reddit, facebook, instagram, github, bilibili, tiktok, linkedin, RSS...". (doc va tim noi dung theo tung nen tang - dung dung cong cu, khong cao SPA).
match: youtube\.com|youtu\.be|twitter\.com|reddit\.com|facebook\.com|instagram\.com|bilibili\.com|tiktok\.com|linkedin\.com|github\.com|xiaohongshu|\byoutube\b|\btwitter\b|\breddit\b|\bfacebook\b|\binstagram\b|\bbilibili\b|\btiktok\b|\blinkedin\b|\bgithub\b|\btweet|transcript|rss feed|\brss\b
---

# Skill: Web reach (route each platform to the right free backend)

Scraping a platform's web SPA is the WORST way to read it (see the `web-reading` skill for why it thrashes).
Almost every platform has a **specialized free backend** that returns clean, structured data directly - a
YouTube transcript, a tweet's text, a Reddit thread, a repo's README/issues. Identify the platform first,
route to its tool, and you skip the whole render/scrape/extract mess.

## Rule 0 - identify the platform, then route (do NOT default to scraping)
| Platform / ask | Best FREE backend | Needs login? |
|---|---|---|
| YouTube (what does this video say) | `yt-dlp` -> subtitles/transcript (NOT scraping the page) | no |
| GitHub (repo / issues / PRs) | `gh` CLI (already here) or the API | no |
| RSS feed | `feedparser` (`pip install feedparser`) | no |
| Generic article / public page | `web_fetch` (returns markdown; set `scrape_backend: "jina"` for public JS pages) | no |
| Reddit / Twitter-X / Bilibili / XiaoHongShu / LinkedIn / podcasts | specialized CLI (below) | some |
| Facebook / Instagram FEED (logged-in) | browser session bridge (agent-reach/OpenCLI) OR the browser MCP + your session | **yes** |

## The fast path: `agent-reach` if it's installed (covers ~15 platforms, free)
[Agent-Reach](https://github.com/Panniantong/Agent-Reach) is a router that installs + health-checks free
backends for ~15 platforms and reuses your logged-in browser session for social ones. If the user has it:
1. `agent-reach doctor --json` - shows which platform backends are live (never assume).
2. Then call the routed tool it points to (`yt-dlp`, `gh`, `twitter`, `bili`, `mcporter`/Exa search, ...)
   via bash, or `agent-reach <platform> <url>` per its docs.
It's not installed by default - `pip install agent-reach` (the user's choice; it pulls in per-platform CLIs).

## Native routes that need NO agent-reach (use these first if present)
- **YouTube:** `yt-dlp --write-auto-subs --skip-download --sub-format vtt -o - "<url>"` (or `--get-...`) for
  the transcript; summarize that, don't open the video page.
- **GitHub:** `gh repo view`, `gh issue list`, `gh api ...` - clean + authenticated already.
- **Generic web:** `web_fetch(url)` -> markdown; large pages paginate (`page:N`).
Check availability honestly first: `which yt-dlp gh` / `agent-reach doctor`. If a backend is missing, say so
and offer the one-line install, don't silently fall back to fragile scraping.

## Login-required feeds (Facebook feed, Twitter home, private IG) - read this first
- These need YOUR authenticated session. Two ways: (a) a browser-session bridge (agent-reach/OpenCLI's Chrome
  extension + daemon) reuses your live login; (b) the browser MCP driving real Chrome that's already logged in.
- Before collecting a feed—especially a requested count such as 50/100—load the `web-reading` skill. Its
  capture-before-scroll + disk accumulator preserves rows that a virtualized feed unmounts and bounds context.
- **Account risk + ToS:** automating a logged-in social account can get it **checkpointed or banned**, and a
  session bridge acts AS you. Warn the user, keep it minimal, prefer public/RSS/API routes, and never do it on
  an account you can't afford to lose. This is the user's call - surface the risk, don't just do it.

## Honesty
Report which backend you used and what you could/couldn't get (not installed, login wall, rate limit, ToS).
Never invent content to fill a gap.
