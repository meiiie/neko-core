# Neko Core - Gemini Omni video kit

## Cách dùng nhanh

1. Đính kèm 5 file trong `assets/video-kit/` theo đúng thứ tự số.
2. Dán nguyên khối **MASTER PROMPT** ở cuối tài liệu này vào Gemini Omni.
3. Chọn đầu ra 16:9, 1920x1080 hoặc 4K, 30 fps, tiếng Việt.
4. Nếu Gemini chỉ tạo clip ngắn, yêu cầu tạo từng shot theo bảng storyboard rồi nối theo timecode.

## Sự thật sản phẩm phải giữ nguyên

- Tên hiển thị: **Neko Core**; CLI/product shell: **Neko Code**; lệnh chạy: `neko`.
- Phiên bản trong ảnh thật: **v0.11.5**.
- Sản phẩm local-first, config-first, terminal-native; viết bằng TypeScript + Bun + Ink/React.
- Kiến trúc Ports & Adapters; core không phụ thuộc UI/provider cụ thể.
- Agent loop: complete -> tool calls -> observe; có streaming, todo, sessions, memory/workflows.
- Công cụ gồm đọc/tìm file, edit, bash, web, MCP, skills, browser và computer-use trên Windows.
- Read-only tools thuộc SAFE; write/edit/bash/computer mutations thuộc GATED hoặc permission policy.
- Có persistent browser profile và explicit-tab Browser Bridge; extension chỉ điều khiển tab người dùng attach.
- `/relay` cho phép điều khiển phiên từ thiết bị khác qua relay E2E; không đưa cookie hay browser capability lên relay.
- Mở rộng model/provider chủ yếu bằng profile; protocol mới bằng adapter; vai trò mới bằng skill Markdown.
- Không được tuyên bố Neko đã đạt SOTA, hoàn toàn tự trị, không bao giờ lỗi hoặc thay thế con người.

## Storyboard chuẩn - 90 giây

| Time | Hình ảnh | Chữ trên màn hình | Voice-over |
|---|---|---|---|
| 00-05 | Nền gần đen. Pixel mark màu amber được vẽ từng ô như terminal boot. Con trỏ bar nhấp nháy. | `NEKO CORE` | “Đây là Neko Core.” |
| 05-13 | Wordmark thật xuất hiện, camera tiến nhẹ. Một dòng lệnh `neko` được gõ, không fake terminal chrome. | `Một chú mèo trong terminal — và làm việc.` | “Một agent sống trong terminal, chạy local-first và được thiết kế để tiếp tục mở rộng.” |
| 13-28 | Dùng ảnh TUI thật. Highlight tuần tự Todo, Read(package.json), Read(ARCHITECTURE.md), todo hoàn thành và kết quả tiếng Việt. Chỉ pan/crop ảnh thật, không thay nội dung. | `PLAN → ACT → VERIFY` | “Neko lập kế hoạch, dùng công cụ thật, quan sát kết quả và chỉ hoàn thành khi có bằng chứng.” |
| 28-40 | Sơ đồ Ports & Adapters từ brand board bung thành animation: UI, providers, MCP, browser ở ngoài; Agent Loop, Tools, Ports ở lõi. Mũi tên hướng vào trong. | `Dependencies point inward.` | “Lõi agent không bị khóa vào một model hay một giao diện. Mọi phụ thuộc đều hướng vào trong.” |
| 40-53 | Sáu capability chip xuất hiện theo nhịp: CODE, WEB, COMPUTER, MCP, SKILLS, MEMORY. Mỗi chip có một micro-scene tối giản, không dashboard giả. | `One core. Many capabilities.` | “Từ code, web và computer-use đến MCP, skills và bộ nhớ dài hạn — tất cả dùng chung một safety boundary.” |
| 53-63 | Hai lane SAFE/GATED. Read/search chạy thẳng; edit/bash/computer dừng tại approval gate amber. Một thao tác nguy hiểm bị chặn đỏ. | `SAFE reads · GATED mutations` | “Đọc an toàn. Thay đổi có kiểm soát. Quyền tự động luôn là một trạng thái có tên và có thể kiểm tra.” |
| 63-73 | Terminal bên trái nối bằng đường mã hóa tới phone silhouette bên phải. Transcript mirror, trạng thái E2E, nút Stop. Không QR/token thật. | `Remote when needed. Local by default.` | “Khi cần, relay phản chiếu phiên tới điện thoại. Cookie, khóa và quyền browser vẫn ở máy local.” |
| 73-82 | Ba nhánh từ lõi: `profile.json`, `adapter.ts`, `skill.md`; chúng cắm vào Neko như module nhưng lõi không đổi. | `Profile · Adapter · Skill` | “Model mới là một profile. Protocol mới là một adapter. Vai trò mới có thể chỉ là một skill Markdown.” |
| 82-90 | End card dùng logo thật. Hai install command hiện lần lượt, sau đó GitHub URL. Nhạc resolve, cursor dừng. | `github.com/meiiie/neko-core` | “Neko Core. Build locally. Extend without limits.” |

## MASTER PROMPT - dán nguyên khối vào Gemini Omni

```text
Create a polished 90-second product launch video for NEKO CORE using the five attached reference assets.

OUTPUT
- 16:9 landscape, 1920x1080 minimum (4K preferred), 30 fps.
- Vietnamese voice-over with a calm, precise, confident developer tone; natural northern/neutral Vietnamese pronunciation.
- Burned-in Vietnamese subtitles, concise and perfectly synchronized.
- Original minimal electronic soundtrack: restrained terminal pulses, soft low-frequency bed, subtle keystrokes and UI ticks; no copyrighted music.
- Premium dark developer-tool art direction, cinematic but factual, suitable for GitHub, Product Hunt and a technical launch page.

REFERENCE ASSET CONTRACT
- Asset 01 is the canonical horizontal NEKO CORE wordmark on dark background.
- Asset 02 is the canonical transparent pixel mark.
- Asset 03 is the canonical square avatar/app icon.
- Asset 04 is a REAL Neko Core v0.11.5 product frame. Preserve every visible terminal line exactly. You may crop, pan, mask and highlight it, but do not rewrite, regenerate or hallucinate its UI.
- Asset 05 is the visual-direction board: near-black canvas, off-white type, one amber signal color, cyan for user/input, green for verified success, sparse monospace typography, strong negative space.
- Preserve the supplied logo geometry and pixels exactly. Never redraw it as a realistic cat, cat face, robot, brain, sparkle, paw, anime mascot or generic AI symbol.

PRODUCT TRUTH
Neko Core is a local-first, config-first, terminal-native coding and automation agent. The product shell is Neko Code and the command is `neko`. It is built with TypeScript, Bun and Ink/React. Its architecture follows Ports & Adapters: the core agent loop, tools, policy and ports remain independent from providers, UI, MCP, browser and other adapters. The agent can plan with todos, read/search/edit files, run commands, reach the web, use MCP and skills, maintain sessions and memory, control an explicitly attached browser tab, and use Windows computer automation. Read-only operations are SAFE; writes, shell commands and state-changing computer actions are GATED by explicit permission modes. `/relay` can mirror and control a session remotely through end-to-end encryption while cookies and browser capabilities remain local. New models are normally profiles, new protocols are adapters, and new roles can be Markdown skills.

NARRATIVE ARC
The film should feel like a precise terminal boot turning into an extensible operating system for agency:
boot -> real task -> architecture -> capabilities -> safety -> remote control -> extensibility -> install.
Do not frame Neko as magic. Frame it as engineered, inspectable and expandable.

SHOT-BY-SHOT TIMELINE

00:00-00:05 — BOOT
Start on #181920 near-black. Draw the exact amber pixel mark from Asset 02 one pixel cluster at a time, like a terminal boot sequence. Add a single blinking hardware-style bar cursor, subtle scanline/grain only. Resolve into the exact wordmark from Asset 01.
On-screen text: “NEKO CORE”.
Voice-over: “Đây là Neko Core.”

00:05-00:13 — PROMISE
Slow controlled camera push toward the exact logo. Type the command `neko` in a clean terminal line. Transition through a cursor blink into the real product surface. Keep typography sparse.
On-screen text: “Một chú mèo trong terminal — và làm việc.”
Voice-over: “Một agent sống trong terminal, chạy local-first và được thiết kế để tiếp tục mở rộng.”

00:13-00:28 — REAL PRODUCT PROOF
Use Asset 04 only. Do not recreate the terminal. Begin on the todo checklist, then make restrained amber/cyan focus frames around “Update Todos”, “Read(package.json)”, “Read(docs/process/ARCHITECTURE.md)”, the completed [x] todos, and the final five-point answer. Use smooth 2.5D pan and crop, no perspective distortion, no fake mouse pointer. Make the progression visually clear: plan -> tool calls -> verified completion.
On-screen text: “PLAN → ACT → VERIFY”.
Voice-over: “Neko lập kế hoạch, dùng công cụ thật, quan sát kết quả và chỉ hoàn thành khi có bằng chứng.”

00:28-00:40 — CLEAN ARCHITECTURE
Derive a motion diagram from Asset 05. Place AGENT LOOP, TOOLS + POLICY and PORTS in the center. UI / CLI / RELAY, PROVIDERS, MCP, BROWSER, SESSIONS, SKILLS and CONFIG sit outside. Animate dependency lines pointing inward only. Use thin rules, small page indices and restrained amber highlights.
On-screen text: “Dependencies point inward.”
Voice-over: “Lõi agent không bị khóa vào một model hay một giao diện. Mọi phụ thuộc đều hướng vào trong.”

00:40-00:53 — CAPABILITIES
Reveal six clean chips: CODE, WEB, COMPUTER, MCP, SKILLS, MEMORY. Give each a one-second abstract but factual micro-scene: code diff, web result lines, Windows accessibility nodes, MCP plug, Markdown skill file, session memory card. These are identity-level fragments, not a fake dashboard.
On-screen text: “One core. Many capabilities.”
Voice-over: “Từ code, web và computer-use đến MCP, skills và bộ nhớ dài hạn — tất cả dùng chung một safety boundary.”

00:53-01:03 — SAFETY
Split into two lanes. SAFE lane: read/search/glob flow through in green/cyan. GATED lane: edit/bash/computer mutation pauses at a clear amber approval boundary. Show one catastrophic action being blocked in red. Keep it technical, elegant and legible.
On-screen text: “SAFE reads · GATED mutations”.
Voice-over: “Đọc an toàn. Thay đổi có kiểm soát. Quyền tự động luôn là một trạng thái có tên và có thể kiểm tra.”

01:03-01:13 — RELAY
Show a terminal silhouette on the left and a phone silhouette on the right, connected by a thin encrypted amber line. Mirror a few terminal rows to the phone. Show compact status chips “E2E”, “session”, and a visible Stop control. Never show a real QR code, pairing secret, cookie, API key, email or account information.
On-screen text: “Remote when needed. Local by default.”
Voice-over: “Khi cần, relay phản chiếu phiên tới điện thoại. Cookie, khóa và quyền browser vẫn ở máy local.”

01:13-01:22 — EXTENSIBILITY
Return to the core diagram. Animate exactly three small modules attaching without changing the core: `profile.json` for a model, `adapter.ts` for a protocol, `skill.md` for a role. The core remains stable while the capability field expands outward.
On-screen text: “Profile · Adapter · Skill”.
Voice-over: “Model mới là một profile. Protocol mới là một adapter. Vai trò mới có thể chỉ là một skill Markdown.”

01:22-01:30 — END CARD
Use the exact logo from Assets 01/02. Show these commands one at a time in large readable monospace, never both as tiny text:
Windows: `irm https://neko.holilihu.online/install.ps1 | iex`
macOS/Linux: `curl -fsSL https://neko.holilihu.online/install.sh | sh`
Finish with: `github.com/meiiie/neko-core`
Voice-over: “Neko Core. Build locally. Extend without limits.”
End on one amber cursor blink and clean silence.

VISUAL DIRECTION
- Premium, sparse, terminal-native, dark developer/tooling identity.
- Palette: #181920 near-black, #F2F2F4 off-white, #F5A026 amber, #20CFD0 cyan, #45D267 verified green, red only for blocked danger.
- Monospace-first typography similar to Cascadia Mono / JetBrains Mono; system sans only for large Vietnamese narration cards.
- Strong grid, generous negative space, thin rules, tiny page-number details, mild CRT grain, no excessive glow.
- Motion is fast but not frantic: precise cursor moves, line reveals, controlled pans, 180-260 ms micro-transitions, longer 600-900 ms scene transitions.
- Use hard cuts on terminal keystrokes and soft match cuts on the amber pixel mark.

ABSOLUTE NEGATIVE CONSTRAINTS
- No generic purple-blue AI gradient, floating orb, humanoid robot, holographic brain, neural-network stock footage, cyberpunk city, random code rain, anime cat, realistic cat or paw icon.
- No fake Neko dashboard, fake browser UI, fake code, altered terminal text or unreadable tiny filler copy.
- No OpenAI, Anthropic, Google, Claude, Codex or Gemini logos. Neko is provider-agnostic; do not imply endorsement.
- No claims of SOTA, AGI, perfect autonomy, unlimited access, zero errors, replacing humans, or controlling everything without permission.
- No secrets, real QR codes, access tokens, API keys, emails, usernames, cookies, personal browser tabs, Messenger content or private file names.
- Do not add features not listed in PRODUCT TRUTH.
- Do not modify, smooth, vectorize or reinterpret the canonical pixel logo.

FINAL QUALITY CHECK BEFORE RENDER
Verify that the exact supplied logo is used consistently; Asset 04 remains unaltered; all Vietnamese diacritics are correct; subtitles match voice-over; every product claim is supported by PRODUCT TRUTH; install commands and GitHub URL are exact; no private or secret material appears; all text is readable on a phone-sized preview.
```

## Checklist duyệt video

- Logo có đúng pixel, đúng amber, không bị Gemini “vẽ đẹp lại”.
- Ảnh terminal thật không bị thay chữ hoặc tạo UI giả.
- Không xuất hiện QR/token/email/cookie/tab cá nhân.
- Không dùng logo của provider khác.
- Tiếng Việt đủ dấu; subtitle khớp voice-over.
- Install command và GitHub URL chính xác tuyệt đối.
- Xem ở kích thước điện thoại vẫn đọc được chữ.
- Không có claim SOTA/AGI/“không giới hạn quyền” hoặc tự động hóa không cần phê duyệt.
