# Tạo ảnh cho terminal agent với thuê bao ChatGPT Plus/Pro

**Hạn chốt kiến thức:** 28/07/2026  
**Trạng thái:** Hoàn tất  
**Phạm vi:** Khả năng tạo ảnh mà Neko Core có thể cung cấp khi người dùng có ChatGPT Plus/Pro nhưng không có billing API riêng.  
**Kết luận:** Có một đường hợp lệ: Neko điều khiển Codex app-server và dùng built-in `image_gen.imagegen` theo hạn mức Codex của thuê bao. Plus/Pro không cấp OpenAI API quota.

## Mục lục

1. [Câu hỏi và tiêu chí kiểm chứng](#1-câu-hỏi-và-tiêu-chí-kiểm-chứng)
2. [OpenAI: model, endpoint và công cụ tạo ảnh mới nhất](#2-openai-model-endpoint-và-công-cụ-tạo-ảnh-mới-nhất)
3. [ChatGPT Plus/Pro có mở đường cho client bên ngoài không?](#3-chatgpt-pluspro-có-mở-đường-cho-client-bên-ngoài-không)
4. [Cách các terminal agent khác hỗ trợ tạo ảnh](#4-cách-các-terminal-agent-khác-hỗ-trợ-tạo-ảnh)
5. [Các phương án thay thế cho Neko Core](#5-các-phương-án-thay-thế-cho-neko-core)
6. [Phản chứng, giới hạn và câu hỏi còn mở](#6-phản-chứng-giới-hạn-và-câu-hỏi-còn-mở)
7. [Khuyến nghị cho Neko Core](#7-khuyến-nghị-cho-neko-core)
8. [Nhật ký phát hiện](#8-nhật-ký-phát-hiện)
9. [Nguồn gốc](#9-nguồn-gốc)

## 1. Câu hỏi và tiêu chí kiểm chứng

- Xác định model/endpoint/công cụ tạo ảnh chính thức mới nhất của OpenAI tính đến 28/07/2026.
- Phân biệt rõ quyền lợi ChatGPT Plus/Pro với quyền truy cập và billing của OpenAI API.
- Kiểm tra Codex app-server/CLI có cung cấp image-generation tool hay backend hợp lệ cho client bên ngoài hay không.
- Đối chiếu cách Claude Code, Gemini CLI và Codex CLI tạo ảnh hoặc nối tới công cụ tạo ảnh.
- Nếu thuê bao ChatGPT không cung cấp đường tích hợp hợp lệ, xếp hạng ba kiến trúc khả thi cho Neko Core.
- Mỗi kết luận quan trọng cần nguồn gốc đã đọc, ngày nguồn, mức tin cậy và tối thiểu hai bằng chứng độc lập khi có thể.

## 2. OpenAI: model, endpoint và công cụ tạo ảnh mới nhất

- [verified] Guide Image generation hiện hành của OpenAI gọi `gpt-image-2` là GPT Image model mới nhất; cùng họ còn có `gpt-image-1.5`, `gpt-image-1` và `gpt-image-1-mini`. Model catalog mô tả GPT Image 2 là model tạo/sửa ảnh state-of-the-art và có snapshot `gpt-image-2-2026-04-21`.
- [verified] OpenAI công bố trải nghiệm **ChatGPT Images 2.0** ngày 21/04/2026. Đây là tên sản phẩm trong ChatGPT; blog không nêu API model ID. Sự trùng ngày với snapshot `gpt-image-2-2026-04-21` là bằng chứng hội tụ, nhưng tài liệu đang đọc chưa có câu mapping trực tiếp hai tên này.
- [verified] OpenAI mô tả hai đường API chính: Image API (`POST /v1/images/generations`, `POST /v1/images/edits`) và built-in tool `image_generation` của Responses API. Image API cho phép chọn GPT Image model trực tiếp; Responses API nhận một mainline model tương thích và tự chọn GPT Image model phía dưới.
- [verified] Guide nói Generations/Edits có từ `gpt-image-1` trở lên; tool của Responses API được kỳ vọng trên `gpt-5` trở lên nhưng phải kiểm tra model page cụ thể. Organization Verification có thể được yêu cầu cho cả bốn GPT Image model.
- [verified] Model page cho `gpt-image-2` liệt kê Image generation và Image edit là endpoint được hỗ trợ, alias mặc định `gpt-image-2`, snapshot ngày 21/04/2026; API free tier ghi `Not supported`. Model page hiển thị nhiều endpoint trong catalog, nhưng không nên diễn giải dấu hiệu catalog đó thành việc gọi trực tiếp `gpt-image-2` qua Responses — guide nói Responses tự chọn image model bên dưới.
- [verified] **Sora không phải endpoint tạo ảnh tĩnh.** Guide Sora 2 nhận text/image nhưng xuất video có audio qua `/v1/videos`; thumbnail WebP và spritesheet JPEG chỉ là phụ phẩm của video. Model page ghi Image = input only, Video/Audio = output only. Dòng “Image generation” trong bảng endpoint tổng quát không thắng được mô tả modality và guide chuyên biệt. Tính đến hạn chốt, Sora 2 là `Legacy` nhưng chưa tới ngày shutdown 24/09/2026.

## 3. ChatGPT Plus/Pro có mở đường cho client bên ngoài không?

- [verified] **Thuê bao ChatGPT Plus/Pro không bao gồm OpenAI API quota.** OpenAI nói API được billing và quản lý riêng với ChatGPT; muốn dùng pay-as-you-go phải thêm payment method trong API account. Vì vậy không thể lấy API key thường rồi kỳ vọng `gpt-image-2`/Responses dùng hạn mức Plus/Pro.
- [verified] **Codex là ngoại lệ hợp lệ theo surface subscription, không phải API quota.** OpenAI nói Codex có thể tạo/sửa ảnh; Plus/Pro đăng nhập Codex bằng tài khoản ChatGPT. Codex rate card áp dụng cho Plus/Pro và liệt kê `GPT-Image-2.0 (image)`/`(text)` theo Codex credits. ChatGPT image limits được nói rõ là tách khỏi Codex limits.
- [verified] ChatGPT Images 2.0 có trên mọi tier; “Images with thinking” có trên Plus/Pro/Business. Surface người dùng được liệt kê là web, iOS, Android; Help Center không công bố endpoint cho client tùy ý. Đường client ngoài được công bố riêng là **Codex**, qua tài khoản ChatGPT và hạn mức Codex.
- [verified] Codex docs công bố skill `$imagegen`, dùng built-in `gpt-image-2`; generation tính vào general Codex usage limits. Với batch lớn, docs hướng dẫn đặt `OPENAI_API_KEY` và dùng Image API, khi đó API pricing áp dụng.
- [verified] **Codex app-server có image-generation tool thật:** namespace `image_gen`, function `imagegen`, capability flag `imageGeneration`. Client app-server dùng `thread/start` + `turn/start`; khi hoàn tất nhận `ThreadItem::ImageGeneration` với base64 `result` và `savedPath`.
- [verified] Test gốc của `openai/codex` chạy với file-backed ChatGPT auth, chủ động bỏ `OPENAI_API_KEY`, rồi gửi generation/edit tới `/api/codex/images/generations` và `/api/codex/images/edits` trên mock ChatGPT base URL. Production constant là `https://chatgpt.com/backend-api/codex`, nên implementation hiện ghép thành `/images/generations` và `/images/edits` dưới base này. Đây là backend nội bộ của **Codex provider**, không phải quota API Platform.
- [verified] Đường tích hợp hợp lệ cho Neko là điều khiển Codex app-server/protocol; **không** gọi thẳng `chatgpt.com/backend-api` hoặc sao chép token/cookie. Source cho thấy endpoint nội bộ nhưng không biến nó thành public API contract.
- [verified] Runtime cài trên máy ngày 28/07/2026 là Codex CLI `0.144.5`; `codex features list` ghi `image_generation` ở trạng thái `stable`. `codex app-server` hỗ trợ stdio/WebSocket và sinh TypeScript/JSON Schema bindings. JSON-RPC `modelProvider/capabilities/read` trả `imageGeneration: boolean`, cho phép client fail closed trước khi tạo ảnh.
- [verified] **Không nên bọc trực tiếp private `backend-api` bằng cookie/token.** Terms of Use 01/01/2026 cấm tự động/programmatic extraction, chia sẻ account credential, né rate limit/protective measures; Help cho Pro còn cấm dùng ChatGPT để power third-party services. App-server/SDK Codex là product boundary được OpenAI công bố; URL backend chỉ là implementation detail.

## 4. Cách các terminal agent khác hỗ trợ tạo ảnh

| Agent | Native/subscription path | Cơ chế mở rộng | Billing/quota thực tế |
|---|---|---|---|
| Codex CLI | Có: `$imagegen` / `image_gen.imagegen` | App-server protocol, direct tool hoặc code-mode | Codex usage/credits của ChatGPT plan |
| Claude Code | Không có native imagegen được công bố | MCP/plugin/custom tool trả image/file | Thuộc generator bên ngoài |
| Gemini CLI | Extension `nanobanana`, không nằm trong core | MCP stdio `generate_image`/`edit_image` | Gemini API key riêng; image models không có free tier |

### 4.1. Codex CLI

- [verified] Codex hỗ trợ tạo và sửa ảnh bằng yêu cầu ngôn ngữ tự nhiên hoặc gọi `$imagegen` rõ ràng; ảnh tham chiếu có thể đưa vào interactive session bằng `-i`/`--image`.
- [verified] Built-in path dùng `gpt-image-2` và tiêu thụ Codex usage limits của thuê bao. Docs ước tính image generation tiêu thụ included limits nhanh hơn khoảng 3–5× so với turn tương đương không tạo ảnh, tùy kích thước/chất lượng.
- [verified] Source bổ sung phần docs còn thiếu: tool schema là `image_gen.imagegen`; request tối thiểu có `prompt`, edit nhận `referenced_image_paths` hoặc `num_last_images_to_include`; app-server item trả raw base64 PNG và đường file đã lưu.
- [verified] App-server protocol công khai capability `imageGeneration`; test tích hợp chứng minh cả direct-tool mode lẫn code-mode (`tools.image_gen__imagegen(...)`) qua `thread/start`/`turn/start`.
- [verified] Kiểm tra runtime Codex CLI `0.144.5` xác nhận feature `image_generation` đã `stable`; app-server có transport stdio/WebSocket và generator cho protocol bindings.

### 4.2. Claude Code

- [verified] Claude/Claude Code hỗ trợ **ảnh đầu vào**: paste/drag/attach ảnh để phân tích. Tài liệu Vision và changelog nói về image input, không công bố model tạo ảnh đầu ra native.
- [verified] Cơ chế mở rộng chính thức là MCP/plugin/custom tool. Claude Code nối local stdio hoặc remote HTTP MCP; tool có thể trả image/file content blocks và Claude tiếp tục agent loop.
- [open] Không tìm thấy `imagegen`, `generate_image` hay “image generation” tool trong repo/changelog `anthropics/claude-code` ở lần kiểm tra 28/07/2026. Kết luận thực dụng: **không có native subscription-backed imagegen được công bố**; muốn tạo ảnh phải nối dịch vụ/API/local generator riêng. Tin cậy: trung bình vì đây là kết luận từ docs/repo không có feature, không phải tuyên bố “không hỗ trợ” của Anthropic.
- Hệ quả cho Neko: pattern Claude Code là “agent gọi MCP/tool bên ngoài”, không giải quyết bài toán billing; credential/quota thuộc generator mà MCP server sử dụng.

### 4.3. Gemini CLI

- [verified] Gemini CLI catalog phân phối extension `nanobanana` v1.0.12; cài bằng `gemini extensions install https://github.com/gemini-cli-extensions/nanobanana`.
- [verified] Extension là MCP server stdio, cung cấp `generate_image`, `edit_image`, `restore_image` và slash commands như `/generate`, `/edit`, `/diagram`.
- [verified] **Extension v1.0.12 đang stale ở model ID:** default `gemini-3.1-flash-image-preview` và tùy chọn `gemini-3-pro-image-preview` đã shutdown 25/06/2026. Stable replacements là `gemini-3.1-flash-image` và `gemini-3-pro-image`; có thể tạm override `NANOBANANA_MODEL`, nhưng manifest/README cần được upstream sửa. Snapshot `main` mới nhất kiểm tra được là 07/03/2026, trước thông báo deprecation 28/05.
- [verified] Đây **không** phải quota đăng nhập Gemini CLI được tái sử dụng: manifest yêu cầu một Gemini API key nhạy cảm (`NANOBANANA_API_KEY`); source fallback qua các env key rồi gọi `@google/genai`. Không có key thì extension báo lỗi auth. Pricing hiện ghi Free Tier `Not available` cho cả bốn Nano Banana model.
- [verified] Ảnh được ghi thành file (mặc định dưới `./nanobanana-output/`), tên sinh từ prompt; PNG là format phổ biến, một số lệnh hỗ trợ JPEG/grid/separate.
- Pattern kiến trúc: agent core + extension MCP + provider API key riêng. So với Codex, Gemini CLI có distribution UX tốt nhưng không giải quyết billing bằng subscription CLI; default stale cho thấy model-ID churn là rủi ro vận hành cần health check.

## 5. Các phương án thay thế cho Neko Core

### 5.1. NVIDIA NIM / API Catalog

- [verified] NVIDIA Visual GenAI NIM hỗ trợ FLUX.1 Dev/Kontext/Schnell, FLUX.2-klein-4B, Stable Diffusion 3.5 Large, Qwen-Image/Qwen-Image-Edit; có OpenAI-compatible image generation/edit APIs.
- [verified] Hosted API Catalog có **trial credits**, nhưng tài liệu NVIDIA hiện hành không công bố một quota miễn phí bền vững, số credit hay SLA. Bài NVIDIA 29/07/2024 chỉ xác nhận free credits để thử NVIDIA-hosted endpoints.
- [verified] Downloadable NIM miễn phí cho NVIDIA Developer Program chỉ dành development/testing/research, giới hạn tối đa 2 node hoặc 16 GPU. Production đi theo NVIDIA AI Enterprise (có trial 90 ngày), nên đây không phải backend miễn phí lâu dài cho sản phẩm.
- Đánh giá: dễ bọc nhờ OpenAI-compatible API và model mới, nhưng quota trial có thể hết/đổi; phù hợp demo/fallback tạm, không làm default không-billing.

### 5.2. Google Gemini API / Nano Banana

- [verified] Gemini API có Nano Banana 2 Lite (`gemini-3.1-flash-lite-image`), Nano Banana 2 (`gemini-3.1-flash-image`), Nano Banana Pro (`gemini-3-pro-image`) và legacy `gemini-2.5-flash-image`; hỗ trợ Interactions/generateContent/Batch APIs.
- [verified] Pricing 28/07/2026 ghi **Free Tier: Not available** cho cả bốn image model. Google AI Studio UI có thể miễn phí tại vùng hỗ trợ, nhưng programmatic Gemini Developer API cần paid tier/billing.
- [verified] Giá thấp nhất được công bố là Nano Banana 2 Lite batch khoảng `$0.0168`/ảnh 1K; standard khoảng `$0.0336`/ảnh 1K. Đây là API rẻ, không phải no-billing path.
- Đánh giá: fallback paid rẻ và API sạch; không đáp ứng điều kiện “chỉ có ChatGPT Plus/Pro, không billing API”.

### 5.3. Local ComfyUI + open weights

- [verified] ComfyUI chạy local/offline, hỗ trợ Windows portable/desktop/manual install và NVIDIA/AMD/Intel/Apple Silicon/CPU. Workflow lưu JSON; local server nhận `POST /prompt`, có `/history/{prompt_id}`, `/view`, `/queue`, `/interrupt` và WebSocket `/ws`.
- [verified] **Default chất lượng/giấy phép tốt cho máy đủ VRAM:** FLUX.2 [klein] 4B, khoảng 13GB VRAM, Apache 2.0, dùng thương mại miễn phí, hỗ trợ text-to-image, editing và tối đa bốn ảnh tham chiếu; có integration ComfyUI chính thức.
- [verified] **Low-VRAM fallback:** ComfyUI có smart offloading/`--lowvram`/CPU path và vẫn hỗ trợ SDXL/SD1.x/FLUX, nhưng latency tăng mạnh. Không nên hứa FLUX.2 4B trên máy 4–8GB chỉ vì ComfyUI có thể offload.
- Bằng chứng máy nghiên cứu: GTX 1650 4GB; không đạt ngưỡng ~13GB của FLUX.2 [klein] 4B. Với cấu hình này, local path chỉ hợp SD1.5/SDXL đã tối ưu hoặc offload chậm, không phải trải nghiệm mặc định.
- Đánh giá: không phí theo request, riêng tư và provider-independent; đổi lại cần download weights lớn, quản lý workflow/model/license, kiểm tra GPU và chịu cold start/latency.

## 6. Phản chứng, giới hạn và câu hỏi còn mở

- [refuted] Giả thuyết “Plus/Pro không mở bất kỳ đường tạo ảnh nào cho terminal client” là sai. Codex app-server là đường chính thức, dùng ChatGPT auth và Codex credits.
- [verified] Giả thuyết “Plus/Pro cấp API quota” là sai. API Platform có billing riêng; Image API và Responses API cần API account/billing.
- [verified] Gọi thẳng `chatgpt.com/backend-api/codex` bằng cookie/token hoặc browser automation không phải phương án sản phẩm: private contract, dễ vỡ và có rủi ro Terms. Neko phải đứng sau Codex app-server/SDK.
- [verified] Không tìm thấy cloud image API miễn phí bền vững phù hợp default: NVIDIA là trial credits; Gemini Nano Banana không có API free tier; Comfy Cloud API cần Creator/Pro.
- [open] Chưa chạy một generation thật từ Neko qua app-server vì nghiên cứu không được phép mặc định tiêu Codex credits. Prototype phải kiểm tra `modelProvider/capabilities/read` rồi xin/hiển thị chi phí hạn mức theo UX hiện hành.
- [open] Codex credit rate, availability theo plan/workspace/region và model routing có thể đổi. Feature detection và lỗi runtime phải là nguồn sự thật, không hard-code quota.
- [open] Chưa benchmark latency/chất lượng local trên các tier GPU. Máy nghiên cứu 4GB không đại diện cho cấu hình 13GB+; cần đo riêng trước khi chọn workflow local mặc định.
- [open] Phủ định tuyệt đối về native Claude imagegen vẫn có độ tin cậy trung bình; nên kiểm lại release notes khi Anthropic thêm capability mới.

## 7. Khuyến nghị cho Neko Core

| Hạng | Phương án | Đáp ứng “Plus/Pro, không API billing” | Kết luận |
|---:|---|---|---|
| 1 | Codex app-server bridge | Có | Làm trước |
| 2 | Local ComfyUI adapter | Có, nếu máy đủ tài nguyên | Fallback tùy chọn |
| 3 | Provider cloud adapter | Không bền vững: trial hoặc paid | Chỉ opt-in |

### Hạng 1 — Codex app-server bridge

Đây là phương án đúng với trường hợp người dùng đang có ChatGPT Plus/Pro. Neko không gọi OpenAI API và không đụng token/cookie. Adapter khởi chạy `codex app-server --stdio`, gọi `modelProvider/capabilities/read`, rồi chỉ đăng ký tool khi `imageGeneration=true`. Một turn dùng `thread/start` + `turn/start`; kết quả lấy từ `ThreadItem::ImageGeneration.result`/`savedPath` và được chép vào đường dẫn workspace do Neko kiểm soát.

- Giữ `ImageGenerationPort` trong core và implementation Codex ở adapter để không phá dependency-inward.
- Yêu cầu Codex CLI tối thiểu có feature stable; vẫn feature-detect thay vì chỉ so version.
- Để Codex tự quản ChatGPT login/refresh. Neko chỉ hiển thị hướng dẫn `codex login` khi account chưa sẵn sàng.
- Không fallback âm thầm sang API key có tính phí.
- Acceptance: generate PNG, edit bằng ảnh tham chiếu, capability=false thì ẩn tool, usage-limit/auth error được báo rõ, test mock app-server không cần network/credits.

### Hạng 2 — Local ComfyUI adapter

Đây là fallback riêng tư và không phí theo request. Neko kết nối một ComfyUI server do người dùng chủ động cài/chạy, gửi workflow JSON qua `/prompt`, theo dõi `/ws` hoặc `/history/{prompt_id}`, rồi tải output qua `/view`.

- Không bundle hay tự tải weights lớn. Cung cấp health check, URL config và workflow templates có version.
- Với khoảng 13GB VRAM trở lên, đề xuất FLUX.2 [klein] 4B. Với máy thấp hơn, yêu cầu người dùng chọn workflow/model tương thích; không tuyên bố FLUX.2 chạy tốt nhờ offload.
- Ghi model ID, workflow hash, seed, license và thời gian chạy vào metadata artifact.
- Acceptance: server offline vẫn tạo được artifact, cancel/timeout hoạt động, OOM trả lỗi có hướng dẫn, không có request ra cloud khi `--disable-api-nodes` được bật.

### Hạng 3 — Provider cloud adapter

Giữ một adapter opt-in cho user-supplied key: NVIDIA NIM/OpenAI-compatible endpoint, Gemini Nano Banana stable IDs, hoặc BFL API. Đây là lựa chọn cuối vì NVIDIA credits chỉ là trial và Gemini image API cần billing.

- Credential chỉ đến từ env/secret store; không lưu vào config hay log.
- Model catalog phải có health check/deprecation check. Sự cố Nano Banana preview IDs là test case bắt buộc.
- UI phải ghi rõ `trial`, `paid`, giá ước tính và provider trước khi request; không gọi khi người dùng chưa bật profile.
- Acceptance: provider timeout/retry tách biệt, model-deprecated lỗi trước generation, không rơi từ free/trial sang paid mà không có consent.

### Quyết định

Triển khai hạng 1 trước. Thiết kế port ngay từ đầu để cắm hạng 2 mà không đổi agent loop. Hạng 3 chỉ nên xuất hiện như profile tùy chọn. Loại bỏ browser automation và direct `backend-api` khỏi backlog.

### Checkpoint 28/07/2026

Hiểu biết tốt nhất hiện tại: Codex đã biến ChatGPT subscription thành một image-generation capability dùng được bởi terminal client qua app-server. Khoảng trống còn lại là implementation/UX của Neko và benchmark local, không còn là thiếu backend hợp lệ. Mở lại nghiên cứu khi Codex protocol, credit rate, GPT Image model, Gemini model IDs hoặc ComfyUI workflows thay đổi.

## 8. Nhật ký phát hiện

Các mục được ghi vào đây ngay sau mỗi phát hiện, trước khi chuyển sang bước nghiên cứu tiếp theo.

- **Phát hiện 1 — 28/07/2026:** Guide API chính thức hiện gọi `gpt-image-2` là model ảnh mới nhất và tài liệu hóa cả Image API lẫn Responses `image_generation`. Trạng thái ban đầu: `open`; đã nâng thành `verified` sau phát hiện 2.
- **Phát hiện 2 — 28/07/2026:** Blog OpenAI công bố ChatGPT Images 2.0 ngày 21/04/2026; model catalog có `gpt-image-2-2026-04-21`. Trạng thái: `verified`; tin cậy: cao cho tên/ngày từng surface, trung bình cho mapping một-một vì blog không nêu API ID.
- **Phát hiện 3 — 28/07/2026:** Sora 2 nhận ảnh làm input nhưng chỉ xuất video/audio; không có API output ảnh tĩnh độc lập. Trạng thái: `verified`; tin cậy: cao; nguồn: guide Sora và model page độc lập trong docs OpenAI.
- **Phát hiện 4 — 28/07/2026:** ChatGPT subscription không chuyển thành API credits/quota; hai hệ billing tách biệt. Trạng thái: `verified`; tin cậy: cao; hai bài Help Center OpenAI xác nhận độc lập.
- **Phát hiện 5 — 28/07/2026:** Codex là đường subscription chính thức để tạo/sửa ảnh: đăng nhập ChatGPT, dùng Codex credits, tách khỏi ChatGPT Images limits và API billing. Trạng thái: `verified`; tin cậy: cao; ba bài Help Center hội tụ.
- **Phát hiện 6 — 28/07/2026:** Codex có `$imagegen` built-in trên `gpt-image-2`; batch lớn chuyển sang API key/billing. Public docs không mô tả app-server/SDK protocol. Trạng thái ban đầu: `verified` cho feature, `open` cho cơ chế; cơ chế đã được phát hiện 7 xác minh bằng source.
- **Phát hiện 7 — 28/07/2026:** Codex app-server có `image_gen.imagegen`, capability `imageGeneration`, app-server item base64 + `savedPath`; test dùng ChatGPT auth và không dùng API key. Trạng thái: `verified`; tin cậy: cao; bằng chứng là implementation + integration test gốc.
- **Phát hiện 8 — 28/07/2026:** Codex CLI `0.144.5` cài trên máy xác nhận image generation là feature `stable` và app-server/protocol tooling sẵn dùng. Trạng thái: `verified`; tin cậy: cao; bằng chứng: lệnh runtime cục bộ.
- **Phát hiện 9 — 28/07/2026:** ChatGPT-auth provider của Codex dùng base `https://chatgpt.com/backend-api/codex`; image extension nối `images/generations|edits`. Trạng thái: `verified` như implementation detail; tin cậy: cao; không phải public contract.
- **Phát hiện 10 — 28/07/2026:** Gọi private backend bằng cookie/token không phải phương án tích hợp hợp lệ; Terms/Pro Help cấm extraction tự động, chia sẻ credential và né hạn mức. Trạng thái: `verified`; tin cậy: cao; trade-off: dùng app-server/SDK chính thức dù thêm dependency Codex.
- **Phát hiện 11 — 28/07/2026:** Claude Code không có native imagegen được công bố; nhận ảnh làm input và gọi external MCP/plugin/custom tool để tạo artifact. Trạng thái: `verified` cho cơ chế input/MCP, `open` cho phủ định tuyệt đối; tin cậy: cao/trung bình.
- **Phát hiện 12 — 28/07/2026:** Gemini CLI tạo ảnh qua extension MCP `nanobanana`, không phải core; default `gemini-3.1-flash-image-preview`, cần Gemini API key riêng, output ra file. Trạng thái: `verified`; tin cậy: cao; catalog + README + source + manifest hội tụ.
- **Phát hiện 13 — 28/07/2026:** NVIDIA NIM có stack image mạnh và OpenAI-compatible API, nhưng hosted “free” là trial credits; self-host miễn phí bị giới hạn mục đích, production cần license. Trạng thái: `verified`; tin cậy: cao; docs + NVIDIA blog hội tụ.
- **Phát hiện 14 — 28/07/2026:** Gemini Nano Banana API không có free tier; extension v1.0.12 vẫn trỏ preview IDs đã shutdown 25/06/2026. Trạng thái: `verified`; tin cậy: cao; pricing + changelog + source extension hội tụ.
- **Phát hiện 15 — 28/07/2026:** ComfyUI là local no-billing backend có API/queue/workflow; FLUX.2 [klein] 4B là default mở tốt ở ~13GB VRAM, nhưng máy 4GB hiện tại cần model nhẹ/offload chậm. Trạng thái: `verified`; tin cậy: cao; docs/source/model card/runtime hội tụ.
- **Phát hiện 16 — 28/07/2026:** Snapshot Nano Banana main ngày 07/03/2026 xác nhận extension chưa nhận model-ID migration tháng 5/6; Codex và ComfyUI snapshots được khóa SHA cùng ngày nghiên cứu. Trạng thái: `verified`; tin cậy: cao.
- **Phát hiện 17 — 28/07/2026:** App-server công bố `modelProvider/capabilities/read` với flag `imageGeneration`, đủ để Neko feature-detect thay vì phụ thuộc version string. Trạng thái: `verified`; tin cậy: cao.

## 9. Nguồn gốc

1. OpenAI, “Image generation”, không ghi ngày trang, truy cập 28/07/2026: https://platform.openai.com/docs/guides/image-generation
2. OpenAI, “Introducing ChatGPT Images 2.0”, 21/04/2026, truy cập 28/07/2026: https://openai.com/index/introducing-chatgpt-images-2-0/
3. OpenAI API, “GPT Image 2 Model”, không ghi ngày trang; snapshot ngày 21/04/2026, truy cập 28/07/2026: https://developers.openai.com/api/docs/models/gpt-image-2
4. OpenAI API, “Video generation with Sora”, không ghi ngày trang; có thông báo shutdown 24/09/2026, truy cập 28/07/2026: https://developers.openai.com/api/docs/guides/video-generation
5. OpenAI API, “Sora 2 Model”, không ghi ngày trang, truy cập 28/07/2026: https://developers.openai.com/api/docs/models/sora-2
6. OpenAI Help Center, “How can I move my ChatGPT subscription to the API?”, cập nhật 14/07/2026, truy cập 28/07/2026: https://help.openai.com/en/articles/8156019-how-can-i-move-my-chatgpt-subscription-to-the-api
7. OpenAI Help Center, “Managing Billing Settings on ChatGPT Web and Platform”, cập nhật 14/07/2026, truy cập 28/07/2026: https://help.openai.com/en/articles/9039756-managing-billing-settings-on-chatgpt-web-and-platform
8. OpenAI Help Center, “Codex rate card”, cập nhật 28/07/2026 theo trang, truy cập 28/07/2026: https://help.openai.com/en/articles/20001106
9. OpenAI Help Center, “Using Codex with your ChatGPT plan”, cập nhật 27/07/2026 theo trang, truy cập 28/07/2026: https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan
10. OpenAI Help Center, “Images in ChatGPT”, cập nhật 18/07/2026, truy cập 28/07/2026: https://help.openai.com/en/articles/11084440-images-in-chatgpt
11. OpenAI Learn, “Create and edit images”, không ghi ngày trang, truy cập 28/07/2026: https://learn.chatgpt.com/docs/image-generation
12. OpenAI Codex source, image-generation backend, truy cập 28/07/2026: https://github.com/openai/codex/blob/main/codex-rs/ext/image-generation/src/backend.rs
13. OpenAI Codex source, Images endpoint client, truy cập 28/07/2026: https://github.com/openai/codex/blob/main/codex-rs/codex-api/src/endpoint/images.rs
14. OpenAI Codex integration test, app-server imagegen extension, truy cập 28/07/2026: https://github.com/openai/codex/blob/main/codex-rs/app-server/tests/suite/v2/imagegen_extension.rs
15. OpenAI Codex app-server schema, provider capability `imageGeneration`, truy cập 28/07/2026: https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/schema/typescript/v2/ModelProviderCapabilitiesReadResponse.ts
16. OpenAI Codex source, model provider constants, truy cập 28/07/2026: https://github.com/openai/codex/blob/main/codex-rs/model-provider-info/src/lib.rs
17. OpenAI Help Center, “About ChatGPT Pro tiers”, cập nhật 23/07/2026, truy cập 28/07/2026: https://help.openai.com/en/articles/9793128-what-is-chatgpt-pro
18. OpenAI, “Terms of Use”, hiệu lực 01/01/2026, truy cập 28/07/2026: https://openai.com/policies/terms-of-use/
19. Anthropic, “Vision”, không ghi ngày trang, truy cập 28/07/2026: https://platform.claude.com/docs/en/build-with-claude/vision
20. Anthropic, “Connect Claude Code to tools via MCP”, không ghi ngày trang, truy cập 28/07/2026: https://code.claude.com/docs/en/mcp
21. Anthropic Claude Code changelog/repository, truy cập 28/07/2026: https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md
22. Gemini CLI, “Browse Extensions”, bản `nanobanana` 1.0.12, truy cập 28/07/2026: https://geminicli.com/extensions/
23. Gemini CLI Extensions, Nano Banana README, truy cập 28/07/2026: https://github.com/gemini-cli-extensions/nanobanana/blob/main/README.md
24. Gemini CLI Extensions, Nano Banana `imageGenerator.ts`, truy cập 28/07/2026: https://github.com/gemini-cli-extensions/nanobanana/blob/main/mcp-server/src/imageGenerator.ts
25. Gemini CLI Extensions, Nano Banana manifest, truy cập 28/07/2026: https://github.com/gemini-cli-extensions/nanobanana/blob/main/gemini-extension.json
26. NVIDIA, “About NVIDIA NIM for Visual Generative AI”, docs latest, truy cập 28/07/2026: https://docs.nvidia.com/nim/visual-genai/latest/overview.html
27. NVIDIA, “Visual Generative AI NIM API Reference”, docs latest, truy cập 28/07/2026: https://docs.nvidia.com/nim/visual-genai/latest/api/index.html
28. NVIDIA Technical Blog, “Access to NVIDIA NIM Now Available Free to Developer Program Members”, 29/07/2024, truy cập 28/07/2026: https://developer.nvidia.com/blog/access-to-nvidia-nim-now-available-free-to-developer-program-members/
29. Google AI for Developers, Gemini API changelog, entry 28/05/2026, truy cập 28/07/2026: https://ai.google.dev/gemini-api/docs/changelog
30. Google AI for Developers, “Gemini Developer API pricing”, truy cập 28/07/2026: https://ai.google.dev/gemini-api/docs/pricing
31. Google AI for Developers, “Nano Banana image generation”, docs current, truy cập 28/07/2026: https://ai.google.dev/gemini-api/docs/image-generation
32. Comfy-Org, ComfyUI README, truy cập 28/07/2026: https://github.com/Comfy-Org/ComfyUI
33. ComfyUI Docs, “Routes”, truy cập 28/07/2026: https://docs.comfy.org/development/comfyui-server/comms_routes
34. Black Forest Labs, “How do I generate quickly with FLUX.2 [klein]?”, cập nhật 06/2026, truy cập 28/07/2026: https://help.bfl.ai/articles/7592221790-how-do-i-generate-quickly-with-flux-2-klein
35. Black Forest Labs, FLUX.2 [klein] 4B model card, truy cập 28/07/2026: https://huggingface.co/black-forest-labs/FLUX.2-klein-4B
36. Snapshot repository: `openai/codex@bb1af235` (28/07/2026), `gemini-cli-extensions/nanobanana@5badc5aa` (07/03/2026), `Comfy-Org/ComfyUI@cd0eddaf` (28/07/2026): https://github.com/openai/codex/commit/bb1af235ea2822d7a40f75ef52e4d6a2cde84da2 · https://github.com/gemini-cli-extensions/nanobanana/commit/5badc5aafea8751fe059a054b629cf2d989bceb1 · https://github.com/Comfy-Org/ComfyUI/commit/cd0eddaf161656a4a38db4ec7f5d8c4eba6168f5
37. OpenAI Codex app-server README/protocol method `modelProvider/capabilities/read`, snapshot 28/07/2026: https://github.com/openai/codex/blob/bb1af235ea2822d7a40f75ef52e4d6a2cde84da2/codex-rs/app-server/README.md
