# Relay security review — 2026-07-29

- Phạm vi: `cloudflare/relay/worker.js`, `client.html`, `camera.html`, `src/adapters/remote-relay.ts`, `relay-crypto.ts` và các điểm gọi trực tiếp trong `src/ui/chat.tsx`.
- Mốc đánh giá: 29/07/2026; ngày truy cập nguồn web: 29/07/2026.
- Phương pháp: đọc mã thật, đối chiếu test hiện có, mô hình hóa tác nhân/biên tin cậy, rồi kiểm tra bằng nguồn sơ cấp hoặc tài liệu chính thức.
- Quy ước: `[verified]` = kết luận cốt lõi có ít nhất hai nguồn độc lập; `[supported]` = một nguồn sơ cấp hoặc quan sát trực tiếp từ mã; `[inference]` = đề xuất/diễn giải từ bằng chứng; `[open]` = chưa đủ bằng chứng.
- Đây là review kỹ thuật, không phải ý kiến pháp lý cho một quốc gia hoặc tình huống triển khai cụ thể.

## Tóm tắt điều hành

**Kết luận ngắn:** mô hình “trang public + capability link + khóa E2E trong `#fragment`” là một mô hình bảo mật hợp lệ và có tiền lệ tốt; public HTML tự nó không phải lỗ hổng. Tuy nhiên, bản relay hiện tại **chưa đạt baseline của một dịch vụ tổ chức/lab năm 2026** vì capability tồn tại vô thời hạn, dùng chung giữa thiết bị, lưu thô trong `localStorage`, vẫn chấp nhận plaintext không seal khi secret đã bật, không có chống replay ở lớp E2E và trang camera mô tả sai biên xử lý ảnh. Nguồn: [C1]–[C6], [S1]–[S8], [S17], [S18].

Năm việc phải sửa trước khi gọi relay là “org/lab-ready”:

1. **Đóng E2E downgrade:** khi secret đã cấu hình, host và browser phải từ chối mọi command/frame/control/reply/presence/mirror không có envelope `{iv,ct}` hợp lệ; hiện plaintext có thể đi thẳng tới `handlers.run`. Nguồn: [C2], [C4], [S17], [S18].
2. **Chống replay ở protocol E2E** bằng sequence/nonce logic, loại thông điệp, hướng truyền và freshness được xác thực bằng AEAD; ciphertext hợp lệ không được phép chạy lần hai. Nguồn: [C4], [C5], [S17], [S18].
3. **Sửa disclosure camera và vòng đời capture:** nói rõ ảnh được giải mã ở host rồi có thể gửi tới vision provider cấu hình; hiện nhãn “chỉ máy Neko đọc được” là sai. Thêm trạng thái capture thường trực và tự dừng khi trang ẩn/rời trang. Nguồn: [C3], [C6], [S20]–[S23].
4. **Đổi pairing thành enrollment ngắn hạn, theo thiết bị và thu hồi riêng:** link scan chỉ dùng một lần/trong khoảng ngắn; sau đó cấp credential riêng cho thiết bị, có hết hạn/inactivity và danh sách thiết bị. Nguồn: [C1], [C2], [C4], [S1], [S6]–[S10].
5. **Không mặc định lưu credential và transcript plaintext vô thời hạn:** thêm “Ghi nhớ thiết bị này”, cảnh báo thiết bị dùng chung, khóa cục bộ và đường thoát cho điện thoại mất. WebAuthn PRF là hardening tùy chọn, không phải phép chữa duy nhất. Nguồn: [C2], [C3], [S15], [S16], [S19].

`safeEqual` hiện tại xử lý đúng bài toán timing của so sánh token, nhưng không giới hạn số lần thử hay chi phí tạo Durable Object. Với token CSPRNG 96 bit, brute-force online không thực tế; rate limit 401 là **NÊN làm để chống abuse/DoS**, không phải bản vá cứu một token yếu. Nguồn: [C1], [C4], [S11], [S14].

## 1. Hệ thống thực sự đang bảo vệ gì

### Luồng và biên tin cậy

1. Host sinh `session`, bearer `token`, E2E `secret` bằng `randomBytes(12).toString("base64url")`: mỗi giá trị có 96 bit entropy trước mã hóa. Pairing được giữ trong `~/.neko-core/relay*.json` và tái sử dụng qua lần chạy; `/relay new` mới xoay vòng. Nguồn: [C4, dòng 50–102, 115–127].
2. URL ghép cặp có dạng `/session/<session>#t=<token>&k=<secret>`. Fragment không nằm trong HTTP request ban đầu; JavaScript của trang đọc fragment, lưu token/secret rồi dùng bearer để gọi Worker và AES-GCM để seal nội dung. Nguồn: [C2, dòng 311–377], [C6, dòng 1675–1745], [S2].
3. Worker dùng `session` để định tuyến Durable Object; token đầu tiên đăng ký session, các request/WS sau phải `safeEqual` với token đã bind. Worker thấy metadata, bearer và ciphertext, nhưng không nhận `secret` từ fragment theo luồng bình thường. Nguồn: [C1, dòng 53–75, 156–190, 239–301].
4. E2E dùng PBKDF2-SHA-256 100.000 vòng từ secret, AES-GCM, IV ngẫu nhiên 12 byte và tag 16 byte. Envelope chỉ có `{iv, ct}`; không có version, session, direction, type, sequence, timestamp hay AAD. Nguồn: [C5, dòng 10–42].
5. Với camera, Worker chỉ forward body `/frame` và không xếp hàng frame; host giải mã rồi gọi `describeImage(...)`. Vì vậy Worker không đọc được pixel, nhưng vision provider cấu hình có thể nhận pixel đã giải mã. Nguồn: [C1, dòng 360–370], [C4, dòng 281–285], [C6, dòng 2152–2180].

### Tác nhân cần xét

- Người đoán capability từ Internet; người có một phần link; người nhặt/mượn điện thoại đã mở khóa; script cùng origin hoặc XSS; operator/log của relay; relay bị chiếm quyền và replay/reorder/drop ciphertext; vision provider; người đứng trong khung hình. Đây là threat model suy ra từ các điểm lưu/định tuyến/xử lý nêu trên. Nguồn: [C1]–[C6], [S1], [S15], [S20].
- Không đánh đồng “server không có secret E2E” với “server không thể gây tác động”: server vẫn có thể từ chối dịch vụ, quan sát metadata, forge plaintext do downgrade hiện tại và phát lại ciphertext cũ nếu protocol nhận không kiểm tra strict sealing/freshness. Nguồn: [C1], [C2], [C4], [C5], [S17], [S18].

## 2. Capability URL có phù hợp thông lệ 2026 không?

### Kết luận

[verified] **Có, nếu gọi đúng tên và quản lý đúng vòng đời.** W3C Capability URLs mô tả URL khó đoán như một capability hữu ích, đồng thời cảnh báo URL dễ rò, yêu cầu HTTPS, expiry, revocation, tránh referrer/third-party content và giải thích rủi ro chia sẻ. Tài liệu này là First Public Working Draft/TAG work, không phải chứng nhận tuân thủ hay W3C Recommendation; vì vậy không tồn tại nhãn nhị phân “đạt chuẩn W3C” cho Neko. Nguồn: [S1], [S2].

[supported] Neko đã làm đúng một số phần quan trọng: HTTPS/HSTS tại Worker, CSP không cho third-party script, `Referrer-Policy: no-referrer`, `Cache-Control: no-store`, `frame-ancestors 'none'`, fragment được xóa bằng `history.replaceState`, và revoke đóng socket/xóa Durable Object. Nguồn: [C1, dòng 112–153, 296–301], [C2, dòng 346–357], [S1].

[supported] Neko còn thiếu đúng các control W3C nhấn mạnh: expiry, capability theo đối tượng để revoke chọn lọc, và vòng đời chia sẻ rõ ràng. `unpair` trên client chỉ xóa local state, không revoke server hoặc thiết bị khác. Nguồn: [C1, dòng 296–301], [C2, dòng 637–651], [S1].

### Đối chiếu sản phẩm/hệ thống

| Hệ thống | Mẫu bảo mật quan sát được | Bài học cho Neko | Nguồn |
|---|---|---|---|
| CryptPad | Khóa tài liệu nằm trong URL hash và không gửi server; tài liệu cũng nói web endpoint/code vẫn phải được tin cậy, hỗ trợ password, expiry/self-destruct và logout thiết bị mất. | Fragment E2E là tiền lệ tốt, nhưng cần lifecycle và bảo vệ endpoint/client storage. | [S2], [S3] |
| Excalidraw | Mã hiện hành tạo room ID 10 byte, key AES-GCM 128 bit và link `#room=<id>,<key>`. | Xác nhận pattern room + fragment key phổ biến; không chứng minh lifecycle hiện tại của Neko đủ. | [S4] |
| Jitsi | Phân tầng: tên phòng khó đoán phù hợp nhóm nhỏ/low-profile; phòng public/high-interest nên có password hoặc authentication; token auth/lobby dùng cho triển khai kiểm soát hơn. | Personal mode có thể nhẹ; org mode cần identity/policy bổ sung. | [S5] |
| Signal | Group/call link có admin approval, reset/disable/delete; call link hết hạn sau thời gian không dùng. | Link mời cần control sau khi phát hành, không chỉ entropy. | [S6], [S7] |
| Cloudflare Zero Trust | Access kiểm tra identity/token theo request, session có thời hạn; service token có tên, expiry, log và revoke riêng. | Đây là baseline phù hợp org, có thể đặt trước Worker; nó bổ sung chứ không thay E2E/anti-replay. | [S8]–[S10] |

[inference] Nên cung cấp hai profile thay vì ép một mô hình: **Personal capability mode** không tài khoản nhưng pairing ngắn hạn/theo thiết bị; **Organization mode** đặt Cloudflare Access/IdP trước Worker, policy deny-by-default và session hữu hạn. Nguồn: [S5], [S8]–[S10].

## 3. Lỗ hổng và câu trả lời kỹ thuật

### 3.1 Brute-force bearer: `safeEqual` có đủ không?

[verified] `safeEqual` là implementation hợp lý để tránh timing leak: mã hash hai chuỗi bằng SHA-256 rồi dùng `crypto.subtle.timingSafeEqual`, có fallback XOR độ dài cố định. Cloudflare mô tả `timingSafeEqual` là so sánh timing-resistant. Nguồn: [C1, dòng 156–170], [S14].

[verified] Nó **không** chống brute-force, credential stuffing, session spraying hay resource abuse; mã Worker không có rate counter/alarm/TTL. Cloudflare WAF có rate-limiting theo response 401/403 và Durable Objects có alarm/`deleteAll()` để tự hết hạn. Nguồn: [C1], [S11]–[S13].

[supported] Token do host hiện tại sinh có 96 bit CSPRNG. Kể cả giả định phi thực tế một triệu thử/giây vào đúng session, thời gian kỳ vọng là khoảng `2^95 / 10^6` giây, xấp xỉ `1,25 × 10^15` năm; brute-force không phải đường tấn công thực tế. Tuy vậy OWASP khuyến nghị custom session ID tối thiểu 128 bit. Nguồn: [C4, dòng 50–53], [S15]; phép tính từ các giá trị này.

[supported] Endpoint `/register` chỉ kiểm tra token không rỗng rồi bind token đầu tiên; API không cưỡng chế độ dài/định dạng/entropy. Client chuẩn sinh token mạnh, nhưng server vẫn chấp nhận deployment/client lỗi với token như `x`. Nguồn: [C1, dòng 181–190, 239–249], [T1].

**Phán quyết:** tăng `session`, `token`, `secret` lên ít nhất 128 bit và reject credential không canonical/đủ dài tại Worker là **PHẢI**. Rate-limit auth failure ở edge là **NÊN**; không dùng một map IP vô hạn trong từng session DO làm tuyến phòng thủ duy nhất. Response-based 401/403 ở WAF là lựa chọn tốt khi gói Cloudflare hỗ trợ; nếu tự làm, bucket phải bị chặn kích thước và có TTL, đồng thời tính đến NAT, IPv6 và tấn công phân tán. Nguồn: [S11]–[S15]; phần kiến trúc là `[inference]`.

### 3.2 Session ID có đoán được không?

[supported] Session ID thật là base64url của 12 byte ngẫu nhiên, không phải mã 12 ký tự hiển thị trong terminal; mã hiển thị chỉ là nhãn rút gọn. Xác suất đoán session 96 bit là không thực tế. Nguồn: [C4, dòng 50–53, 104–106].

[inference] Session là routing handle, không nên được coi là secret duy nhất. Không cần chuyển toàn bộ session vào fragment hoặc che public HTML; cần nâng lên 128 bit để đồng bộ baseline, giữ auth token độc lập và không log fragment/header nhạy cảm. Nguồn: [C1], [S1], [S15].

[supported] “First token wins” cho `/register` có thể gây session squatting nếu session bị lộ trước lúc host đăng ký; luồng CLI bình thường đăng ký trước rồi mới in link, nên rủi ro thực tế thấp. Nguồn: [C1, dòng 239–249], [C6, dòng 1689–1743].

### 3.3 E2E downgrade: paired mode vẫn nhận plaintext

[verified] Đây là lỗ hổng integrity trực tiếp, nghiêm trọng hơn replay. Ở host, `decrypt()` chỉ gọi AES-GCM khi `opts.secret && isSealed(payload)`; nếu secret tồn tại nhưng payload không có dạng `{iv,ct}`, nhánh còn lại trả `String(payload)` và `drain()` chuyển chuỗi đó tới `handlers.run`. Một relay độc hại/bị chiếm quyền hoặc bên có bearer nhưng không có E2E secret vì vậy có thể forge command plaintext. Chấp nhận dữ liệu ngoài AEAD đồng nghĩa bỏ qua authentication mà GCM/RFC 5116 cung cấp. Nguồn: [C4, dòng 164–171, 179–207], [S17], [S18].

[supported] Cùng helper này xử lý `frame` và `control`, nên plaintext bắt đầu bằng `data:image/` có thể tới vision handler, còn JSON control có thể tới `handlers.control`. Các gate ID/state ở UI có thể làm một số control cũ vô hiệu, nhưng không sửa command-forgery ở `handlers.run`. Nguồn: [C4, dòng 281–293], [C6, dòng 2152–2184, 2252–2273].

[supported] Browser có downgrade đối xứng: khi key tồn tại, reply/presence/mirror chỉ được unseal nếu object có trường `iv`; nếu không, client nhận/render plaintext. Đường wrong-secret hiện còn cố ý phát reply lỗi plaintext. Nguồn: [C2, dòng 571–578, 958–980, 1070–1075], [C4, dòng 185–190].

**Bản vá P0:** nếu đã có secret, payload không phải sealed object hoặc GCM auth fail phải bị loại; chỉ cho plaintext trong một legacy mode được cấu hình rõ khi **không có secret**. Browser không được render plaintext như reply đã xác thực; lỗi pairing phải là trạng thái local/untrusted cố định, không phải nội dung tùy ý từ relay. Thêm test: paired host từ chối plaintext job/frame/control; paired client từ chối plaintext reply/presence/mirror; legacy no-secret vẫn hoạt động. Nguồn: [C2], [C4], [S17], [S18]; thiết kế bản vá là `[inference]`.

### 3.4 Replay

[verified] Đây là lỗ hổng thực tế. AES-GCM xác thực ciphertext nhưng tự nó không bảo đảm anti-replay; NIST và RFC 5116 đều yêu cầu protocol dùng sequence/timestamp/nonce semantics thích hợp, có thể xác thực qua AAD. Nguồn: [S17], [S18].

[supported] Envelope Neko chỉ có IV/ciphertext. Host không lưu message ID hay replay window trước khi chạy command; counter `jobId` trong Durable Object chỉ là routing server-side và không nằm trong dữ liệu E2E được xác thực. Relay độc hại hoặc bị chiếm quyền có thể lưu và gửi lại một command hợp lệ cũ. Nguồn: [C1, dòng 336–358], [C4, dòng 164–171], [C5].

[inference] Protocol v2 nên seal cả metadata `{v, direction, type, sessionHash, senderDeviceId, seq, issuedAt, expiresAt}` dưới AAD; mỗi sender có counter đơn điệu, receiver giữ highest-seq/sliding window và từ chối duplicate/out-of-window. Timestamp đơn lẻ không đủ vì clock skew; queue/reconnect cần window hữu hạn. Tách key theo hướng/type bằng KDF cũng giảm nhầm miền. Nguồn: [S17], [S18].

### 3.5 Revoke, expiry và pairing

[supported] `/revoke` hiện đóng host/mirror/client socket và `deleteAll()`, nên revoke toàn session hoạt động. `/relay new` gọi revoke rồi tạo pairing mới. Nguồn: [C1, dòng 296–301], [C4, dòng 115–127], [T1].

[supported] Không có `expiresAt`, idle timeout, alarm hoặc device identity trong Durable Object. Pairing file host và token/secret browser được giữ qua restart vô thời hạn cho tới khi người dùng chủ động xoay/xóa. Nguồn: [C1], [C2, dòng 339–373], [C4, dòng 55–102].

[supported] Nút `unpair` chỉ quên capability trên điện thoại hiện tại; nó không vô hiệu hóa capability đã sao chép hay thiết bị khác. Đây là khác biệt UX nguy hiểm giữa “quên trên máy này” và “thu hồi quyền”. Nguồn: [C2, dòng 637–651], [S1], [S6]–[S10].

[inference] Thiết kế đích: link trong fragment là **enrollment token dùng một lần, hết hạn khoảng 10 phút**; sau xác nhận host, server cấp bearer theo `deviceId`, host/device dẫn xuất hoặc trao E2E key theo thiết bị; có danh sách `lastUsed`, expiry/inactivity và revoke từng thiết bị. Thời lượng chính xác phải theo use case, nhưng không nên biến shared bearer hiện tại thành “24 giờ rồi hết” mà vẫn dùng chung. Nguồn: [S1], [S6]–[S10], [S13].

### 3.6 `localStorage`, điện thoại mất/mượn và WebAuthn

[verified] Client lưu bearer, E2E secret và tối đa 50 lượt transcript plaintext theo host trong origin-wide `localStorage`; camera cũng lưu token/secret. Mọi script cùng origin đọc được, dữ liệu sống qua phiên browser, và điện thoại đã mở khóa cho người cầm máy cả lịch sử lẫn quyền điều khiển. OWASP khuyến nghị không để session identifier/sensitive data trong localStorage vì XSS và thiếu bảo đảm confidentiality-at-rest. Nguồn: [C2, dòng 339–373, 998–1006], [C3, dòng 66–78], [S15], [S16].

[inference] Mức tối thiểu phải làm: mặc định session-only hoặc hỏi “Ghi nhớ trên thiết bị này”; không lưu transcript plaintext mặc định; cảnh báo thiết bị dùng chung; nút “Khóa/Quên thiết bị”; và kill switch từ host để revoke thiết bị mất. `HttpOnly` cookie không thể tự giữ E2E secret mà JavaScript cần dùng, nên cần thiết kế wrapping/worker isolation thay vì đổi storage API máy móc. Nguồn: [C2], [S3], [S15], [S16].

[supported] WebAuthn Level 3 có extension PRF tùy chọn để dẫn xuất vật liệu khóa phía client. Nó phù hợp làm “khóa thiết bị” để wrap credential khi browser/OS hỗ trợ, nhưng WebAuthn authentication đơn thuần không bảo vệ một secret vẫn nằm thô trong localStorage; cần recovery và fallback. Nguồn: [S19].

[inference] Bước hardening dài hạn có thể học CryptPad: tách origin/UI sandbox và giữ secret trong worker/outer context; dùng non-extractable `CryptoKey` hoặc WebAuthn-PRF wrapping. Cách này giảm exfiltration trực tiếp nhưng không làm JavaScript cùng origin đã bị chiếm quyền trở nên đáng tin. Nguồn: [S3], [S16], [S19].

## 4. Camera: consent, indicator và disclosure

[supported] Trang hiện tại chỉ gọi `getUserMedia({video, audio:false})` sau khi người dùng bấm Start, có preview và nút Stop dừng tracks. Đây là nền tảng consent tốt; browser cũng phải cung cấp indicator quyền/capture ở cấp user agent. Nguồn: [C3, dòng 42–62, 112–125, 171–179], [S20].

[verified] Copy hiện tại nói ảnh “chỉ máy Neko của bạn đọc được” là sai về biên dữ liệu: host giải mã ảnh rồi `describeImage` có thể gửi ảnh tới vision provider cấu hình. EDPB yêu cầu disclosure nêu truyền cho bên thứ ba nếu có; Google Play cũng dùng chuẩn prominent disclosure về loại dữ liệu, cách dùng/chia sẻ trước permission. Nguồn: [C3, dòng 44–50], [C6, dòng 2152–2180], [S21], [S23].

[supported] Không có handler `visibilitychange`, `pagehide` hay `freeze`; capture interval chỉ dừng khi người dùng bấm Stop hoặc trang bị browser kết thúc. Do đó trạng thái tab ẩn/khóa màn hình không được ứng dụng xử lý rõ ràng. Nguồn: [C3].

[verified] W3C yêu cầu browser xin phép và thể hiện capture/access; Apple App Review 2.5.14 yêu cầu app có explicit consent cùng chỉ báo hình/âm rõ khi ghi hoặc tạo bản ghi hoạt động. Apple là benchmark sản phẩm cho app, không trực tiếp biến thành nghĩa vụ App Store đối với trang web. Nguồn: [S20], [S22].

[supported] GDPR/EDPB không tạo một quy tắc phổ quát “web camera phải có chấm đỏ”. Nghĩa vụ phụ thuộc controller, mục đích, cơ sở pháp lý, phạm vi và household exemption; EDPB nhấn mạnh purpose cụ thể, minimization, thông báo dễ thấy trước vùng bị giám sát, bên nhận và retention. Nguồn: [S21].

**PHẢI sửa UI camera:**

- Trước permission, hiển thị: “Neko chụp một JPEG khoảng mỗi 1,6 giây để coaching; Worker chỉ chuyển ciphertext/metadata và không queue frame; máy Neko giải mã; vision provider `<tên>` có thể nhận ảnh theo chính sách của provider; âm thanh tắt.” Nguồn: [C1, dòng 360–370], [C3], [C6].
- Khi chạy, giữ nhãn thường trực “CAMERA ĐANG GỬI ẢNH”, cadence/lần gửi cuối và nút Stop luôn thấy; không chỉ đổi màu nút. Nguồn chuẩn sản phẩm: [S20], [S22], [S23].
- Dừng interval, tracks và request đang chờ khi `visibilitychange:hidden`, `pagehide`/`freeze`; trở lại phải bấm Start lại. Nguồn: [C3], [S20], [S23].
- Nhắc người dùng xin phép người khác/bystander khi họ có thể lọt vào khung; legal text chi tiết phụ thuộc nơi triển khai. Nguồn: [S21].

## 5. Xếp hạng theo tác động

| Mức | Việc | Lý do/tiêu chí hoàn tất | Nguồn |
|---|---|---|---|
| PHẢI — P0 | Từ chối plaintext trong paired/E2E mode | Host không chạy plaintext job/frame/control; browser không render plaintext reply/presence/mirror; legacy chỉ khi không có secret. | [C2], [C4], [S17], [S18] |
| PHẢI — P0 | Sửa disclosure camera, indicator và auto-stop nền | Loại bỏ mô tả sai về vision provider; không capture khi người dùng không còn nhìn trang. | [C3], [C6], [S20]–[S23] |
| PHẢI — P0 | Protocol E2E v2 chống replay | Duplicate ciphertext bị từ chối; test replay, reorder, reconnect, expiry và hai hướng. | [C4], [C5], [S17], [S18] |
| PHẢI — P0 | Cưỡng chế capability ≥128 bit | Generator dùng ít nhất 16 byte; Worker reject token/session không canonical hoặc quá ngắn; test weak register. | [C1], [C4], [S15] |
| PHẢI — P1 | Pairing một lần/ngắn hạn, credential theo thiết bị | Có expiry/alarm, device list, last-used, revoke từng thiết bị và kill switch máy mất. | [C1], [C2], [S1], [S6]–[S13] |
| PHẢI — P1 | Sửa persistence mặc định | “Remember device” là lựa chọn rõ; transcript không plaintext mặc định; shared-device warning/lock. | [C2], [C3], [S15], [S16] |
| NÊN | Rate-limit auth failure ở edge | Chống abuse/DoS; ưu tiên WAF response-based 401/403, không map IP vô hạn trong DO. | [C1], [S11]–[S13] |
| NÊN | Organization profile với Cloudflare Access | Identity/IdP, deny-by-default, session hữu hạn; vẫn giữ E2E và anti-replay. | [S8]–[S10] |
| NÊN | Version/AAD, directional keys, audit metadata | Giảm protocol confusion; log counter/lý do auth fail nhưng không log bearer, WS subprotocol hay fragment. | [C1], [C5], [S17], [S18] |
| NÊN | `X-Robots-Tag`/`robots.txt` cho route pairing | Giảm index/crawl metadata; không thay auth. | [S1] |
| NÊN | WebAuthn PRF/non-extractable key cho “Lock device” | Bảo vệ at-rest tốt hơn khi có hỗ trợ và recovery. | [S16], [S19] |
| KHÔNG CẦN | Bắt đăng nhập cho mọi personal relay | Capability mode vẫn hợp lệ nếu có entropy, expiry, revoke và UX chia sẻ đúng. | [S1]–[S7] |
| KHÔNG CẦN | Giấu hoặc chặn tải public HTML như bản vá chính | Trang shell public không cấp quyền; capability mới cấp quyền. | [C1], [S1]–[S4] |
| KHÔNG CẦN | Đổi AES-GCM chỉ vì tên “AES-256” | Primitive hiện tại có authentication; vấn đề chính là entropy/lifecycle/replay protocol. | [C5], [S17], [S18] |
| KHÔNG CẦN | Xem rate-limit per-IP trong từng DO là đủ | Không chặn distributed attack/session spray; dễ tạo state không giới hạn và false positive NAT. | [S11]–[S13]; kết luận kiến trúc `[inference]` |
| KHÔNG CẦN | Bắt buộc WebAuthn để relay chạy | PRF là optional và cần fallback; nó không thay expiry/revoke/anti-replay. | [S19] |

## Kết luận và việc cần làm

1. **Trong 0–2 ngày:** đóng plaintext downgrade ở cả host và browser; paired mode chỉ nhận authenticated sealed payload; thêm regression tests cho job/frame/control/reply/presence/mirror và giữ legacy rõ ràng chỉ khi không có secret. Nguồn: [C2], [C4], [S17], [S18].
2. **Trong 0–2 ngày:** sửa ngay text camera; công khai tên/loại vision provider tại thời điểm Start; thêm banner capture thường trực; dừng tracks/interval trên hidden/pagehide; thêm test lifecycle camera. Nguồn: [C3], [C6], [S20]–[S23].
3. **Trong 0–2 ngày:** đổi `randomBytes(12)` thành tối thiểu `randomBytes(16)` cho session/token/secret; Worker validate canonical base64url/độ dài ở `/register` và route; bổ sung test token yếu/session sai. Nguồn: [C1], [C4], [S15].
4. **Trước release kế tiếp:** phát hành envelope v2 có version/direction/type/device/sequence/freshness trong AAD; host/client giữ replay window; giữ đường migrate v1 ngắn hạn rồi tắt v1. Nguồn: [C4], [C5], [S17], [S18].
5. **Trước khi quảng bá là org/lab-ready:** tách enrollment link khỏi device credential; enrollment một lần và khoảng 10 phút; DO alarm dọn pairing; device list/revoke riêng; `/relay new` vẫn là emergency revoke-all. Nguồn: [C1], [C2], [S1], [S6]–[S13]; thời lượng 10 phút là đề xuất `[inference]`.
6. **Trước khi quảng bá là org/lab-ready:** đổi persistence sang opt-in “Ghi nhớ thiết bị”; bỏ transcript plaintext mặc định; thêm lock/forget và cảnh báo thiết bị dùng chung; nghiên cứu WebAuthn PRF wrapping sau khi có fallback/recovery. Nguồn: [C2], [C3], [S15], [S16], [S19].
7. **Hardening vận hành:** thêm edge rate limit cho 401/403, register/WS/request volume; metrics không chứa secret; `X-Robots-Tag`; profile Cloudflare Access cho tổ chức. Nguồn: [S1], [S8]–[S13].
8. **Không tốn công vào bản vá giả:** không biến public HTML thành private chỉ để tạo cảm giác an toàn; không xem timing-safe compare hay CAPTCHA là thay thế cho strict E2E/entropy/lifecycle; không bắt WebAuthn trước khi sửa downgrade/replay/revoke. Nguồn: [S1], [S14], [S15], [S17]–[S19].

Sau các mục 1–6 và test đối kháng tương ứng, mô hình có thể được mô tả chính xác là: **capability-based, E2E-sealed relay với strict authenticated payloads, enrollment hữu hạn và quyền theo thiết bị**. Trước đó, mô tả phù hợp hơn là **personal experimental relay có content confidentiality trong luồng honest-client nhưng chưa có strict E2E integrity, lifecycle và replay protection hoàn chỉnh**. Nguồn: tổng hợp [C1]–[C6], [S1]–[S23].

## Giới hạn và câu hỏi mở

- [open] Chưa kiểm tra cấu hình Cloudflare account/WAF/logging thực tế; do đó chưa kết luận header `Authorization` hoặc `Sec-WebSocket-Protocol` có bị lưu trong sản phẩm log nào đang bật. Cần audit cấu hình triển khai, không suy từ source Worker. Nguồn phạm vi đã kiểm tra: [C1], [S11], [S12].
- [open] Chưa có threat model chính thức về mức độ relay operator được tin cậy. Nếu operator được tin cậy hoàn toàn, replay có xác suất thấp hơn; nhưng tuyên bố “blind/E2E relay” hợp lý phải chịu được relay độc hại đối với confidentiality và command freshness. Nguồn cho khoảng trống protocol: [C1], [C5], [S17], [S18].
- [open] Thời hạn enrollment/device/inactivity cuối cùng cần dữ liệu UX và deployment profile; con số 10 phút là điểm khởi đầu, không phải tiêu chuẩn bắt buộc. Nguồn so sánh: [S1], [S7]–[S10].
- [open] Tuân thủ GDPR/luật camera cụ thể cần xác định controller, quốc gia, mục đích, người trong khung và chính sách retention của vision provider. Nguồn: [S21].

## Nguồn mã và test

- [C1] [`cloudflare/relay/worker.js`](../../cloudflare/relay/worker.js), trạng thái repo được đọc ngày 29/07/2026.
- [C2] [`cloudflare/relay/client.html`](../../cloudflare/relay/client.html), trạng thái repo được đọc ngày 29/07/2026.
- [C3] [`cloudflare/relay/camera.html`](../../cloudflare/relay/camera.html), trạng thái repo được đọc ngày 29/07/2026.
- [C4] [`src/adapters/remote-relay.ts`](../../src/adapters/remote-relay.ts), trạng thái repo được đọc ngày 29/07/2026.
- [C5] [`src/adapters/relay-crypto.ts`](../../src/adapters/relay-crypto.ts), trạng thái repo được đọc ngày 29/07/2026.
- [C6] [`src/ui/chat.tsx`](../../src/ui/chat.tsx), các luồng `/relay` và camera, trạng thái repo được đọc ngày 29/07/2026.
- [T1] `test/relay-worker.test.ts`, `relay-crypto.test.ts`, `remote-relay.test.ts`, `relay-client.test.ts`, đọc ngày 29/07/2026. Test hiện có bao phủ auth/revoke/giới hạn/tamper và happy-path E2E, nhưng chưa có paired-mode plaintext rejection, replay, TTL, rate-limit hoặc camera lifecycle.

## Nguồn ngoài

- [S1] W3C, [Good Practices for Capability URLs](https://www.w3.org/TR/capability-urls/), First Public Working Draft, 02/10/2017; truy cập 29/07/2026.
- [S2] CryptPad, [Developer Guide — General information](https://docs.cryptpad.org/en/dev_guide/general.html), docs 2026.5.0, trang không nêu ngày; truy cập 29/07/2026.
- [S3] CryptPad, [Security](https://docs.cryptpad.org/en/user_guide/security.html), docs 2026.5.0, trang không nêu ngày; truy cập 29/07/2026.
- [S4] Excalidraw, source tại commit [`1acf66e`](https://github.com/excalidraw/excalidraw/commit/1acf66edabc2ac5bbd4aed0714aed7dca7cc2aab), 28/07/2026; các file [room link](https://github.com/excalidraw/excalidraw/blob/1acf66edabc2ac5bbd4aed0714aed7dca7cc2aab/excalidraw-app/data/index.ts), [encryption](https://github.com/excalidraw/excalidraw/blob/1acf66edabc2ac5bbd4aed0714aed7dca7cc2aab/packages/excalidraw/data/encryption.ts), [constants](https://github.com/excalidraw/excalidraw/blob/1acf66edabc2ac5bbd4aed0714aed7dca7cc2aab/packages/common/src/constants.ts); truy cập 29/07/2026.
- [S5] Jitsi, [Security](https://jitsi.org/security/), n.d.; và [Token Authentication](https://jitsi.github.io/handbook/docs/devops-guide/token-authentication/), cập nhật 14/07/2026; truy cập 29/07/2026.
- [S6] Signal Support, [Group Link or QR-code](https://support.signal.org/hc/en-us/articles/360051086971-Group-Link-or-QR-code), n.d.; truy cập 29/07/2026.
- [S7] Signal Support, [Create and share call links](https://support.signal.org/hc/en-us/articles/7860719423002-How-to-create-and-share-call-links), n.d.; truy cập 29/07/2026.
- [S8] Cloudflare, [Service tokens](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/), cập nhật 09/07/2026; truy cập 29/07/2026.
- [S9] Cloudflare, [Session management](https://developers.cloudflare.com/cloudflare-one/access-controls/access-settings/session-management/), cập nhật 06/05/2026; truy cập 29/07/2026.
- [S10] Cloudflare, [Self-hosted public applications](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/), cập nhật 17/04/2026; truy cập 29/07/2026.
- [S11] Cloudflare, [Rate limiting rules](https://developers.cloudflare.com/waf/rate-limiting-rules/), cập nhật 22/04/2026; truy cập 29/07/2026.
- [S12] Cloudflare, [Rate limiting best practices](https://developers.cloudflare.com/waf/rate-limiting-rules/best-practices/), cập nhật 05/05/2026; truy cập 29/07/2026.
- [S13] Cloudflare, [Durable Object alarms](https://developers.cloudflare.com/durable-objects/api/alarms/) và [TTL example](https://developers.cloudflare.com/durable-objects/examples/durable-object-ttl/), cập nhật 21/04/2026; truy cập 29/07/2026.
- [S14] Cloudflare, [Workers Web Crypto — `timingSafeEqual`](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/), cập nhật 23/04/2026; truy cập 29/07/2026.
- [S15] OWASP, [Session Management Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html), trang không nêu ngày; truy cập 29/07/2026.
- [S16] OWASP, [HTML5 Security Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/HTML5_Security_Cheat_Sheet.html), trang không nêu ngày; truy cập 29/07/2026.
- [S17] NIST, [SP 800-38D — GCM and GMAC](https://nvlpubs.nist.gov/nistpubs/Legacy/SP/nistspecialpublication800-38d.pdf), 11/2007, Appendix D; truy cập 29/07/2026.
- [S18] IETF, [RFC 5116 — An Interface and Algorithms for Authenticated Encryption](https://www.rfc-editor.org/rfc/rfc5116.html), 01/2008; truy cập 29/07/2026.
- [S19] W3C, [Web Authentication Level 3](https://www.w3.org/TR/webauthn-3/), Candidate Recommendation Snapshot, 26/05/2026; truy cập 29/07/2026.
- [S20] W3C, [Media Capture and Streams](https://www.w3.org/TR/mediacapture-streams/), Candidate Recommendation Draft, 09/10/2025; truy cập 29/07/2026.
- [S21] EDPB, [Guidelines 3/2019 on processing personal data through video devices](https://www.edpb.europa.eu/documents/guideline/guidelines-32019-on-processing-of-personal-data-through-video-devices_en), final 30/01/2020, PDF version 2.1 ngày 26/02/2020; truy cập 29/07/2026.
- [S22] Apple, [App Review Guidelines §2.5.14](https://developer.apple.com/app-store/review/guidelines/), cập nhật 08/06/2026; truy cập 29/07/2026.
- [S23] Google Play, [User Data — prominent disclosure and consent](https://support.google.com/googleplay/android-developer/answer/10144311?hl=en-gb), trang chính sách sống không nêu ngày phát hành; truy cập 29/07/2026.

## Checkpoint 2026-07-29

- [verified] Pattern capability URL + fragment E2E là hợp lệ, nhưng không tự tạo ra org/lab-grade security. Confidence: high. Nguồn: [C1]–[C6], [S1]–[S10].
- [verified] Plaintext downgrade/forgery là khoảng trống P0 cao nhất; tiếp theo là anti-replay, lifecycle/revoke theo thiết bị và disclosure camera. Confidence: high. Nguồn: [C1]–[C6], [S17]–[S23].
- [supported] 96-bit CSPRNG không tạo nguy cơ brute-force thực tế, nhưng thấp hơn baseline 128-bit cho custom session và server không cưỡng chế token mạnh. Confidence: high. Nguồn: [C1], [C4], [S15].
- [supported] `localStorage` hiện biến điện thoại đã mở khóa/XSS cùng origin thành quyền điều khiển cộng transcript plaintext. Confidence: high. Nguồn: [C2], [C3], [S15], [S16].
- Tradeoff: giữ personal mode không tài khoản để bảo toàn UX, nhưng capability phải hữu hạn, theo thiết bị và có revoke rõ; org mode thêm Cloudflare Access thay vì làm personal mode nặng nề. Nguồn: [S1], [S5]–[S10].
