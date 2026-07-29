# Bộ prompt Seedance 2.0 — video "Tôi đi thi Thực Chiến AI" (đội Neko Core)

> Soạn 30/07/2026. Căn cứ kỹ thuật: `seedance-prompt-playbook-2026-07-30.md` (nghiên cứu tài liệu
> chính thức ByteDance Seed / Volcengine / Dreamina + paper arXiv:2604.14148 + kinh nghiệm người dùng).
> **Dán nguyên khối trong ô ``` vào Seedance. Không sửa gì cũng chạy được.**

---

## 0. Cài đặt trước khi sinh (đặt một lần, giữ nguyên cho MỌI clip)

| Thông số | Chọn | Vì sao |
|---|---|---|
| Tỷ lệ | **16:9** | Giữ nguyên giữa các clip, đổi giữa chừng là drift |
| Độ phân giải | **1080p** | Native của model là 480p/720p, 1080p là mức dịch vụ nâng |
| Thời lượng mỗi lần sinh | **5 giây** (tối đa 15) | 6 cảnh × 5 giây = 30 giây |
| Âm thanh (`generate_audio`) | **BẬT** cho cảnh 1, 4, 6 · **TẮT** cho cảnh có người nói | Xem mục 3 |
| Seed | để tự do | Seed **không** khoá được danh tính nhân vật |

**Ba điều đã kiểm chứng, đọc trước khi bắt tay:**

1. **Không có ô negative prompt** (Volcengine API không có field này) → mọi điều cấm phải viết
   **thẳng trong prompt**. Các prompt dưới đây đã có sẵn câu cấm ở cuối.
2. **Tiếng Việt CHƯA nằm trong danh sách ngôn ngữ được ByteDance benchmark** (paper chỉ đo
   Anh/Nhật/Hàn/Indonesia/Bồ/Tây Ban Nha). → **Tự thu lời thoại**, đừng để model nói tiếng Việt.
3. **Ký hiệu chính thức trong prompt**: nhạc `(...)` · tiếng động `<...>` · lời thoại `{...}` ·
   chữ hiện trên hình `【...】`. Ta dùng `(...)` và `<...>`, **không dùng** `【...】` (chữ để dựng sau).

---

## 1. Sáu prompt — dán từng cái một

> Mỗi cảnh sinh **3 lần**, chọn take tốt nhất. Prompt viết bằng tiếng Anh vì model bám sát hơn;
> phần dịch để anh hiểu mình đang yêu cầu gì.

### Cảnh 1 (0–5s) — Terminal thức dậy · *có tiếng*

```
5 seconds, 16:9, cinematic. Extreme close-up of a dark laptop terminal screen in an unlit room at
night. A single amber block cursor blinks twice, then dense monospace code lines cascade upward,
their glow reflecting on the glossy screen surface and faintly on a pair of glasses out of focus in
the foreground. Camera pushes in very slowly, shallow depth of field, dust motes drifting through the
light. Deep black background, one warm amber accent color, film grain, no color banding.
(low ambient hum) <soft mechanical keyboard clicks, distant laptop fan>
Do not render any readable text, letters, numbers, logos or watermarks. No people, no captions.
```
*Dịch: cận cảnh màn hình terminal tối, con trỏ hổ phách nhấp nháy rồi mã chạy lên, máy đẩy vào rất
chậm, có tiếng gõ phím và quạt máy. Cấm sinh chữ đọc được.*

---

### Cảnh 2 (5–10s) — Người lập trình trong đêm · *tắt tiếng nếu quay thật*

> **Ưu tiên quay thật bằng điện thoại** (giám khảo tin gương mặt thật, và Seedance đòi xác minh khi
> dùng ảnh người thật). Chỉ dùng prompt này nếu không quay được.

```
5 seconds, 16:9, cinematic. @Image1 is the identity and wardrobe reference: keep the face, hair and
clothing unchanged. Medium close-up of a young Vietnamese man in his early twenties sitting in a dark
room, lit only by the laptop screen in front of him. He types, pauses, reads something on screen, then
a small satisfied smile appears. Camera slowly arcs from his profile toward three-quarter view, eye
level, shallow depth. Cool screen light on the face, warm practical lamp far behind, natural skin
texture, no beauty smoothing.
<soft keyboard typing, quiet room tone>
Keep the same face throughout, no morphing. Do not render text, logos, subtitles or extra people.
```
*Đính kèm: 1 ảnh chính diện rõ mặt của Hùng làm `@Image1`.*

---

### Cảnh 3 (10–15s) — Agent đang làm việc · **QUAY MÀN HÌNH THẬT**

> **Đừng sinh cảnh này.** Đây là bằng chứng sản phẩm — quay màn hình thật mới có sức nặng.
> Cách quay: mở neko toàn màn hình, chạy một tác vụ có kết quả nhìn thấy được (ví dụ đọc file → sửa
> mã → chạy test xanh, hoặc xuất một bảng Excel). Ghi màn hình 1080p, tốc độ 2× khi dựng.

Nếu bắt buộc phải sinh (không có máy quay màn hình):
```
5 seconds, 16:9. Screen-recording look of a fullscreen terminal application on a dark background:
panels of monospace text updating line by line, a small amber progress indicator filling, a green
check mark appearing at the end of a list. Static camera, slight digital sharpness, subtle screen
glow. Dark charcoal UI with amber and green accents only.
<quiet keystrokes, a soft confirmation chime>
Do not render readable words, code, logos or watermarks - shapes and glyph textures only. No people.
```

---

### Cảnh 4 (15–20s) — Rút mạng, vẫn chạy · *cảnh đắt nhất, có tiếng*

```
5 seconds, 16:9, cinematic. A hand reaches into frame and unplugs an ethernet cable from the side of a
laptop; the connector clicks free and the cable falls away. On the screen behind the hand, the text
lines keep scrolling without interruption. Camera pans smoothly from the unplugged port to the screen
and settles there, eye level, shallow depth of field. Dark room, cool screen light against a warm
amber rim on the laptop edge, cinematic contrast.
<a plastic connector clicking free, then near-silence, then quiet keyboard typing resuming>
Do not render readable text, letters, logos or watermarks. No captions, no extra people.
```
*Dịch: tay rút cáp mạng, chữ trên màn hình vẫn chạy tiếp — hình ảnh nói trọn "mất mạng vẫn chạy".*

**Biến thể nếu take đầu xấu** (đổi **một** biến, đúng nguyên tắc của Dreamina): thay
`unplugs an ethernet cable` → `flips the Wi-Fi switch off on a laptop keyboard`.

---

### Cảnh 5 (20–25s) — Ba thành viên · **QUAY THẬT**

> **Bắt buộc quay thật.** Video thi bắt buộc phải thấy đủ ba thành viên; sinh mặt người thật vừa rủi
> ro giống-mà-không-đúng, vừa vướng yêu cầu xác minh của Volcengine.
> Cách quay: ngoài trời, giờ vàng (16h30–17h30), điện thoại đặt ngang tầm ngực, ba bạn đứng lệch
> tầng, cùng nhìn vào một điện thoại đang phát giọng Neko rồi ngẩng lên cười. Quay 3 lần, mỗi lần 8 giây.

Nếu muốn có thêm một cảnh nhóm kiểu điện ảnh xen vào:
```
5 seconds, 16:9, cinematic. @Image1 is the group identity reference: keep all three faces, hairstyles
and clothing exactly as shown. Three young Vietnamese students stand shoulder to shoulder outdoors in
warm late-afternoon sunlight, looking down at a phone held by the one in the middle, then all three
look up and laugh naturally at the same moment. Camera pushes in slowly at eye level, golden backlight
rimming their hair, soft natural skin tones, gentle lens flare.
<warm outdoor ambience, distant traffic, light laughter>
Keep the same three faces, no morphing, no added or removed people. Do not render text or logos.
```
*Đính kèm: 1 ảnh nhóm ba bạn đã bố trí đúng đội hình làm `@Image1`.*

---

### Cảnh 6 (25–30s) — Kết · *có tiếng*

```
5 seconds, 16:9, cinematic. The camera pulls back slowly and steadily from a glowing laptop screen in
a completely dark room, until the screen is a small warm rectangle of light centered in a vast black
frame. In the last second a single amber block cursor blinks once in the middle of that light, then
the light fades to black. Deep black #0A0B0D, one amber accent #F0A030, cinematic stillness, subtle
film grain.
(a single low warm synth note sustaining, then silence)
Do not render any text, letters, logos or watermarks. No people, no captions.
```
*Chỗ này để dành cho chữ ghép hậu kỳ: `NEKO CORE — Tôi đi thi Thực Chiến AI`.*

---

## 2. Cách gộp còn 2 lần sinh (nếu tài khoản giới hạn lượt)

Seedance 2.0 **sinh được nhiều cú máy trong một lần** bằng cú pháp `Shot 1 / Shot 2 / Shot 3`
(chính thức). Đừng ép mốc giây kiểu `0-3s` — tài liệu tháng 7 cảnh báo là bất ổn.

**Lần sinh A (15 giây, thay cảnh 1 + 3 + 4):**
```
15 seconds, 16:9, cinematic, three continuous shots in one dark room at night.
Shot 1: extreme close-up of a dark terminal screen, an amber block cursor blinks, then monospace code
lines cascade upward; camera pushes in very slowly.
Shot 2: static wide of the same laptop on a wooden desk, panels of text updating, a small amber
progress bar filling and a green check mark appearing.
Shot 3: a hand unplugs an ethernet cable from the laptop; the text on screen keeps scrolling; camera
pans from the port to the screen and holds.
Consistent dark charcoal room, one warm amber accent, shallow depth of field, film grain throughout.
<mechanical keyboard clicks, laptop fan, a connector clicking free, then quiet typing resuming>
Do not render readable text, letters, numbers, logos or watermarks. No people visible except one hand.
```

**Lần sinh B (10 giây, thay cảnh 6 + một nhịp thở):**
```
10 seconds, 16:9, cinematic, two shots.
Shot 1: slow dolly back from a glowing laptop screen in a pitch-dark room, the screen shrinking to a
small warm rectangle of light in the center of frame.
Shot 2: the same frame holds still; a single amber block cursor blinks once at the center of the light,
then everything fades to black.
Deep black background, one amber accent, cinematic stillness, subtle grain.
(a single low warm synth note sustaining, then silence)
Do not render text, letters, logos or watermarks. No people.
```

---

## 3. Vì sao KHÔNG để Seedance nói tiếng Việt

Tính đến 30/07/2026, ByteDance **chưa công bố tiếng Việt** trong các ngôn ngữ được đo (paper chỉ có
Anh/Nhật/Hàn/Indonesia/Bồ/Tây Ban Nha). Model *có thể* thử nói, nhưng không có bảo đảm về dấu giọng
và khẩu hình — mà video này chỉ có 30 giây để gây ấn tượng.

**Cách làm chắc ăn:** sinh hình **không thoại** (như các prompt trên — chỉ có tiếng động và nhạc),
rồi **tự thu lời thoại** bằng giọng một thành viên. Chân thật hơn, và đúng tinh thần "Tôi đi thi".

**Lời thoại (68 chữ, vừa 30 giây):**
```
Ba đứa mình ở Hải Phòng. Và tụi mình tự viết một con AI.
Không phải app gọi API — là agent chạy thẳng trên máy.
Nó đọc mã, sửa mã, làm báo cáo, nhưng luôn hỏi trước khi ra tay.
Rút mạng, nó vẫn chạy. Vì dữ liệu của mình thì nên ở lại máy mình.
Nó còn biết nhìn, biết nói tiếng Việt, đứng sau ống kính nhắc tụi mình tạo dáng.
Neko Core. Tụi mình đi thi Thực Chiến AI.
```
Thu bằng điện thoại trong phòng có rèm/chăn (hút vọng), cách miệng một gang tay, đọc chậm hơn bình
thường một chút. Thu 3 lần, chọn bản tự nhiên nhất.

---

## 4. Quy trình sinh — làm đúng thứ tự này thì đỡ mất lượt

1. **Sinh cảnh 1 trước** (dễ nhất, không có người) → xem model bám prompt tới đâu, rồi mới sinh tiếp.
2. Mỗi cảnh **3 take**, chỉ đổi **MỘT biến** giữa các lần (Dreamina khuyến nghị) — ví dụ đổi
   `pushes in very slowly` thành `holds still`, giữ nguyên mọi thứ khác.
3. Take nào bị lỗi mặt/tay/vật lý thì **bỏ hẳn**, đừng cố sửa bằng prompt dài thêm.
4. Sinh ở **720p để duyệt take**, chỉ render lại **1080p** cho take đã chọn (tiết kiệm lượt và thời gian).
5. Nhớ **tải take về ngay** — lượt sinh trên các nền tảng thường có hạn lưu.

---

## 5. Dựng (CapCut, 60–90 phút)

1. Timeline 1920×1080, 30 fps, đúng **00:00:30.00**.
2. Xếp theo thứ tự cảnh 1→6, cắt đúng nhịp câu thoại (cắt ở khoảng lặng giữa hai câu, không cắt giữa từ).
3. Voice-over là lớp chủ đạo; nhạc nền để **nhỏ hơn giọng 12–15 dB**; tiếng động của Seedance giữ ~20%.
4. **Chữ ghép ở đây, không sinh bằng AI**: tên ba thành viên (mỗi tên 1,5 giây khi người đó xuất hiện),
   câu chốt `NEKO CORE — Tôi đi thi Thực Chiến AI` ở 2 giây cuối. Phông đậm, trắng, viền mảnh.
   **Soi lại từng dấu tiếng Việt** trước khi xuất.
5. Xuất **MP4 / H.264 / 1080p / 30fps / AAC**.
6. **Kiểm tra cuối:** xem một lần **tắt tiếng** — nếu vẫn hiểu câu chuyện thì video đạt; xem một lần
   bằng tai nghe để bắt tiếng rè.

---

## 6. Lỗi hay gặp với Seedance (và cách né)

| Lỗi | Dấu hiệu | Cách né |
|---|---|---|
| Chữ AI sai chính tả | Chữ nguệch ngoạc trên màn hình/áo | Prompt đã cấm sẵn; chữ ghép ở CapCut |
| Mặt biến dạng giữa clip | Mặt "chảy" khi quay đầu | Cận cảnh ngắn, một chuyển động; hoặc quay thật |
| Tay sáu ngón | Tay vào khung gần camera | Cảnh 4 chỉ để tay ở rìa khung, chuyển động dứt khoát |
| Vật lý sai | Cáp rút ra mà không nhúc nhích | Take khác; mô tả rõ "connector clicks free and the cable falls away" |
| Drift phong cách giữa các clip | Clip sáng tối khác nhau | Giữ nguyên tỷ lệ + độ phân giải + cùng câu mô tả ánh sáng ở mọi prompt |
| Watermark | Logo nền tảng ở góc | Kiểm tra gói tài khoản trước khi sinh hàng loạt |

---

## 7. Nếu chỉ còn 3 tiếng (phương án tối giản)

Bỏ hết cảnh sinh, làm **100% quay thật**: (1) màn hình terminal chạy, (2) rút dây mạng vẫn chạy,
(3) ba bạn ngoài trời cười. Ba cảnh đó + voice-over + chữ CapCut đã đủ kể câu chuyện và **thật 100%**.
Seedance chỉ nên là lớp gia vị — thứ ghi điểm với giám khảo vẫn là *sản phẩm đang chạy thật*.
