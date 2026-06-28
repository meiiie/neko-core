# Isolated computer-use (own cursor, doesn't touch your Windows) — Part B

This is the **robust SOTA** answer to "the agent shouldn't hijack my mouse": run the agent in a **separate
virtual desktop with its own input queue**. It's exactly how [Claude Computer Use](https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool)
works (a container + a virtual X11 display) and how [UFO²](https://arxiv.org/pdf/2504.14603) isolates input
on Windows. You're on **Windows 11 Home** (no Windows Sandbox / Hyper-V), but you already have **Docker via
WSL2**, so the container path works.

## What you get
The agent drives a virtual **Linux desktop inside a container** — its OWN screen + OWN cursor, fully isolated
from your Windows host. Your real mouse/keyboard are untouched; you watch it live in a browser tab and can
keep working in parallel. This removes the shared-desktop foreground fight (the maximized-app focus stealing
seen on the host).

## Run the isolated desktop (you have Docker)
```bash
cd skills/computer-use/isolated
docker compose up -d            # first run pulls the image (~1-2 GB)
# open http://localhost:3000  -> an isolated XFCE desktop in your browser
docker compose down             # stop + discard
```

## Wire Neko into it (next step)
The compose above gives the isolated DESKTOP. To make Neko act inside it:
1. **Build a Linux `neko`**: `bun build --compile --target=bun-linux-x64 --outfile dist/neko-linux bin/neko.ts`.
2. **Add the Linux control/vision tools** in the container: `xdotool` (mouse/keyboard — the `mouse.ps1`
   equivalent), `scrot` or `import` (screenshot — the `screenshot.ps1` equivalent). Port the two helper
   scripts to call these (e.g. `xdotool mousemove X Y click 1`, `import -window root out.png`).
3. **Run Neko in the container** pointed at the virtual display (`DISPLAY=:1`), with the same NVIDIA key.
   It screenshots the virtual desktop, grounds with `see.ts`/`ground.ts`, and acts with the xdotool helper —
   all on the isolated display. No overlay needed there: the agent IS the only user of that desktop.

## Why not the alternatives, on your machine
- **Windows Sandbox / Hyper-V** — need Win Pro/Enterprise; you have Home. Out.
- **VirtualBox/VMware** — works but heavy (a Windows ISO + license + tens of GB). The Docker path above is
  lighter and you already have Docker.
- **WSL2 + WSLg** — also viable (a Linux desktop with its own cursor) if you prefer it over a container.

## Honest scope
The desktop container is one `docker compose up` away (concrete, runnable). Steps 1–3 (Linux neko +
xdotool/scrot helpers) are a focused follow-up, not yet built here — they make the isolated agent fully
autonomous on its own cursor. For controlling your **Windows** apps specifically with a separate cursor, a
Windows guest VM is the only true-isolation route on Home edition; the Docker desktop isolates a **Linux**
environment (same as Claude CU).
