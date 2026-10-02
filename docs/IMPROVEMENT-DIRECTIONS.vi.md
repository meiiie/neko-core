# Định hướng cải thiện Neko Core

Tài liệu này chuyển các ý tưởng nghiên cứu về tool calling, context engineering,
reasoning và đánh giá agent thành những hướng có thể kiểm chứng cho Neko Core. Đây
là **đề xuất thử nghiệm**, không phải cam kết tính năng hay mô tả hành vi đã phát hành.

Trạng thái và ưu tiên đang thực hiện vẫn thuộc về [roadmap](process/ROADMAP.md).
Các hợp đồng hiệu năng, cache và bằng chứng hoàn thành nằm trong
[hướng dẫn hiệu quả harness](process/EFFICIENCY.md); chính sách đánh giá nằm trong
[evaluation policy](process/EVALUATION.md).

## Nguyên tắc

- Đo chất lượng và độ tin cậy cùng với token, chi phí và độ trễ. Ít token hơn không
  tự động có nghĩa là tốt hơn.
- Mọi thao tác làm thay đổi trạng thái phải tiếp tục đi qua `ToolRegistry`, permission
  gate, seatbelt và cơ chế checkpoint hiện hành.
- Ưu tiên cấu hình/profile cho model và endpoint tương thích; không biến danh sách model,
  quota miễn phí hay giá của một nhà cung cấp thành giả định cố định trong core.
- Thay đổi mặc định chỉ sau khi có regression tất định và bằng chứng lặp lại phù hợp
  với loại tuyên bố.
- Bài báo, bản tin và kết quả của một lần chạy là giả thuyết hoặc đầu vào nghiên cứu;
  chúng không thay thế nguồn chính thức, code, test hay hợp đồng trong repo.

## Các hướng đề xuất

### 1. Tool chaining: thử batch có giới hạn, không chạy code tùy ý

Neko đã có schema tool tường minh, phân loại quyền và `ToolRegistry`. Agent cũng có
thể thực thi sớm hoặc chạy song song một số thao tác đọc an toàn. Vì vậy, lợi ích cần
tìm kiếm là giảm lượt gọi không cần thiết trong chuỗi thao tác, không phải bỏ qua
ranh giới tool hiện có.

Nếu đo được một khoảng trống cụ thể, có thể thử một **kế hoạch thao tác khai báo có
schema và giới hạn**. Mỗi bước chỉ gọi một tool Neko được cho phép; kết quả có thể
được tham chiếu ở bước sau theo quy tắc rõ ràng. Không đánh giá Python/JavaScript do
model sinh ra bằng `eval`, `exec` hoặc một subprocess có quyền host làm đường thực thi
tool thay thế. Cách đó sẽ làm mờ permission, audit và kết quả chưa xác định.

Điều kiện cho một thử nghiệm:

- Mọi bước đều qua cùng một registry và kiểm tra quyền trước khi thực thi.
- Giới hạn số bước, fan-out, kích thước input/output, thời gian và hủy lượt.
- Ghi checkpoint theo từng effect; không tự phát lại mutation có kết quả chưa xác định.
- Chỉ áp dụng trước cho tác vụ đọc độc lập; mutation vẫn phải giữ đúng xác nhận và thứ
  tự hiệu ứng hiện hành.
- So sánh số provider calls, thời gian, kết quả tác vụ và lỗi so với đường chạy hiện tại.

Điểm bắt đầu để khảo sát: `src/core/tools.ts`, `src/core/tool-runtime.ts`,
`src/core/agent.ts` và `src/core/agent-constants.ts`.

### 2. Context engineering và prompt caching: tối ưu bằng phép đo

Neko đã tách phần prompt nền, session context và turn context; một số adapter hỗ trợ
cache theo giao thức của provider. `/cost` và efficiency diagnostics cũng đã có số
liệu runtime. Hướng tiếp theo là kiểm tra liệu thay đổi thứ tự hoặc nội dung prefix
có làm tăng cache hit trong workload thật mà vẫn cập nhật đúng trạng thái project,
tools và policy hay không.

Đề xuất đo trên các tác vụ cố định, phân biệt cache lạnh và cache ấm, và ghi nhận usage
do provider trả về, số request, retry, độ trễ và kết quả cuối. Prefix-change không tự
nó chứng minh cache hit hay cache miss. Không đưa các con số tiết kiệm chung từ một
nguồn bên ngoài thành cam kết cho Neko.

Tham khảo hợp đồng hiện tại: [Harness efficiency](process/EFFICIENCY.md) và
`src/core/efficiency.ts`.

### 3. Reasoning và chọn model: giữ lựa chọn rõ ràng cho người dùng

Neko đã chuyển reasoning effort qua provider port, có thể đối chiếu với năng lực model
được quảng bá, và hỗ trợ profile cấu hình. `adaptive_effort` hiện là lựa chọn cấu hình,
không phải mặc định bắt buộc.

Có thể đánh giá effort/profile theo nhóm tác vụ: thao tác cơ học, coding nhiều bước,
và tác vụ cần xác minh chặt. Nếu bổ sung định tuyến nhanh/chuyên sâu, nên đặt sau một
cấu hình opt-in có thể kiểm tra: nêu profile được chọn và lý do, giữ nguyên billing
route người dùng chọn, không âm thầm đổi API key, tài khoản OAuth hay nhà cung cấp.
So sánh chất lượng, chi phí và độ trễ trước khi đề xuất thay đổi mặc định.

### 4. Đánh giá agent: validator tất định trước, judge LLM là phụ trợ

LLM-as-a-Judge có thể dao động hoặc thiên lệch theo thứ tự và độ dài câu trả lời. Với
kết quả kiểm tra được bằng test, artifact, checksum hay điều kiện logic, dùng validator
tương ứng làm căn cứ chính. Judge LLM có thể giải thích hoặc phân loại trường hợp khó,
nhưng không nên biến một nhận xét đơn lẻ thành bằng chứng chất lượng.

Với so sánh cần phán đoán chủ quan, đóng băng task và ngân sách trước; ẩn danh/đảo thứ
tự các phương án; chạy nhiều replicate và báo bất định. Tách lỗi hạ tầng khỏi kết quả
của agent. Giữ nguyên [evaluation policy](process/EVALUATION.md); ProgramBench vẫn
tạm dừng cho đến khi chủ sở hữu yêu cầu tiếp tục.

### 5. Provider và endpoint miễn phí: coi quota là dữ liệu dễ hết hạn

Endpoint miễn phí hữu ích cho phát triển và thử nghiệm, nhưng model, giới hạn request,
điều khoản và chất lượng có thể đổi nhanh. Cấu hình chúng qua profile hoặc endpoint
tương thích; lưu thông tin xác thực trong vùng cấu hình riêng hoặc biến môi trường.
Không đặt key thật, quota giả định hay tên model nhất thời vào source, prompt mặc định
hoặc tài liệu ổn định của sản phẩm.

Trước khi công bố hướng dẫn cho một route, kiểm tra tài liệu nhà cung cấp hiện hành,
phân biệt rõ subscription với API billing, rồi xác nhận bằng `doctor`, catalog/model
metadata và một smoke test có ngân sách giới hạn.

## Thứ tự triển khai khuyến nghị

1. **Lập baseline trước:** chọn tác vụ đại diện và ghi lại pass/fail, provider calls,
   cache usage, retries, chi phí và latency theo hợp đồng đo hiện hành.
2. **Thử một thay đổi nhỏ:** ưu tiên cải thiện chẩn đoán cache/effort hoặc batch các
   thao tác đọc an toàn; chỉ thay một biến trong mỗi so sánh.
3. **Bảo vệ ranh giới:** thêm regression cho quyền, giới hạn tài nguyên, hủy, checkpoint
   và `unknown_outcome` trước khi bật cho người dùng.
4. **Quyết định bằng bằng chứng:** chỉ mở rộng khi chất lượng không giảm ngoài biên
   chấp nhận đã xác định và lợi ích hiệu năng lặp lại được. Nếu chưa đủ bằng chứng,
   giữ thử nghiệm ở trạng thái opt-in hoặc dừng.

Không chạy campaign có chi phí, không bật `scripts/self-improve.ts` như kiểm tra thường
lệ và không tiếp tục ProgramBench nếu chưa có yêu cầu rõ ràng của chủ sở hữu.

## Tài liệu và điểm vào liên quan

- [Harness architecture](HARNESS-ARCHITECTURE.md) — luồng agent, context, tools và
  persistence.
- [Ports and adapters](process/ARCHITECTURE.md) — dependency và trust boundaries.
- [Harness efficiency](process/EFFICIENCY.md) — cache, diagnostics và yêu cầu đo hiệu năng.
- [Evaluation policy](process/EVALUATION.md) — điều kiện cho benchmark và tuyên bố chất lượng.
- [Extending Neko](EXTENDING.md) — mở rộng provider, tools, skills và MCP.
