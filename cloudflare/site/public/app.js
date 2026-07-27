/*
 * Neko Core site behaviour: language, platform, install tabs, copy.
 *
 * i18n: English lives in the MARKUP, Vietnamese in the dictionary below. A key-only system degrades to
 * empty elements for crawlers, reader mode and anyone with JavaScript off; this one degrades to English,
 * and a key with no translation falls back rather than blanking.
 */
(function () {
  "use strict";

  var VI = {
    "announce": "Phiên bản 0.17.1 có thêm Oracle — ý kiến thứ hai từ một mô hình khác.",
    "announce.link": "Nó làm gì",

    "nav.how": "Cách hoạt động",
    "nav.download": "Tải về",
    "nav.docs": "Tài liệu",
    "nav.cta": "Lấy Neko",

    "hero.eyebrow": "Tác tử lập trình chạy tại máy",
    "hero.h1": "Nó chạy trên máy bạn.<br>Và hỏi trước khi ra tay.",
    "hero.lead": "Một tác tử trong terminal biết đọc, sửa, chạy, duyệt web và ghi nhớ — với bất kỳ mô hình nào, kể cả mô hình chạy ngoại tuyến ngay trên phần cứng của bạn.",
    "copy": "Chép",
    "hero.download": "Tải cho",
    "hero.other": "Nền tảng khác",
    "hero.trust": "Miễn phí vĩnh viễn · giấy phép MIT · Windows, macOS và Linux · không cần tài khoản",

    "s1.label": "Phê duyệt",
    "s1.title": "Nó hỏi trước khi chạm vào máy bạn.",
    "s1.body": "Neko xếp những công cụ chỉ nhìn vào một nhóm, và những công cụ làm thay đổi thứ gì đó vào nhóm khác. Nhóm đầu chạy ngay. Nhóm sau chờ bạn, và ranh giới giữa hai nhóm được in ra bởi một lệnh bạn tự chạy được.",
    "s1.f1.t": "Đọc thì chạy ngay, ghi thì chờ duyệt",
    "s1.f1.d": "<code>read_file</code>, <code>search</code>, <code>glob</code> và <code>ls</code> chạy tức thì. <code>write_file</code>, <code>edit</code> và <code>bash</code> chờ bạn đồng ý.",
    "s1.f2.t": "Quyền tự chủ có tên gọi",
    "s1.f2.d": "Tắt phê duyệt là một chế độ bạn chủ động bước vào, và chân phiên làm việc hiển thị nó suốt thời gian còn bật.",
    "s1.f3.t": "Kiểm chứng được, không phải lời hứa",
    "s1.f3.d": "<code>neko policy</code> dựng lại ranh giới từ mã nguồn và thoát với mã lỗi khi có gì đó lệch đi.",
    "s1.f4.t": "Hệ điều hành giữ hộ",
    "s1.f4.d": "Bash chạy trong sandbox thật trên những nền tảng có hỗ trợ. Đường dẫn ra ngoài thư mục dự án bị từ chối ở mọi nơi.",
    "s1.panel": "KIỂM TOÁN QUYỀN",

    "s2.label": "Mô hình",
    "s2.title": "Thêm một mô hình chỉ là sửa một tệp.",
    "s2.body": "Neko nói chuyện với mọi endpoint tương thích OpenAI — dịch vụ đám mây, tài khoản công ty, hay một máy chủ mô hình chạy ngay trên cái máy trước mặt bạn. Cái cuối cùng chính là thứ giúp nó vẫn làm việc khi rút mạng.",
    "s2.panel": "MỘT PROFILE CHẠY NỘI BỘ",
    "s2.f1.t": "Thuê bao hoặc khoá API",
    "s2.f1.d": "ChatGPT, Claude, Gemini, Grok, Kimi và DeepSeek đăng nhập ngay trong ứng dụng. Mọi thứ khác chỉ cách một dòng base URL.",
    "s2.f2.t": "Hoặc không cần ai cả",
    "s2.f2.d": "Trỏ một profile vào llama.cpp hay Ollama là mọi byte ở lại trên phần cứng của bạn.",
    "s2.f3.t": "Đổi giữa chừng",
    "s2.f3.d": "<code>/provider</code> và <code>/model</code> đổi endpoint khi phiên đang chạy. Cuộc trò chuyện được mang theo.",
    "s2.f4.t": "Khoá vẫn là của bạn",
    "s2.f4.d": "Đọc từ biến môi trường khi một yêu cầu cần đến, để ngoài dự án, và không bao giờ in ra.",

    "s3.title": "Ý kiến thứ hai, từ một mô hình không có tay.",
    "s3.body": "Khi bí, Neko gửi được một lát cắt bạn chọn của dự án sang một mô hình mạnh hơn để hỏi ý. Mô hình đó không nhận công cụ nào, nên điều nhiều nhất nó làm được là trả lời. Đưa tay cho nó thì nó thành một tác tử thứ hai, tính tiền bạn hai lần cho cùng một ngữ cảnh.",
    "s3.f1.t": "Bạn thấy bản kê khai trước",
    "s3.f1.d": "Mọi tệp trong gói đều được liệt kê trước khi yêu cầu đi ra, và <code>--dry-run</code> dừng lại đúng ở đó.",
    "s3.f2.t": "Tệp chứa bí mật bị bỏ nguyên tệp",
    "s3.f2.d": "<code>.env</code>, khoá riêng tư và mọi thứ dưới <code>.neko-core/</code> không bao giờ lọt vào gói.",
    "s3.f3.t": "Mã của bạn tới nơi vẫn đọc được",
    "s3.f3.d": "Chỉ giá trị chuỗi giống khoá bị che, nên <code>process.env.API_KEY</code> tới tay oracle đúng như bạn đã viết.",
    "s3.f4.t": "Phải được phê duyệt",
    "s3.f4.d": "Gửi mã nguồn ra khỏi máy nằm sau đúng lời hỏi như khi chạy một lệnh shell.",
    "s3.panel": "CHẠY THỬ KHÔNG GỬI",

    "s4.label": "Mở rộng",
    "s4.title": "Một tệp Markdown dạy nó một nghề mới.",
    "s4.body": "Lập trình là việc Neko làm được ngay khi mở hộp, còn kỹ năng là cách nó học mọi việc khác. Viết hướng dẫn một lần vào một thư mục; Neko chỉ nạp khi công việc thực sự khớp, nên một thư viện rộng chẳng tốn gì để mang theo.",
    "s4.panel": "MỘT KỸ NĂNG",
    "s4.f1.t": "Kỹ năng",
    "s4.f1.d": "Mô tả một lần cách bạn muốn một việc được làm, lần sau gặp việc đó Neko tự tìm ra.",
    "s4.f2.t": "MCP",
    "s4.f2.d": "Máy chủ MCP nào cũng cắm vào được, và dự án đã có <code>.mcp.json</code> thì dùng luôn, không sửa gì.",
    "s4.f3.t": "Bộ nhớ",
    "s4.f3.d": "Quyết định sống qua nhiều phiên dưới dạng tệp thường, bạn mở, sửa hay xoá được.",
    "s4.f4.t": "Tác tử con",
    "s4.f4.d": "Giao một nhánh điều tra cho ngữ cảnh riêng của nó, để mạch chính vẫn dễ đọc.",

    "s5.label": "Năng lực",
    "s5.title": "Một công cụ cho cả vòng việc.",
    "c1.t": "Chế độ kế hoạch", "c1.d": "Neko trình bày cách làm, và mọi sửa đổi vẫn bị chặn cho tới khi bạn duyệt kế hoạch.",
    "c2.t": "Sửa nhiều tệp", "c2.d": "Refactor xuyên codebase, mỗi thay đổi hiện ra dạng diff trước khi vào.",
    "c3.t": "Tìm trong mã", "c3.d": "Dùng ripgrep khi máy bạn có, và bản dựng sẵn bên trong khi không có.",
    "c4.t": "Chạy lệnh", "c4.d": "Chạy build và test với timeout riêng từng lệnh, kèm chế độ nền cho việc dài.",
    "c5.t": "Truy cập web", "c5.d": "Tìm kiếm chạy được ngay không cần cấu hình, và một lệnh nâng nó lên SearXNG riêng.",
    "c6.t": "Cầu nối trình duyệt", "c6.d": "Dùng đúng một tab Chrome đã đăng nhập, với trạng thái đồng ý hiện ngay trên trang.",
    "c7.t": "Điều khiển máy", "c7.d": "Trên Windows: UI Automation, gõ Unicode, và một con trỏ riêng để yên chuột của bạn.",
    "c8.t": "Họp", "c8.d": "Ghi âm và gỡ băng sau khi bạn đồng ý. Âm thanh được xử lý tại máy bạn và ở lại đó.",
    "c9.t": "Tài liệu Office", "c9.d": "Tệp Word, Excel, PowerPoint được dựng, rồi mở ra kiểm chứng trước khi Neko coi là xong.",
    "c10.t": "Hook", "c10.d": "Chạy script của bạn quanh mỗi lần gọi công cụ. Hook chạy trước có quyền chặn một lần gọi.",
    "c11.t": "Phiên làm việc", "c11.d": "Được lưu, liệt kê và tiếp tục đúng tại điểm bạn rời đi.",
    "c12.t": "Ngữ cảnh dự án", "c12.d": "Đọc các tệp NEKO.md, AGENTS.md và CLAUDE.md kho mã của bạn đã có sẵn.",
    "c13.t": "Điều khiển từ điện thoại", "c13.d": "Lái một phiên đang chạy từ điện thoại qua kênh trung chuyển mã hoá đầu-cuối.",
    "c14.t": "Giọng nói", "c14.d": "Nói với Neko trong terminal, hoặc đọc chính tả thẳng vào dòng nhập.",
    "c15.t": "Chạy không giao diện", "c15.d": "<code>neko run</code> hợp với CI và script, còn <code>--loop</code> tự soát lại việc mình làm tới khi xong.",
    "c16.t": "Có đo đạc", "c16.d": "<code>neko bench lift</code> cho biết bao nhiêu phần kết quả đến từ bộ khung chứ không từ mô hình.",

    "s6.label": "Cài đặt",
    "dl.title": "Hai cách cài, cách nào cũng khoảng một phút.",
    "dl.body": "Neko phát hành dưới dạng một tệp chạy độc lập. Node, Bun, Python và tài khoản đều là những thứ bạn bỏ qua được.",
    "dl.recommended": "NÊN DÙNG",
    "dl.a.title": "Dán một dòng",
    "dl.a.body": "Bộ cài chọn đúng bản cho máy bạn, đặt <code>neko</code> vào PATH để terminal nào cũng tìm thấy, và lo việc cập nhật về sau.",
    "dl.a.help": "<b>Chưa từng dùng terminal?</b> Bấm Start, gõ <b>PowerShell</b>, mở lên, dán dòng lệnh ở trên rồi bấm Enter. Khi chạy xong, gõ <code>neko</code> và bấm Enter lần nữa.",
    "dl.b.title": "Hoặc lấy tệp về",
    "dl.b.body": "Vẫn là chương trình đó dưới dạng tệp tải thẳng, dành cho lúc bạn thích tự đặt tệp hơn là chạy một dòng lệnh.",
    "dl.b.button": "Tải cho",
    "dl.b.all": "Tất cả nền tảng và mã kiểm tra",
    "dl.get": "Tải",
    "dl.b.help": "<b>Hai điều nên biết trước.</b> Neko là chương trình chạy trong terminal, nên mở tệp ra bạn sẽ thấy một cửa sổ đầy chữ chứ không phải ứng dụng đồ hoạ — cửa sổ đó chính là Neko. Và các bản dựng này chưa có chữ ký số, nên Windows sẽ hiện màn hình xanh \"ứng dụng không nhận dạng được\": chọn <b>More info</b>, rồi <b>Run anyway</b>.",
    "dl.foot": "Mọi bản dựng đều công bố trên GitHub kèm mã SHA-256, ra thẳng từ quy trình dựng công khai.",
    "dl.foot.link": "Tất cả bản phát hành",

    "foot.by": "Do The Wiii Lab xây dựng. Miễn phí, giấy phép MIT.",
    "foot.releases": "Bản phát hành",
    "foot.changelog": "Nhật ký thay đổi",
    "foot.security": "Bảo mật",
    "foot.sov": "Hoàng Sa và Trường Sa thuộc chủ quyền Việt Nam."
  };

  var TITLES = {
    en: "Neko Core — a coding agent that runs on your computer",
    vi: "Neko Core — tác tử lập trình chạy trên máy của bạn"
  };

  // English is read out of the markup, so the dictionary only holds the translation and nothing can
  // drift out of sync with the page it describes.
  var nodes = [].slice.call(document.querySelectorAll("[data-i18n]"));
  var EN = {};
  nodes.forEach(function (node) {
    var key = node.getAttribute("data-i18n");
    if (!(key in EN)) EN[key] = node.innerHTML;
  });

  var current = document.documentElement.lang === "vi" ? "vi" : "en";

  function apply(lang) {
    var dict = lang === "vi" ? VI : EN;
    nodes.forEach(function (node) {
      var key = node.getAttribute("data-i18n");
      var value = dict[key];
      node.innerHTML = value === undefined ? EN[key] : value; // untranslated stays English, never empty
    });
    document.documentElement.lang = lang;
    document.title = TITLES[lang];
    var button = document.getElementById("lang");
    if (button) button.textContent = lang === "vi" ? "EN" : "VI";
    current = lang;
  }

  apply(current);

  var langButton = document.getElementById("lang");
  if (langButton) {
    langButton.addEventListener("click", function () {
      apply(current === "vi" ? "en" : "vi");
      try { localStorage.setItem("neko-lang", current); } catch (e) { /* private mode */ }
    });
  }

  /* ---------- platform ---------- */
  var RELEASE = "https://github.com/meiiie/neko-core/releases/latest/download/";
  var PLATFORMS = {
    // Apple silicon cannot be told from Intel in a browser, so the default follows the overwhelmingly
    // likely case and the table directly beneath it carries the Intel build.
    windows: { name: "Windows", file: "neko-windows-x64.exe", size: "87 MB", row: "windows" },
    macos:   { name: "macOS",   file: "neko-macos-arm64",     size: "64 MB", row: "macos-arm64" },
    linux:   { name: "Linux",   file: "neko-linux-x64",       size: "81 MB", row: "linux-x64" }
  };

  function detect() {
    var hint = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || "";
    var agent = hint + " " + (navigator.userAgent || "");
    if (/mac|iphone|ipad|ipod/i.test(agent)) return "macos";
    if (/linux|android|cros/i.test(agent)) return "linux";
    return "windows";
  }

  var platform = PLATFORMS[detect()];
  [].forEach.call(document.querySelectorAll("[data-os-name]"), function (n) { n.textContent = platform.name; });
  [].forEach.call(document.querySelectorAll("[data-os-size]"), function (n) { n.textContent = platform.size; });
  [].forEach.call(document.querySelectorAll("#heroDownload, #mainDownload"), function (a) { a.href = RELEASE + platform.file; });
  var row = document.querySelector('tr[data-platform="' + platform.row + '"]');
  if (row) row.setAttribute("data-current", "");

  /* ---------- install tabs ---------- */
  [].forEach.call(document.querySelectorAll(".tabs"), function (tabs) {
    tabs.addEventListener("click", function (event) {
      var tab = event.target.closest(".tab");
      if (!tab) return;
      [].forEach.call(tabs.querySelectorAll(".tab"), function (other) {
        var selected = other === tab;
        other.setAttribute("aria-selected", String(selected));
        var panel = document.getElementById(other.getAttribute("aria-controls"));
        if (panel) panel.hidden = !selected;
      });
    });
  });
  if (platform !== PLATFORMS.windows) {
    [].forEach.call(document.querySelectorAll("#tab-sh, #tab2-sh"), function (tab) { tab.click(); });
  }

  /* ---------- copy ---------- */
  [].forEach.call(document.querySelectorAll(".copy"), function (button) {
    button.addEventListener("click", function () {
      navigator.clipboard.writeText(button.getAttribute("data-copy")).then(function () {
        var original = button.innerHTML;
        button.textContent = current === "vi" ? "Đã chép" : "Copied";
        setTimeout(function () { button.innerHTML = original; }, 1400);
      });
    });
  });
})();
