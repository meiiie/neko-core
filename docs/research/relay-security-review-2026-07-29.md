# Rà soát bảo mật Neko Core Relay đến 29/07/2026

- **Trạng thái:** đang nghiên cứu, cập nhật liên tục
- **Mốc đánh giá:** 2026-07-29
- **Ngày truy cập nguồn web:** 2026-07-29, trừ khi ghi khác
- **Phạm vi code bắt buộc:** `cloudflare/relay/worker.js`, `cloudflare/relay/client.html`, `cloudflare/relay/camera.html`, `src/adapters/remote-relay.ts`, `src/adapters/relay-crypto.ts`
- **Nguồn phạm vi:** yêu cầu tác nghiệp của người dùng, 2026-07-29

## Quy ước bằng chứng

- `[verified]`: claim cốt lõi đã được đối chiếu với ít nhất hai nguồn độc lập, hoặc code thực tế cộng một nguồn sơ cấp phù hợp.
- `[supported]`: có một nguồn sơ cấp mạnh hoặc bằng chứng code trực tiếp, nhưng chưa đủ hai nguồn độc lập.
- `[inference]`: suy luận bảo mật từ bằng chứng đã dẫn; không trình bày như sự thật đã được chứng minh.
- `[open]`: câu hỏi hoặc giả thuyết chưa đủ bằng chứng.
- `Ngày nguồn: n.d.`: trang nguồn không công bố ngày rõ ràng.

Mỗi claim thực chất trong báo cáo phải có dòng `Nguồn:` và ngày. Khi nguồn không chứng minh được toàn bộ claim, báo cáo phải thu hẹp claim hoặc hạ mức bằng chứng.

## Câu hỏi nghiên cứu

### 1. Capability URL và chuẩn thực hành đến 2026

- [open] Mô hình hiện tại có phù hợp với hướng dẫn W3C về capability URLs và thực hành của CryptPad, Excalidraw, Jitsi, Signal link-invite, Cloudflare Zero Trust hay không?
  - Nguồn cần kiểm tra: code trong phạm vi; tài liệu hoặc repository chính thức của từng tổ chức/dự án; ngày truy cập 2026-07-29.

### 2. Lỗ hổng thực tế cần vá

- [open] Độ mạnh thực tế của Bearer token, `safeEqual`, session ID, chống brute force, replay, revoke và thời hạn pairing chưa được xác minh.
  - Nguồn cần kiểm tra: code trong phạm vi; OWASP/NIST/IETF/Cloudflare hoặc tài liệu sơ cấp tương đương; ngày truy cập 2026-07-29.

- [open] Rủi ro lưu secret trong `localStorage` trên điện thoại bị mất hoặc cho mượn, và tính phù hợp của WebAuthn/expiry, chưa được xác minh.
  - Nguồn cần kiểm tra: code trong phạm vi; W3C WebAuthn, OWASP, tài liệu nền tảng chính thức; ngày truy cập 2026-07-29.

### 3. Trang camera và đồng thuận

- [open] Chưa xác minh camera page hiện có chỉ báo đồng thuận/đang truyền hình phù hợp với chuẩn pháp lý và chính sách nền tảng hay chưa.
  - Nguồn cần kiểm tra: `camera.html`; GDPR/EDPB và chính sách Apple/Google hoặc hướng dẫn nền tảng chính thức; ngày truy cập 2026-07-29.

### 4. Xếp hạng biện pháp

Bảng này sẽ được điền sau khi hoàn tất threat model và kiểm chứng nguồn.

| Mức | Biện pháp | Kịch bản tấn công được giảm | Bằng chứng | Chi phí/đánh đổi |
|---|---|---|---|---|
| PHẢI | [open] | [open] | [open] | [open] |
| NÊN | [open] | [open] | [open] | [open] |
| KHÔNG CẦN | [open] | [open] | [open] | [open] |

## Threat model từ code

### Tài sản và ranh giới tin cậy

- [open] Chưa lập xong từ code thực tế.
  - Nguồn: năm file trong phạm vi; sẽ bổ sung đường dẫn và dòng sau khi đọc; 2026-07-29.

### Luồng tạo phiên, định tuyến, xác thực và mã hóa

- [open] Chưa lập xong từ code thực tế.
  - Nguồn: năm file trong phạm vi; sẽ bổ sung đường dẫn và dòng sau khi đọc; 2026-07-29.

### Bề mặt tấn công

- [open] Chưa lập xong từ code thực tế.
  - Nguồn: năm file trong phạm vi; sẽ bổ sung đường dẫn và dòng sau khi đọc; 2026-07-29.

## Đối chiếu nguồn sơ cấp

### W3C capability URLs

- [open] Đang thu thập nguồn.
  - Nguồn: sẽ bổ sung; truy cập 2026-07-29.

### CryptPad

- [open] Đang thu thập nguồn.
  - Nguồn: sẽ bổ sung; truy cập 2026-07-29.

### Excalidraw

- [open] Đang thu thập nguồn.
  - Nguồn: sẽ bổ sung; truy cập 2026-07-29.

### Jitsi

- [open] Đang thu thập nguồn.
  - Nguồn: sẽ bổ sung; truy cập 2026-07-29.

### Signal link-invite

- [open] Đang thu thập nguồn.
  - Nguồn: sẽ bổ sung; truy cập 2026-07-29.

### Cloudflare Zero Trust

- [open] Đang thu thập nguồn.
  - Nguồn: sẽ bổ sung; truy cập 2026-07-29.

## Phân tích kiểm soát bảo mật

### Brute force và so sánh token

- [open] Đang kiểm tra `safeEqual`, entropy token và rate limiting theo IP/phiên.
  - Nguồn: code thực tế và nguồn chuẩn sẽ bổ sung; 2026-07-29.

### Session ID

- [open] Đang kiểm tra cách sinh, entropy, exposure và khả năng enumeration.
  - Nguồn: code thực tế và nguồn chuẩn sẽ bổ sung; 2026-07-29.

### Replay, revoke và vòng đời pairing

- [open] Đang kiểm tra nonce/counter, trạng thái Durable Object, TTL và cơ chế thu hồi.
  - Nguồn: code thực tế và nguồn chuẩn sẽ bổ sung; 2026-07-29.

### Secret trong URL fragment và localStorage

- [open] Đang kiểm tra khả năng secret tới server, phạm vi truy cập JavaScript, retention và rủi ro thiết bị.
  - Nguồn: code thực tế và nguồn chuẩn sẽ bổ sung; 2026-07-29.

### Camera, đồng thuận và chỉ báo đang truyền

- [open] Đang kiểm tra luồng permission, chỉ báo giao diện, dừng capture và disclosure.
  - Nguồn: code thực tế và nguồn chuẩn sẽ bổ sung; 2026-07-29.

## Giả thuyết phản bác cần thử

- [open] Capability URL không mặc nhiên là thiết kế yếu; có thể đạt mức thực hành tốt nếu entropy, compartmentalization, expiry, revoke và xử lý leak đủ mạnh.
  - Nguồn cần kiểm tra: W3C và các triển khai E2EE được nêu trong phạm vi; 2026-07-29.

- [open] Rate limit theo IP không mặc nhiên là biện pháp bắt buộc nếu token đủ entropy; có thể chỉ là defense-in-depth, đồng thời gây hại cho người dùng sau NAT.
  - Nguồn cần kiểm tra: entropy thực tế trong code và hướng dẫn OWASP/NIST/Cloudflare; 2026-07-29.

- [open] WebAuthn có thể không giải quyết đúng bài toán secret E2EE được dùng trên thiết bị khách; cần phân biệt xác thực người dùng, bảo vệ khóa và trải nghiệm ghép nối.
  - Nguồn cần kiểm tra: W3C WebAuthn và kiến trúc hiện tại; 2026-07-29.

## Checkpoint 2026-07-29 — khởi tạo

- Đã tạo ledger trước khi phân tích, đúng phạm vi người dùng yêu cầu.
- Chưa có kết luận bảo mật; tất cả giả thuyết còn `[open]`.
- Bước tiếp theo: đọc code thực tế, cập nhật threat model, rồi fan-out nguồn sơ cấp.

## Kết luận và việc cần làm

> Chưa chốt. Mục này chỉ được hoàn thiện sau khi threat model, đối chiếu nguồn và kiểm tra link kết thúc.

1. [open] Việc phải vá ngay.
2. [open] Việc nên làm theo lộ trình.
3. [open] Việc không cần làm hoặc không đúng lớp vấn đề.
