# Live Camera Coach cho Neko Core

> Ledger nghiên cứu sống — cập nhật đến 2026-07-29.
>
> Quy ước bằng chứng: `[verified]` = claim cốt lõi có ít nhất hai nguồn độc lập;
> `[supported]` = có một nguồn sơ cấp/kiểm chứng trực tiếp đáng tin;
> `[inference]` = suy luận kỹ thuật từ bằng chứng đã nêu; `[open]` = chưa đủ bằng chứng.
> Mỗi nguồn ghi ngày công bố/cập nhật nếu có và ngày truy cập; `n.d.` nếu nguồn không công bố ngày.

## Câu hỏi và tiêu chí chấp nhận

Làm sao Neko Core kết nối camera điện thoại hoặc máy ảnh của người dùng để nhìn khung hình và coach tạo dáng
trực tiếp bằng giọng nói, tận dụng relay Cloudflare E2E, browser bridge/trang web tự phục vụ, Voice Realtime
v3 WebRTC và vision đọc ảnh hiện có?

Kết quả phải:

1. Kiểm toán implementation thật trong `cloudflare/` và các seam liên quan trong repo.
2. So sánh ít nhất A) camera web qua relay + snapshot, B) IP camera/RTSP, C) tethering Sony/Canon/gPhoto2,
   và D) một phương án tốt hơn nếu có.
3. Ước lượng vòng lặp nhìn → suy luận → nói, băng thông và ngưỡng đủ dùng cho người giữ dáng vài giây.
4. Phân tích privacy, consent, retention, failure modes và phạm vi dữ liệu đi qua từng trust boundary.
5. Kết thúc bằng “Kiến trúc khuyến nghị + lộ trình MVP”, xếp hạng ba phương án và chỉ rõ MVP nhỏ nhất chạy được.

## Giả thuyết ban đầu — kết quả phản chứng

- [supported] A — trang relay dùng `getUserMedia()`, gửi JPEG snapshot có nhịp độ — là MVP ít code nhất vì điện
  thoại đã pair và Neko đã có E2E + vision ảnh; cần media lane ephemeral, không tái dùng queue agent-turn.
- [inference] Stream video liên tục không cần cho vertical slice; sample-and-hold 0,5–1 fps, one-in-flight và
  drop-old có bandwidth/privacy/staleness tốt hơn. Chỉ benchmark thực tế mới chốt nhịp cuối.
- [inference] Cue đầu p50 ≤2 s và steady cue p50 ≤1,5 s là design target hợp lý khi người dùng giữ pose vài giây;
  không tìm thấy chuẩn công bố để nâng nó thành fact.
- [supported] RTSP/IP-camera và tethering có giá trị studio/pro nhưng tăng app/gateway/credential/device matrix;
  virtual webcam/UVC là nhánh máy ảnh thật ít code hơn SDK trực tiếp trên Windows.
- [supported] D — pose landmarks cục bộ + semantic keyframe — là kiến trúc đích mạnh về latency/bandwidth/privacy,
  nhưng thêm model/WASM/Web Worker/calibration nên đứng sau MVP A.

## Ledger phát hiện

### 1. Tài sản hiện có trong Neko Core

- [supported] Relay v5 là Cloudflare Worker + Durable Object; máy Neko chủ động mở WebSocket ra ngoài,
  điện thoại dùng HTTPS/WebSocket, nên không cần mở inbound port hay cùng LAN. Worker có queue khi host offline,
  partial reply, interrupt và mirror/replay. Nguồn: `cloudflare/relay/README.md`, `cloudflare/relay/worker.js`
  (repo tại 2026-07-29).
- [supported] Payload hội thoại/metadata được seal ở hai đầu bằng AES-256-GCM; secret nằm trong URL fragment,
  không gửi tới Worker. Wire format hiện là JSON `{iv, ct}` chứa UTF-8/base64, không phải kênh binary/media.
  Nguồn: `src/adapters/relay-crypto.ts`, `cloudflare/relay/client.html`, `src/adapters/remote-relay.ts`
  (repo tại 2026-07-29).
- [supported] Worker chặn request và WebSocket frame trên 1.050.000 byte; durable mirror giữ tối đa 400 event,
  tổng ciphertext khoảng 1,5 MB. Client page hiện gửi text qua `/send`; host giải mã thành `string` rồi gọi
  `handlers.run()`. Nguồn: `cloudflare/relay/worker.js:36-45`, `src/adapters/remote-relay.ts:164-220`
  (repo tại 2026-07-29).
- [supported] Trang relay hiện **cấm camera và microphone** bằng `Permissions-Policy: camera=(), microphone=()`;
  CSP chỉ cho ảnh `data:` và kết nối cùng origin. Camera MVP phải thay policy/CSP có chủ đích, không thể chỉ thêm
  `getUserMedia()` vào JavaScript. Nguồn: `cloudflare/relay/worker.js:116-129` (repo tại 2026-07-29).
- [supported] Browser Bridge là adapter loopback `127.0.0.1` cho một tab Chrome trên máy Neko, giới hạn request
  64 KiB; page content/capability không đi qua relay. Nó hữu ích cho UI/consent pattern, nhưng không phải đường
  camera từ browser điện thoại về host. Nguồn: `docs/process/BROWSER-BRIDGE.md:57-81` (repo tại 2026-07-29).
- [supported] Vision bridge hiện nhận **một data URL** và gọi model vision với content item `image_url`; prompt
  mặc định tối ưu cho chép chữ/UI, chưa có pose schema, temporal state hay cue policy. Nguồn:
  `src/adapters/vision.ts:13-50` (repo tại 2026-07-29).
- [supported] Voice Realtime v3 hiện có hai transport: native Windows (mic PCM 24 kHz mono/50 ms qua App Server,
  phát bằng `ffplay`) và browser WebRTC. Browser page được host trên `127.0.0.1`; audio WebRTC đi browser↔OpenAI,
  còn loopback WebSocket chỉ điều khiển/heartbeat. Nó chưa được phục vụ qua Cloudflare relay cho điện thoại.
  Nguồn: `src/adapters/chatgpt-voice.ts:21-26,249-355,410-435,679-703`,
  `src/adapters/native-voice-audio.ts:34-39,117-205` (repo tại 2026-07-29).
- [inference] Không nên nhét frame camera vào `/send` hiện tại: đường này có semantics “một agent turn”, queue
  offline bền vững và mirror transcript; frame pose là dữ liệu ephemeral cần drop-old/keep-latest. Nên thêm message
  type/kênh media riêng, vẫn E2E, không durable, rate/size bounded. confidence=high; dựa trên code relay nêu trên.

### 2. Web camera, transport và media pipeline

- [verified] `getUserMedia()` chỉ dùng được trong secure context; trình duyệt phải xin quyền camera/microphone,
  có thể từ chối, không có thiết bị hoặc để promise chờ nếu người dùng không chọn. W3C còn yêu cầu chỉ báo quyền/capture
  và cho phép người dùng dừng/revoke. Nguồn độc lập: W3C Media Capture and Streams (living standard, truy cập
  2026-07-29), MDN `MediaDevices.getUserMedia()` (cập nhật 2025-06-23, truy cập 2026-07-29).
- [supported] `Permissions-Policy` mặc định cho `camera`/`microphone` là `self`, nhưng Neko đang chủ động đặt allowlist
  rỗng. MVP phải đổi thành camera cùng origin, vẫn giữ microphone tắt nếu chỉ phát TTS; nút **Bắt đầu coaching** là
  user gesture để xin camera và mở khóa audio trên mobile. Nguồn: W3C Media Capture and Streams; repo
  `cloudflare/relay/worker.js:116-129` (truy cập 2026-07-29).
- [inference] Frame đủ cho đánh giá bố cục/toàn thân nên bắt đầu ở 960×540 hoặc 1280×720, JPEG quality 0,65–0,75,
  rồi hạ quality/kích thước đến khi **ciphertext wire ≤ 200 KiB**. Đây là operational bound để tránh đụng trần app
  1,05 MB và giảm uplink; cần test riêng tay, mặt, ánh sáng và quần áo chi tiết.
- [inference] Media lane đề xuất: phone capture → canvas resize/encode → AES-GCM seal → WebSocket `media_frame` →
  Worker chuyển tiếp mù, không queue/mirror/store → host mở seal → vision → `coach_cue` E2E về phone. Mỗi frame có
  `session_id`, `seq`, `captured_at`, kích thước và orientation; host chỉ giữ **frame mới nhất**, tối đa một inference
  đang chạy, bỏ frame/cue đã stale.
- [supported] Cloudflare hiện cho WebSocket message tới 32 MiB, lớn hơn nhiều trần 1,05 MB do chính Neko đặt; việc
  platform cho phép lớn hơn không phải lý do tăng trần media. Nguồn: Cloudflare Durable Objects Limits (cập nhật
  2026-06-01, truy cập 2026-07-29), Cloudflare changelog “WebSocket message limit increased to 32 MiB”
  (2025-10-31, truy cập 2026-07-29).
- [inference] Không cần stream video liên tục vào VLM. Với người giữ pose vài giây, sample-and-hold 0,5–1 fps,
  event-driven và drop-old tạo vòng phản hồi hữu ích hơn một hàng đợi video: dữ liệu ít hơn, không có cue dựa trên
  tư thế đã bỏ, và trust boundary hẹp hơn.

### 3. Voice Realtime và vision loop

- [supported] Realtime v3 đang được negotiate rõ `version: "v3"`, `outputModality: "audio"`, transport WebRTC
  bằng SDP offer/answer; không tự hạ về V2. Nguồn: `src/adapters/chatgpt-voice.ts:410-435,470-500`
  (repo tại 2026-07-29).
- [supported] Browser voice page hiện chỉ xin **microphone audio**, add một audio track và tạo data channel
  `oai-events`; nó không có camera track, không gửi frame/cue qua data channel, và `/offer` chỉ nghe loopback.
  Nguồn: `src/adapters/chatgpt-voice.ts:679-703` (repo tại 2026-07-29).
- [inference] “Camera trên relay page + voice v3 hiện có” chưa phải phép ghép trực tiếp: trang relay ở public
  origin; voice consent page ở loopback origin và token/offer handler chỉ nghe localhost. Có ba mức ghép:
  (1) MVP nói cue bằng `speechSynthesis` ngay trên điện thoại; (2) stream cue text về một voice/TTS layer;
  (3) đưa signaling V3 qua relay E2E để WebRTC audio vẫn đi trực tiếp phone↔OpenAI. Mức (3) tận dụng V3 đầy đủ
  nhưng code/risk cao hơn rõ rệt.
- [supported] Public OpenAI Realtime API dùng WebRTC cho browser/mobile, có data channel cho event và nhận
  `input_image` bằng data URL trong một conversation item; model Realtime công bố image input nhưng không hỗ trợ
  video input. Nguồn: OpenAI “Realtime API with WebRTC”, “Realtime conversations” và model page `gpt-realtime`
  (truy cập 2026-07-29).
- [supported] Đường public API ở trên cần backend giữ standard API key và mint ephemeral token cho browser; đây là
  **sản phẩm/billing/trust boundary khác** với bridge ChatGPT-subscription + Codex App Server của Neko. Không được
  giả định API public chứng minh App Server v3 hiện tại nhận `input_image` hay chủ động phát một cue text giữa call.
  Nguồn: OpenAI “Realtime API with WebRTC”; `src/adapters/chatgpt-voice.ts:687-700` (truy cập 2026-07-29).
- [supported] OpenAI mô tả speech-to-speech phù hợp hội thoại tự nhiên, độ trễ thấp; pipeline nối chuỗi phù hợp khi
  cần transcript, kiểm soát và tái dùng text agent. Với pose coach, vision → cue text có cấu trúc → TTS là đường
  dễ kiểm thử nhất trước; speech-to-speech chỉ nên thêm khi người dùng cần đối thoại hai chiều. Nguồn: OpenAI
  “Voice agents” (truy cập 2026-07-29).

#### Cue contract đề xuất

- [inference] Vision không được trả một bài critique. Mỗi result gắn `frame_seq` và chỉ có một hành động ngắn:
  `{cue_vi, confidence, reason_code, next_sample_ms, stop_reason}`. `cue_vi` tối đa khoảng 12 từ, ưu tiên vai/cằm/
  tay/trọng tâm/định hướng mắt hoặc khoảng cách camera; cue phải nói “bên trái của bạn” sau khi đã hiệu chỉnh mirror.
- [inference] Chỉ phát cue khi confidence qua ngưỡng và khác cue gần nhất; khóa phát trong lúc câu trước đang nói,
  cho phép người dùng ngắt/dừng, và bỏ mọi result có `frame_seq` cũ. Low-confidence cue phải yêu cầu chỉnh camera/
  ánh sáng/đứng trọn khung thay vì đoán vị trí cơ thể.

### 4. IP camera/RTSP và tethering máy ảnh

#### B — IP camera/RTSP

- [supported] Browser không nhận RTSP trực tiếp như một camera track tiêu chuẩn; cần gateway/proxy đổi RTSP sang
  WebRTC/HLS hoặc trích JPEG cục bộ. MediaMTX công bố đúng use case ingest RTSP và phát WebRTC/HLS cho browser;
  FFmpeg có RTSP demuxer/input riêng. Nguồn độc lập: MediaMTX docs “Introduction” (n.d., truy cập 2026-07-29),
  FFmpeg Protocols Documentation — RTSP (n.d., truy cập 2026-07-29).
- [inference] Luồng thực tế là app IP-camera/camera → RTSP qua LAN/VPN → FFmpeg/MediaMTX trên máy Neko → snapshot
  → vision; cue vẫn quay về phone qua relay. Nó bỏ được upload frame qua Cloudflare khi camera cùng LAN, nhưng thêm
  app, địa chỉ/credential, firewall, codec và lỗi mạng; việc dùng phone như IP camera còn cạnh tranh camera/foreground
  với trang voice coach.
- [supported] MediaMTX hỗ trợ internal/HTTP/JWT auth và RTSP credential; URL/credential phải được coi là secret,
  không ghi log hoặc đưa vào model. Nguồn: MediaMTX Authentication (n.d., truy cập 2026-07-29).

#### C — máy ảnh Sony/Canon/gPhoto2

- [verified] Đường ít code nhất cho máy ảnh thật không phải SDK mà là **virtual webcam/UVC**: Sony Imaging Edge
  Webcam và Canon EOS Webcam Utility biến model hỗ trợ thành camera source cho ứng dụng máy tính; Neko chỉ cần lấy
  frame bằng browser/FFmpeg như một webcam. Nguồn độc lập: Sony Imaging Edge Webcam download/instructions và Canon
  EOS Webcam Utility updates/compatible apps (truy cập 2026-07-29).
- [supported] Sony Imaging Edge Webcam có danh sách model/OS cụ thể, output được Sony ghi là 1024×576 và không lấy
  microphone của camera; đây là preview đủ cho pose nhưng không đại diện chất lượng ảnh cuối. Nguồn: Sony Imaging
  Edge Webcam Instructions (n.d., truy cập 2026-07-29).
- [supported] Khi cần live view, shutter hoặc setting, Canon EDSDK hỗ trợ Windows/macOS và Canon CCAPI điều khiển
  qua HTTP/Wi‑Fi; Sony Camera Remote SDK hỗ trợ USB/Ethernet/Wi‑Fi theo model. Nguồn: Canon Developer Resources —
  SDK/CCAPI; Sony Camera Remote SDK (truy cập 2026-07-29).
- [supported] gPhoto2/libgphoto2 mạnh cho remote capture/live preview trên hệ Unix-like, nhưng upstream nói Microsoft
  OS hiện không có; matrix thiết bị do cộng đồng duy trì còn tự cảnh báo có thể thiếu/sai. Trên nền Windows hiện tại,
  gPhoto2 qua WSL/VM không phải mặc định MVP. Nguồn upstream: gPhoto Remote controlling cameras và libgphoto2 README
  (truy cập 2026-07-29).
- [inference] SDK trực tiếp chỉ đáng làm sau khi có nhu cầu pro rõ: auto-capture/shutter, đồng bộ ảnh chất lượng cao,
  hoặc điều khiển exposure/focus. Nếu chỉ cần nhìn để coach, virtual webcam giảm mạnh code nhưng đổi phần khó thành
  setup/compatibility phía người dùng.

### 5. Sản phẩm camera-coach hiện có

- [supported] Google Pixel Camera Coach dùng Gemini trên cloud, cần dữ liệu/Wi‑Fi, phân tích **preview chứ không phải
  ảnh cuối**, hỏi người dùng muốn nhấn vào chủ thể/ý định nào rồi đưa từng bước về framing, ánh sáng, bố cục, zoom và
  camera mode. Người dùng duyệt tip rồi tự bấm chụp. Nguồn chính thức:
  Google Blog “How to use Camera Coach” (2025-09-03) và Google Store “Camera Coach” (truy cập 2026-07-29).
- [supported] Google mô tả tính năng là quét scene theo thời gian thực và hiển thị visual prompts/contextual tips;
  họ **không** công bố voice loop liên tục, pose-body schema hoặc latency SLA. Vì vậy không được dùng Camera Coach
  để chứng minh cue dưới một giây. Nguồn: Google Blog “Pixel group photo features” (2025-10-06) và hai trang trên.
- [inference] Bài học có thể chuyển sang Neko là **intent-first + progressive cue**: hỏi “ảnh toàn thân/nhóm/chân dung,
  ai là chủ thể, máy cố định hay có người cầm”, rồi chỉ nói một thay đổi có thể làm ngay. Đây phù hợp hơn việc VLM
  mô tả cả khung hình trong một lượt.
- [supported] Một sản phẩm thương mại như Photogenik quảng bá live coaching cho pose/framing/light/expression,
  hands-free capture và xác nhận “hold the pose”; đây chỉ là tín hiệu thị trường từ vendor, không phải kiểm chứng độc
  lập về chất lượng hay latency. Nguồn: Photogenik product page (n.d., truy cập 2026-07-29).

### 5.1. D — on-device pose gate + remote vision keyframe

- [supported] MediaPipe Pose Landmarker cho Web/JavaScript chạy ở IMAGE hoặc VIDEO mode và trả 33 landmark chuẩn
  hóa cùng world coordinates/confidence. `detect()`/`detectForVideo()` là synchronous và có thể block main thread;
  Google khuyên chạy trong Web Worker. Nguồn: Google AI Edge “Pose landmark detection guide for Web” (cập nhật
  2026-05-28, truy cập 2026-07-29).
- [inference] D không thay VLM: landmarks xử lý tốt các góc vai/khuỷu/gối, độ nghiêng và việc cơ thể vào khung,
  nhưng không hiểu ý ảnh, ánh sáng, nét mặt, quần áo che khuất, tay tinh tế hay quan hệ giữa nhiều người. Kiến trúc
  tốt là local gate 10–30 fps để phát hiện ổn định/thay đổi; chỉ gửi keyframe khi pose ổn 300–500 ms hoặc khi cần
  critique semantic.
- [inference] D giảm bandwidth và stale cue, đồng thời cho micro-cue hình học nhanh; đổi lại phải ship model/WASM,
  Web Worker, coordinate/mirror calibration, smoothing và test theo browser/device. Vì vậy đây là **kiến trúc đích
  tốt hơn**, nhưng không phải vertical slice ít code nhất.

### 5.2. D-alt — phone nối thẳng public Realtime multimodal

- [inference] Một public Realtime session trên phone có thể nhận audio WebRTC và `input_image` events, bỏ đoạn
  phone→Neko-host cho inference. Topology gọn nhưng cần API key backend/ephemeral token, billing và data policy khác;
  đồng thời bỏ qua asset vision/permission của Neko. Chỉ nghiên cứu như opt-in cloud mode, không xếp hạng mặc định
  khi mục tiêu là tận dụng relay E2E + ChatGPT-subscription V3 hiện có.

### 6. Latency budget, bandwidth và trải nghiệm

Không tìm thấy chuẩn công bố dành riêng cho “độ trễ voice pose coaching”. Các mốc dưới đây là **design target cần
đo**, không phải fact từ Google/OpenAI hay một ngưỡng sinh lý phổ quát.

| Thành phần | Target MVP | Ghi chú |
|---|---:|---|
| Chờ đến sample kế tiếp | trung bình 0,5 s ở 1 fps | 0,5 fps làm thời gian chờ trung bình 1 s |
| Resize + JPEG | 20–100 ms | đo trên điện thoại thấp nhất còn hỗ trợ |
| Phone → host qua relay | 50–250 ms | phụ thuộc mạng; ghi p50/p95 thực tế |
| Vision + pose cue | 0,4–1,2 s | giả thuyết ngân sách, phải benchmark model thật |
| Cue E2E về phone + bắt đầu TTS | 0,05–0,3 s | `speechSynthesis` phụ thuộc OS/browser/voice |

- [inference] Target trải nghiệm: cue đầu sau khi bấm Start **p50 ≤ 2,0 s, p95 ≤ 3,0 s**; khi pose đang ổn định,
  cue mới **p50 ≤ 1,5 s, p95 ≤ 2,5 s**. Result trên 3 s phải kiểm tra stale; trên 4 s nên bỏ. Vì người dùng giữ pose
  vài giây, target này có khả năng đủ dùng nhưng phải được test với người thật, không tuyên bố là SLA trước đo.
- [inference] Đo bốn timestamp ở cùng `frame_seq`: `captured_at`, `host_received_at`, `vision_done_at`,
  `cue_audio_started_at`. Metric chính là capture→first-audio p50/p95 và stale-drop rate, không chỉ thời gian model.
- [inference] Với hard cap 200 KiB/frame, 0,5 fps ≈ 0,82 Mbit/s và ≈ 59 MiB uplink/10 phút; 1 fps ≈ 1,64 Mbit/s
  và ≈ 117 MiB/10 phút. Đây là upper-bound ở wire; ảnh thực tế nhỏ hơn sẽ giảm tuyến tính.
- [inference] Wire JSON hiện bị **base64 hai lần** nếu plaintext là data URL: JPEG→base64 rồi ciphertext→base64,
  overhead xấp xỉ 16/9 so với JPEG trước JSON/GCM. JPEG 120 KiB vì vậy thành khoảng 213 KiB trên wire. Media lane
  binary sau này có thể giảm overhead; MVP phải có compression loop theo **wire bytes**, không theo canvas blob.
- [inference] State machine tối thiểu: `idle → consent → calibrate → capture_one → infer → speak → settle →
  capture_one`; không có queue frame. Bắt đầu ở 1 fps nhưng chỉ một inference đang chạy; hạ còn 0,5 fps sau khi pose
  ổn và ngừng hẳn khi tab background, host offline hoặc người dùng bấm Stop.
- [inference] Cue nên là một thay đổi trong một câu, rồi chờ 1,5–3 s để người dùng làm theo. Nói đồng thời nhiều chỉnh
  sửa tạo tải nhận thức và khiến frame kế tiếp khó quy kết cải thiện cho cue nào.

### 7. Privacy, consent và safety

- [verified] Camera phải được xin qua explicit Start và có chỉ báo đang capture; Stop phải gọi `MediaStreamTrack.stop()`
  cho mọi track. W3C/MDN mô tả permission, indicator và lifecycle này; Neko cần thêm preview thật, trạng thái “camera
  đang gửi 1 fps” và nút Stop luôn thấy được. Nguồn độc lập: W3C Media Capture and Streams; MDN getUserMedia
  (truy cập 2026-07-29).
- [inference] Consent phải tách camera, microphone và lưu ảnh. MVP chỉ cần camera + audio output, nên giữ mic tắt;
  bật hội thoại voice là opt-in thứ hai. Chọn camera trước/sau và mirror preview phải hiện rõ.
- [supported] E2E AES-GCM hiện có nghĩa Cloudflare không thấy plaintext nếu implementation/key management đúng;
  nhưng **máy Neko và vision provider vẫn thấy pixels**, còn relay thấy ciphertext size/timing/session routing. Đây là
  trust boundary phải ghi ngay trên consent UI. Nguồn: repo relay/crypto (2026-07-29).
- [inference] Media lane mặc định: không Durable Object storage, không offline queue, không mirror/replay, không ghi
  frame/data URL vào log, chỉ giữ latest frame trong RAM đến khi inference hoàn tất rồi xóa reference. Telemetry chỉ
  giữ timestamp, byte size, latency, status/error và model id; không giữ cue nếu cue có mô tả nhạy cảm.
- [supported] Nếu chọn public OpenAI API, tài liệu Data Controls hiện ghi `/v1/realtime` không dùng dữ liệu để train,
  có abuse-monitoring retention mặc định tối đa 30 ngày và đủ điều kiện Zero Data Retention; điều này **không tự áp
  dụng** cho bridge ChatGPT-subscription/App Server hiện tại. Nguồn: OpenAI “Your data” (truy cập 2026-07-29).
- [supported] MediaPipe nói processing input của Tasks/Models diễn ra on-device, nhưng có thể gửi usage/performance
  metrics và yêu cầu thông báo/consent thích hợp. On-device landmarks giảm lượng ảnh phải rời điện thoại, không đồng
  nghĩa “không có network telemetry”. Nguồn: MediaPipe Privacy Notice (sửa 2026-06-05, truy cập 2026-07-29).
- [inference] Safety policy cho coach: không nhận dạng người, suy đoán tuổi/sức khỏe/giới/ngoại hình hấp dẫn, không
  chê cơ thể; chỉ cue hình học/chức năng và dùng ngôn ngữ trung tính. Với trẻ em, nơi riêng tư, người ngoài khung hoặc
  trang phục nhạy cảm, phải nhắc consent và cho phép local-only/stop; auto-capture ảnh cuối mặc định tắt.
- [inference] Khi unpair/Stop: stop tracks, đóng media socket, hủy inference có thể hủy, zeroize/remove session key
  reference, xóa camera choice nếu người dùng yêu cầu; không thể hứa xóa tức thì bản provider đã nhận ngoài chính
  sách retention đã công bố.

#### Failure modes bắt buộc xử lý

| Lỗi | Hành vi an toàn/đo được |
|---|---|
| Host offline/reconnect | Không queue frame; hiện “Neko offline”, dừng capture loop; reconnect không replay ảnh cũ |
| Mạng chậm/model timeout | Một inference, keep-latest; drop result stale; hiện degraded state thay vì nói cue muộn |
| Không thấy đủ người/ánh sáng | Không đoán pose; yêu cầu lùi máy, tăng sáng hoặc vào lại khung |
| Mirror/orientation sai | Calibration đầu session; lưu flag theo frame; cue theo trái/phải của người dùng |
| Tab background/screen lock | Dừng sampling và TTS; yêu cầu Start lại khi visible |
| TTS/voice unavailable | Cue text lớn + rung tùy chọn; không âm thầm mất cue |
| Phone nóng/pin yếu | Hạ fps/size; cho phép mode “chụp khi bấm” thay vì loop |
| Provider/crypto/validation error | Bỏ frame, không log pixels, không fallback sang kênh plaintext |

Tất cả hàng trên là [inference] từ threat/latency model; MVP cần test fault injection tương ứng.

## Bảng quyết định

Thang tương đối: 5 = thuận lợi nhất; “effort” 5 = ít code Neko nhất. Điểm không phải benchmark; nó là decision aid
được giải thích bằng các ledger entry phía trên.

| Phương án | Effort | Loop latency | Bandwidth | Privacy | Reach/setup | Reuse asset | Kết luận |
|---|---:|---:|---:|---:|---:|---:|---|
| A. Phone web snapshot qua relay E2E | 5 | 4 | 3 | 4 | 5 | 5 | **Hạng 1 / MVP** |
| D. MediaPipe local + remote keyframe | 3 | 5 | 5 | 5 | 4 | 4 | **Hạng 2 / kiến trúc đích** |
| C1. Sony/Canon virtual webcam/UVC | 4 | 4 | 5 | 5 | 2 | 3 | **Hạng 3 / pro-camera adapter** |
| B. IP camera/RTSP + gateway | 2 | 3 | 2 | 2 | 2 | 2 | Studio/LAN niche |
| C2. SDK Sony/Canon trực tiếp | 1 | 4 | 5 | 5 | 1 | 2 | Chỉ khi cần shutter/settings |
| D-alt. Public Realtime multimodal | 2 | 5 | 3 | 2 | 4 | 2 | Opt-in API mode, không mặc định |

Lý do D không đứng hạng 1: nó thắng về latency/bandwidth/privacy sau khi hoàn thiện, nhưng thêm một subsystem WASM,
coordinate smoothing và device QA trước khi chứng minh vision→cue có ích. Lý do C1 hơn B/C2: Windows đã thấy virtual
camera như video device thông thường, trong khi RTSP cần gateway/credential và SDK tạo integration matrix theo hãng.

## Kiến trúc khuyến nghị + lộ trình MVP

### Xếp hạng ba phương án

1. **A — phone web snapshot qua relay E2E**: ít code nhất, không cài app, dùng được khác mạng, tái dùng pairing/crypto/
   vision; phải thêm media lane ephemeral đúng semantics.
2. **D — local pose gate + remote keyframe**: kiến trúc đích tốt nhất cho nhịp nhanh và privacy; thêm sau khi có
   baseline đo được để biết landmark thực sự cải thiện latency/bandwidth bao nhiêu.
3. **C1 — máy ảnh qua virtual webcam/UVC**: adapter thực dụng nhất cho Sony/Canon; giữ cùng host vision/cue loop,
   chấp nhận setup và compatibility matrix. SDK trực tiếp là phase sau; RTSP đứng ngoài top 3.

### Kiến trúc đề xuất

```text
Phone relay page
  camera getUserMedia → resize/JPEG → E2E seal → ephemeral media WebSocket
                                              ↓
Cloudflare Worker/DO                  blind forward, no store/queue/mirror
                                              ↓
Neko host                 open seal → latest-frame gate → pose vision → cue policy
                                              ↓
Phone relay page           E2E coach_cue → text overlay + speechSynthesis → người dùng
```

Sau MVP, đặt MediaPipe/Web Worker trước bước encode: cue hình học chắc chắn có thể phát cục bộ, còn semantic keyframe
mới đi qua relay. Voice V3 trở thành session hội thoại opt-in song song: phone xin mic riêng, SDP signaling đi qua
relay đến App Server bridge, audio WebRTC đi trực tiếp. Trước khi làm, cần spike chứng minh App Server V3 có supported
path để inject pose context/cue; nếu không, giữ TTS pipeline hoặc chọn public API mode với consent/billing riêng.

### MVP nhỏ nhất chạy được

**Phạm vi có:** một người, một camera phone, một session online, snapshot tối đa 1 fps, một cue tiếng Việt mỗi lượt,
front/rear camera, Stop tức thì và telemetry không ảnh.

**Phạm vi cố ý chưa có:** mic/hội thoại V3, MediaPipe, video stream, RTSP, SDK máy ảnh, auto-shutter, lưu ảnh, nhóm
người và background replacement.

1. Trong `cloudflare/relay/worker.js`, mở `Permissions-Policy` cho camera cùng origin; thêm media message/route chỉ
   forward tới host online, hard cap 200 KiB wire, rate limit, không Durable Object queue/mirror/replay.
2. Trong `cloudflare/relay/client.html`, thêm Start/Stop, live preview, front/rear selector, intent ngắn, canvas encode
   có compression loop, `seq/captured_at/orientation/mirrored`; chỉ gửi khi host ACK ready. Dùng `speechSynthesis`
   cho cue và text overlay làm fallback.
3. Trong host relay adapter, phân luồng `media_frame` khỏi `handlers.run()`, decrypt/validate, keep-latest và gọi một
   pose-specific vision adapter. Không ghi data URL/pixels vào logs; hủy/bỏ result stale.
4. Prompt/schema chỉ trả một cue ≤12 từ và confidence/reason code; state giữ previous cue, mirror calibration và
   cooldown. Khi không thấy trọn người/ánh sáng quá tối, cue đầu phải sửa khung hình thay vì đoán pose.
5. Instrument bốn timestamp; pilot ở 0,5 và 1 fps. Gate để đi tiếp: capture→first-audio p50 ≤2,0 s/p95 ≤3,0 s,
   steady cue p50 ≤1,5 s/p95 ≤2,5 s, stale-drop hoạt động, Stop tắt track và không frame nào xuất hiện trong
   durable storage/mirror/log.

Đây là vertical slice nhỏ nhất vẫn đúng nghĩa **Neko nhìn rồi nói trực tiếp**. Nó không giả vờ đã tích hợp V3:
`speechSynthesis` là output voice của MVP; V3 là milestone hội thoại kế tiếp sau khi loop camera đo được.

### Lộ trình sau MVP

- **M1 — hardening A:** adaptive 0,5–1 fps, backpressure/drop-old, reconnect không replay, orientation/mirror test,
  prompt eval cho full-body/half-body và privacy UI.
- **M2 — D hybrid:** MediaPipe trong Web Worker, smoothing/stability gate, cue hình học local và chỉ gửi semantic
  keyframe; A/D benchmark cùng thiết bị/mạng.
- **M3 — voice conversational:** spike signaling V3 qua relay và context injection supported; nếu pass, ghép mic
  opt-in + interrupt. Nếu fail, không dùng protocol nội bộ undocumented; giữ TTS hoặc thiết kế public-API mode riêng.
- **M4 — camera thật:** port `FrameSource` chung; ưu tiên Windows virtual webcam/UVC, sau đó RTSP adapter cho studio,
  cuối cùng Canon/Sony SDK khi có yêu cầu shutter/settings cụ thể.

## Open questions

- [answered] Relay JSON/E2E UTF-8 không có binary media; app cap 1,05 MB dù Cloudflare platform cho 32 MiB.
  Khuyến nghị giữ media wire cap 200 KiB, không tăng đến platform maximum.
- [open] App Server Realtime v3 có supported method để inject pose context/cue và yêu cầu audio response giữa call
  hay không? Code hiện tại không chứng minh được; cần protocol spike, không dựa vào public Realtime API để suy ra.
- [answered] Vision nhận một data URL; cần pose prompt/schema, temporal state, mirror calibration và stale-result gate.
- [answered] Google Pixel Camera Coach là cloud preview + intent + từng tip framing/lighting/composition/mode;
  nguồn chính thức không chứng minh voice loop, body-pose coaching hay latency SLA.
- [answered] Không tìm được chuẩn nhịp cue riêng cho posing; giữ các mốc latency là testable design targets.
- [open] iOS Safari/Android Chrome thấp nhất nào được hỗ trợ, tab background/screen lock xử lý ra sao, và voice
  `speechSynthesis` tiếng Việt nào có sẵn? Cần device matrix thực nghiệm.
- [open] Vision provider thực tế của từng profile có retention/region/latency nào? Consent UI phải resolve từ config,
  không hard-code một lời hứa chung.

## Nhật ký checkpoint

### Checkpoint 2026-07-29 — khởi tạo

Best understanding hiện tại: camera web trên điện thoại là giả thuyết dẫn đầu vì khớp với relay và vision ảnh,
nhưng chưa được chấp nhận trước khi đọc code và nguồn chính thức. Các con số latency mới là target thiết kế,
không phải fact.

### Checkpoint 2026-07-29 — sau kiểm toán repo

A vẫn dẫn đầu về reach và reuse, nhưng cần một media lane ephemeral mới, mở camera policy có consent rõ và một
pose-specific vision/cue loop. Browser Bridge không vận chuyển camera phone. Realtime v3 hiện bị tách origin khỏi
relay; vì vậy MVP ít code nhất nên chứng minh camera→vision→cue bằng TTS trên phone trước, rồi mới nâng cue audio
lên Realtime v3. Đây là quyết định staging, chưa phải kết luận cuối.

### Checkpoint 2026-07-29 — kết luận nghiên cứu

A được giữ làm MVP sau phản chứng: nó không “miễn code” vì relay hiện cấm camera và queue sai semantics cho media,
nhưng vẫn là thay đổi nhỏ nhất trên asset đang live. D hybrid thắng dài hạn nhưng cần baseline trước. Máy ảnh thật
nên đi qua virtual webcam/UVC trước SDK. RTSP phù hợp studio cố định, không phải onboarding đại trà. Vòng latency
không có chuẩn công bố; các ngưỡng trong tài liệu là falsifiable targets và MVP phải đo capture→first-audio.

## Nguồn

Tất cả URL dưới đây được truy cập ngày **2026-07-29**; `n.d.` nghĩa là trang không hiện ngày công bố/cập nhật.

### Web camera và transport

- W3C, [Media Capture and Streams](https://www.w3.org/TR/mediacapture-streams/) — living standard, n.d.
- MDN, [MediaDevices: getUserMedia()](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia)
  — cập nhật 2025-06-23.
- Cloudflare, [Durable Objects limits](https://developers.cloudflare.com/durable-objects/platform/limits/)
  — cập nhật 2026-06-01.
- Cloudflare, [Workers WebSocket message size increased to 32 MiB](https://developers.cloudflare.com/changelog/post/2025-10-31-increased-websocket-message-size-limit/)
  — 2025-10-31.

### Realtime, voice và data controls

- OpenAI, [Realtime API with WebRTC](https://developers.openai.com/api/docs/guides/realtime-webrtc) — n.d.
- OpenAI, [Realtime conversations](https://developers.openai.com/api/docs/guides/realtime-conversations) — n.d.
- OpenAI, [Voice agents](https://developers.openai.com/api/docs/guides/voice-agents) — n.d.
- OpenAI, [GPT Realtime model](https://developers.openai.com/api/docs/models/gpt-realtime) — n.d.
- OpenAI, [Your data](https://developers.openai.com/api/docs/guides/your-data) — n.d.

### On-device pose, RTSP và máy ảnh

- Google AI Edge, [Pose landmark detection guide for Web](https://developers.google.com/edge/mediapipe/solutions/vision/pose_landmarker/web_js)
  — cập nhật 2026-05-28.
- Google AI Edge, [MediaPipe repository/privacy notice](https://github.com/google-ai-edge/mediapipe)
  — notice sửa 2026-06-05.
- MediaMTX, [Introduction](https://mediamtx.org/docs/kickoff/introduction) và
  [Authentication](https://mediamtx.org/docs/features/authentication) — n.d.
- FFmpeg, [Protocols Documentation — RTSP](https://ffmpeg.org/ffmpeg-protocols.html#rtsp) — n.d.
- gPhoto, [Remote controlling cameras](https://www.gphoto.org/doc/remote/) — n.d.; libgphoto2,
  [README](https://github.com/gphoto/libgphoto2) — n.d.
- Sony, [Imaging Edge Webcam — download](https://support.d-imaging.sony.co.jp/app/webcam/en/download/index.php)
  và [instructions](https://support.d-imaging.sony.co.jp/app/webcam/en/instruction/) — n.d.
- Sony, [Camera Remote SDK](https://www.sony.jp/camera-biz/sdk/) — n.d.
- Canon, [Developer SDK resources](https://www.usa.canon.com/support/sdk) và
  [CCAPI/EDSDK resources](https://asia.canon/en/campaign/developerresources/sdk) — n.d.
- Canon, [EOS Webcam Utility updates](https://www.usa.canon.com/digital-cameras/eos-webcam-utility/updates)
  và [compatible apps](https://www.usa.canon.com/digital-cameras/eos-webcam-utility/compatible-apps) — n.d.

### Camera coach tham chiếu

- Google, [How to use Pixel Camera Coach](https://blog.google/products-and-platforms/devices/pixel/how-to-use-camera-coach/)
  — 2025-09-03.
- Google Store, [Camera Coach](https://store.google.com/us/magazine/camera-coach?hl=en-US) — n.d.
- Google, [Pixel group photo features](https://blog.google/products-and-platforms/devices/pixel/pixel-group-photo-features-ai/)
  — 2025-10-06.
- Photogenik, [AI Photography Coach](https://photogenik.app/) — n.d.; vendor marketing only.

### Bằng chứng implementation trong repo

- `cloudflare/relay/README.md`, `cloudflare/relay/worker.js`, `cloudflare/relay/client.html`.
- `src/adapters/remote-relay.ts`, `src/adapters/relay-crypto.ts`, `src/adapters/vision.ts`.
- `src/adapters/chatgpt-voice.ts`, `src/adapters/native-voice-audio.ts`.
- `docs/process/BROWSER-BRIDGE.md`.

Snapshot repo: branch/worktree local tại 2026-07-29; các path trên là nguồn trực tiếp cho hành vi Neko, không phải
cam kết API ổn định bên ngoài.
