# AI Thực Chiến 2026 — hồ sơ đăng ký + kịch bản video "Tôi đi thi A.I"

> Đội **Neko Core** · soạn 29/07/2026 · **hạn nộp 31/07/2026** (BTC không công bố giờ chốt/múi giờ
> — nộp sớm ít nhất một ngày). Dữ kiện thể lệ và nguyên văn form: `thucchien-ai-2026.md` cùng thư mục.

> Historical record: references to the MIT license below describe the public
> releases available when this July 2026 submission was written. Current
> licensing is defined by [`../../LICENSING.md`](../../LICENSING.md).

---

## PHẦN 1 — Điền form đăng ký (dán thẳng vào từng ô)

### THÔNG TIN ĐỘI DỰ THI

**`Tên đội thi (*)`**
```
Neko Core
```

**`Tên startup / tổ chức đại diện (nếu có)`**
```
(để trống — hoặc điền tên trường/CLB nếu muốn đại diện)
```

**`Giới thiệu ngắn gọn về đội (dưới 100 từ)`** — 92 từ:
```
Neko Core là ba người trẻ ở Hải Phòng tự viết một AI agent chạy trên máy của chính mình.
Sản phẩm cùng tên - Neko Core - là agent lập trình cho terminal: một file chạy duy nhất,
hoạt động được cả khi không có mạng, ghép được mọi mô hình (API, thuê bao, hay mô hình mở
chạy ngay trên máy), và luôn hỏi trước khi sửa file hay chạy lệnh. Mã nguồn mở MIT, phát
hành công khai, có 900 bài kiểm thử tự động. Chúng tôi tin dữ liệu người Việt nên ở lại
trên máy người Việt - và tự tay dựng công cụ để điều đó thành sự thật.
```

### THÔNG TIN THÀNH VIÊN

> Điều lệ giới hạn **18–35 tuổi** (trang chủ lại ghi "không phân biệt tuổi" — cứ điền thật,
> nếu ai ngoài khoảng này thì hỏi BTC trước). Số điện thoại/email/năm sinh **anh tự điền**.

**Thành viên 1** (đội trưởng)
- `Họ và tên`: `Nguyễn Mạnh Hùng`
- `Vai trò`: `Đội trưởng · Kiến trúc & phát triển lõi agent`
- `Kinh nghiệm chuyên môn` (mẫu, sửa cho đúng):
```
Tác giả chính của Neko Core (TypeScript/Bun/Ink): vòng lặp agent, hệ thống công cụ có kiểm
soát quyền, tích hợp đa nhà cung cấp mô hình, giao diện terminal toàn màn hình, quy trình
phát hành tự động (CI/CD, kiểm thử, phát hành nhị phân đa nền tảng). Tối ưu suy luận LLM:
vLLM, lượng tử hoá FP8/INT4, đo đạc TTFT/TPOT trên GPU H200. Dự thi Viettel AI Race 2026
bảng LLM serving và HackAIthon 2026 bảng C.
```

**Thành viên 2**
- `Họ và tên`: `Phạm Thị Minh Hồng`
- `Vai trò`: `Nghiên cứu & đánh giá mô hình · Dữ liệu`
- `Kinh nghiệm chuyên môn` (mẫu — sửa theo đúng việc bạn ấy làm):
```
Nghiên cứu và kiểm chứng mô hình: xây bộ đánh giá, đo chất lượng đầu ra, đối chiếu nguồn
gốc trước khi kết luận. Xử lý dữ liệu tiếng Việt cho các tác vụ trích xuất và tóm tắt.
```

**Thành viên 3**
- `Họ và tên`: `Nghiêm Thị Mỹ Linh`
- `Vai trò`: `Sản phẩm & trải nghiệm người dùng · Truyền thông`
- `Kinh nghiệm chuyên môn` (mẫu — sửa theo đúng việc bạn ấy làm):
```
Thiết kế trải nghiệm và tài liệu sản phẩm: giao diện dòng lệnh, trang giới thiệu sản phẩm,
hướng dẫn người dùng không chuyên. Kiểm thử sản phẩm trên người dùng thật và ghi nhận phản hồi.
```

### NĂNG LỰC KỸ THUẬT CỦA ĐỘI

**`Ngôn ngữ lập trình, framework(*)`**
```
TypeScript (Bun runtime), React/Ink, Python, Bash/PowerShell; SQLite; Cloudflare Workers &
Durable Objects; Docker; Git/GitHub Actions (CI/CD, phát hành nhị phân đa nền tảng).
```

**`Nền tảng A.I từng sử dụng(*)`**
```
OpenAI (API + Codex App Server của thuê bao ChatGPT, realtime voice WebRTC), Anthropic Claude,
Google Gemini, NVIDIA NIM, Groq, DeepSeek, Kimi, Z.ai; mô hình mở chạy cục bộ qua Ollama/LM Studio
(GGUF); giao thức MCP (Model Context Protocol); vLLM cho triển khai suy luận.
```

**`Kinh nghiệm xử lý dữ liệu / ML(*)`**
```
Triển khai và tối ưu suy luận LLM trên GPU H200: vLLM, lượng tử hoá FP8/INT4, prefix caching,
vá kernel, đo TTFT/TPOT/throughput theo trace 420 request đa lượt. Xây bộ đánh giá tự động cho
agent (đo "harness lift" - phần chất lượng do khung agent đem lại, tách khỏi mô hình). Nhận dạng
tiếng nói tiếng Việt (whisper.cpp, parakeet/Nemotron ASR) với tách kênh và chấm WER/CER.
Thị giác: đọc ảnh bằng VLM và chỉnh ảnh tham số hoá xác định (ImageMagick, RawTherapee, LibRaw).
```

**`Thành tích nổi bật trong công nghệ`** *(kiểm lại số liệu trước khi nộp)*
```
- Neko Core: sản phẩm mã nguồn mở MIT, đã phát hành công khai tới v0.21.2 với 900 bài kiểm thử
  tự động, nhị phân cho Windows/macOS/Linux, tự cập nhật, trang giới thiệu và hạ tầng relay
  chạy trên Cloudflare: github.com/meiiie/neko-core
- Viettel AI Race 2026 (bảng tối ưu LLM serving): đội dự thi, tối ưu vLLM cho LFM2.5-1.2B trên H200.
- HackAIthon 2026 bảng C: vào Vòng 2 với harness trắc nghiệm chạy mô hình mở cục bộ.
```

### DỰ ÁN THỰC TẾ

**`Danh sách sản phẩm/dự án`**
```
1) Neko Core - AI agent lập trình cho terminal, local-first
2) Neko Relay - điều khiển agent từ điện thoại, mã hoá đầu-cuối
3) Neko Photo Coach - trợ lý nhiếp ảnh: điện thoại quay, AI nhắc dáng bằng giọng nói tiếng Việt
```

**`Mô tả danh sách dự án`**
```
1) Neko Core: agent lập trình chạy hoàn toàn trên máy người dùng - đọc/sửa mã, chạy lệnh, gọi
   công cụ, nhưng mọi thao tác ghi và chạy đều phải được người dùng duyệt. Một file nhị phân,
   không phụ thuộc nhà cung cấp: dùng được API trả phí, thuê bao có sẵn, hoặc mô hình mở chạy
   ngay trên máy khi không có mạng. Kèm hệ kỹ năng mở rộng theo lĩnh vực (nhiếp ảnh, văn phòng,
   họp hành, mua sắm) và bộ nhớ dài hạn cục bộ.
2) Neko Relay: mở một cầu nối do chính người dùng sở hữu trên Cloudflare để điều khiển agent từ
   điện thoại. Toàn bộ nội dung mã hoá AES-256-GCM đầu-cuối; máy chủ trung gian chỉ thấy bản mã.
3) Neko Photo Coach: điện thoại quay khung hình, agent nhìn và nói hướng dẫn tạo dáng bằng chính
   giọng realtime tiếng Việt; ảnh chụp xong được hậu kỳ theo tham số (không tái tạo khuôn mặt).
```

**`Link demo/báo cáo của danh sách dự án`**
```
https://github.com/meiiie/neko-core · https://neko.holilihu.online
```

### VIDEO "TÔI ĐI THI A.I"

**`Link video clip giới thiệu (30–60 giây)(*)`** → dán link YouTube (chế độ **Không công khai/Unlisted**)
hoặc Google Drive **đã bật "bất kỳ ai có liên kết"**. **Tự kiểm tra bằng cửa sổ ẩn danh trước khi nộp.**

### THÔNG TIN KHÁC

**`Bạn biết đến cuộc thi qua đâu?(*)`** → `Website`

**`Câu hỏi hoặc đề xuất cho Ban Tổ Chức(*)`** — hỏi đúng ba điểm đang mâu thuẫn trong thể lệ:
```
Kính gửi BTC, đội Neko Core xin hỏi 3 điểm:
(1) Video giới thiệu: Điều lệ ghi 30 giây, form ghi 30-60 giây - đội nên theo mốc nào?
(2) Sản phẩm của đội là mã nguồn mở đã công bố công khai trên GitHub từ trước. Điều 7 yêu cầu
    sản phẩm "chưa dự thi/đoạt giải khác" và "không trùng giải pháp đã công bố" - BTC cho phép
    đội tiếp tục phát triển sản phẩm mở này trong các vòng sau chứ ạ?
(3) Độ tuổi: Điều lệ ghi 18-35, trang chủ ghi "không phân biệt tuổi" - mốc nào là chính thức?
Trân trọng cảm ơn BTC.
```

**`Tôi đồng ý với các điều khoản trên`** → tick, rồi **GỬI ĐĂNG KÝ**.

> ⚠️ **Đọc Điều 14 trước khi tick**: BTC được quyền dùng miễn phí, không giới hạn hình ảnh/video/sản
> phẩm dự thi cho truyền thông; đội vào Vòng 3–4 cam kết mở mã nguồn mô hình lõi, và sản phẩm cuối
> được chọn phát triển thì thuộc sở hữu Hiệp hội Dữ liệu Quốc gia. Neko Core vốn đã là MIT nên phần
> mở mã không vướng, nhưng đây là điều khoản cả ba thành viên nên đọc và đồng thuận.

---

## PHẦN 2 — Kịch bản video 30 giây "Tôi đi thi Thực Chiến AI"

### Ràng buộc kỹ thuật của Seedance 2.0 (đã kiểm chứng)

| Điều | Con số | Ý nghĩa cho ta |
|---|---|---|
| Độ dài mỗi lần sinh | **4–15 giây** | 30 giây phải ghép **nhiều clip** → chia 6 cảnh × 5 giây |
| Tỷ lệ | 16:9, 4:3, 1:1, 3:4, 9:16 | Dùng **16:9** (video có thể lên sóng/trình chiếu) |
| Độ phân giải | native 480p/720p, dịch vụ tới 1080p | Xuất **1080p**, đừng phóng to quá |
| Ảnh/video tham chiếu | tối đa **9 ảnh, 3 video, 3 audio** mỗi lần | Khoá nhân vật + phong cách bằng ảnh thật |
| Người thật | cần xác minh/ủy quyền (Trusted Assets) | **Cảnh có mặt 3 thành viên: QUAY THẬT bằng điện thoại**, đừng sinh |
| Prompt | 30–100 từ, chủ thể trước, mỗi lần đổi 1 biến | Xem prompt sẵn bên dưới |

> **Chữ trên màn hình: đừng để Seedance sinh.** Sinh chữ trong video luôn rủi ro sai dấu tiếng Việt.
> Ghép chữ ở khâu dựng (CapCut) — vừa sắc nét, vừa chắc chắn đúng chính tả.

### Ý tưởng chủ đạo

> **"Chúng tôi không chỉ dùng AI. Chúng tôi tự viết ra nó — và nó chạy trên máy của chính mình."**

Đây là thứ khiến đội khác biệt trên sóng: hầu hết thí sinh mang **ứng dụng gọi API**; các bạn mang
**một agent tự viết, mã nguồn mở, chạy offline**. Video phải chứng minh điều đó bằng *hình ảnh thật
đang chạy*, không phải lời hứa.

### Bảng phân cảnh (6 cảnh × 5 giây = 30 giây)

| # | Giây | Hình | Nguồn | Chữ trên màn hình |
|---|---|---|---|---|
| 1 | 0–5 | Terminal tối bật lên, con trỏ hổ phách nhấp nháy, logo mèo pixel hiện ra | **Quay màn hình thật** | — |
| 2 | 5–10 | Cận mặt Hùng gõ phím trong phòng tối, ánh màn hình hắt lên | **Quay thật (điện thoại)** | `NGUYỄN MẠNH HÙNG` |
| 3 | 10–15 | Neko chạy: đọc file, sửa mã, xuất bảng Excel — chữ chạy như dòng suối | **Quay màn hình thật** | `Tự viết. Không phải wrapper.` |
| 4 | 15–20 | Rút mạng/tắt Wi-Fi, agent vẫn chạy tiếp | **Quay thật + Seedance** | `Mất mạng vẫn chạy` |
| 5 | 20–25 | Ngoài trời: điện thoại quay 3 bạn, giọng Neko nhắc dáng, cả nhóm cười | **Quay thật** | `PHẠM THỊ MINH HỒNG · NGHIÊM THỊ MỸ LINH` |
| 6 | 25–30 | Camera lùi khỏi màn hình, logo NEKO CORE + con trỏ hổ phách | **Seedance** | `NEKO CORE — Tôi đi thi Thực Chiến AI` |

### Lời thoại (voice-over tiếng Việt — 68 chữ, vừa 30 giây)

```
(0-5s)   Ba đứa mình ở Hải Phòng. Và tụi mình tự viết một con AI.
(5-10s)  Không phải app gọi API. Là agent chạy thẳng trên máy.
(10-15s) Nó đọc mã, sửa mã, làm báo cáo — nhưng luôn hỏi trước khi ra tay.
(15-20s) Rút mạng, nó vẫn chạy. Vì dữ liệu của mình, nên ở lại máy mình.
(20-25s) Nó còn biết nhìn, biết nói tiếng Việt, đứng sau ống kính nhắc tụi mình tạo dáng.
(25-30s) Neko Core. Tụi mình đi thi Thực Chiến AI.
```

### Prompt Seedance cho từng cảnh (dán thẳng)

**Cảnh 1 — Terminal thức dậy** *(nếu không quay được màn hình thật)*
```
5 giây, 16:9. Cận cảnh một màn hình terminal tối trong phòng thiếu sáng. Con trỏ khối màu hổ phách
nhấp nháy, rồi các dòng lệnh đơn sắc chạy lên như nước. Máy quay đẩy vào rất chậm, tiêu cự nông,
bụi lơ lửng trong luồng sáng. Nền đen #0A0B0D, điểm nhấn hổ phách #F0A030. Âm thanh: tiếng gõ phím
cơ khe khẽ, tiếng quạt laptop. KHÔNG sinh chữ đọc được, không logo, không người.
```

**Cảnh 4 — Mất mạng vẫn chạy**
```
5 giây, 16:9. Bàn tay rút sợi cáp mạng khỏi laptop, biểu tượng Wi-Fi trên màn hình chuyển sang gạch
chéo, nhưng dòng chữ trên terminal vẫn tiếp tục chạy. Máy quay lia ngang chậm từ tay sang màn hình,
giữ nét ở màn hình. Ánh sáng phòng tối, viền hổ phách trên cạnh laptop. Âm thanh: tiếng cáp bật ra,
rồi im lặng, chỉ còn tiếng gõ phím. KHÔNG sinh chữ đọc được, không logo.
```

**Cảnh 6 — Kết**
```
5 giây, 16:9. Máy quay lùi chậm khỏi một màn hình laptop đang sáng trong bóng tối, đến khi màn hình
chỉ còn là một ô sáng nhỏ ấm áp giữa khung hình đen. Một con trỏ khối hổ phách nhấp nháy đúng giữa
màn hình rồi tắt. Tông đen sâu #0A0B0D với một điểm hổ phách #F0A030 duy nhất, điện ảnh, tĩnh lặng.
Âm thanh: một nốt trầm ấm ngân dài rồi im. KHÔNG sinh chữ, không logo, không người.
```

**Nếu muốn Seedance dựng cả cảnh có người** (rủi ro hơn, cần ảnh tham chiếu và xác minh):
```
5 giây, 16:9. @Image1 là tham chiếu danh tính và trang phục bất biến. Ba bạn trẻ Việt Nam đứng cạnh
nhau trước bức tường sáng, cùng nhìn vào một màn hình laptop rồi ngẩng lên cười với nhau. Máy quay
đẩy vào chậm ngang tầm mắt. Ánh sáng ban ngày dịu, màu ấm tự nhiên, da chân thực. Giữ nguyên khuôn
mặt, tóc, trang phục. KHÔNG sinh chữ, không thêm người lạ, không đổi hình dạng khuôn mặt.
```

### Cách dựng (CapCut, ~1 buổi)

1. **Quay thật trước** cảnh 2, 3, 5 (điện thoại là đủ) — đây là phần "thật" mà giám khảo tin.
2. Sinh cảnh 1, 4, 6 bằng Seedance (mỗi cảnh sinh 3–4 lần, chọn take tốt nhất).
3. Ghép theo bảng phân cảnh, **cắt đúng nhịp lời thoại**.
4. Thu voice-over bằng chính giọng một thành viên (chân thật hơn giọng AI, và đúng tinh thần "tôi đi thi").
5. Chèn chữ bằng CapCut: phông đậm, chữ trắng, viền mảnh; tên thành viên hiện 1,5 giây mỗi người.
6. Nhạc nền tiết chế, nhỏ hơn giọng nói 12–15 dB. Xuất **1080p, 16:9, MP4/H.264**.
7. Xem lại trên **điện thoại tắt tiếng** — nếu chữ vẫn kể được câu chuyện thì video đạt.

### Ba điều khiến video này ăn điểm (bám đúng 4 hướng chấm mà BTC công bố)

- **NDA — khả thi & giá trị thực tiễn**: sản phẩm *đang chạy thật*, có người dùng thật, mã công khai.
- **NDC — chất lượng dữ liệu & thuật toán**: cảnh "rút mạng vẫn chạy" nói đúng một câu chuyện kỹ
  thuật — dữ liệu ở lại máy, mô hình chạy cục bộ được.
- **VTV — trình bày & sức lan tỏa**: có nhân vật, có cảm xúc, có câu chốt đọng lại.
- **Chuyên gia — sáng tạo & truyền cảm hứng**: ba sinh viên tự viết agent, không phải ghép API.

### Việc cần làm ngay (còn 2 ngày)

- [ ] Hôm nay: quay cảnh 2, 3, 5 bằng điện thoại (30 phút) + sinh 3 cảnh Seedance
- [ ] Hôm nay: thu voice-over, dựng, xuất 1080p
- [ ] Ngày mai: upload YouTube (Unlisted) → **thử link ở cửa sổ ẩn danh**
- [ ] Ngày mai: điền form theo Phần 1, kiểm lại số liệu thành tích, gửi đăng ký
- [ ] Chụp màn hình xác nhận sau khi gửi (BTC không hứa gửi email xác nhận)
