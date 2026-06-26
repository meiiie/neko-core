---
name: browser-visual-qa
description: Visually verify and debug a web page or UI you built/changed - drive it in a browser, capture screenshots (or record a video and extract frames), then READ those images with vision to check, frame by frame, that it actually works. For "open/test/verify/debug the page/site/UI/app in a browser", visual regressions, "did my change render right", flows that only fail at runtime. (kiem tra/debug giao dien/trang web truc quan).
---

# Skill: Browser visual QA (see what you built)

Close the loop on UI work the way a careful engineer does: don't just read the DOM/code — **look at the
rendered result**. Drive the page, capture what happens as images, and **analyze them with vision** to
confirm it works or pinpoint what broke. Keep the captures as an **evidence trail** the user can review.

## Prerequisites (check first, say so honestly if missing)
1. **A browser MCP server** wired in config (`mcp_servers`), e.g. Playwright MCP:
   ```jsonc
   { "mcp_servers": { "playwright": { "command": "npx", "args": ["-y", "@playwright/mcp@latest", "--save-trace", "--output-dir", ".neko-browser"] } } }
   ```
   Tools then appear as `mcp__playwright__browser_navigate`, `..._click`, `..._type`, `..._take_screenshot`, `..._snapshot`. (Stealth/real-Chrome options are in the `procurement` skill.)
2. **Vision to ANALYZE frames**: set `"vision": true` in config AND use a vision-capable model. Without
   it, `read_file` on an image returns only metadata (size/dimensions), not what's on screen — say so and
   fall back to DOM `..._snapshot` (text) instead of pretending you can see.
3. (Advanced, for dense timelines) **ffmpeg** on PATH to split a recorded video into frames.

## The loop
1. **Navigate** to the page (`browser_navigate`). For a local app, start its dev server first
   (`bash run_in_background: true`) and wait for the port.
2. **Act**: click/type/scroll through the exact flow under test (`browser_click`, `browser_type`, ...).
3. **Capture** at each meaningful step:
   - **Screenshots (primary, reliable):** `browser_take_screenshot` -> save a PNG (e.g.
     `.neko-browser/step-01-login.png`). One per state worth checking.
   - **Video (optional, dense):** if the MCP/Playwright is recording a video, stop it, then split it with
     `scripts/extract-frames.ts` (ffmpeg) into PNG frames.
4. **Analyze with vision**: `read_file` each PNG and judge it against the EXPECTED result — is the layout
   right? the data shown? any error/blank/overlap? Go **frame by frame** for an animation or a transient
   bug. Quote what you actually see, not what the code "should" do.
5. **Verify or fix**: if a frame shows the bug, you now have the visual evidence + the step it happened →
   fix the code, re-run the loop, and confirm the NEW screenshots look right. Don't claim "fixed" until a
   capture proves it.

## Evidence trail
Keep captures under a per-run folder (`.neko-browser/<task>/step-NN-*.png`) and name them by step. They are
the proof of what happened — cite them in your summary ("step-03 shows the cart total renders as NaN") so
the user can open the same images and confirm.

## Honest limits
- Frame analysis needs a vision model; with a text model you can still drive + assert on the DOM snapshot,
  but you can't "see" rendering. Don't fake it.
- Anti-bot sites (Cloudflare/captcha) may block automation — see the `procurement` skill's stealth notes;
  a human may still be needed.
- Screenshots are the 80/20; reach for video frames only when a transient/animation bug needs them.
