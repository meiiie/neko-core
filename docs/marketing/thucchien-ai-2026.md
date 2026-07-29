# Thực Chiến AI 2026 và Seedance 2.0

> Ledger nghiên cứu tính đến ngày 29/07/2026. Truy cập nguồn ngày 29/07/2026, trừ khi ghi khác.
>
> Mức bằng chứng: `[verified]` = claim cốt lõi được ít nhất hai nguồn độc lập xác nhận; `[supported]` = có một nguồn sơ cấp hoặc bằng chứng trực tiếp mạnh; `[inference]` = suy luận có căn cứ; `[open]` = chưa đủ bằng chứng hoặc nguồn mâu thuẫn.

## Phạm vi và câu hỏi

- **Phần A — Cuộc thi Thực Chiến AI:** trang chủ và toàn bộ trang con; thể lệ, đối tượng, đăng ký, giải thưởng, tiêu chí chấm, thời hạn; yêu cầu video “Tôi đi thi AI”; nguyên văn các trường của form đăng ký.
- **Phần B — Seedance 2.0 (ByteDance):** giới hạn clip, tỷ lệ khung hình, image-to-video, cấu trúc prompt, camera, nhất quán nhân vật, khả năng render chữ/tiếng Việt có dấu và lỗi thường gặp.
- **Đầu ra hành động:** bộ ràng buộc cụ thể để sản xuất video dự thi dài 30 giây.

## A. Cuộc thi Thực Chiến AI

### A1. Bản đồ website và nguồn chính thức

- [supported] Sitemap chính thức của domain gồm 29 URL loại `page`, 2 URL loại `post`, 1 trang chuyên mục và 1 trang tác giả. Đã mở từng URL qua Jina Reader; một lỗi kết nối ở `/round2-exam-take/` đã được retry thành công. Lượt kiểm lại cuối ngày 29/07 vẫn đủ đúng 33 URL này, không xuất hiện trang mới. Nguồn: [sitemap index](https://thucchien.ai/wp-sitemap.xml), [page sitemap](https://thucchien.ai/page-sitemap.xml), [post sitemap](https://thucchien.ai/post-sitemap.xml), [category sitemap](https://thucchien.ai/category-sitemap.xml), [author sitemap](https://thucchien.ai/author-sitemap.xml) (tự sinh; truy cập 29/07/2026).
- [supported] Nội dung công khai có giá trị trực tiếp cho mùa 2026 tập trung ở [trang chủ](https://thucchien.ai/) và [Điều lệ](https://thucchien.ai/the-le-cuoc-thi/). `/team-invite/` hiện trả lại nguyên trang chủ. Nguồn: ba URL trên (n.d.; truy cập 29/07/2026).
- [supported] Các trang đã kiểm tra và kết quả:
  - **Đăng nhập/tài khoản hoặc yêu cầu xác thực:** `/login/`, `/bgk-dashboard/`, `/member-dashboard/`, `/member-lost-password/`, `/member-reset-password/` (trả 403 nếu thiếu token ở lượt kiểm lại), `/team-profile/`, `/change-password/`, `/member-view/`, `/round2-exam-detail/`, `/round3-exam-detail/`, `/round4-exam-detail/`, `/team-management/`, `/mini-rounds3/`, `/round-3-admin-control/`, `/round3-chatbox/`, `/display-screen-chatbox/`.
  - **Trang công khai nhưng không có bài thi/bài nộp:** `/round2-exam-submit/`, `/round2-submission-view/`, `/round2-exam-take/`.
  - **Endpoint nội bộ hiện trả WordPress 500 qua Jina khi chưa đăng nhập:** `/bgk-cham-diem-vong-chung-khao/`, `/bang-xep-hang-vong-2/`, `/round-3-mini-rounds-leaderboard/`, `/round-3-leaderboard/`, `/round-3-leaderboard-chatbox/`, `/bang-xep-hang-ban-ket-total/` (lượt kiểm lại 29/07/2026; không coi lỗi này là nội dung/thể lệ công khai).
  - **Nội dung mùa 2025/legacy:** `/report-ban-ket/`; `/blog/`; `/top-100-tai-nang-aithucchien/`; `/category/news/`; `/author/admin/`. Bài Top 100 tự ghi “AI Thực Chiến 2025”.
- [supported] Subdomain [docs.thucchien.ai](https://docs.thucchien.ai/) chứa hướng dẫn kỹ thuật Vòng 2–4 và API từ mùa trước; không có trang Vòng 1/đăng ký hiện hành (`/docs/round-1` trả `Page Not Found`). Không dùng tài liệu này để suy diễn tiêu chí sơ loại 2026. Nguồn: [docs sitemap](https://docs.thucchien.ai/sitemap.xml), [trang tài liệu](https://docs.thucchien.ai/) (n.d.; truy cập 29/07/2026).

### A2. Mốc thời gian

- [verified] Thời hạn đăng ký công khai: **19/06/2026–31/07/2026**. Trang chủ là nguồn vận hành; các báo ngày khởi động cũng xác nhận vòng sơ loại diễn ra tháng 7. Nguồn: [trang chủ](https://thucchien.ai/) (n.d.; truy cập 29/07/2026), [VTC News](https://vtcnews.vn/ai-thuc-chien-mua-2-nang-cap-thanh-gameshow-giai-thuong-cao-nhat-1-ty-dong-ar1024507.html) (19/06/2026), [Nhà báo & Công luận](https://congluan.vn/hap-dan-giai-thuong-tien-ty-va-hoc-bong-1-trieu-usd-tai-gameshow-ai-thuc-chien-2026-tren-song-quoc-gia-post350578.html) (19/06/2026).
- [supported] Lộ trình được báo chí công bố: sơ loại tháng 7/2026; chung khảo tháng 8; bán kết tháng 9–10; các đêm chung kết trong tháng 11–12/2026; Gala trao giải dự kiến tháng 01/2027. Nguồn: VTC News và Nhà báo & Công luận (19/06/2026; URL ở trên).
- [open] Website **không công bố giờ chốt, múi giờ hoặc cơ chế gia hạn** cho ngày 31/07. Điều lệ còn để trống ngày công bố kết quả và thời gian từng vòng; BTC giữ quyền đổi lịch và thông báo trên kênh chính thức. Nguồn: [Điều 6 và Điều 16](https://thucchien.ai/the-le-cuoc-thi/) (n.d.; truy cập 29/07/2026).

### A3. Ai được tham gia

- [supported] Theo Điều 2: (1) công dân Việt Nam **18–35 tuổi** đang sống, học tập hoặc làm việc trong/ngoài nước; (2) người nước ngoài đang sống, học tập và làm việc hợp pháp tại Việt Nam; (3) mọi thành viên phải có đầy đủ năng lực hành vi dân sự. Nguồn: [Điều lệ, Điều 2](https://thucchien.ai/the-le-cuoc-thi/) (n.d.; truy cập 29/07/2026).
- [verified] Hình thức thi theo đội; mỗi cá nhân chỉ tham gia một đội; mỗi đội có **1–3 thành viên**, không phân biệt ngành nghề, và phải cử một đội trưởng. “Tối đa 3” được điều lệ và hai bài báo độc lập xác nhận. Nguồn: [Điều lệ, Điều 3](https://thucchien.ai/the-le-cuoc-thi/) (n.d.), VTC News và Nhà báo & Công luận (19/06/2026; URL ở A2).
- [supported] Không được dự thi: thành viên trực tiếp thuộc Ban Chỉ đạo/BTC/BGK/Tổ chuyên môn/Tổ ra đề; nhân sự nhà tài trợ/đối tác trực tiếp xây nội dung chuyên môn, nền tảng hoặc dữ liệu độc quyền; người đã được truy cập trước đề, dữ liệu hay nền tảng chấm. Nguồn: [Điều lệ, Điều 4](https://thucchien.ai/the-le-cuoc-thi/) (n.d.; truy cập 29/07/2026).
- [open] Trang chủ lại quảng bá “không phân biệt tuổi”, trái với giới hạn 18–35 trong Điều lệ; nên dùng **18–35** như điều kiện thận trọng hơn và hỏi BTC nếu có thành viên ngoài khoảng tuổi này. Nguồn: [trang chủ](https://thucchien.ai/), [Điều lệ](https://thucchien.ai/the-le-cuoc-thi/) (n.d.; truy cập 29/07/2026).

### A4. Thể lệ, cách đăng ký và cách nộp bài

- [supported] Vòng 1 nộp **trực tuyến tại `thucchien.ai`**: điền form trên trang chủ, dán link video giới thiệu và nộp hồ sơ năng lực nếu có; bấm **“GỬI ĐĂNG KÝ”**. BGK sơ khảo chọn 100 đội vào Vòng 2. Nguồn: [trang chủ/form](https://thucchien.ai/) và [Điều lệ, Điều 8](https://thucchien.ai/the-le-cuoc-thi/) (n.d.; truy cập 29/07/2026).
- [supported] Lộ trình bốn vòng: (1) đăng ký/sơ loại; (2) 100 đội tạo sản phẩm AI bằng API/công cụ theo đề, chia 10 bảng, lấy 10 nhất bảng + 2 suất BGK cứu; (3) 12 đội có 4 tuần phát triển/tối ưu LLM/SLM tiếng Việt, lấy 3 đội nhất bảng + 1 đội khán giả bình chọn; (4) 4 đội có 4 tuần làm MVP, pitch và demo tại Gala. Nguồn: [Điều lệ, Điều 8](https://thucchien.ai/the-le-cuoc-thi/) (n.d.; truy cập 29/07/2026).
- [supported] Quy định sản phẩm ở các vòng sau: do đội tự phát triển, chưa dự/đoạt giải khác; không trùng giải pháp đã công bố; chứng minh ứng dụng trong điều kiện Việt Nam và hiệu quả kinh tế/xã hội; mã nguồn nộp ZIP hoặc Git, có thể dùng tiếng Việt/Anh nhưng pitch/demo tại trường quay bằng tiếng Việt; tài nguyên ngoài danh mục phải khai báo và được BGK chấp thuận bằng văn bản. Nguồn: [Điều lệ, Điều 7](https://thucchien.ai/the-le-cuoc-thi/) (n.d.; truy cập 29/07/2026).
- [supported] Đội vào Vòng 3–4 cam kết mở mã nguồn mô hình/thành phần lõi theo giấy phép thông dụng; sản phẩm cuối được chọn để phát triển được điều lệ ghi là thuộc sở hữu Hiệp hội Dữ liệu Quốc gia. BTC được quyền sử dụng độc quyền, miễn phí và không giới hạn hình ảnh, video, thông tin, sản phẩm dự thi cho truyền thông/giáo dục/quảng bá. Đây là điều khoản nên đọc kỹ trước khi đăng ký. Nguồn: [Điều lệ, Điều 14](https://thucchien.ai/the-le-cuoc-thi/) (n.d.; truy cập 29/07/2026).
- [open] Điều 5 mô tả một bộ hồ sơ chi tiết khác (phiếu có tên giải pháp, địa chỉ/nơi công tác, tỷ lệ đóng góp, chữ ký; bản mô tả đề tài; tài liệu minh họa), nhưng còn để trống ngày nhận và địa chỉ nộp tại Ban Khoa Giáo VTV. Form vận hành trên trang chủ không yêu cầu đầy đủ các mục đó. Không thể xác minh BTC có đòi bổ sung bộ này ở Vòng 1 hay không. Nguồn: [Điều lệ, Điều 5](https://thucchien.ai/the-le-cuoc-thi/) và [form](https://thucchien.ai/) (n.d.; truy cập 29/07/2026).

### A5. Video “Tôi đi thi AI”

- [supported] **Làm đúng 30 giây** là phương án an toàn: Điều lệ ghi “video giới thiệu 30 giây”; hướng dẫn và trường form cho phép **30–60 giây**. Clip 30 giây thỏa cả hai cách diễn đạt. Nguồn: [Điều lệ, Điều 8](https://thucchien.ai/the-le-cuoc-thi/) và [trang chủ/form](https://thucchien.ai/) (n.d.; truy cập 29/07/2026).
- [supported] Nội dung bắt buộc theo form: giới thiệu đội; có hình ảnh các thành viên; nêu bật tinh thần, cá tính đội và lý do đến với cuộc thi. **Khuyến khích** làm bằng AI, không ghi là bắt buộc. Nguồn: [form đăng ký](https://thucchien.ai/) (n.d.; truy cập 29/07/2026).
- [supported] Cách nộp: điền một **link video** vào trường bắt buộc `Link video clip giới thiệu (30–60 giây)(*)`, rồi gửi form. Nguồn: [form đăng ký](https://thucchien.ai/) (n.d.; truy cập 29/07/2026).
- [open] BTC không công bố nền tảng host, định dạng container/codec, độ phân giải, dung lượng, tỷ lệ khung hình, quyền riêng tư hay quy ước tên file. Suy luận vận hành: dùng link không cần đăng nhập và thử mở ở cửa sổ ẩn danh; đây là khuyến nghị, **không phải yêu cầu đã công bố**. Nguồn: [form đăng ký](https://thucchien.ai/) và toàn bộ sitemap công khai (truy cập 29/07/2026).
- [open] Tên chủ đề xuất hiện hai dạng: “Tôi đi thi A.I” trên trang chủ/form và “Tôi đi thi Thực Chiến AI” trong Điều lệ. Dùng câu đầy đủ **“Tôi đi thi Thực Chiến AI”** trong thoại/caption sẽ bao hàm cả hai. Nguồn: [trang chủ/form](https://thucchien.ai/) và [Điều lệ, Điều 8](https://thucchien.ai/the-le-cuoc-thi/) (truy cập 29/07/2026).

### A6. Giải thưởng

- [verified] Giải Nhất: **1 tỷ đồng tiền mặt**; nguồn báo chí cùng ngày phát động còn ghi gói “Điều kỳ diệu của Techcombank” trị giá **1 triệu USD** dưới dạng học bổng hoặc khoản đầu tư. Nguồn: [VTC News](https://vtcnews.vn/ai-thuc-chien-mua-2-nang-cap-thanh-gameshow-giai-thuong-cao-nhat-1-ty-dong-ar1024507.html) và [Nhà báo & Công luận](https://congluan.vn/hap-dan-giai-thuong-tien-ty-va-hoc-bong-1-trieu-usd-tai-gameshow-ai-thuc-chien-2026-tren-song-quoc-gia-post350578.html) (19/06/2026). Trang chủ dùng ảnh cho con số Giải Nhất nên trình đọc văn bản không trích được, nhưng có dòng “và Cúp Vô địch”.
- [verified] Giải Nhì: **300 triệu đồng**. Nguồn: [trang chủ](https://thucchien.ai/) (n.d.) và Nhà báo & Công luận (19/06/2026; URL ở trên).
- [open] **Hai Giải Ba đang mâu thuẫn:** trang chủ hiện ghi **100 triệu đồng/giải**, còn Nhà báo & Công luận ngày phát động ghi **150 triệu đồng/giải**. Khi lập kế hoạch, dùng số chính thức đang hiển thị trên website là 100 triệu nhưng cần BTC xác nhận trước khi truyền thông. Nguồn: [trang chủ](https://thucchien.ai/) (truy cập 29/07/2026), [Nhà báo & Công luận](https://congluan.vn/hap-dan-giai-thuong-tien-ty-va-hoc-bong-1-trieu-usd-tai-gameshow-ai-thuc-chien-2026-tren-song-quoc-gia-post350578.html) (19/06/2026).
- [supported] Trang chủ còn liệt kê: Giải tuần (tiền mặt, chưa ghi mức); Ứng dụng Dữ liệu Xuất sắc (hiện vật/chứng nhận NDC); Startup AI Tiềm năng (hiện vật/chứng nhận + cơ hội ươm tạo NDA); Ứng dụng AI Sáng tạo nhất (khán giả bình chọn); học bổng đào tạo chuyên sâu. Nguồn: [trang chủ](https://thucchien.ai/) (n.d.; truy cập 29/07/2026).
- [supported] Tiền thưởng được trao sau khi khấu trừ thuế nếu có. Nguồn: [Điều lệ, Điều 12](https://thucchien.ai/the-le-cuoc-thi/) (n.d.; truy cập 29/07/2026).

### A7. Tiêu chí chấm

- [supported] **Chưa có bảng điểm/trọng số công khai cho sơ loại hoặc từng vòng.** Điều 9 chỉ ghi tiêu chí chi tiết sẽ công bố trước khi vòng thi bắt đầu. Nguồn: [Điều lệ, Điều 9](https://thucchien.ai/the-le-cuoc-thi/) (n.d.; truy cập 29/07/2026), đối chiếu toàn bộ sitemap công khai ngày 29/07/2026.
- [supported] Trang chủ cho biết các nhóm đánh giá ở mức định hướng: NDA — tính khả thi và giá trị thực tiễn; NDC — chất lượng dữ liệu và thuật toán; VTV — trình bày, truyền thông, sức lan tỏa; chuyên gia liên ngành — sáng tạo, tiềm năng xã hội, tính truyền cảm hứng. Nguồn: [trang chủ](https://thucchien.ai/) (n.d.; truy cập 29/07/2026).
- [inference] Với hồ sơ sơ loại, nên làm video và form chứng minh bốn trục trên, nhưng **không gọi chúng là trọng số chính thức**. Điều 7 còn đặt ngưỡng nguyên bản, mới, ứng dụng được và hiệu quả kinh tế/xã hội; đây là điều kiện sản phẩm chung, không phải rubric có điểm.
- [supported] Nếu hòa điểm, thứ hạng theo tiêu chí phụ và quyết định cuối cùng của Trưởng BGK; quyết định chuyên môn của BGK là cuối cùng. Nguồn: [Điều lệ, Điều 8–10](https://thucchien.ai/the-le-cuoc-thi/) (n.d.; truy cập 29/07/2026).

### A8. Nguyên văn các trường trong form đăng ký

> Bản chép trường hiển thị trên trang chủ ngày 29/07/2026. Dấu `(*)` và placeholder tiếng Anh được giữ nguyên; các trường thành viên 2–3 không hiện dấu bắt buộc dù phần lưu ý nói mỗi đội có 03 thành viên.
>
> Lưu ý hiển thị phía trên form: `❗ Lưu ý: Mỗi đội gồm 03 thành viên. Hãy điền đầy đủ và chính xác các thông tin dưới đây. Hồ sơ hợp lệ cần nộp đầy đủ các mục yêu cầu.`

**THÔNG TIN ĐỘI DỰ THI**

- `Tên đội thi (*):` — placeholder `Enter your team name`
- `Tên startup / tổ chức đại diện (nếu có)` — placeholder `Enter your name`
- `Giới thiệu ngắn gọn về đội (dưới 100 từ):` — placeholder `Enter team introduction`

**THÔNG TIN THÀNH VIÊN**

- `Họ và tên thành viên 1 (*):` — `Enter name`
- `Vai trò (*):` — `Enter role`
- `Số điện thoại (*):` — `Enter phone`
- `Email (*):` — `Enter email`
- `Năm sinh (*):` — `Enter birth year`
- `Kinh nghiệm chuyên môn (*)` — `Enter experience`
- `Họ và tên thành viên 2:` — `Enter name`
- `Vai trò:` — `Enter role`
- `Số điện thoại:` — `Enter phone`
- `Email:` — `Enter email`
- `Năm sinh:` — `Enter birth year`
- `Kinh nghiệm chuyên môn` — `Enter experience`
- `Họ và tên thành viên 3:` — `Enter name`
- `Vai trò:` — `Enter role`
- `Số điện thoại:` — `Enter phone`
- `Email:` — `Enter email`
- `Năm sinh:` — `Enter birth year`
- `Kinh nghiệm chuyên môn` — `Enter experience`

**NĂNG LỰC KỸ THUẬT CỦA ĐỘI**

- `Ngôn ngữ lập trình, framework(*):` — `Enter programming languages`
- `Nền tảng A.I từng sử dụng(*):` — `Enter A.I platforms`
- `Kinh nghiệm xử lý dữ liệu / ML(*):` — `Enter ML experience`
- `Thành tích nổi bật trong công nghệ:` — `Enter tech achievements`

**DỰ ÁN THỰC TẾ**

- `Danh sách sản phẩm/dự án:` — placeholder nguyên văn:
  - `Liệt kê các sản phẩm/dự án mà đội đã thực hiện:`
  - ` - Dự án 1: Tên dự án, mô tả ngắn`
  - ` - Dự án 2: Tên dự án, mô tả ngắn`
  - ` - Dự án 3: Tên dự án, mô tả ngắn`
- `Mô tả danh sách dự án:` — placeholder nguyên văn:
  - ` - Vấn đề giải quyết:`
  - ` - Giải pháp A.I cụ thể:`
  - ` - Mức độ hoàn thiện:`
  - ` - Đối tượng mục tiêu:`
- `Link demo/báo cáo của danh sách dự án:` — placeholder nguyên văn:
  - `Liệt kê các link demo/báo cáo của các dự án:`
  - ` - Link demo dự án 1: https://...`
  - ` - Link báo cáo dự án 2: https://...`
  - ` - Link landing page dự án 3: https://...`

**VIDEO “TÔI ĐI THI A.I”**

- `Link video clip giới thiệu (30–60 giây)(*)` — `Enter your link`

Ghi chú bắt buộc nguyên văn:

> `*Yêu cầu bắt buộc: Vui lòng đính kèm link video clip ngắn (30 – 60 giây) khuyến khích làm bằng A.I giới thiệu đội thi, hình ảnh các thành viên đội thi, video nêu bật tinh thần, cá tính đội và lý do đến với cuộc thi.`

**THÔNG TIN KHÁC**

- `Bạn biết đến cuộc thi qua đâu?(*)` — `Facebook / Website / Mentor / Khác.....`
- `Câu hỏi hoặc đề xuất cho Ban Tổ Chức(*):` — `Câu hỏi của bạn`

**CAM KẾT THAM GIA**

`Tôi cam kết:`

- `- Thông tin đã cung cấp là chính xác và trung thực.`
- `- Tuân thủ nghiêm túc mọi quy định của cuộc thi.`
- `- Không sao chép, đạo nhái code hoặc ý tưởng từ người khác.`
- `- Đồng ý sử dụng hình ảnh/video phù hợp cho truyền thông và quảng bá.`
- `- Tham gia tích cực, có trách nhiệm trong suốt quá trình thi.`
- `- Bảo mật thông tin liên quan đến cuộc thi.`
- Checkbox `Tôi đồng ý với các điều khoản trên`
- Nút `GỬI ĐĂNG KÝ`

Nguồn: [form đăng ký chính thức](https://thucchien.ai/) (n.d.; truy cập 29/07/2026).

### A9. Điểm chưa rõ hoặc mâu thuẫn

| Vấn đề | Nguồn A | Nguồn B | Cách xử lý an toàn |
| --- | --- | --- | --- |
| Số thành viên | Điều lệ + báo chí: 1–3/tối đa 3 | Hướng dẫn và lưu ý form: đúng 3 | Nếu có thể, đăng ký 3; nếu chỉ có 1–2, email BTC trước khi nộp. |
| Tuổi | Điều lệ: công dân Việt Nam 18–35 | Trang chủ: “không phân biệt tuổi” | Theo giới hạn 18–35 cho đến khi BTC xác nhận khác. |
| Video | Điều lệ: 30 giây | Trang chủ/form: 30–60 giây | Làm đúng 30 giây. |
| Tên chủ đề | “Tôi đi thi Thực Chiến AI” | “Tôi đi thi A.I” | Dùng tên đầy đủ trong thoại/caption. |
| Giải Ba | Website: 100 triệu/giải | Báo 19/06: 150 triệu/giải | Không quảng bá con số chưa được BTC xác nhận. |
| Hồ sơ | Form online thiên về năng lực đội | Điều 5 đòi thêm đề tài, chữ ký, tỷ lệ đóng góp nhưng để trống deadline/địa chỉ | Nộp form hiện hành; hỏi BTC có cần bộ hồ sơ Điều 5 ngay Vòng 1 không. |
| Tiêu chí | Trang chủ nêu bốn hướng đánh giá | Điều lệ chưa công bố rubric/trọng số | Không tự gán trọng số. |
| Deadline | Có ngày 31/07/2026 | Không có giờ/múi giờ | Nộp sớm, không chờ cuối ngày 31/07. |
| File video | Form chỉ nhận link | Không có format/resolution/host/quyền riêng tư | Dùng MP4 phổ thông và link xem không cần đăng nhập như lựa chọn vận hành, không gọi là quy định. |

- [supported] Kênh hỏi chính thức: `lienhe@thucchien.ai`; fanpage được Điều lệ dẫn tới `facebook.com/chuongtrinh.aithucchien`. Nguồn: [Điều lệ, Điều 19](https://thucchien.ai/the-le-cuoc-thi/) (n.d.; truy cập 29/07/2026).

## B. Seedance 2.0 (ByteDance)

### B1. Danh tính sản phẩm và nguồn chính thức

- [supported] **Seedance 2.0** là mô hình tạo video kèm âm thanh của ByteDance Seed, phát hành chính thức ngày 12/02/2026. Kiến trúc hợp nhất nhận văn bản, ảnh, video và âm thanh; sinh hình, thoại, nhạc nền và hiệu ứng âm thanh đồng bộ. Nguồn: [ByteDance Seed — official launch](https://seed.bytedance.com/en/blog/seedance-2-0-official-launch) (12/02/2026), [bài báo kỹ thuật arXiv:2604.14148](https://arxiv.org/abs/2604.14148) (15/04/2026).
- [supported] Nghiên cứu này chỉ coi ByteDance Seed, Volcengine và Dreamina/CapCut là nguồn chính thức. Các giao diện như Higgsfield, Atlas Cloud hoặc công cụ gắn nhãn “Seedance” khác là bên thứ ba; giới hạn, giá và hậu xử lý của chúng có thể khác mô hình gốc.

### B2. Giới hạn clip và tỷ lệ khung hình

- [supported] Giới hạn mô hình công bố là **4–15 giây mỗi lần sinh**; trang dịch vụ Volcengine cũng ghi “lâu nhất 15 giây”. Vì vậy video dự thi 30 giây phải ghép từ ít nhất hai lần sinh, và thực tế nên dùng nhiều clip ngắn hơn để dễ chọn take. Nguồn: [bài báo kỹ thuật](https://arxiv.org/abs/2604.14148) (15/04/2026), [Volcengine Seedance 2.0](https://www.volcengine.com/activity/seedance2) (n.d.; truy cập 29/07/2026).
- [supported] Dreamina liệt kê năm tỷ lệ: **16:9, 4:3, 1:1, 3:4, 9:16**. Nguồn: [Dreamina — Seedance 2.0 tool](https://dreamina.capcut.com/tools/seedance-2-0) (n.d.; truy cập 29/07/2026).
- [open] Bài báo kỹ thuật ghi độ phân giải sinh nguyên bản **480p hoặc 720p**. Trang Volcengine hiện tự mâu thuẫn: thẻ gói flagship liệt kê 480p/720p/1080p/**4K**, còn FAQ trên cùng trang ghi độ phân giải tối đa **1080p**. Vì vậy không nên đồng nhất output/upscale của dịch vụ với độ phân giải native của mô hình, và phải kiểm selector thực tế trước khi hứa 4K. Nguồn: bài báo kỹ thuật và Volcengine ở trên (kiểm lại 29/07/2026).
- [inference] Cuộc thi không quy định tỷ lệ. Với video có ba thành viên và khả năng lên sóng/trình chiếu, **16:9** là lựa chọn vận hành an toàn; đây không phải yêu cầu của BTC.

### B3. Image-to-video và đầu vào tham chiếu

- [supported] **Có image-to-video.** Một lần tạo có thể nhận tối đa **9 ảnh, 3 video và 3 audio** làm tham chiếu; mô hình có thể học thành phần khung hình, nhân vật, chuyển động/camera, hiệu ứng và âm thanh từ các tài sản này. Nguồn: [ByteDance Seed — official launch](https://seed.bytedance.com/en/blog/seedance-2-0-official-launch) (12/02/2026), [bài báo kỹ thuật](https://arxiv.org/abs/2604.14148) (15/04/2026).
- [supported] Dreamina hỗ trợ hai workflow: **First and last frame** để khóa đầu/cuối một cảnh, và **Multiframes** để gọi tài sản trong prompt bằng `@Image1`, `@Video1`, `@Audio1`. Nguồn: [Dreamina — prompt guide](https://dreamina.capcut.com/resource/seedance-2-0-prompt) (n.d.; truy cập 29/07/2026).
- [supported] Với ảnh/video người thật, hệ thống tài sản tin cậy của Volcengine yêu cầu xác minh hoặc ủy quyền hợp pháp; ảnh rõ mặt, chính diện, đủ sáng giúp vượt kiểm tra nhất quán tốt hơn, còn ảnh nghiêng hoặc nhiều người có thể thất bại. Nguồn: [Volcengine — Trusted Assets](https://docs.volcengine.com/docs/82379/2315856?lang=en) (cập nhật 14/04/2026).

### B4. Cấu trúc prompt hiệu quả

- [supported] Dreamina đề xuất điểm khởi đầu **30–100 từ**, nêu chủ thể trước, dùng negative prompt có chọn lọc và chỉ đổi một biến mỗi lần thử. Nguồn: [Dreamina — prompt guide](https://dreamina.capcut.com/resource/seedance-2-0-prompt) (n.d.; truy cập 29/07/2026).
- [inference] Cấu trúc dễ kiểm soát nhất cho từng clip:
  1. **Đích:** thời lượng, tỷ lệ, loại cảnh.
  2. **Vai trò tài sản:** `@Image1` khóa nhân vật; `@Video1` tham chiếu camera/nhịp; `@Audio1` tham chiếu âm thanh.
  3. **Anchor nhân vật:** khuôn mặt, tóc, trang phục, đạo cụ bất biến.
  4. **Hành động theo nhịp:** ai làm gì, theo thứ tự nào; có thể chia mốc giây.
  5. **Máy quay:** cỡ cảnh + góc + một chuyển động chính + đối tượng được bám.
  6. **Look:** bối cảnh, ánh sáng, màu, chất liệu.
  7. **Âm thanh:** thoại, ambience, SFX, nhạc; hoặc ghi rõ sẽ làm hậu kỳ.
  8. **Ràng buộc:** các lỗi cụ thể cần tránh, không nhồi danh sách phủ định mâu thuẫn.
- [supported] Prompt mẫu chính thức của ByteDance được viết như chỉ dẫn đạo diễn: chủ thể/trang phục, chuỗi hành động, cỡ cảnh, camera, ánh sáng, vật lý, âm thanh và chuyển cảnh. Prompt dài vẫn có thể hữu ích cho cảnh phức tạp; mốc 30–100 từ là khởi điểm của Dreamina, không phải giới hạn cứng. Nguồn: [ByteDance Seed — official launch](https://seed.bytedance.com/en/blog/seedance-2-0-official-launch) (12/02/2026), prompt guide ở trên.
- [supported] Một người dùng Reddit sau hai tuần thử nghiệm báo structured shot list theo bốn khối `subjects / environment / style / shots` giúp continuity và camera tốt hơn “blob prompt”; mỗi shot ghi angle/lens/movement/action/SFX. Đây là kinh nghiệm cá nhân chạy qua Atlas Cloud, không phải benchmark mô hình gốc, nhưng cùng hướng với prompt mẫu chính thức. Nguồn: [Reddit r/Seedance_AI](https://www.reddit.com/r/Seedance_AI/comments/1toxy1r/stopped_writing_blob_prompts_for_seedance_20/) (khoảng 06/2026; truy cập 29/07/2026).

**Template dùng ngay**

```text
10 giây, 16:9. @Image1 là tham chiếu danh tính và trang phục bất biến của [TÊN].
Cảnh [cỡ cảnh] tại [bối cảnh]. [TÊN] [hành động 1], rồi [hành động 2].
Máy quay [một chuyển động] bám theo [đối tượng], từ [điểm A] đến [điểm B].
Ánh sáng [mô tả], màu [mô tả], chuyển động tự nhiên. Âm thanh: [ambience/SFX].
Giữ nguyên khuôn mặt, tóc, trang phục và đạo cụ; không sinh chữ, logo hoặc người thừa.
```

### B5. Mô tả chuyển động camera

- [supported] Ghi **cỡ cảnh + góc + động từ camera + đối tượng + thời điểm/đích đến**. Từ vựng dùng được trong prompt mẫu/tài liệu: `wide/medium/close-up`, `low-angle/overhead/POV`, `static/locked`, `pan left/right`, `tilt`, `slow push-in/dolly-in`, `pull-back`, `tracking/follow`, `lateral truck`, `orbit/arc`, `crane/jib`, `handheld`, `whip pan`, `rack focus`, `slow motion`. Nguồn: các prompt mẫu trong [official launch](https://seed.bytedance.com/en/blog/seedance-2-0-official-launch) (12/02/2026) và [Dreamina prompt guide](https://dreamina.capcut.com/resource/seedance-2-0-prompt) (n.d.).
- [inference] Mỗi clip ngắn nên có **một chuyển động máy chính**. Ví dụ tốt: “medium shot, máy quay dolly-in chậm từ thắt lưng đến cận mặt trong 4 giây, giữ mắt nhân vật ở giữa khung”; kém kiểm soát: “cinematic camera, pan, orbit, zoom, handheld”.
- [supported] Khi khó diễn đạt quỹ đạo, có thể đưa video tham chiếu và nói `@Video1` chỉ dùng cho chuyển động camera/nhịp dựng; ByteDance công bố mô hình có thể tham chiếu motion và camera từ video. Nguồn: official launch và Dreamina prompt guide ở trên.

### B6. Giữ nhất quán nhân vật giữa các cảnh

- [supported] Cơ chế mạnh nhất là dùng **cùng một bộ ảnh tham chiếu rõ nét** trong mọi lần sinh, gọi đúng tài sản bằng `@Image`, và lặp nguyên văn anchor khuôn mặt/tóc/trang phục/đạo cụ. Nếu dùng ảnh người thật, phải có quyền và có thể phải xác minh danh tính. Nguồn: [ByteDance Seed — official launch](https://seed.bytedance.com/en/blog/seedance-2-0-official-launch) (12/02/2026), [Dreamina prompt guide](https://dreamina.capcut.com/resource/seedance-2-0-prompt), [Volcengine Trusted Assets](https://docs.volcengine.com/docs/82379/2315856?lang=en) (14/04/2026).
- [inference] Workflow ổn định: làm một **character sheet** chính diện + 3/4 + toàn thân; giữ cùng tỷ lệ/độ phân giải/look; mỗi clip chỉ một hành động và một camera move; lấy frame cuối đã duyệt của clip trước làm first frame/reference cho clip sau. Sinh từng cảnh riêng rồi dựng, không yêu cầu một prompt tự giải quyết cả phim.
- [supported] ByteDance thừa nhận **multi-subject consistency** vẫn cần cải thiện. Vì vậy cảnh ba thành viên nên bắt đầu từ một ảnh nhóm đã bố trí đúng, hoặc quay thật/ghép hậu kỳ thay vì mong model tự duy trì ba danh tính qua nhiều shot. Nguồn: [official launch — limitations](https://seed.bytedance.com/en/blog/seedance-2-0-official-launch) (12/02/2026).
- [supported] Báo cáo thực tế khớp nhau ở điểm quan trọng: trong một clip thường ổn hơn giữa nhiều lần sinh; dùng lại đúng ảnh tham chiếu chính diện và mô tả nguyên văn giúp nhiều hơn text-only; khóa cả tỷ lệ/độ phân giải/ánh sáng. Nguồn: [Reddit — two weeks of testing](https://www.reddit.com/r/aivideos/comments/1smtzb9/seedance_20_character_consistency_across_shots/) (khoảng 04/2026) và [Tao Prompts — workflow phim dài](https://www.youtube.com/watch?v=KxRR8uiex_s) (01/05/2026; transcript kiểm tra 29/07/2026).
- [supported] Dan Kieft vẫn gặp mũ bảo hiểm xuất hiện/mất giữa shot, nhân vật trùng lặp và mặt nhiều nhân vật lệch; cách sửa thực tế là chuẩn bị start frame/character sheet đúng trạng thái, sinh nhiều take rồi dựng truyền thống. Nguồn: [Dan Kieft — Full Course](https://www.youtube.com/watch?v=ZghLm9MXVIY) (24/04/2026; transcript kiểm tra 29/07/2026).

### B7. Render chữ và tiếng Việt có dấu

- [supported] ByteDance công khai rằng **độ chính xác render chữ còn cần cải thiện**. Đây là bằng chứng trực tiếp rằng không nên giao tên đội, slogan, URL hay thông tin bắt buộc cho hình ảnh do model tự vẽ. Nguồn: [official launch — limitations](https://seed.bytedance.com/en/blog/seedance-2-0-official-launch) (12/02/2026).
- [open] Chưa có tài liệu chính thức hoặc phép thử độc lập đủ mạnh chứng minh Seedance 2.0 viết **tiếng Việt có dấu** đúng và ổn định theo từng frame. Tìm kiếm tiếng Việt ngày 29/07/2026 chủ yếu trả blog SEO và mẹo nhép môi; các tuyên bố marketing về title/font overlay không chứng minh chính tả dấu tiếng Việt. Nguồn: [ByteDance official launch — giới hạn text rendering](https://seed.bytedance.com/en/blog/seedance-2-0-official-launch) (12/02/2026) và lượt tìm kiếm nguồn Việt ngày 29/07/2026, không tìm thấy test đáng tin cậy để nâng mức bằng chứng.
- [supported] Trong một workflow quảng cáo sản phẩm, Matt Loui quan sát trực tiếp chữ sai, chi tiết camera điện thoại sai, frame glitch và âm nhạc bị đứt; anh tách cảnh trong CapCut rồi bỏ các shot lỗi. Đây là bằng chứng người dùng về lỗi chữ nói chung, chưa phải test riêng tiếng Việt. Nguồn: [Matt Loui — Full Prompting Tutorial](https://www.youtube.com/watch?v=-k6BAe27dDU) (22/04/2026; transcript kiểm tra 29/07/2026).
- [inference] Cách an toàn: prompt **“no text, no letters, no logos”**; render phần hình; sau đó ghép tiêu đề, tên người, subtitle và logo bằng CapCut/Premiere/DaVinci. Thoại tiếng Việt cũng nên thu voice-over riêng nếu độ chính xác là điều kiện bắt buộc.

### B8. Lỗi thường gặp và cách giảm lỗi

- [supported] Chính ByteDance nêu các giới hạn còn tồn tại: ổn định chi tiết, độ chân thực ở cảnh siêu thực, sức sống của chuyển động, đôi lúc méo âm thanh; nhất quán nhiều chủ thể, độ chính xác chữ và hiệu ứng dựng phức tạp còn cần cải thiện. Nguồn: [official launch — limitations](https://seed.bytedance.com/en/blog/seedance-2-0-official-launch) (12/02/2026).
- [supported] **Drift khuôn mặt/tóc/trang phục/đạo cụ giữa clip:** cùng một ảnh tham chiếu chính diện, cùng anchor nguyên văn, cùng aspect/resolution/look; giảm extreme close-up; sinh nhiều take. Nguồn: [Reddit — two weeks of testing](https://www.reddit.com/r/aivideos/comments/1smtzb9/seedance_20_character_consistency_across_shots/) (khoảng 04/2026), Dan Kieft và Tao Prompts (URL ở B6).
- [supported] **Nhiều nhân vật bị trộn/trùng hoặc khác mặt:** dùng start frame có sẵn đúng tất cả thành viên; nếu shot quan trọng, quay ảnh nhóm thật hoặc tách từng người rồi composite. Nguồn: ByteDance limitation và Dan Kieft (URL ở B6).
- [supported] **Camera/action không đúng, vật thể sai hình hoặc biến mất:** một chủ thể + một hành động liên tục + một camera move mỗi clip; thêm first/last frame; cắt shot xấu thay vì cố cứu cả lần sinh. Nguồn: [Reddit — Dreamina experience](https://www.reddit.com/r/Seedance_AI/comments/1s2brnd/my_experience_with_the_new_dreamina_seedance_20/) (khoảng 03/2026), Dan Kieft và Matt Loui (URL ở B6–B7).
- [supported] **Chuyển động nhanh nhòe cạnh, âm thanh méo/đứt, hard cut phức tạp:** giảm tốc/chuyển động, tách clip ngắn, dựng cut và mix âm thanh ngoài model. Nguồn: Reddit Dreamina experience, Matt Loui và official limitations ở trên.
- [inference] **Prompt bị bỏ sót lệnh:** rút về 30–100 từ hoặc structured blocks; bỏ lệnh camera mâu thuẫn; chỉ đổi một biến khi retry; dùng video reference nếu quỹ đạo camera quan trọng.
- [open] **Queue/credit và feature khác theo vùng/provider:** một snapshot người dùng Dreamina ghi nhận queue gần một giờ ngay sau phát hành; các creator YouTube thử qua Higgsfield. Reddit trả 403 ở lượt kiểm lại nên đây chỉ là báo cáo cá nhân, không phải trạng thái dịch vụ hiện tại. Không lấy tốc độ, credit hoặc feature của bên thứ ba làm thông số ByteDance. Nguồn: Reddit Dreamina experience và ba video YouTube trong danh mục nguồn.

### B9. Điểm chưa rõ hoặc mâu thuẫn

| Vấn đề | Bằng chứng | Kết luận vận hành |
| --- | --- | --- |
| Duration trong Dreamina | Prompt guide/promo cho chọn 5/10/15 giây; một bước trên tool page ghi 5–12 giây | Giới hạn mô hình là 4–15 giây; kiểm tra selector/tài khoản thực tế, đừng hứa luôn có 15 giây trên mọi giao diện. |
| Độ phân giải | Paper: native 480p/720p; thẻ gói Volcengine ghi tới 4K nhưng FAQ cùng trang ghi tối đa 1080p | Tách native khỏi output/upscale dịch vụ; kiểm selector thực tế, không hứa 4K chỉ từ thẻ marketing. |
| Số tài sản tham chiếu | ByteDance/paper: 9 ảnh + 3 video + 3 audio; Dreamina viết “up to 12 clips” nhưng ngay sau đó cũng liệt kê 9 + 3 + 3 = 15 tài sản | Dùng giới hạn rõ theo từng loại: 9 ảnh, 3 video, 3 audio; không dùng tổng “12 clips”. |
| Lẫn phiên bản | Các trang/bên thứ ba có thể đang bán một phiên bản Seedance khác 2.0 | Luôn kiểm model selector; không gán thời lượng của phiên bản khác cho 2.0. |
| Chữ tiếng Việt | Model có thể tạo chữ nhưng ByteDance thừa nhận text accuracy chưa ổn | Không dùng chữ sinh trong video cho nội dung bắt buộc; ghép typography hậu kỳ. |

## Tóm tắt để làm video 30 giây

### Bộ ràng buộc chốt

- **Master đúng 30,00 giây.** Điều lệ ghi 30 giây, form ghi 30–60 giây; đúng 30 giây thỏa cả hai. Đừng dùng một output 30 giây gắn nhãn Seedance 2.0: model 2.0 chỉ sinh 4–15 giây/lần.
- **Nguồn hình:** tạo 5–8 clip Seedance dài khoảng 4–8 giây để có handle và take dự phòng; chọn/cắt còn 5–6 shot trong timeline 30 giây. Hai clip 15 giây là mức tối thiểu về toán học nhưng rủi ro drift và khó dựng hơn.
- **Khung:** chọn **16:9** cho cả project và mọi lần sinh; giữ nguyên aspect/resolution giữa shot. BTC chưa quy định tỷ lệ, nên đây là lựa chọn vận hành cho nhóm ba người và màn hình ngang.
- **Nhân vật:** với mỗi thành viên, chuẩn bị ảnh chính diện đủ sáng + 3/4 + toàn thân; xin đồng ý sử dụng ảnh. Dùng lại đúng asset và đúng một anchor mô tả ở mọi prompt. Shot có đủ ba người nên khởi đầu từ một ảnh nhóm đã bố trí đúng hoặc dùng footage thật.
- **Prompt:** một shot = một mục tiêu, một hành động liên tục, một camera move. Viết theo `duration/aspect → @reference → subject anchor → action beats → shot/angle/camera → light/look → audio → constraints`; đổi một biến mỗi lần retry.
- **Chữ:** không để Seedance tự viết tên đội, tên người, slogan hay tiếng Việt có dấu. Prompt `no text, no letters, no logos`, rồi ghép typography/subtitle/logo trong phần mềm dựng và soi lại từng dấu.
- **Âm thanh:** thu voice-over tiếng Việt riêng; dựng nhạc có quyền sử dụng và SFX ở hậu kỳ. Không đặt độ chính xác phát âm/nhép môi tiếng Việt vào đường găng nếu chưa test trực tiếp trên tài khoản sẽ dùng.

### Storyboard đúng 30 giây

| Mốc | Nội dung phải thấy/nghe | Cách làm ít rủi ro |
| --- | --- | --- |
| 0,00–3,00 | Hook hình ảnh + vấn đề đội muốn giải | Một hero shot, camera move đơn giản; chưa cần chữ sinh. |
| 3,00–8,00 | Tên đội và **hình đủ các thành viên** | Ảnh/footage nhóm thật hoặc I2V từ ảnh nhóm; tên ghép hậu kỳ. |
| 8,00–15,00 | Vai trò/năng lực nổi bật của đội | 2–3 cut ngắn, mỗi người một hành động rõ. |
| 15,00–23,00 | “Wow moment”: AI biến dữ liệu/ý tưởng thành kết quả | Một shot chính + một shot reaction; ưu tiên demo/visual cụ thể. |
| 23,00–28,00 | Cá tính, tinh thần và lý do đến cuộc thi | Voice-over khoảng một câu; giữ gương mặt ổn định bằng reference. |
| 28,00–30,00 | Câu chốt **“Tôi đi thi Thực Chiến AI”** | Thoại/VO thật; title card và logo ghép hậu kỳ. |

Với tốc độ đọc tự nhiên, toàn bộ voice-over nên khoảng **65–75 từ tiếng Việt**, đọc thử bằng đồng hồ trước khi khóa dựng.

### Export, QA và nộp

1. [inference] Xuất một bản phổ thông **MP4, H.264, 1920×1080, 25 hoặc 30 fps, AAC**; đây là khuyến nghị tương thích, không phải format BTC đã công bố.
2. Kiểm đúng `00:00:30.00`; xem không tiếng để chắc hình vẫn hiểu được, rồi nghe bằng tai nghe để tìm âm đứt/méo.
3. Soi frame-by-frame: đủ mặt thành viên, không đổi tóc/trang phục/đạo cụ, không người thừa, không chữ AI sai, subtitle tiếng Việt đủ dấu.
4. Tải lên nơi người chấm mở được **không cần đăng nhập**; thử link trong cửa sổ ẩn danh và trên điện thoại.
5. Dán link vào trường bắt buộc `Link video clip giới thiệu (30–60 giây)(*)`, hoàn tất các trường form và bấm `GỬI ĐĂNG KÝ`.
6. Nộp trước 31/07/2026 và lưu screenshot/xác nhận. Website không ghi giờ chốt hay múi giờ, nên không chờ cuối ngày.

## Nhật ký cập nhật

- **29/07/2026 — Khởi tạo:** tạo ledger trước khi thu thập nguồn; chưa coi placeholder là kết luận.
- **29/07/2026 — Cụm A/website:** lập sitemap toàn domain, mở từng trang con và retry URL lỗi; tách trang mùa 2026 khỏi dashboard/legacy mùa 2025.
- **29/07/2026 — Cụm A/thể lệ + form:** chép trường form, ghi lịch, đối tượng, cách nộp, giải thưởng, tiêu chí; giữ nguyên các mâu thuẫn về đội, tuổi, video và Giải Ba.
- **29/07/2026 — Cụm B/nguồn chính thức:** đối chiếu ByteDance Seed, paper, Volcengine và Dreamina; tách giới hạn mô hình khỏi giới hạn giao diện/dịch vụ; ghi prompt, camera, I2V, character consistency và giới hạn render chữ.
- **29/07/2026 — Cụm B/người dùng thực tế:** kiểm bài Reddit có ngày và transcript ba video YouTube; ghi drift qua clip, lỗi đa nhân vật/đạo cụ/chữ/âm thanh và workflow character sheet + hậu kỳ; không nâng báo cáo cá nhân thành benchmark.
- **29/07/2026 — Chốt:** lập storyboard 30,00 giây và checklist export/nộp; quét placeholder/fence/diff, đọc lại tài liệu và mở lại toàn bộ URL nguồn chính.
- **29/07/2026 — Kiểm lại trạng thái thật:** đọc lại toàn bộ file và DOM form; bổ sung các placeholder dự án, ghi chú video và khối cam kết bị thiếu. Mở lại nguồn Seedance chính thức; ghi đúng mâu thuẫn Volcengine 4K/1080p và Dreamina “12 clips”/15 tài sản.

## Danh mục nguồn

### Cuộc thi

- [Trang chủ/form Thực Chiến AI](https://thucchien.ai/) — n.d.; truy cập 29/07/2026.
- [Điều lệ cuộc thi](https://thucchien.ai/the-le-cuoc-thi/) — n.d.; truy cập 29/07/2026.
- [Sitemap chính thức](https://thucchien.ai/wp-sitemap.xml) và các sitemap con — tự sinh; truy cập 29/07/2026.
- [Tài liệu kỹ thuật cuộc thi](https://docs.thucchien.ai/) và [sitemap docs](https://docs.thucchien.ai/sitemap.xml) — n.d.; truy cập 29/07/2026.
- [VTC News: AI Thực chiến mùa 2](https://vtcnews.vn/ai-thuc-chien-mua-2-nang-cap-thanh-gameshow-giai-thuong-cao-nhat-1-ty-dong-ar1024507.html) — 19/06/2026.
- [Nhà báo & Công luận: giải thưởng AI Thực chiến 2026](https://congluan.vn/hap-dan-giai-thuong-tien-ty-va-hoc-bong-1-trieu-usd-tai-gameshow-ai-thuc-chien-2026-tren-song-quoc-gia-post350578.html) — 19/06/2026.

### Seedance 2.0 — nguồn chính thức

- [ByteDance Seed: Seedance 2.0 official launch](https://seed.bytedance.com/en/blog/seedance-2-0-official-launch) — 12/02/2026.
- [Seedance 2.0: Advancing Video Generation for World Complexity](https://arxiv.org/abs/2604.14148) — 15/04/2026.
- [Volcengine: Seedance 2.0](https://www.volcengine.com/activity/seedance2) — n.d.; truy cập 29/07/2026.
- [Volcengine: Trusted Assets](https://docs.volcengine.com/docs/82379/2315856?lang=en) — cập nhật 14/04/2026.
- [Dreamina: Seedance 2.0 prompt guide](https://dreamina.capcut.com/resource/seedance-2-0-prompt) — n.d.; truy cập 29/07/2026.
- [Dreamina: Seedance 2.0 tool](https://dreamina.capcut.com/tools/seedance-2-0) — n.d.; truy cập 29/07/2026.

### Seedance 2.0 — trải nghiệm người dùng

- [Reddit: character consistency after two weeks](https://www.reddit.com/r/aivideos/comments/1smtzb9/seedance_20_character_consistency_across_shots/) — khoảng 04/2026; truy cập 29/07/2026.
- [Reddit: Dreamina Seedance 2.0 experience](https://www.reddit.com/r/Seedance_AI/comments/1s2brnd/my_experience_with_the_new_dreamina_seedance_20/) — khoảng 03/2026; truy cập 29/07/2026.
- [Reddit: structured shot lists](https://www.reddit.com/r/Seedance_AI/comments/1toxy1r/stopped_writing_blob_prompts_for_seedance_20/) — khoảng 06/2026; qua Atlas Cloud, truy cập 29/07/2026.

> Lượt kiểm lại cuối ngày 29/07/2026: Reddit trả 403 qua Jina và backend OpenCLI chưa khả dụng. Ba mục trên được giữ như snapshot người dùng đã đọc ở lượt đầu; không claim thông số lõi nào chỉ dựa vào chúng.

- [Dan Kieft: Seedance 2.0 Full Course](https://www.youtube.com/watch?v=ZghLm9MXVIY) — 24/04/2026; 167.221 lượt xem tại lượt kiểm lại 29/07/2026.
- [Tao Prompts: Create Seamless AI Films of ANY Length](https://www.youtube.com/watch?v=KxRR8uiex_s) — 01/05/2026; 97.990 lượt xem tại lượt kiểm lại 29/07/2026.
- [Matt Loui: Seedance 2.0 Full Prompting Tutorial](https://www.youtube.com/watch?v=-k6BAe27dDU) — 22/04/2026; 69.015 lượt xem tại thời điểm kiểm tra.

> Ba video YouTube trình diễn workflow qua giao diện bên thứ ba và có thể có affiliate/sponsorship. Chỉ dùng chúng làm bằng chứng thao tác/lỗi output đã quan sát, không dùng cho giới hạn chính thức hay so sánh chất lượng.
