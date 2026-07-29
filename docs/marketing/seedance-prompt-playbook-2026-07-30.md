# Seedance 2.0 Prompt Playbook — nghiên cứu kỹ thuật đến 30/07/2026

> Trạng thái: **bản nghiên cứu hoàn chỉnh, đang kiểm toán nguồn/cú pháp**  
> Tạo: 30/07/2026 (Asia/Saigon)  
> Lần cập nhật gần nhất: 30/07/2026  
> Phạm vi: Seedance 2.0 của ByteDance; tài liệu ByteDance Seed, Volcengine, Dreamina/CapCut; arXiv:2604.14148; trải nghiệm Reddit r/Seedance_AI, X và blog thực hành.

## Cách đọc mức độ bằng chứng

- `[verified]`: claim cốt lõi được xác nhận bởi ít nhất hai nguồn độc lập; ưu tiên nguồn chính thức/sơ cấp.
- `[supported]`: có một nguồn sơ cấp tốt hoặc nhiều dấu hiệu cùng chiều nhưng chưa đủ hai nguồn độc lập.
- `[inference]`: suy luận thực hành từ bằng chứng đã nêu; không phải cam kết chính thức của sản phẩm.
- `[open]`: chưa đủ bằng chứng, nguồn xung đột hoặc tính năng phụ thuộc surface/khu vực/tài khoản.

Mỗi claim thực tế phải có `Nguồn:` và ngày trang công bố/cập nhật nếu có; dùng `n.d.` khi trang không công bố ngày. `Truy cập:` là ngày kiểm tra nguồn.

## Kết luận điều hành

- `[verified]` **Có âm thanh và thoại.** Seedance 2.0 sinh audio-video trong cùng lượt: lời thoại/voice-over, ambience, sound effects và nhạc nền; Volcengine bật/tắt bằng `generate_audio`. Audio stereo hai kênh và multi-shot dài tối đa 15 giây là capability chính thức.
- `[open]` **Tiếng Việt: có thể thử, chưa được xác nhận là ngôn ngữ hỗ trợ chính thức.** Paper chỉ benchmark sáu ngôn ngữ ngoài tiếng Trung: English, Japanese, Korean, Indonesian, Portuguese, Spanish; không có Vietnamese. Không có số liệu chính thức để gọi chất lượng thoại Việt là “tốt”. Với câu chữ phải chính xác, dùng TTS/thu âm tiếng Việt rồi hậu kỳ là đường an toàn.
- `[verified]` **Một generation có thể chứa nhiều shot.** Cú pháp chính thức ưu tiên `Shot 1 / Shot 2 / Shot 3` (hoặc `Cảnh quay 1/2/3`) theo thứ tự; guide tháng 7 cảnh báo ép mốc `0–3s` quá chính xác có thể bất ổn.
- `[verified]` **Giữ nhân vật bằng reference, không phải seed.** Dùng lại cùng headshot + full-body sạch trong mọi generation; bind rõ `@Image1`/`ảnh 1`; khóa ratio, resolution, style/light. First/last frame và `return_last_frame` giúp nối clip. `seed` chỉ điều khiển ngẫu nhiên, tài liệu không cam kết identity lock hay tái lập bit-exact.
- `[verified]` **Volcengine API không có field `negative_prompt`.** Negative/constraint được viết inline trong prompt. Dreamina cũng hướng dẫn negative instructions nhưng trang 2.0 không tài liệu hóa ô negative riêng.
- `[verified]` **API bản chuẩn** `doubao-seedance-2-0-260128`: 4–15 giây, 24 fps output; 480p/720p/1080p và 4K 10-bit HEVC theo tài liệu tháng 7. Paper v1 gọi 480p/720p là độ phân giải *native*; vì vậy không nên quảng cáo “native 4K”.

Nguồn: [ByteDance Seed — Official Launch](https://seed.bytedance.com/en/blog/seedance-2-0-official-launch) (12/02/2026), [paper arXiv:2604.14148 v1](https://arxiv.org/pdf/2604.14148) (15/04/2026), [Volcengine prompt guide](https://docs.volcengine.com/docs/82379/2222480?lang=zh) (cập nhật 20/07/2026), [Volcengine tutorial](https://docs.volcengine.com/docs/82379/2298881?lang=zh) (cập nhật 28/07/2026), [Volcengine Create Task API](https://api.volcengine.com/api-docs/view?action=CreateContentsGenerationsTasks&serviceCode=ark&version=2024-01-01) (cập nhật 07/05/2026). Truy cập: 30/07/2026.

## 1. Âm thanh, thoại và tiếng Việt

### 1.1 Có sinh âm thanh và lời thoại không?

`[verified]` **Có.** Seedance 2.0 là mô hình audio-video joint generation. Output có thể phối hợp đồng thời:

- lời thoại nhân vật hoặc voice-over;
- âm thanh môi trường và foley;
- nhạc nền/giai điệu;
- đồng bộ nhịp, hành động và khẩu hình.

Qua Volcengine API, đặt `"generate_audio": true`; `false` tạo video im lặng. Tài liệu API nói rõ model tự sinh giọng người, SFX và BGM dựa trên prompt/visual. Dreamina còn nhận voice/audio reference để hướng dẫn tone, pitch, emotion và lip-sync.

`[supported]` Chất lượng tốt so với thế hệ trước nhưng **không sạch tuyệt đối**. Paper nội bộ báo điểm audio/AV-sync dẫn đầu nhóm so sánh; chính ByteDance vẫn ghi nhận méo/nhiễu audio và lỗi lip-sync ở cảnh nhiều người nói. Người dùng r/Seedance_AI báo audio reference đôi khi bị đổi timing, từ hoặc ngữ điệu dù prompt yêu cầu giữ nguyên.

Nguồn: [ByteDance launch](https://seed.bytedance.com/en/blog/seedance-2-0-official-launch) (12/02/2026), [paper, tr. 1–3 và 16–17](https://arxiv.org/pdf/2604.14148) (15/04/2026), [Create Task API — `generate_audio`](https://api.volcengine.com/api-docs/view?action=CreateContentsGenerationsTasks&serviceCode=ark&version=2024-01-01) (07/05/2026), [Dreamina Seedance 2.0](https://dreamina.capcut.com/tools/seedance-2-0) (n.d.), [Reddit: audio không được giữ nguyên](https://www.reddit.com/r/Seedance_AI/comments/1v4cba5/how_can_i_force_seedance_20_to_use_my_uploaded/) (23/07/2026). Truy cập: 30/07/2026.

### 1.2 Có nói được tiếng Việt không? Chất lượng thế nào?

`[open]` Câu trả lời chính xác đến 30/07/2026 là: **Seedance 2.0 có thể nhận câu thoại tiếng Việt để thử sinh, nhưng ByteDance chưa công bố Vietnamese trong danh sách benchmark/support và chưa có đánh giá đáng tin để bảo đảm phát âm, dấu giọng hay lip-sync.**

- Prompt guide hỗ trợ “ngôn ngữ nhỏ/không phải Trung-Anh” bằng cách ghi rõ tên ngôn ngữ trước câu thoại. Đây là cú pháp tổng quát, không phải danh sách support.
- Paper đánh giá voice ngoài tiếng Trung trên **English, Japanese, Korean, Indonesian, Portuguese, Spanish**. Không tìm thấy “Vietnamese” trong paper.
- Ngay cả tiếng Trung, guide vẫn có workaround thay chữ hiếm/đa âm bằng chữ đồng âm dễ đọc; vậy không nên suy rằng tiếng Việt sẽ ổn định hơn.
- Báo cáo cộng đồng cho biết pre-recorded speech ở một “native language” chưa hỗ trợ có thể bị model sửa; post không nêu ngôn ngữ nên không được dùng làm bằng chứng riêng cho tiếng Việt.

**Khuyến nghị production cho tiếng Việt:**

1. Giữ một người nói mỗi shot; cận hoặc trung cận, miệng đủ lớn; câu ngắn vừa thời lượng.
2. Ghi rõ “nói bằng tiếng Việt”, giới tính/độ tuổi/chất giọng/vùng giọng, tốc độ và cảm xúc; không trộn ngôn ngữ trừ tên riêng.
3. Test 3–5 take ở draft/720p, nghe từng âm tiết và xem khẩu hình.
4. Nếu từng chữ phải đúng: tạo hình không thoại hoặc lip-sync tham chiếu, sau đó **thay audio gốc trong CapCut/Premiere**. Audio reference hiện không có bảo đảm “100% untouched”.

Nguồn: [Volcengine prompt guide — language/symbol rules](https://docs.volcengine.com/docs/82379/2222480?lang=zh) (20/07/2026), [paper Table 20](https://arxiv.org/pdf/2604.14148) (15/04/2026), [Reddit audio-reference limitation](https://www.reddit.com/r/Seedance_AI/comments/1v4cba5/how_can_i_force_seedance_20_to_use_my_uploaded/) (23/07/2026). Truy cập: 30/07/2026.

### 1.3 Cú pháp thoại chuẩn theo từng surface

| Surface | Cú pháp có căn cứ | Ví dụ nên dùng |
|---|---|---|
| Volcengine prompt guide | `{lời thoại}`; với ngôn ngữ không phải Trung/Anh, ghi rõ ngôn ngữ | `Cô gái nói bằng tiếng Việt, giọng miền Nam ấm, rõ, tốc độ vừa {Xin chào, hôm nay mình sẽ chỉ bạn một mẹo nhỏ}` |
| Volcengine Create Task API | Tài liệu khuyên đặt lời thoại trong dấu ngoặc kép; trong JSON phải escape `\"` | `"text": "Cận cảnh. Cô gái nói bằng tiếng Việt, nhẹ và rõ: \"Xin chào, rất vui được gặp bạn.\""` |
| Dreamina/CapCut | Natural language + tên asset `@AssetName`; trang chính thức không quy định `{}` là bắt buộc | `@Image1 as character reference. The woman speaks in Vietnamese, warm Southern accent: "Xin chào..." No subtitles.` |

Quy ước symbol chính thức trong prompt guide:

- nhạc: `(nhạc nền piano chậm, nhỏ)`;
- SFX: `<tiếng cửa gỗ khép nhẹ>`;
- thoại: `{Xin chào}`;
- chữ/subtitle cần xuất hiện: `【Chương 1: Khởi hành】`.

`[inference]` Không cần trộn tất cả symbol. Chọn **một convention nhất quán theo surface**; nếu API đã dùng dấu ngoặc kép thì ưu tiên ví dụ API. Đừng nhầm `@Audio1` (tham chiếu tone/nhịp) với lệnh giữ nguyên waveform.

Nguồn: [Volcengine prompt guide](https://docs.volcengine.com/docs/82379/2222480?lang=zh) (20/07/2026), [Create Task API](https://api.volcengine.com/api-docs/view?action=CreateContentsGenerationsTasks&serviceCode=ark&version=2024-01-01) (07/05/2026), [Dreamina tutorial](https://dreamina.capcut.com/resource/how-to-use-seedance-2-0) (n.d.). Truy cập: 30/07/2026.

## 2. Multi-shot trong một lần sinh

### 2.1 Có thể có nhiều cú máy không?

`[verified]` **Có.** Official launch ghi rõ high-quality multi-shot audio-video dài tới 15 giây; paper gọi đây là “professional multi-shot narrative capability”. Cùng một clip có thể cắt từ toàn cảnh sang trung cảnh, cận cảnh, POV hoặc reaction shot, với audio tiếp diễn xuyên shot.

Không có tài liệu chính thức công bố “tối đa N shot”. Các ví dụ cộng đồng cho thấy 6 shot/15 giây và thậm chí 15 micro-cut/15 giây có thể chạy, nhưng creator X lưu ý đôi khi vẫn phải sửa các cut nhỏ. Đó là demo, không phải SLA.

Nguồn: [ByteDance launch](https://seed.bytedance.com/en/blog/seedance-2-0-official-launch) (12/02/2026), [paper](https://arxiv.org/pdf/2604.14148) (15/04/2026), [Higgsfield prompt guide](https://higgsfield.ai/blog/seedance-prompting-guide) (13/04/2026), [Dheepan Ratnam trên X](https://x.com/Dheepanratnam/status/2042910477320114293) (11/04/2026). Truy cập: 30/07/2026.

### 2.2 Cú pháp ưu tiên

Volcengine prompt guide cập nhật 20/07 khuyên dùng thứ tự shot, **không ép timestamp**:

```text
Định nghĩa nhân vật: Mai = cô gái trong ảnh 1, tóc bob đen, áo khoác vàng.
Phong cách toàn cục: phim trinh thám đêm mưa, 35mm, tương phản thấp, xanh thép; cùng gương mặt, tóc và trang phục xuyên suốt.

Cảnh quay 1 — Toàn cảnh, máy dolly-in chậm. Mai bước vào ngõ, vai hơi co vì lạnh. <mưa nhỏ, tiếng bước chân>
Cảnh quay 2 — Cắt sang trung cận. Mai dừng lại, quay đầu chậm; ánh đèn xe quét qua mặt. Cô nói nhỏ {Có ai ở đó không?}
Cảnh quay 3 — Cận cảnh phản ứng, máy cố định. Đồng tử chuyển sang trái, bàn tay siết nhẹ quai túi. Nhạc trầm dừng đột ngột.

Ràng buộc: không phụ đề, không logo, không đổi mặt/trang phục, không flicker, không nhân vật trùng lặp.
```

Mỗi shot nên có: **shot size/cut → chủ thể → một hành động chính → vị trí/thay đổi không gian → một camera move → audio**. Lặp đúng tên nhân vật, không dùng “cô ấy/anh ấy” mơ hồ khi có nhiều người.

`[verified]` Guide nói hỗ trợ `Shot 1/2/3` và ưu tiên nhịp tự nhiên vì mốc chính xác như `0–3 giây` chưa ổn định. `Timestamp` vẫn xuất hiện trong ví dụ API/Dreamina và được cộng đồng dùng tốt cho beat/montage; hãy xem nó là **soft timing**. Nếu đúng frame/time là bắt buộc, sinh shot riêng rồi dựng ở timeline.

Nguồn: [Volcengine prompt guide — storyboard timing](https://docs.volcengine.com/docs/82379/2222480?lang=zh) (20/07/2026), [Create Task API example](https://api.volcengine.com/api-docs/view?action=CreateContentsGenerationsTasks&serviceCode=ark&version=2024-01-01) (07/05/2026), [Dreamina prompt guide](https://dreamina.capcut.com/resource/seedance-2-0-prompt) (20/04/2026 trên bản localized). Truy cập: 30/07/2026.

### 2.3 Khi nào multi-shot, khi nào sinh từng shot?

- Dùng **multi-shot một lượt** cho nhịp kể ngắn, reaction, montage, phát hiện camera angle mới; continuity nội clip thường tốt hơn giữa các generation độc lập.
- Dùng **một shot mỗi lượt** khi identity, chữ/logo, product detail, thoại chính xác hoặc choreography là tiêu chí cứng.
- Dùng **video extension** cho một cảnh thoại/đường chuyển động liên tục; dùng clip riêng + hậu kỳ cho chase/fight/montage phức tạp.
- `[inference]` Với 15 giây và nhân vật quan trọng, khởi đầu 3–5 shot. Chỉ tăng micro-cut khi mỗi beat cực đơn giản và chấp nhận hậu kỳ.

Nguồn: [Volcengine prompt guide — extension vs segmented editing](https://docs.volcengine.com/docs/82379/2222480?lang=zh) (20/07/2026), [Creative Bloq phỏng vấn Kévin Mendiboure](https://www.creativebloq.com/ai/how-a-filmmaker-turned-a-10-year-old-unmakeable-movie-idea-into-reality-with-ai) (09/06/2026). Truy cập: 30/07/2026.

## 3. Giữ nhất quán nhân vật giữa các lần sinh

### 3.1 Thứ tự ưu tiên thực tế

`[verified]` Không có một công tắc “character lock” tuyệt đối. Thứ tự đáng tin cậy là:

1. **Cùng reference sạch trong mọi request.** Một headshot thẳng, đủ sáng, nền đơn giản + một ảnh toàn thân/trang phục. Mặt phải chiếm tỷ lệ lớn ở headshot.
2. **Bind asset và định nghĩa nhân vật một lần.** Ví dụ: `Mai@Image1`; hoặc `Gương mặt Mai tham chiếu ảnh 1, trang phục tham chiếu ảnh 2`. Dùng lại đúng nhãn “Mai” ở mọi shot.
3. **Đặt reference quan trọng lên đầu prompt.** Giữ nguyên thứ tự upload, prompt template, ratio, resolution, style, palette và ánh sáng qua các generation.
4. **Dùng first frame chất lượng cao.** Với shot tiếp theo, tạo/chuẩn hóa start frame có đúng nhân vật, set, costume và ánh sáng trước khi animate.
5. **Nối bằng last frame.** API đặt `return_last_frame: true`; lấy PNG không watermark làm `role: "first_frame"` ở task sau. Có thể đặt cả `first_frame` + `last_frame` để khóa hai đầu clip.
6. **Seed là phụ.** Giữ cùng seed giúp giảm một nguồn ngẫu nhiên nhưng không thay thế reference/first frame và không bảo đảm identity.

Nguồn: [Volcengine prompt guide — ID drift](https://docs.volcengine.com/docs/82379/2222480?lang=zh) (20/07/2026), [Create Task API — `return_last_frame`, `seed`](https://api.volcengine.com/api-docs/view?action=CreateContentsGenerationsTasks&serviceCode=ark&version=2024-01-01) (07/05/2026), [Reddit: two-week consistency test](https://www.reddit.com/r/aivideos/comments/1smtzb9/seedance_20_character_consistency_across_shots/) (16/04/2026), [Creative Bloq filmmaker interview](https://www.creativebloq.com/ai/how-a-filmmaker-turned-a-10-year-old-unmakeable-movie-idea-into-reality-with-ai) (09/06/2026). Truy cập: 30/07/2026.

### 3.2 `@Image1`, upload order và API role

- **Dreamina UI:** gọi asset theo tên hiển thị, ví dụ `@Image1`, `@Video1`, `@Audio1`, rồi gán việc cụ thể: identity, costume, camera, motion, music.
- **Volcengine guide/console:** dùng `图片1/视频1/音频1` (ảnh 1/video 1/audio 1) theo thứ tự upload; guide cũng hiển thị dạng `@图片1` trong ví dụ UI. Không đưa raw Asset ID vào prompt thay cho tên asset.
- **Volcengine API:** asset nằm trong `content` với role `reference_image`, `reference_video`, `reference_audio`. Để khóa biên, dùng `first_frame` và `last_frame`.

```json
{
  "model": "doubao-seedance-2-0-260128",
  "content": [
    {"type": "text", "text": "Mai giữ nguyên gương mặt, tóc và áo khoác; quay đầu chậm rồi nhìn thẳng ống kính."},
    {"type": "image_url", "image_url": {"url": "https://.../start.png"}, "role": "first_frame"},
    {"type": "image_url", "image_url": {"url": "https://.../end.png"}, "role": "last_frame"}
  ],
  "duration": 5,
  "ratio": "adaptive",
  "generate_audio": true,
  "return_last_frame": true,
  "seed": 123456,
  "watermark": false
}
```

`[supported]` Official guide khuyên **không nạp một collage nhiều góc/multi-view** trực tiếp vì model có thể hiểu thành nhiều người và sinh “song sinh”. Character sheet nhiều góc vẫn hữu ích ở khâu pre-production để tạo các start frame; khi gọi Seedance, tách thành ảnh đơn sạch hoặc dùng start frame đã tổng hợp.

Nguồn: [Volcengine prompt guide](https://docs.volcengine.com/docs/82379/2222480?lang=zh) (20/07/2026), [Volcengine video tutorial](https://docs.volcengine.com/docs/82379/2298881?lang=zh) (28/07/2026), [Dreamina tutorial](https://dreamina.capcut.com/resource/how-to-use-seedance-2-0) (n.d.), [Creative Bloq](https://www.creativebloq.com/ai/how-a-filmmaker-turned-a-10-year-old-unmakeable-movie-idea-into-reality-with-ai) (09/06/2026). Truy cập: 30/07/2026.

## 4. Negative prompt

### 4.1 Có field/cú pháp riêng không?

`[verified]` **Volcengine Create Task API không có `negative_prompt` field.** Schema chỉ nhận negative constraints trong text prompt. Dreamina chính thức khuyên “use negative prompts wisely” nhưng hướng dẫn Seedance 2.0 không chỉ ra một ô negative riêng hoặc delimiter đặc biệt. Vì vậy cú pháp bền nhất là một dòng cuối:

```text
Ràng buộc: không phụ đề hay chữ trên màn hình; không logo/watermark; không đổi mặt, tóc, trang phục; không thêm người; không tay/ngón thừa; không morphing; không flicker; không chuyển động giật hoặc vật lý phi lý.
```

`watermark: false` chỉ điều khiển **AI watermark do platform thêm**. Nó không ngăn model vẽ logo/watermark giả bên trong hình; vẫn cần “không logo, không watermark” trong prompt và input sạch chữ.

Nguồn: [Create Task API schema](https://api.volcengine.com/api-docs/view?action=CreateContentsGenerationsTasks&serviceCode=ark&version=2024-01-01) (07/05/2026), [Volcengine prompt guide — constraints/common problems](https://docs.volcengine.com/docs/82379/2222480?lang=zh) (20/07/2026), [Dreamina prompt guide](https://dreamina.capcut.com/resource/seedance-2-0-prompt) (20/04/2026 trên bản localized). Truy cập: 30/07/2026.

### 4.2 Bộ constraint nên dùng

| Mục tiêu | Cụm từ gợi ý |
|---|---|
| Không chữ rác | `không phụ đề; không text overlay; không ký tự ngẫu nhiên; không logo; không watermark` |
| Giữ identity | `cùng một gương mặt, tóc, tuổi, trang phục và tỷ lệ cơ thể ở mọi shot; không đổi mặt; không sinh bản sao/song sinh` |
| Giữ hình thể | `giải phẫu tự nhiên; đúng hai tay; bàn tay/ngón tay ổn định; không chi thừa; không biến dạng` |
| Chuyển động | `một hành động chính mỗi shot; chuyển động liên tục, có quán tính, đúng trọng lực; không giật/cà kheo/trượt chân` |
| Ổn định hình | `không morphing; không melting; không flicker; không texture crawl; không vật thể tự xuất hiện/biến mất` |
| Camera | `một camera move mỗi shot; không zoom/pan/orbit ngẫu nhiên; không đổi tiêu cự đột ngột` |
| Audio | `không nhạc nền` hoặc `chỉ ambience`; `một người nói mỗi shot`; `không thêm lời`; `không tiếng click ở cuối` |

`[inference]` Hãy dùng 3–6 constraint **liên quan trực tiếp** tới failure có khả năng xảy ra, không dán một “negative mega-list” 50 từ. Mâu thuẫn hoặc quá nhiều phủ định làm loãng action/camera chính. Viết điều muốn giữ theo dạng dương (`gương mặt ổn định`, `camera cố định`) rồi thêm một phủ định ngắn cho lỗi quan trọng.

## 5. Lỗi thường gặp và cách tránh

| Lỗi | Nguyên nhân/dấu hiệu | Cách giảm lỗi có căn cứ |
|---|---|---|
| Mặt đổi, ID drift | Face quá nhỏ; collage head/full-body; nhiều style/light; text-only qua nhiều generation | Headshot độc lập, thẳng/đủ sáng/ít biểu cảm + full-body riêng; bind rõ ảnh nào cho mặt/trang phục; dùng lại cùng reference ở mọi request; khóa ratio/resolution/light; ưu tiên start frame |
| Nhân vật “song sinh”/bị lặp | Multi-view bị hiểu thành nhiều người; chủ thể mơ hồ; nhiều người trong cảnh | Không nạp một collage multi-view; ảnh một người; lặp tên + asset; thêm constraint cấm duplicate/twin; official guide cảnh báo trên 4 reference character làm ổn định giảm |
| Tay/mặt/cơ thể biến dạng | Quá nhiều động tác mạnh, người che nhau, camera phức tạp | Một action chính/shot; mô tả bộ phận + tốc độ + lực; ưu tiên động tác chậm, liên tục; cận vừa thay vì extreme close-up tay phức tạp; dùng motion-reference video |
| Chuyển động sai vật lý/floaty | Động từ trừu tượng, không có điểm tựa/quán tính; action và camera cùng quá mạnh | Ghi chuỗi nguyên nhân → lực → quán tính → dừng; nêu tiếp xúc, trọng lực, hướng; một camera move/shot; với fight/dance dùng reference choreography; sinh shot riêng nếu quá phức tạp |
| Morphing/đồ vật đổi hình | Transformation dài, detail conflict, vật thể bị che/mở lại | Khóa silhouette/material/color; mô tả từng phase ngắn; first/last frame; tránh vừa transform vừa orbit/zoom; tách shot và dựng hậu kỳ nếu product/logo phải chính xác |
| Chữ sai/gibberish | Text restoration vẫn là điểm yếu; chữ hiếm/ký hiệu đặc biệt | Dùng chữ thông dụng, rất ngắn; nêu nội dung, vị trí, thời điểm, style; nếu phải đúng tuyệt đối (đặc biệt dấu tiếng Việt/logo), tạo clip không chữ rồi composite typography trong CapCut/AE |
| Tự sinh subtitle/logo/watermark | Model học từ video có overlay hoặc input chứa chữ | Input sạch chữ; constraint `không phụ đề/chữ/logo/watermark`; horizontal trước rồi crop dọc có thể giảm subtitle tự sinh; `watermark:false` cho watermark của API |
| Style drift/da nhựa | Reference viết thực nhưng muốn hoạt hình, hoặc style chỉ nói chung chung | Chuyển reference sang style đích trước; khóa palette/material/light ở header; dùng mô tả chất liệu cụ thể; tránh chỉ viết “cinematic” |
| Shot nối bị giật/lùi | Extension overlap hoặc frame đầu/cuối lệch | Kết clip ở cut/transition tự nhiên; official workaround: khi ghép extension, cắt 6 frame cuối đoạn trước và 1 frame đầu đoạn sau; vẫn kiểm tra tay/mặt tại splice |
| First/last-frame bị kéo giãn | Tỷ lệ ảnh đầu/cuối không khớp output | Crop ảnh đúng pixel/aspect; đặt `ratio:"adaptive"`; không dùng hai frame khác tỷ lệ/composition cực đoan |
| Extension càng dài càng bẩn | Tích lũy compression/generation, mặt xuất hiện block | Hạn chế số lần extend; dùng nguồn HD; tạo lại start frame từ master asset; official guide nêu workflow white-model cho một số cảnh nhưng đây không phải lựa chọn mặc định |
| Thoại đổi người/khẩu hình sai | Nhiều speaker, line dài, mặt nhỏ; audio ref bị reinterpret | Một người nói/shot; gọi tên trước line; cận/trung cận; câu ngắn; tách lượt thoại; với tiếng Việt chính xác, post-mix audio gốc |
| Click/nhiễu ở cuối | Audio bị cắt đúng biên clip | Regenerate hoặc fade-out audio envelope trong CapCut; để khoảng thở cuối prompt/clip |

`[verified]` Paper tự liệt kê các điểm cần cải thiện: minor deformation, edge-case motion plausibility, high-frequency visual noise, audio distortion/noise và multi-speaker lip-sync. Official launch còn nêu multi-subject consistency, text restoration và complex editing chưa tối ưu. Đây là failure mode của model, không phải lúc nào prompt cũng sửa được.

Nguồn: [paper, tr. 3](https://arxiv.org/pdf/2604.14148) (15/04/2026), [ByteDance launch](https://seed.bytedance.com/en/blog/seedance-2-0-official-launch) (12/02/2026), [Volcengine prompt guide — common problems](https://docs.volcengine.com/docs/82379/2222480?lang=zh) (20/07/2026), [Volcengine tutorial — aspect jump](https://docs.volcengine.com/docs/82379/2291680?lang=zh) (07/07/2026), [Reddit dialogue swap](https://www.reddit.com/r/u_Sakura_Liamahs/comments/1uu6kxr/anyone_else_struggling_with_character_dialogue/) (07/2026), [TechRadar field observation](https://www.techradar.com/ai-platforms-assistants/ive-been-watching-seedance-2-0-videos-so-you-dont-have-to-and-they-are-a-nightmare-dreamscape) (23/02/2026). Truy cập: 30/07/2026.

## 6. Tham số kỹ thuật: Volcengine API và Dreamina UI

### 6.1 Volcengine Ark Video Generation API

Endpoint tạo task bất đồng bộ:

```text
POST https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks
GET  https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks/{id}
```

| Tham số | Seedance 2.0 chuẩn | Ghi chú |
|---|---|---|
| `model` | `doubao-seedance-2-0-260128` | Fast: `doubao-seedance-2-0-fast-260128`; Mini: `doubao-seedance-2-0-mini-260615` |
| `content` | text + image/video/audio refs | Open platform: tối đa 9 ảnh, 3 video, 3 audio; role `reference_*`, `first_frame`, `last_frame` |
| `generate_audio` | `true`/`false` | 2.0/2.0 Fast hỗ trợ; không suy default, nên đặt rõ |
| `resolution` | `480p`, `720p`, `1080p`, `4k` | Default API schema: `720p`; chỉ bản chuẩn có 1080p/4K; 4K là 10-bit H.265/HEVC |
| `ratio` | `16:9`, `4:3`, `1:1`, `3:4`, `9:16`, `21:9`, `adaptive` | Default cho 2.0: `adaptive`; first/last frame nên dùng `adaptive` nếu chưa crop |
| `duration` | số nguyên 4–15, hoặc `-1` | `-1` để model chọn số giây hợp lệ |
| FPS | output 24 fps | Response trả `framespersecond: 24`; `frames` **chưa hỗ trợ** ở 2.0/fast, không có documented FPS setter |
| `seed` | integer từ `-1` đến `2^32-1` | Kiểm soát randomness; không có cam kết tái lập/identity lock |
| `watermark` | `true`/`false` | `true`: AI mark góc phải dưới; `false`: platform không thêm mark |
| `return_last_frame` | `true`/`false` | Trả PNG cùng kích thước, không watermark để nối task |
| `camera_fixed` | **chưa hỗ trợ** ở 2.0/fast | Đừng copy generic example có field này rồi kỳ vọng hiệu lực |
| Output | MP4 | 4K dùng HEVC 10-bit; cần player/browser tương thích |

Body tối thiểu nên truyền tham số tường minh:

```json
{
  "model": "doubao-seedance-2-0-260128",
  "content": [
    {
      "type": "text",
      "text": "Trung cận, máy dolly-in chậm. Người phụ nữ nói bằng tiếng Việt: \"Xin chào.\" Không phụ đề."
    }
  ],
  "generate_audio": true,
  "resolution": "720p",
  "ratio": "16:9",
  "duration": 5,
  "seed": 123456,
  "watermark": false,
  "return_last_frame": true
}
```

`[verified]` Tài liệu chung tháng 5 chỉ liệt kê đến 1080p, còn tutorial tháng 7 thêm 4K cho bản chuẩn. Paper v1 nói native 480p/720p. Cách ghi trung thực: **API output hỗ trợ 4K 10-bit; paper không gọi đó là native 4K.**

Nguồn: [Create Task API](https://api.volcengine.com/api-docs/view?action=CreateContentsGenerationsTasks&serviceCode=ark&version=2024-01-01) (07/05/2026), [Volcengine 2.0 tutorial](https://docs.volcengine.com/docs/82379/2291680?lang=zh) (07/07/2026), [Volcengine general video tutorial](https://docs.volcengine.com/docs/82379/2298881?lang=zh) (28/07/2026), [paper](https://arxiv.org/pdf/2604.14148) (15/04/2026). Truy cập: 30/07/2026.

### 6.2 Dreamina/CapCut UI

| Mục | Những gì trang chính thức công bố | Độ chắc chắn |
|---|---|---|
| Asset syntax | `@AssetName`; Single-frame cho first/last frame, Multiframes cho image/video/audio | `[supported]` theo tutorial |
| Reference | 9 ảnh, 3 video, 3 audio; video/audio tới 15 s | `[verified]` với ByteDance/paper; Dreamina có câu “12 clips” nhưng phép cộng danh sách là 15, nên bỏ con số 12 |
| Aspect ratio | `16:9`, `4:3`, `1:1`, `3:4`, `9:16` | `[supported]`; trang UI không nêu `21:9` dù API có |
| Resolution | UI page nêu 720p–1080p; download 1080p; có Upscale/4K workflow | `[supported]`; phụ thuộc plan/surface, không gọi là native 4K |
| Duration | Một guide nêu ví dụ 5/10/15 s; landing page khác ghi 5–12 s | `[open]` vì tài liệu Dreamina tự mâu thuẫn; dùng option thực tế tài khoản |
| FPS | Không thấy generation-FPS setting được tài liệu hóa; tool Frame Interpolation có thể ra 30/60 fps | `[supported]` đây là hậu xử lý, không phải model FPS |
| Seed | Không thấy seed control được tài liệu hóa công khai cho UI | `[open]`; không giả định có |
| Watermark | Trial/plan có thể khác; paid tier thường mở export chất lượng cao hơn | `[open]`; kiểm tra plan/export dialog của tài khoản |
| Audio | Native/reference audio; có thêm `Generate soundtrack` sau generation | `[supported]`; không nhầm post-tool với `generate_audio` API |

Nguồn: [Dreamina Seedance 2.0 tool page](https://dreamina.capcut.com/tools/seedance-2-0) (n.d.), [Dreamina how-to](https://dreamina.capcut.com/resource/how-to-use-seedance-2-0) (n.d.), [Dreamina prompt guide](https://dreamina.capcut.com/resource/seedance-2-0-prompt) (20/04/2026 trên bản localized), [Dreamina 4K creator guide](https://dreamina.capcut.com/seedance/seedance-2-0-4k-for-content-creators) (n.d.). Truy cập: 30/07/2026.

## 7. Làm video “điện ảnh” hơn

### 7.1 “Cinematic” là một hệ thống quyết định

`[verified]` Paper đánh giá cinematic language theo logic shot, tính biểu cảm, vi phạm trục 180°, shot-size mismatch và pacing; aesthetics theo lighting, framing, composition, color grading, costume/prop/set coherence. Vì vậy thêm mỗi chữ `cinematic` không đủ.

Viết prompt theo bảy lớp:

1. **Ý đồ shot:** khán giả cần cảm thấy/biết điều gì sau shot này?
2. **Subject/blocking:** ai ở đâu, nhìn/hướng/chạm gì, một hành động chính.
3. **Shot size + lens feel:** wide/medium/close-up; `24mm wide`, `50mm natural`, `85mm portrait` nếu cần, nhưng không lạm dụng thông số.
4. **Một camera move:** static, slow dolly-in, lateral tracking, orbit, handheld breathing; không gom push + pull + pan + crane trong một shot.
5. **Lighting:** nguồn sáng, hướng, độ cứng, contrast, practicals; ví dụ `soft window key + warm rim from hallway`.
6. **Palette/texture:** 2–3 màu, vật liệu và grade; ví dụ `steel blue shadows, sodium-orange practicals, subtle 35mm grain`.
7. **Sound/pacing:** ambience, foley, thoại, beat/cut; âm thanh phải hỗ trợ trọng lượng chuyển động.

### 7.2 Workflow chất lượng cao nhất

- Viết script, character/set/prop bible và shot list trước; Seedance là camera/generator, không thay pre-production.
- Chốt **start frame đẹp** trước khi animate. Filmmaker Kévin Mendiboure coi start frame là yếu tố quan trọng nhất cho photorealism.
- Test prompt bằng Fast/720p hoặc clip 4–5 s; đổi **một biến mỗi lượt**; khi motion/camera/identity ổn mới render Standard/độ phân giải cao.
- Dùng 4–5 reference có vai trò rõ thay vì nhồi mức tối đa: 1–2 character, 1 scene, 1 motion/camera video, 1 audio.
- Mỗi asset một nhiệm vụ. Reference camera phải tương thích nhịp audio; dolly chậm đối nghịch EDM nhanh sẽ làm model nhận chỉ dẫn thời gian xung đột.
- Sinh nhiều take và QC từng tiêu chí: mặt/tay, object continuity, motion/physics, text/logo, cut, audio/lip-sync. “One prompt” hiếm khi là production workflow thực tế.
- Hậu kỳ vẫn là bước bắt buộc cho typography, audio thoại chính xác, splice, color match và cleanup.

Nguồn: [paper — cinematic/narrative evaluation](https://arxiv.org/pdf/2604.14148) (15/04/2026), [Volcengine prompt guide](https://docs.volcengine.com/docs/82379/2222480?lang=zh) (20/07/2026), [Creative Bloq filmmaker interview](https://www.creativebloq.com/ai/how-a-filmmaker-turned-a-10-year-old-unmakeable-movie-idea-into-reality-with-ai) (09/06/2026), [ChatCut X guide](https://x.com/chatcutapp/status/2041763561333264865) (08/04/2026), [Reddit consistency test](https://www.reddit.com/r/aivideos/comments/1smtzb9/seedance_20_character_consistency_across_shots/) (16/04/2026). Truy cập: 30/07/2026.

## Mẫu prompt làm việc

```text
ASSET / ID
- Mai@Image1: khóa gương mặt, tóc bob đen, nốt ruồi nhỏ dưới mắt trái.
- Image2: khóa áo khoác vàng và túi da nâu.
- Video1: chỉ tham chiếu nhịp camera tracking, không lấy nhân vật/bối cảnh.
- Audio1: chỉ tham chiếu ambience mưa nhẹ và tone nhạc trầm.

GLOBAL LOOK
Phim neo-noir hiện thực, 16:9; 50mm tự nhiên; bóng xanh thép, đèn sodium cam; contrast vừa, da tự nhiên, grain 35mm rất nhẹ. Mai giữ nguyên gương mặt, tóc, tuổi, tỷ lệ và trang phục xuyên suốt.

CẢNH QUAY 1
Toàn cảnh ngõ đêm mưa, máy tracking ngang chậm. Mai bước ba bước, tay phải giữ quai túi; giày chạm vũng nước tạo gợn nhỏ. <mưa nhỏ, bước chân ướt>

CẢNH QUAY 2
Cắt sang trung cận, máy dolly-in rất nhẹ. Mai dừng, quay đầu chậm theo tiếng động; ánh đèn xe quét qua mắt. Mai nói bằng tiếng Việt, giọng miền Nam thấp và rõ {Có ai ở đó không?}

CẢNH QUAY 3
Cận cảnh reaction, máy cố định. Mắt Mai nhìn lệch trái, ngón tay siết quai túi; nhạc ngừng, chỉ còn mưa.

RÀNG BUỘC
Không phụ đề/chữ/logo/watermark; không đổi mặt/tóc/trang phục; không người trùng lặp; giải phẫu tự nhiên; không morphing/flicker; một camera move mỗi shot; chuyển động có quán tính và đúng trọng lực.
```

Dùng prompt này như **khung**, không copy nguyên style cho mọi video. Với API, đổi `Image1/Video1/Audio1` thành đúng thứ tự/role trong `content`; với Dreamina, dùng tên `@AssetName` mà UI hiển thị.

## Checklist và cú pháp chuẩn

`[open]` Sẽ chốt sau khi hoàn tất đối chiếu 7 câu hỏi.

## Lỗi cần tránh

`[open]` Sẽ chốt thành danh sách kiểm tra ngắn, áp dụng ngay.

## Ledger nguồn

| ID | Loại | Nguồn | Ngày nguồn | Truy cập | Dùng để xác minh |
|---|---|---|---|---|---|
| P01 | Paper sơ cấp | [arXiv:2604.14148](https://arxiv.org/abs/2604.14148) | 04/2026 (cần xác minh revision) | 30/07/2026 | Kiến trúc/capability, prompting hoặc đánh giá được paper công bố |

## Claim ledger

| Claim | Trạng thái | Nguồn | Ghi chú giới hạn |
|---|---|---|---|
| Seedance 2.0 sinh âm thanh/thoại | `[open]` | Chưa đối chiếu | Phải tách model capability khỏi surface được cấp quyền |
| Hỗ trợ thoại tiếng Việt | `[open]` | Chưa đối chiếu | Phải tách “nhận prompt tiếng Việt” khỏi “phát âm tiếng Việt” |
| Một generation hỗ trợ multi-shot | `[open]` | Chưa đối chiếu | Cần cú pháp và giới hạn thực tế |
| Seed bảo đảm identity qua các lần sinh | `[open]` | Chưa đối chiếu | Không suy từ deterministic sampling sang identity lock |
| Có negative prompt riêng | `[open]` | Chưa đối chiếu | Có thể khác giữa API và UI |

## Nhật ký cập nhật

- 30/07/2026: Tạo ledger và khung câu hỏi; chưa chốt claim kỹ thuật nào trước khi đọc nguồn.