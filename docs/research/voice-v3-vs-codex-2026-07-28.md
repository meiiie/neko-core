# Voice v3 của Neko Core so với Codex CLI 0.144.5

**Ngày chốt kiến thức:** 2026-07-28
**Trạng thái:** Hoàn tất vòng nghiên cứu source/schema ngày 2026-07-28. Kết luận về cấu hình có bằng chứng trực tiếp; thứ hạng chất lượng model vẫn cần A/B audio để định lượng.

## Câu hỏi nghiên cứu

1. Codex CLI dùng model Realtime chuyên dụng hay dùng model text cho voice?
2. Hai bên khác nhau thế nào về sample rate, VAD/turn detection, noise suppression, barge-in và output buffer?
3. Các tham số `thread/realtime/*` trong app-server schema của Codex 0.144.5 có ý nghĩa gì?
4. Neko đang truyền `gpt-5.6` vào phiên Realtime: đúng, được bỏ qua, hay sai giao thức?
5. Khác biệt nào giải thích trực tiếp việc Codex nghe tốt hơn, và Neko nên sửa thế nào?

## Phương pháp và chuẩn bằng chứng

- Nguồn chính cấp 1: mã nguồn/schema/config cục bộ của Codex CLI 0.144.5; mã nguồn Neko Core; tài liệu OpenAI chính thức.
- Mỗi thông số quan trọng phải có đường dẫn tệp/dòng hoặc URL và ngày truy cập.
- Phân biệt rõ: quan sát trực tiếp, suy luận từ mã, và đề xuất chưa được đo A/B.
- Cố gắng bác bỏ từng kết luận bằng nguồn hoặc đường chạy độc lập trước khi xếp là đã xác minh.

## Nhật ký phát hiện

### F0 — Khởi tạo

- [superseded] Mốc khởi tạo trước điều tra; được thay thế bởi F1–F14.
  - Bằng chứng: file được tạo trước khi đọc source/schema theo yêu cầu.
  - Cập nhật: 2026-07-28.

### F1 — Phiên bản và bề mặt protocol có thật trong binary

- [verified] Binary cục bộ tự nhận là `codex-cli 0.144.5`. Lệnh `codex app-server generate-json-schema --out <tmp>` sinh schema tổng v1/v2 và tám schema riêng: `ThreadRealtimeStartedNotification`, `ThreadRealtimeSdpNotification`, `ThreadRealtimeTranscriptDeltaNotification`, `ThreadRealtimeTranscriptDoneNotification`, `ThreadRealtimeOutputAudioDeltaNotification`, `ThreadRealtimeItemAddedNotification`, `ThreadRealtimeErrorNotification`, cùng `ThreadRealtimeClosedNotification`.
  - Độ tin cậy: cao.
  - Bằng chứng: chạy trực tiếp `codex --version` và `codex app-server generate-json-schema --out <tmp>` ngày 2026-07-28; không dựa vào tài liệu web hoặc trí nhớ mô hình.
  - Giới hạn: tên notification mới chỉ chứng minh bề mặt protocol tồn tại; chưa chứng minh model, codec hay hành vi audio bên trong.

### F2 — Transport và hình dạng audio ở biên app-server

- [verified] `ThreadRealtimeStartTransport` có hai nhánh: `{type: "websocket"}` và `{type: "webrtc", sdp}`. Nhánh WebRTC mô tả `sdp` là offer sinh sau khi cấu hình audio và data channel cho sự kiện Realtime. Server trả remote SDP bằng `thread/realtime/sdp`.
  - Độ tin cậy: cao.
  - Bằng chứng: schema v2 do chính binary 0.144.5 sinh ngày 2026-07-28.
- [verified] `thread/realtime/outputAudio/delta` mang `audio.data` (string/base64 ở tầng JSON), `sampleRate: uint32`, `numChannels: uint16`, và `samplesPerChannel?: uint32 | null`; `itemId` cũng có thể null. Schema **không** cố định sample rate hoặc số kênh.
  - Độ tin cậy: cao.
  - Bằng chứng: `v2/ThreadRealtimeOutputAudioDeltaNotification.json` và định nghĩa `ThreadRealtimeAudioChunk` trong schema tổng.
  - Hệ quả: phải tìm sample rate thực tế trong implementation/SDP/config/runtime; không được kết luận `24 kHz` chỉ từ schema.

### F3 — Phải sinh schema với `--experimental`

- [verified] Schema mặc định giữ các notification Realtime nhưng loại request experimental. Lệnh đúng để khảo sát đầy đủ ở 0.144.5 là `codex app-server generate-json-schema --experimental --out <tmp>`.
  - Độ tin cậy: cao.
  - Bằng chứng: help của binary và hai lần sinh schema đối chứng ngày 2026-07-28.
- [verified] Bộ đầy đủ có sáu request: `thread/realtime/start`, `appendAudio`, `appendText`, `appendSpeech`, `stop`, `listVoices`; mỗi request có file `Params` và `Response` riêng.
  - Độ tin cậy: cao.
  - Bằng chứng: schema experimental do binary cục bộ 0.144.5 sinh.
- [verified] `codex features list` xếp `realtime_conversation` là `under development`; giá trị config cục bộ hiện là `false`. Vì vậy protocol này chưa phải giao diện ổn định và client first-party có thể bật feature riêng khi khởi chạy.
  - Độ tin cậy: cao cho trạng thái binary/config; trung bình cho cách client first-party bật feature (chưa đọc call site).

### F4 — Tham số chính xác của `thread/realtime/*`

- [verified] `thread/realtime/start` chỉ bắt buộc `threadId` và `outputModality` (`text | audio`). Các trường tùy chọn/null gồm `model`, `version` (`v1 | v2`), `voice`, `transport`, `prompt`, `realtimeSessionId`, `includeStartupContext`, `clientManagedHandoffs`, `codexResponsesAsItems`, hai prefix cho handoff/item, và `flushTranscriptTailOnSessionEnd`.
  - Độ tin cậy: cao.
  - Bằng chứng: `ThreadRealtimeStartParams.json` sinh bởi binary 0.144.5 với `--experimental`.
- [verified] Mô tả schema gọi `model` là override của **configured realtime model** cho riêng session; `version` tương tự cho **configured realtime protocol version**. Điều này tách khái niệm model Realtime khỏi model text của thread ở tầng protocol, dù vẫn cần source để biết default/call site.
  - Độ tin cậy: cao về contract; chưa kết luận tên model mặc định.
- [verified] `appendAudio` nhận cùng cấu trúc chunk có `data`, `sampleRate`, `numChannels`, tùy chọn `samplesPerChannel`/`itemId`; `appendText` nhận `text` và role mặc định `user`; `appendSpeech` nhận “speakable text”; `stop` chỉ cần `threadId`; `listVoices` không có params và trả danh sách/default riêng cho v1 và v2.
  - Độ tin cậy: cao.
- [verified] Voice enum của 0.144.5 gồm 19 giá trị: `alloy`, `arbor`, `ash`, `ballad`, `breeze`, `cedar`, `coral`, `cove`, `echo`, `ember`, `juniper`, `maple`, `marin`, `sage`, `shimmer`, `sol`, `spruce`, `vale`, `verse`.
  - Độ tin cậy: cao.

### F5 — Model, version, voice và audio session thật của Codex

- [verified] Codex 0.144.5 dùng model Realtime chuyên dụng mặc định `gpt-realtime-1.5` (`DEFAULT_REALTIME_MODEL`), không dùng model text `gpt-5.6-sol` trong `~/.codex/config.toml`. Thứ tự chọn model là: `thread/realtime/start.model` → `experimental_realtime_ws_model` → `gpt-realtime-1.5`.
  - Độ tin cậy: cao.
  - Bằng chứng: `codex-rs/core/src/realtime_conversation.rs` tại tag `rust-v0.144.5`, commit `87db9bc18ba5bc82c1cb4e4381b44f693ee35623`; config cục bộ chỉ có `model = "gpt-5.6-sol"` và không có override Realtime.
- [verified] Constant wire audio là PCM signed 16-bit/base64 ở `24_000 Hz`; session v2 đặt rõ cả input và output `audio/pcm` rate 24.000. Default voice là `marin` cho v2 và `cove` cho v1.
  - Độ tin cậy: cao.
  - Bằng chứng: `codex-api/src/endpoint/realtime_websocket/methods_common.rs`, `methods_v2.rs`, và `protocol/src/protocol.rs` cùng tag.
- [verified] v2 conversational đặt `noise_reduction = {type: "near_field"}`, input transcription model `gpt-4o-mini-transcribe`, `turn_detection = {type: "server_vad", interrupt_response: true, create_response: true, silence_duration_ms: 500}`.
  - Độ tin cậy: cao.
  - Bằng chứng: `codex-api/src/endpoint/realtime_websocket/methods_v2.rs`.
- [verified] v1 là session type `quicksilver`, intent `quicksilver`; source gửi format PCM 24 kHz nhưng để `noise_reduction`, `transcription`, `turn_detection` là `null` và không chỉ định output format. Đây không có nghĩa v1 thiếu các chức năng đó: backend Quicksilver có thể áp default riêng, nhưng client không gửi tham số trong `session.update`.
  - Độ tin cậy: cao cho payload client; thấp về default kín của backend.
- [verified] WebRTC AVAS bắt buộc v1 + conversational; WebSocket có thể dùng v1 hoặc v2. Khi WebRTC không override version, code buộc v1 và bỏ qua voice config chung để backend/call path chọn phù hợp, trừ khi request chỉ định version/voice theo nhánh hợp lệ.
  - Độ tin cậy: cao.

### F6 — Output buffer và xử lý mic nằm ở client transport

- [verified] Codex CLI/app-server trên Windows không chứa `cpal`/`rodio` hoặc một audio playback ring buffer. TUI chỉ biết notification; các chunk `outputAudio/delta` được chuyển nguyên sang client host.
  - Độ tin cậy: cao cho source công khai 0.144.5.
  - Bằng chứng: grep toàn repo tag 0.144.5; `app-server/src/bespoke_event_handling.rs` chỉ chuyển `RealtimeEvent::AudioOut` thành notification.
- [verified] Luồng WebRTC chuẩn trong README giao `RTCPeerConnection`, `getUserMedia({audio: true})`, remote `MediaStream` và `<audio autoplay>` cho browser/webview. Vì vậy jitter/playout buffer và audio processing mặc định của WebRTC/browser không có tham số trong `thread/realtime/*` schema.
  - Độ tin cậy: cao về kiến trúc; thông số buffer nội bộ của host cụ thể không công khai trong repo.
- [verified] Core dùng queue bounded 256 frame cho input audio và 256 event cho output; đây là backpressure giữa app-server/core, **không phải** mục tiêu độ trễ của loa. Core còn cộng `samplesPerChannel / sampleRate` để theo dõi độ dài audio output theo item, phục vụ truncate/cancel semantics.
  - Độ tin cậy: cao.
  - Bằng chứng: `AUDIO_IN_QUEUE_CAPACITY`, `OUTPUT_EVENTS_QUEUE_CAPACITY`, `OutputAudioState` trong `core/src/realtime_conversation.rs`.
- [open] Chưa thể nêu số millisecond của playout/jitter buffer Codex client: số đó thuộc browser/webview hoặc app host, không có trong source/schema CLI được khảo sát.
  - Độ tin cậy: cao rằng schema không có; chưa đủ bằng chứng về implementation client đóng.

## Codex CLI 0.144.5

### Model và đường chạy

- Text agent cục bộ: `gpt-5.6-sol` từ `~/.codex/config.toml`.
- Realtime mặc định: `gpt-realtime-1.5`; override nằm ở `thread/realtime/start.model` hoặc config `experimental_realtime_ws_model`.
- WebRTC: protocol v1/Quicksilver, default voice `cove`; host browser/webview sở hữu mic, loa và `RTCPeerConnection`.
- WebSocket: v1 hoặc v2; v2 default voice `marin`, PCM 24 kHz, `near_field`, `gpt-4o-mini-transcribe`, `server_vad`, `silence_duration_ms: 500`, `create_response: true`, `interrupt_response: true`.
- Bare TUI: không có audio client; feature `realtime_conversation` là experimental và đang off trong config cục bộ.

### `thread/realtime/*` sinh từ binary 0.144.5

Lệnh nguồn sự thật: `codex app-server generate-json-schema --experimental --out <tmp>`.

| Method | Params bắt buộc | Params tùy chọn quan trọng | Response |
|---|---|---|---|
| `thread/realtime/start` | `threadId`, `outputModality: text/audio` | `model`, `version: v1/v2`, `voice`, `transport`, `prompt`, `realtimeSessionId`, `includeStartupContext`, `clientManagedHandoffs`, `codexResponsesAsItems`, `codexResponseItemPrefix`, `codexResponseHandoffPrefix`, `flushTranscriptTailOnSessionEnd` | `{}` |
| `thread/realtime/appendAudio` | `threadId`, `audio` | Trong `audio`: `samplesPerChannel`, `itemId` | `{}` |
| `thread/realtime/appendText` | `threadId`, `text` | `role: user/developer/assistant`, mặc định `user` | `{}` |
| `thread/realtime/appendSpeech` | `threadId`, `text` | Không | `{}` |
| `thread/realtime/stop` | `threadId` | Không | `{}` |
| `thread/realtime/listVoices` | Không | Không | danh sách/default v1 và v2 |

`audio` có contract `{data, sampleRate, numChannels, samplesPerChannel?, itemId?}`. `data` là base64 PCM ở đường WebSocket hiện thực; schema cố ý không khóa sample rate. Notifications gồm `started`, `sdp`, `itemAdded`, `transcript/delta`, `transcript/done`, `outputAudio/delta`, `error`, `closed`.

### Khác biệt schema 0.145.0 mà Neko cần

Support Pack thêm `version: "v3"`, `codexResponseHandoffMode` và `initialItems`; `initialItems` chỉ dành cho v3, tối đa 128 item và 8.192 token text ước tính. Không được đọc các trường này như capability của binary PATH 0.144.5.

## Neko Core voice v3

### F7 — Neko không chạy v3 bằng CLI 0.144.5 và không gửi `gpt-5.6` làm model Realtime

- [verified] `chatgpt-voice.ts` yêu cầu `CODEX_VOICE_MIN_VERSION = "0.145.0"`, gửi `version: "v3"`, và từ chối nếu notification `thread/realtime/started.version` khác `v3`. CLI PATH 0.144.5 chỉ có enum v1/v2, nên không thể là binary chạy session v3 này.
  - Độ tin cậy: cao.
- [verified] Máy hiện có Support Pack managed chính thức `codex-app-server 0.145.0`, cài từ release `rust-v0.145.0` ngày 2026-07-23; discovery ưu tiên nó trước CLI PATH. Đây mới là binary mà Neko voice v3 chọn.
  - Độ tin cậy: cao.
  - Bằng chứng: `~/.neko-core/codex-support/support-pack.json`, chạy trực tiếp binary `--version`, và `managedExecutable()` trong `codex-app-server.ts`.
- [verified] Neko gửi model text hiện hành (ví dụ `gpt-5.6-terra`) vào `thread/start.model` để tạo **Codex agent thread** có tools/history. Cả native lẫn WebRTC đều **không gửi** `model` trong `thread/realtime/start`; chúng chỉ gửi `version: "v3"`, audio modality, prompt/context/handoff options và transport.
  - Độ tin cậy: cao.
  - Bằng chứng: `chatgpt-voice.ts:171-180`, `:281-290`, `:425-435`; test xác nhận hai payload tách biệt.
  - Phán quyết: premise “Neko truyền `gpt-5.6` vào Realtime” là sai với code hiện tại. Truyền model text vào `thread/start` là đúng để chọn background/tool agent. Nếu thêm `model: "gpt-5.6"` vào `thread/realtime/start` mới là sai, vì trường đó dành cho model Realtime chuyên dụng.
- [verified] Neko xóa `OPENAI_API_KEY` và `NEKO_API_KEY` khi spawn sidecar voice (`forbidApiBilling: true`), rồi đăng nhập bằng ChatGPT auth tokens. Vì vậy không có fallback âm thầm sang Realtime API trả phí.
  - Độ tin cậy: cao.

### F8 — v3 dùng một model live riêng và không gửi bộ tham số VAD/noise kiểu v2

- [verified] Ở tag `rust-v0.145.0`, model mặc định của v1/v2 vẫn là `gpt-realtime-1.5`, nhưng v3 có constant riêng `DEFAULT_FRAMELESS_REALTIME_MODEL = "gpt-live-1-boulder-alpha"`. Thứ tự chọn vẫn là override Realtime riêng → config Realtime riêng → default theo version; model text của `thread/start` không tham gia.
  - Độ tin cậy: cao.
  - Bằng chứng: `codex-rs/core/src/realtime_conversation.rs` tại tag `rust-v0.145.0`, commit `25af12f7e61572b0bc18ddb1008be543b91519b0`.
  - Giới hạn: hậu tố `alpha` là bằng chứng trực tiếp về tên snapshot, không tự nó chứng minh chất lượng thấp hơn; cần A/B mới định lượng được.
- [verified] Session v3/Frameless Bidi gửi `instructions`, `audio.output.voice`, `delegation`, tùy chọn `model` và `initial_items`. Nó **không** gửi `audio/pcm` rate, input transcription, noise reduction hay `server_vad` trong session JSON. Các chi tiết input/turn-taking đó thuộc đường `/live`/AVAS và default phía dịch vụ/transport, không giống payload v2 được khai báo tường minh.
  - Độ tin cậy: cao về payload client; thấp về các default kín phía dịch vụ.
  - Bằng chứng: `codex-api/src/endpoint/realtime_websocket/methods_frameless_bidi.rs` và `realtime_call.rs` cùng tag 0.145.0.
- [verified] Voice mặc định của v3 là `cove`, cùng nhánh default với v1; v2 mặc định `marin`. Vì Codex WebRTC v1 và Neko v3 đều có thể rơi về `cove`, khác biệt “nghe tốt hơn” không thể mặc nhiên quy cho tên voice.
  - Độ tin cậy: cao.
  - Bằng chứng: `RealtimeVoicesList::builtin()` trong protocol 0.145.0.

### F9 — Neko mặc định đi qua FFmpeg/FFplay native, không phải WebRTC

- [verified] `beginVoice()` mặc định `transport = "native"`; `/voice start` cũng chọn native khi máy có FFmpeg/FFplay. Picker đặt “Start GPT-Live in terminal” lên đầu khi native sẵn sàng; browser V3 chỉ là mục “compatibility”. Vì vậy phép so sánh thường gặp là **Codex WebRTC/browser host** với **Neko DirectShow → FFmpeg → JSON-RPC → FFplay**, không phải cùng transport.
  - Độ tin cậy: cao.
  - Bằng chứng: `src/ui/chat.tsx:1277`, `:1383-1413`, `:1747-1753`.
- [verified] Mic native được resample thành PCM s16le mono `24.000 Hz`; FFmpeg DirectShow dùng `-audio_buffer_size 50`. Neko đóng frame `50 ms` = `1.200` sample = `2.400` byte rồi gọi tuần tự `thread/realtime/appendAudio` qua JSON-RPC. `MAX_QUEUED_FRAMES = 8` cho phép tối đa danh nghĩa `400 ms` frame đang chờ; khi đầy, code bỏ frame **mới đến** và giữ audio cũ.
  - Độ tin cậy: cao.
  - Bằng chứng: `src/adapters/native-voice-audio.ts:34-39`, `:117-124`, `:176-195`; `test/native-voice-audio.test.ts:33-79`.
  - Giới hạn: 400 ms là trần queue theo code, không phải số latency đã đo; latency thực còn phụ thuộc tốc độ phản hồi app-server.
- [verified] Output native đẩy PCM vào `ffplay` với `nobuffer`/`low_delay`, nhưng bỏ qua giá trị trả về của `stdin.write()` và không đợi `drain`; không có ring buffer hay giới hạn millisecond phía output. Barge-in chỉ xảy ra khi Neko nhận **transcript delta role=user**, lúc đó nó kill hẳn FFplay; chunk sau phải spawn player mới.
  - Độ tin cậy: cao.
  - Bằng chứng: `native-voice-audio.ts:140-159`, `:198-215`; `chatgpt-voice.ts:501-508`; test native xác nhận kill process.
  - Hệ quả suy luận: đây là ứng viên mạnh cho tiếng cắt cứng, độ trễ ngắt và khoảng hẫng sau barge-in; cần đo A/B để định lượng.
- [verified] Browser V3 của Neko dùng `RTCPeerConnection`, remote `<audio autoplay>` và `getUserMedia` với `echoCancellation`, `noiseSuppression`, `autoGainControl` đều `true`. Audio đi thẳng qua WebRTC; control socket chỉ giữ phiên/liveness.
  - Độ tin cậy: cao.
  - Bằng chứng: HTML bridge trong `src/adapters/chatgpt-voice.ts`.

### F10 — Tài liệu công khai xác nhận 24 kHz và tách hẳn GPT-5.6 khỏi model voice

- [verified] OpenAI mô tả `gpt-realtime-1.5` là model audio-in/audio-out chuyên dụng cho voice agent; API Reference quy định PCM input/output chỉ hỗ trợ `24.000 Hz`. Điều này khớp source Codex 0.144.5 và PCM native của Neko.
  - Độ tin cậy: cao.
  - Bằng chứng: trang model `gpt-realtime-1.5` và Realtime API Reference chính thức, truy cập 2026-07-28.
- [verified] Catalog chính thức mô tả `gpt-5.6-sol`/`terra`/`luna` là text + image input, text output; audio không phải modality của chúng. Do đó dùng `gpt-5.6` làm `thread/start.model` là hợp lệ cho agent text/tool, nhưng dùng nó làm `thread/realtime/start.model` sẽ sai loại model.
  - Độ tin cậy: cao.
  - Bằng chứng: OpenAI Models catalog chính thức ngày 2026-07-28.
- [verified] Catalog công khai **không liệt kê** `gpt-live-1-boulder-alpha`; tên này chỉ xuất hiện trong source Codex Support Pack 0.145.0. Báo cáo coi đây là snapshot/internal alias của đường ChatGPT Live, không suy diễn capability hoặc SLA API công khai từ tên đó.
  - Độ tin cậy: cao rằng model không có trong catalog đã kiểm; trung bình về phân loại “internal alias”.
- [verified] Parser Frameless Bidi v3 không ánh xạ event `speech_started`/`speech_stopped`; nó chỉ expose session, input/output transcript, `turn.done`, output audio, delegation và error. Vì vậy Neko native 0.145.0 không có notification VAD sớm hơn transcript để bắt ở app-server contract hiện tại.
  - Độ tin cậy: cao.
  - Bằng chứng: `protocol_frameless_bidi.rs` và tests tại tag 0.145.0.

### F11 — WebRTC tự quản output buffer/barge-in; native/WebSocket phải tự làm nhưng contract v3 thiếu event sớm

- [verified] OpenAI khuyến nghị WebRTC thay cho WebSocket cho client browser/mobile vì “more consistent performance”. Với WebRTC/SIP, server biết lượng audio đã phát, tự hủy response khi VAD bắt đầu và tự truncate phần audio chưa phát. Với WebSocket, client phải bắt `input_audio_buffer.speech_started`, dừng playback ngay, đo `audio_end_ms` và gửi `conversation.item.truncate`.
  - Độ tin cậy: cao.
  - Bằng chứng: hướng dẫn WebRTC và mục “Handling interruptions” trong Realtime conversations, truy cập 2026-07-28.
- [verified] Realtime speech-to-speech bật VAD mặc định; default công khai là `server_vad`. Cấu hình mẫu/chính xác gồm `threshold: 0.5`, `prefix_padding_ms: 300`, `silence_duration_ms: 500`, `create_response: true`, `interrupt_response: true`. Đây cũng là các giá trị source Codex v2 gửi, ngoại trừ source chỉ ghi rõ `silence_duration_ms: 500` và dùng default cho threshold/prefix.
  - Độ tin cậy: cao cho API công khai và v2; trung bình khi suy sang backend Quicksilver/v3 nội bộ.
- [verified] Noise reduction phía API chạy trước VAD/model; `near_field` dành cho mic gần, `far_field` cho mic laptop/phòng. Codex v2 chọn `near_field`; v1 và v3 không gửi trường này. Neko browser bật xử lý mic của browser (`echoCancellation`, `noiseSuppression`, `autoGainControl`); Neko native không có tầng tương đương trước FFmpeg.
  - Độ tin cậy: cao về payload/client; không biết default kín của v1/v3 backend.
- [verified] TUI terminal của Codex 0.144.5 không có call site voice hay audio device; `realtime_conversation` mặc định off. “Voice của Codex CLI” trong phép so sánh thực chất là app-server protocol được một app/browser/webview host, còn bare CLI không sở hữu loa/mic.
  - Độ tin cậy: cao cho source công khai 0.144.5.

### F12 — Giả thuyết transport ban đầu, sau đó bị thu hẹp

- [superseded] Source UI cho thấy `/voice start` ưu tiên native, nên giả thuyết đầu tiên là Codex WebRTC đang bị so với Neko FFmpeg/FFplay. F13 xác minh route native không thể xác thực bằng ChatGPT subscription trên Support Pack 0.145.0; giả thuyết này chỉ còn đúng cho một cấu hình API-key ngoài chính sách hiện tại.
- [supported inference] `gpt-realtime-1.5` v1 và `gpt-live-1-boulder-alpha` v3 là hai model/protocol khác nhau, nên prosody, độ tự nhiên và turn-taking có thể khác. Chưa có trace A/B cùng mic/voice/transport, vì vậy chưa thể định lượng mức tác động.
- [refuted] `gpt-5.6` không phải nguyên nhân làm voice v3 kém: nó không được gửi vào Realtime. Default voice cũng không giải thích được khi cả Codex WebRTC v1 và Neko v3 đều là `cove`.

### F13 — Native V3 bị chặn bởi auth; phiên subscription chạy được phải là WebRTC

- [verified] Khi `transport` bị bỏ trống, App Server chọn WebSocket. Source 0.145.0 gọi `realtime_api_key()` cho nhánh này và trả lỗi `realtime conversation requires API key auth` nếu chỉ có ChatGPT/SIWC auth. TODO trong source xác nhận đây là hạn chế tạm thời.
  - Độ tin cậy: cao.
  - Bằng chứng: `core/src/realtime_conversation.rs:1125-1185` và `:1559-1583` tại tag 0.145.0; test upstream cũng assert đúng error.
- [verified] Neko native bỏ `transport`, đồng thời sidecar xóa `OPENAI_API_KEY`/`NEKO_API_KEY` với `forbidApiBilling: true`. Do đó native V3 hiện không thể qua preflight trong chính sách production; `friendlyVoiceError()` đã có nhánh mô tả đúng lỗi này.
  - Độ tin cậy: cao.
  - Hệ quả: nếu người dùng đã nghe một phiên Neko subscription V3 thành công, đó là browser/WebRTC. Pipeline FFmpeg/FFplay là lỗi thiết kế/UX và rủi ro tương lai, nhưng không thể là nguyên nhân waveform của phiên thành công hiện tại.

### F14 — Neko thay thế prompt voice giàu biểu cảm của Codex bằng prompt rất ngắn

- [verified] Khi request có `prompt`, `prepare_realtime_backend_prompt()` dùng nó thay cho `BACKEND_PROMPT`. Codex 0.144.5 mặc định có prompt chuyên cho hội thoại: ấm, vui, dí dỏm, biểu cảm, nói như cộng tác viên/bạn bè và điều phối backend tự nhiên. Neko luôn gửi `VOICE_REALTIME_PROMPT`, nên default đó không được dùng.
  - Độ tin cậy: cao.
  - Bằng chứng: `core/src/realtime_prompt.rs` và `prompts/templates/realtime/backend_prompt.md` tại tag 0.144.5; `chatgpt-voice.ts:425-434`.
- [verified] Prompt Realtime của Neko chỉ có bốn câu, lặp ba lần yêu cầu nói ngắn/tiến độ ngắn/tóm tắt rõ; nó không mô tả cadence, sự ấm áp, tính biểu cảm hay cách nối hội thoại ngoài “Speak naturally”. Đây là khác biệt trực tiếp về phong cách phát ngôn, không phải codec.
  - Độ tin cậy: cao về prompt; trung bình-cao rằng nó ảnh hưởng cảm nhận “nghe tốt”, cần A/B để đo.

## So sánh trực tiếp

| Thuộc tính | Codex 0.144.5 qua app host | Neko V3 browser | Neko V3 native (UI đang ưu tiên thử) |
|---|---|---|---|
| Binary/protocol | PATH `0.144.5`; WebRTC v1, WebSocket v1/v2 | Support Pack `0.145.0`; WebRTC v3 | Support Pack `0.145.0`; WebSocket v3, nhưng bị auth gate |
| Model Realtime mặc định | `gpt-realtime-1.5` | `gpt-live-1-boulder-alpha` | Không khởi động được bằng subscription; nếu có API key thì `gpt-live-1-boulder-alpha` |
| Prompt Realtime | Default Codex voice prompt giàu tone/personality nếu client không override | Bốn câu Neko, nhấn mạnh concise/progress | Cùng prompt Neko nếu qua được auth |
| Model text/tool | Tách riêng; local là `gpt-5.6-sol` | `cfg.model` chỉ ở `thread/start` | Như browser |
| Input audio | Media track WebRTC hoặc PCM app-managed | Media track WebRTC | DirectShow → FFmpeg → PCM s16le mono 24 kHz |
| Frame/queue client | WebRTC host không expose số trong schema | WebRTC host không expose số trong Neko | 50 ms/frame; tối đa 8 frame = 400 ms; đầy thì bỏ frame mới |
| Mic DSP | Host phụ trách; v2 server chọn `near_field`, v1 không gửi NR | Browser: EC + NS + AGC đều `true`; v3 không gửi server NR | Không có EC/NS/AGC trước FFmpeg; v3 không gửi server NR |
| VAD/turn | v2: `server_vad`, silence 500 ms, create+interrupt `true`; v1 backend default kín | Backend v3/default kín | Backend v3/default kín; app-server không expose `speech_started` |
| Barge-in | WebRTC server tự cancel + truncate phần chưa phát | WebRTC server tự cancel + truncate | Đợi transcript user, rồi kill FFplay; không gửi truncate từ client |
| Output buffer | WebRTC server/host quản; WebSocket client tự quản | WebRTC server/host quản | Pipe FFplay; không kiểm `write()`/`drain`, không cap theo ms |
| Voice mặc định | v1 `cove`; v2 `marin` | v3 `cove` | v3 `cove` |

### Phán quyết câu hỏi model

`thread/start.model = gpt-5.6-*` là **đúng** cho Codex text/tool agent. `thread/realtime/start.model` của Neko hiện **không tồn tại**, nên Realtime v3 dùng default `gpt-live-1-boulder-alpha`. Không được copy `cfg.model` sang trường Realtime. Nếu cần A/B, phải có config riêng cho model Realtime.

## Các khác biệt xếp theo tác động

1. **Prompt Realtime bị thay thế — tác động cao lên cảm nhận tự nhiên, độ chắc trung bình-cao.** Codex default chỉ dẫn rõ sự ấm áp, dí dỏm, biểu cảm và nhịp cộng tác; Neko override bằng bốn câu thiên về trả lời/tiến độ ngắn. Cơ chế đã xác minh và có thể A/B mà không đổi transport/model.
2. **Model/protocol `gpt-realtime-1.5` v1 so với `gpt-live-1-boulder-alpha` v3 — tiềm năng tác động cao, độ chắc trung bình.** Đây là khác biệt service lớn nhất còn lại khi cả hai chạy WebRTC; có thể đổi prosody, ngôn ngữ, VAD và turn-taking. Chưa có A/B cùng prompt/voice nên chưa định lượng được.
3. **Backend VAD/noise policy v1 so với v3 — tác động trung bình-cao, độ chắc thấp-trung bình.** v1/v3 đều không gửi cấu hình tường minh; default kín có thể khác. Ở client, Neko browser đã bật EC/NS/AGC nên không có bằng chứng nó thua Codex ở bước mic DSP.
4. **Context/history/handoff — tác động trung bình lên latency và nhịp hội thoại, thấp lên waveform.** Neko bật startup context, gửi initial history và BEM handoff để dùng tools. Đây là thêm chức năng, nhưng cần A/B prompt tối giản để tách chi phí.
5. **Native transport — tác động rất cao nếu sau này dùng API key, nhưng không giải thích phiên subscription đang nghe.** Route này có queue 400 ms, barge-in muộn và output không backpressure; hiện nó bị auth gate trước khi có audio.
6. **Default voice và `gpt-5.6` — không phải nguyên nhân.** Cả WebRTC v1 và v3 default `cove`; GPT-5.6 chỉ thuộc text/tool thread.

## Bản vá đề xuất cho Neko

### P0 — Đưa GPT-Live WebRTC thành mặc định

Sửa `src/ui/chat.tsx`:

- `beginVoice(transport = "browser")` thay cho `"native"`.
- `/voice start` gọi `beginVoice("browser")`; không gọi native khi chỉ có ChatGPT auth.
- Đưa “GPT-Live browser” lên đầu picker và bỏ chữ “compatibility”; ghi “recommended: WebRTC, automatic playout/truncation”.
- Ẩn/disable native trong subscription mode với lý do chính xác: `Codex 0.145 WebSocket requires API-key auth; Neko does not enable API billing`.
- Giữ nguyên constraints hiện có: `echoCancellation: true`, `noiseSuppression: true`, `autoGainControl: true`. Không ép `sampleRate: 24000` ở `getUserMedia`; WebRTC tự negotiate media, còn 24 kHz là contract PCM của đường socket.

Các trường cố định của payload production nên giữ chính xác:

```json
{
  "version": "v3",
  "outputModality": "audio",
  "includeStartupContext": true,
  "flushTranscriptTailOnSessionEnd": true,
  "codexResponseHandoffMode": "bemTags",
  "transport": { "type": "webrtc", "sdp": "<offer>" }
}
```

Giữ **không có `model`** để v3 dùng default của Support Pack; không copy `cfg.model`. `voice` có thể để trống để nhận default `cove`, hoặc expose picker từ `listVoices`; hard-code lại `cove` không cải thiện chất lượng. `includeStartupContext: true` là giá trị production hiện tại; chỉ tắt trong A/B cô lập context. Ngoài các trường cố định trên, production gửi `prompt` từ P1 và chỉ thêm `initialItems` khi history sau lọc không rỗng.

### P1 — Viết lại prompt cho lời nói tự nhiên, rồi A/B trước khi đổi model

Giữ identity Neko nhưng thay `VOICE_REALTIME_PROMPT` bằng chỉ dẫn riêng, không copy prompt Codex:

```text
You are Neko Core, a warm and curious realtime collaborator. Match the user's language.
Speak in natural conversational turns with varied cadence; concise means focused, not clipped.
Use warmth and light wit when appropriate. Avoid bullet-like progress narration and repeated status phrases.
Let the user interrupt. For tool work, acknowledge once, hand off silently, then explain the verified result naturally.
```

Chạy A/B cùng browser v3, `cove`, cùng 20 prompt nói tiếng Việt: prompt cũ so với prompt mới. Chấm mù naturalness, warmth, cadence, pronunciation và interruption; giữ latency riêng, không gộp thành một điểm.

### P2 — Chỉ gia cố native nếu người dùng chủ động cho phép API-key billing

Sửa `src/adapters/native-voice-audio.ts` với budget client sau:

- `FRAME_MS = 20`; ở 24 kHz mono s16le, `FRAME_BYTES = 960`, `samplesPerChannel = 480`.
- `MAX_QUEUED_FRAMES = 5`; queue input tối đa `100 ms`, thay mức danh nghĩa 400 ms.
- DirectShow thử `-audio_buffer_size 20`; nếu device từ chối thì retry đúng một lần với `50`. FFmpeg xác nhận đơn vị là millisecond.
- Thay Promise chain bằng deque + sender pump. Khi đủ 5 frame, bỏ **frame cũ nhất**, không bỏ lời mới nhất.
- Thêm `MAX_OUTPUT_BUFFER_MS = 120`; tính duration bằng `bytes / (sampleRate × channels × 2)`. Nếu `stdin.write()` trả `false`, đợi `drain`; không tiếp tục đẩy vô hạn.
- Gắn generation ID cho output. `interruptOutput()` tăng generation, xóa queue phần mềm, kill player cũ; mọi chunk thuộc generation cũ bị bỏ. Đây chỉ giảm audio stale, chưa tạo được barge-in sớm vì v3 không expose `speech_started`.

Các số 20/100/120 ms là **budget bản vá phía client để A/B**, không phải default do OpenAI công bố. Không đầu tư route này trước khi có quyết định sản phẩm rõ về API-key billing hoặc app-server hỗ trợ ChatGPT auth cho WebSocket.

### P3 — Khóa regression model routing và auth bằng test

Bổ sung vào `test/chatgpt-voice.test.ts`:

```ts
expect(threadStart.params.model).toBe("gpt-5.6-terra");
expect(realtimeStart.params.model).toBeUndefined();
expect(realtimeStart.params.version).toBe("v3");
```

Bổ sung assertion WebRTC production dùng `includeStartupContext: true`. Thêm test UI rằng ChatGPT subscription chọn browser và không thử native. Các test frame 960 byte/queue/drain chỉ đi cùng P2.

### P4 — A/B model đúng cách, không đổi default âm thầm

Tạo flag lab chỉ cho browser:

- Baseline Codex-match: `version: "v1"`, `model: "gpt-realtime-1.5"`, `voice: "cove"`, WebRTC; bỏ `initialItems` và `codexResponseHandoffMode` vì là v3-only.
- Neko v3: `version: "v3"`, bỏ `model`, `voice: "cove"`, WebRTC. Chỉ flag lab được phép nới assertion `expected v3` để nhận v1; production vẫn fail closed.
- Chỉ chạy sau khi đã chọn prompt thắng ở P1. Cả hai dùng cùng mic, browser constraints, prompt và không history để chấm prosody/latency; sau đó chạy lại với tools/history để đo chi phí handoff.

Đo tối thiểu 20 lượt ghép cặp: end-of-speech → audio đầu tiên; mic-onset khi assistant đang nói → loa im; tỷ lệ false cut; số lần audio underrun; chấm mù naturalness. Chỉ đổi model/version mặc định nếu A/B thắng rõ. `gpt-realtime-2.1` là model API công khai mới hơn vào ngày chốt, nhưng không được tự đưa vào đường subscription vì Neko đang cấm API billing và entitlement App Server chưa được chứng minh.

## Nguồn

### Mã nguồn và schema

- Codex release [`rust-v0.144.5`](https://github.com/openai/codex/releases/tag/rust-v0.144.5), commit khảo sát `87db9bc18ba5bc82c1cb4e4381b44f693ee35623`, phát hành 2026-07-16.
- Codex [`realtime_conversation.rs` 0.144.5](https://github.com/openai/codex/blob/rust-v0.144.5/codex-rs/core/src/realtime_conversation.rs), [`realtime_prompt.rs`](https://github.com/openai/codex/blob/rust-v0.144.5/codex-rs/core/src/realtime_prompt.rs), [`backend_prompt.md`](https://github.com/openai/codex/blob/rust-v0.144.5/codex-rs/prompts/templates/realtime/backend_prompt.md), [`methods_v1.rs`](https://github.com/openai/codex/blob/rust-v0.144.5/codex-rs/codex-api/src/endpoint/realtime_websocket/methods_v1.rs), [`methods_v2.rs`](https://github.com/openai/codex/blob/rust-v0.144.5/codex-rs/codex-api/src/endpoint/realtime_websocket/methods_v2.rs), [`methods_common.rs`](https://github.com/openai/codex/blob/rust-v0.144.5/codex-rs/codex-api/src/endpoint/realtime_websocket/methods_common.rs).
- Schema runtime: binary cục bộ `codex-cli 0.144.5`; lệnh `codex app-server generate-json-schema --experimental --out <tmp>` chạy ngày 2026-07-28.
- Codex release [`rust-v0.145.0`](https://github.com/openai/codex/releases/tag/rust-v0.145.0), commit khảo sát `25af12f7e61572b0bc18ddb1008be543b91519b0`; [`realtime_conversation.rs`](https://github.com/openai/codex/blob/rust-v0.145.0/codex-rs/core/src/realtime_conversation.rs), [`methods_frameless_bidi.rs`](https://github.com/openai/codex/blob/rust-v0.145.0/codex-rs/codex-api/src/endpoint/realtime_websocket/methods_frameless_bidi.rs), [`protocol_frameless_bidi.rs`](https://github.com/openai/codex/blob/rust-v0.145.0/codex-rs/codex-api/src/endpoint/realtime_websocket/protocol_frameless_bidi.rs), [`realtime.rs`](https://github.com/openai/codex/blob/rust-v0.145.0/codex-rs/app-server-protocol/src/protocol/v2/realtime.rs).
- Neko Core: `src/adapters/chatgpt-voice.ts`, `src/adapters/native-voice-audio.ts`, `src/ui/chat.tsx`, `test/chatgpt-voice.test.ts`, `test/native-voice-audio.test.ts`, đọc trực tiếp ngày 2026-07-28.
- Support Pack cục bộ: `~/.neko-core/codex-support/support-pack.json`; managed binary tự nhận `codex-app-server 0.145.0`.
- FFmpeg cục bộ: `ffmpeg -hide_banner -h demuxer=dshow` xác nhận `audio_buffer_size` là latency theo millisecond.

### Tài liệu OpenAI chính thức, truy cập 2026-07-28

- [GPT-Realtime-1.5 model](https://developers.openai.com/api/docs/models/gpt-realtime-1.5)
- [OpenAI model catalog](https://developers.openai.com/api/docs/models)
- [Realtime API reference](https://platform.openai.com/docs/api-reference/realtime)
- [Realtime API with WebRTC](https://developers.openai.com/api/docs/guides/realtime-webrtc)
- [Voice activity detection](https://developers.openai.com/api/docs/guides/realtime-vad)
- [Realtime conversations — handling interruptions](https://developers.openai.com/api/docs/guides/realtime-conversations#handling-interruptions)
- [GPT-Realtime-2.1 model](https://developers.openai.com/api/docs/models/gpt-realtime-2.1) — chỉ để ghi nhận SOTA công khai ngày chốt; không phải model của Codex 0.144.5/Neko v3.
