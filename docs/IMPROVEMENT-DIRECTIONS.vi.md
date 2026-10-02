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


### 6. Ưu tiên phiên dài: kết hợp quản lý ngữ cảnh và trí nhớ dài hạn

Trước khi tối ưu batch tool hay cache, ưu tiên kiểm chứng việc giữ đúng nhiệm vụ,
thông tin đã được sửa, nguồn bằng chứng và khả năng tiếp tục sau gián đoạn. Số lượt
hội thoại tự nó không chứng minh trí nhớ chính xác.

Hai hướng tham khảo bổ sung:

- [Context Language Models, v1 ngày 29/09/2026](https://arxiv.org/html/2609.37725v1):
  cho model chỉnh sửa ngữ cảnh đang sử dụng thay vì chỉ nối thêm hoặc tóm tắt định kỳ.
  [Bộ chuyển đổi context của mã tham khảo](https://github.com/facebookresearch/context-language-models/blob/18dc11115f50f261233c5bba7937834491e307e8/clm/clm_harness/context_utils/context_string.py)
  giữ phần system và nhiệm vụ ban đầu, nhưng không bảo toàn cấu trúc tool call sau
  khi tái dựng văn bản. Vì vậy không dùng bản ngữ cảnh chỉnh sửa làm nhật ký hiệu ứng.
  Suffix Cache Reuse cần hỗ trợ ở tầng phục vụ model; không thể giả định bật được
  bằng thay đổi trong client gọi API.
- [Hindsight](https://github.com/vectorize-io/hindsight) bổ sung hướng retain, recall,
  reflect và [truy hồi kết hợp](https://hindsight.vectorize.io/developer/retrieval).
  [Observations](https://hindsight.vectorize.io/developer/observations) gợi ý cách
  tổng hợp kiến thức có bằng chứng. Khi tích hợp, runtime phải quyết định bank và
  phạm vi; không coi tag do model cung cấp là quyền truy cập. Trong
  [mã lọc tag](https://github.com/vectorize-io/hindsight/blob/0be6c02b2aafc2b6bdb188ef1842ac507e0cfa2b/hindsight-api-slim/hindsight_api/engine/search/tags.py),
  các chế độ any/all có thể gồm dữ liệu không gắn tag trong cùng bank; cần lựa chọn
  phạm vi và kiểm thử rõ ràng cho từng đường truy hồi.

#### Thiết kế thử nghiệm cho Neko

Đây là định hướng, chưa phải hợp đồng tính năng đã triển khai:

1. **Bằng chứng gốc:** lưu sự kiện, nội dung nguồn và kết quả công cụ tách khỏi bản
   context model được chỉnh. Không biến bản tóm tắt thành bằng chứng rằng một
   mutation đã thành công.
2. **Ngữ cảnh làm việc:** thử một bản nhìn có thể chỉnh sửa, gắn với đúng task/root
   và phiên bản. Áp dụng bản sửa theo compare-and-swap; sửa trên phiên bản cũ phải bị
   từ chối. Giữ khả năng kiểm tra diff và hoàn tác bản nhìn.
3. **Giới hạn quyền sửa:** model có thể tổ chức nội dung làm việc, nhưng không tự
   đổi host authority, danh tính task, permission, kết quả công cụ gốc hoặc nâng
   dữ liệu bên ngoài thành chỉ dẫn của người dùng.
4. **Trí nhớ dài hạn:** phân biệt sự kiện, suy luận và thông tin đã bị thay thế;
   giữ nguồn, thời điểm và phạm vi áp dụng. Chia sẻ giữa task/project cần một
   đường chuyển giao tường minh, không trộn tự động theo độ giống ngữ nghĩa.
5. **Một lõi dùng chung:** logic thuộc Neko Core; Wiii trình bày nguồn, phạm vi,
   bản sửa và trạng thái phục hồi, không xây harness trí nhớ thứ hai.
6. **Gọn và tùy chọn:** không bắt mọi lần khởi động phải chờ database, embedding
   hay dịch vụ tổng hợp trí nhớ. Thử backend Hindsight qua adapter opt-in trước;
   công bố thêm chi phí vận hành và độ trễ của cả ghi, truy hồi và tổng hợp.

#### Tiêu chí kiểm chứng trước khi thay mặc định

- Cùng model, billing route, dữ liệu, token budget và điều kiện hạ tầng cho bốn
  cấu hình: baseline, context chỉnh sửa, memory backend, và kết hợp cả hai.
- Có bài kiểm tra trên 300 lượt với sửa thông tin nhiều lần, nhiễu, nén context,
  chuyển task, hai folder cùng tên, restart và gián đoạn giữa thao tác.
- Đo nhớ đúng dữ kiện mới nhất, thông tin lỗi thời bị dùng lại, truy hồi sai task,
  độ đúng của nguồn, xử lý khi chưa có dữ kiện và kết quả công việc cuối.
- Đo token/cache do provider báo, latency, số request, chi phí bổ sung cho memory
  và tính hoàn chỉnh của checkpoint. Không chuyển số FLOPs của nghiên cứu thành
  lời hứa giảm hóa đơn API.
- Nhật ký công cụ phải phân biệt hoàn tất, thất bại và chưa biết kết quả. Không
  tự phát lại effect chưa xác định chỉ vì context model nói cần làm tiếp.
- Tách kiểm thử lưu trữ tất định khỏi đánh giá model thật. Một bài chạy bị chặn
  mạng, hết quota hay thiếu phản hồi chưa được tính là đã hoàn thành.
- Đóng băng baseline, báo số lần lặp và các giới hạn. Không hứa “tuyệt đối không
  nhầm nhớ” chỉ từ một bộ kiểm thử hoặc một điểm benchmark.

Chỉ nâng thử nghiệm thành mặc định sau khi chất lượng và các ranh giới trên đạt
tiêu chí đã định. Các quy tắc tạm dừng ProgramBench, campaign trả phí và
self-improvement hiện hành vẫn áp dụng.

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
