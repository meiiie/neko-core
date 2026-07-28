---
name: imagegen
description: Generate images (tao anh / ve anh / sinh anh / image / illustration / logo / poster / banner / mascot) through the user's ChatGPT subscription via the Codex image tool. Use when the user asks for a new picture; for EDITING an existing photo use the photo-editing skill instead.
match: (tạo|tao|vẽ|ve|sinh|generate|draw|render).{0,30}(ảnh|anh\b|image|logo|poster|banner|illustration|mascot)|image.?gen
---

# Skill: Image generation (ChatGPT subscription route)

The `mcp__neko_image__generate` tool renders a text prompt to a PNG in the project, through the
user's ChatGPT plan (Codex image tool, GPT-Image class). No API key, no extra billing - but it
consumes subscription usage ~3-5x faster than a text turn, so make every generation count.

## Before generating

1. One generation should carry a COMPLETE prompt. Write it like an art director's brief:
   - subject and action, composition/framing (close-up? rule of thirds? negative space?)
   - light (golden hour, studio softbox, rim light...), palette, mood
   - style anchor (photorealistic / flat vector / watercolor / anime cel...), aspect intent
   - what must NOT appear (text and typography are usually rendered as gibberish - say "no text")
2. Vietnamese text INSIDE an image comes out as diacritic gibberish. Never ask the model to render
   Vietnamese words - generate art only, composite words in HTML/CSS afterwards.
3. Ask the user before burning multiple variations; default is ONE image per request.

## After generating

- ALWAYS read the file back with read_file (vision) and judge it against the brief before declaring
  done. If it misses, refine the PROMPT (name the specific failure) rather than re-rolling blind.
- Tell the user the saved path and what you changed in the prompt if you iterated.

## When the tool is absent

The tool only appears when Codex support + ChatGPT login exist. If it is missing, say exactly that
(`/login` for ChatGPT, `neko support` for the Codex component) - do NOT silently fall back to a paid
API or scrape any web UI.
