/*
 * Neko Core site behaviour: language, platform, install tabs, copy.
 *
 * i18n design: English lives in the MARKUP, Vietnamese lives in the dictionary below. That way a
 * crawler, a reader-mode view, and anyone with JavaScript off still get a real page instead of empty
 * elements - which is what a key-only i18n system degrades to. A Vietnamese browser is switched on
 * load, and the choice is remembered.
 */
(function () {
  "use strict";

  var VI = {
    "announce": "Neko Core 0.17.1 đã ra - kèm Oracle, ý kiến thứ hai từ một mô hình khác.",
    "announce.link": "Xem thử &rarr;",

    "nav.capabilities": "Năng lực",
    "nav.download": "Tải về",
    "nav.docs": "Tài liệu",
    "nav.cta": "Tải về",

    "hero.marker": "TÁC TỬ LẬP TRÌNH CHẠY TẠI MÁY",
    "hero.tagline": "Nó chạy trên máy của bạn.",
    "hero.tagline2": "Và hỏi trước khi ra tay.",
    "hero.lede": "Một tác tử trong terminal biết đọc, sửa, chạy, duyệt web và ghi nhớ - với bất kỳ mô hình nào, kể cả mô hình chạy ngoại tuyến ngay trên máy bạn. Miễn phí, mã nguồn mở, và không bao giờ đụng vào tệp nào mà không báo bạn.",
    "hero.download": "Tải cho",
    "hero.terminal": "Cài bằng dòng lệnh",
    "hero.micro": "Miễn phí vĩnh viễn &middot; giấy phép MIT &middot; Windows, macOS, Linux &middot; không cần tài khoản",

    "s1.label": "AN TOÀN THEO MẶC ĐỊNH",
    "s1.title": "Nó hỏi trước khi chạm vào máy bạn.",
    "s1.body": "Phần lớn tác tử xin bạn tin tưởng chúng. Neko làm cho sự tin tưởng đó thành không cần thiết: công cụ có thể thay đổi thứ gì đó nằm ở một hạng khác với công cụ chỉ nhìn, và ranh giới ấy kiểm toán được chứ không phải một lời hứa.",
    "s1.p1": "<b>Đọc thì tự do, thay đổi thì không.</b> read, search, glob, ls chạy ngay; write, edit và bash phải chờ bạn.",
    "s1.p2": "<b>Quyền tự chủ là một trạng thái có tên.</b> Tắt phần duyệt là một chế độ khai báo rõ, không phải mặc định ẩn - và luôn hiển thị khi đang bật.",
    "s1.p3": "<b>Ranh giới được kiểm toán.</b> <code>neko policy</code> dựng lại nó từ mã nguồn và báo lỗi to nếu có lệch.",
    "s1.p4": "<b>Hệ điều hành giữ hộ.</b> Bash chạy trong sandbox thật ở nơi có hỗ trợ, và thoát khỏi thư mục dự án thì bị từ chối ở mọi nơi.",
    "s1.card": "KIỂM TOÁN QUYỀN",

    "s2.label": "MÔ HÌNH NÀO CŨNG ĐƯỢC, KỂ CẢ KHÔNG DÙNG CỦA AI",
    "s2.title": "Mô hình mới là một dòng cấu hình, không phải một bản phát hành.",
    "s2.body": "Neko nói chuyện được với mọi endpoint tương thích OpenAI. Bao gồm dịch vụ đám mây, tài khoản công ty của bạn, và một máy chủ mô hình chạy ngay trên máy bạn - đó mới là thứ khiến nó thực sự chạy được ngoại tuyến, chứ không phải chỉ quảng cáo là ngoại tuyến.",
    "s2.p1": "<b>Gói thuê bao hay API key.</b> ChatGPT, Claude, Gemini, Grok, Kimi, DeepSeek - hoặc bất kỳ endpoint nào bạn với tới được.",
    "s2.p2": "<b>Hoặc không cần ai cả.</b> Trỏ một profile vào llama.cpp hay Ollama là không một byte nào rời khỏi máy.",
    "s2.p3": "<b>Đổi giữa chừng.</b> <code>/provider</code> và <code>/model</code> đổi endpoint ngay lúc đang chạy; cuộc trò chuyện vẫn còn nguyên.",
    "s2.p4": "<b>Khoá vẫn là của bạn.</b> Đọc từ biến môi trường khi cần, không lưu trong dự án, không in ra.",
    "s2.card": "MỘT PROFILE CHẠY NỘI BỘ",
    "s2.note": "Chỉ có vậy. Không plugin, không build lại, không cần khoá.",

    "s3.title": "Ý kiến thứ hai - từ một mô hình không có tay.",
    "s3.body": "Khi Neko bí, nó gửi được một lát cắt có chọn lọc của dự án sang một mô hình khác, mạnh hơn. Mô hình đó không có công cụ nào: nó tư vấn, không hành động. Nếu người cố vấn cũng có tay thì nó chỉ là một tác tử thứ hai, và bạn trả tiền hai lần cho cùng một ngữ cảnh.",
    "s3.p1": "<b>Không có gì lặng lẽ rời máy.</b> Bản kê khai những gì sắp gửi luôn in ra trước. <code>--dry-run</code> thì không gửi gì cả.",
    "s3.p2": "<b>Bí mật bị từ chối, không phải cắt bớt.</b> Tệp chứa khoá bị bỏ nguyên tệp; chuỗi giống khoá thì bị che tại chỗ.",
    "s3.p3": "<b>Mã của bạn vẫn đọc được.</b> Chỉ giá trị chuỗi bị đụng tới, nên <code>process.env.API_KEY</code> còn nguyên - che nó là làm hỏng đúng thứ bạn nhờ đọc.",
    "s3.p4": "<b>Phải được duyệt.</b> Neko không tự ý hỏi được. Gửi mã nguồn ra khỏi máy có cùng mức rào với chạy một lệnh shell.",
    "s3.card": "CHẠY THỬ KHÔNG GỬI",

    "s4.label": "TUỲ BẠN NẶN",
    "s4.title": "Một tệp Markdown là đủ để dạy nó một nghề mới.",
    "s4.body": "Neko mở hộp ra là một tác tử lập trình, nhưng nó không bị giới hạn ở lập trình. Một kỹ năng chỉ là một thư mục có tệp Markdown; Neko chỉ nạp toàn bộ hướng dẫn khi công việc thực sự khớp, nên mở rộng bao nhiêu cũng không tốn ngữ cảnh.",
    "s4.p1": "<b>Kỹ năng.</b> Viết một lần cách bạn muốn một việc được làm. Lúc gặp việc đó Neko tự tìm ra.",
    "s4.p2": "<b>MCP.</b> Máy chủ MCP nào cũng cắm vào được; tệp <code>.mcp.json</code> sẵn có của dự án dùng luôn, không sửa gì.",
    "s4.p3": "<b>Bộ nhớ.</b> Quyết định còn lại giữa các phiên, và mỗi mục là một tệp bạn đọc hay xoá được.",
    "s4.p4": "<b>Tác tử con.</b> Giao một nhánh điều tra cho ngữ cảnh riêng của nó, để nó không làm rối mạch chính.",
    "s4.card": "MỘT KỸ NĂNG",

    "s5.label": "LẤY VỀ",
    "dl.title": "Hai đường vào. Đường nào cũng mất một phút.",
    "dl.body": "Neko là một tệp chạy độc lập. Không phải cài gì thêm - không Node, không Bun, không Python, không tài khoản.",
    "dl.recommended": "NÊN DÙNG",
    "dl.a.title": "Dán một dòng",
    "dl.a.body": "Nó tự tải đúng bản cho máy bạn và đặt <code>neko</code> vào PATH, để sau đó gõ ở terminal nào cũng chạy. Nó lo luôn việc cập nhật.",
    "dl.a.help": "Trên Windows: bấm nút Start, gõ <b>PowerShell</b>, mở lên, dán dòng lệnh, bấm Enter. Xong thì gõ <code>neko</code>.",
    "copy": "Chép",
    "dl.b.title": "Hoặc tải thẳng tệp về",
    "dl.b.body": "Nếu bạn thích cầm một tệp hơn là chạy một dòng lệnh. Vẫn là cùng một chương trình - chỉ là bạn tự đặt và tự chạy.",
    "dl.b.button": "Tải cho",
    "dl.b.all": "Tất cả nền tảng và mã kiểm tra",
    "dl.get": "Tải",
    "dl.b.help": "<b>Hai lời báo trước thành thật.</b> Neko là chương trình chạy trong terminal: bấm đúp vào tệp sẽ ra một cửa sổ đen đầy chữ - đó là ứng dụng, không phải lỗi. Và vì bản dựng chưa có chữ ký số, Windows sẽ hiện màn hình xanh \"ứng dụng không nhận dạng được\" - chọn More info rồi Run anyway, hoặc dùng cách cài một dòng ở trên.",
    "dl.foot": "Mọi bản dựng đều công bố trên GitHub kèm mã SHA-256, ra thẳng từ quy trình dựng công khai.",
    "dl.foot.link": "Xem tất cả bản phát hành &rarr;",

    "s6.label": "TẤT CẢ TRONG HỘP",
    "s6.title": "Một công cụ cho cả vòng việc.",
    "g1.t": "Chế độ kế hoạch", "g1.d": "Trình bày cách làm trước; mọi sửa đổi bị chặn tới khi bạn duyệt.",
    "g2.t": "Sửa nhiều tệp", "g2.d": "Refactor xuyên tệp, mỗi thay đổi hiện ra dạng diff trước khi vào.",
    "g3.t": "Tìm trong mã", "g3.d": "Dùng ripgrep khi máy có, không có thì dùng bản dựng sẵn bên trong.",
    "g4.t": "Chạy lệnh", "g4.d": "Chạy build và test, có timeout riêng từng lệnh và chế độ chạy nền.",
    "g5.t": "Web theo bậc thang", "g5.d": "Tìm kiếm chạy ngay không cần cấu hình; muốn thì nâng lên SearXNG riêng.",
    "g6.t": "Cầu nối trình duyệt", "g6.d": "Dùng đúng một tab Chrome đã đăng nhập, với sự đồng ý hiện rõ trên trang.",
    "g7.t": "Điều khiển máy", "g7.d": "Trên Windows: UI Automation, gõ Unicode, và con trỏ riêng không cướp chuột của bạn.",
    "g8.t": "Họp", "g8.d": "Ghi và gỡ băng ngay tại máy sau khi bạn đồng ý. Âm thanh không rời khỏi máy.",
    "g9.t": "Tài liệu Office", "g9.d": "Word, Excel, PowerPoint - dựng xong rồi kiểm chứng, không phải click mò.",
    "g10.t": "Hook", "g10.d": "Chạy script của bạn quanh mỗi lần gọi công cụ; hook chạy trước có quyền chặn.",
    "g11.t": "Phiên làm việc", "g11.d": "Lưu lại, liệt kê được, và tiếp tục đúng chỗ bạn dừng.",
    "g12.t": "Ngữ cảnh dự án", "g12.d": "Đọc luôn NEKO.md, AGENTS.md và CLAUDE.md bạn đã có.",
    "g13.t": "Điều khiển từ điện thoại", "g13.d": "Lái một phiên đang chạy từ điện thoại, mã hoá đầu-cuối.",
    "g14.t": "Giọng nói", "g14.d": "Nói chuyện với Neko trong terminal, hoặc đọc chính tả vào ô nhập.",
    "g15.t": "Chạy không giao diện", "g15.d": "<code>neko run</code> cho CI và script; <code>--loop</code> tự kiểm cho tới khi xong việc.",
    "g16.t": "Có đo đạc", "g16.d": "<code>neko bench lift</code> đo phần giá trị do chính bộ khung tạo ra, không chỉ đo mô hình.",

    "cta.title": "Mở terminal lên là bắt đầu được.",
    "cta.body": "Chạy với mọi codebase, mọi ngôn ngữ, trên chính cái máy bạn đang có.",
    "cta.docs": "Đọc tài liệu",

    "foot.by": "Do The Wiii Lab xây dựng. Miễn phí, giấy phép MIT.",
    "foot.releases": "Bản phát hành",
    "foot.changelog": "Nhật ký thay đổi",
    "foot.security": "Bảo mật",
    "foot.sov": "Neko Core là sản phẩm Việt Nam. Hoàng Sa và Trường Sa thuộc chủ quyền Việt Nam."
  };

  var TITLES = {
    en: "Neko Core - a local-first terminal coding agent",
    vi: "Neko Core - tác tử lập trình chạy ngay trong terminal của bạn"
  };

  // The English strings are read out of the markup on load, so the dictionary only ever holds the
  // translation. Nothing can drift out of sync with the page it describes.
  var nodes = [].slice.call(document.querySelectorAll("[data-i18n]"));
  var EN = {};
  nodes.forEach(function (node) {
    var key = node.getAttribute("data-i18n");
    if (!(key in EN)) EN[key] = node.innerHTML;
  });

  function apply(lang) {
    var dict = lang === "vi" ? VI : EN;
    nodes.forEach(function (node) {
      var key = node.getAttribute("data-i18n");
      var value = dict[key];
      if (value === undefined) value = EN[key]; // an untranslated string stays English, never empty
      node.innerHTML = value;
    });
    document.documentElement.lang = lang;
    document.title = TITLES[lang];
    var button = document.getElementById("lang");
    if (button) button.textContent = lang === "vi" ? "EN" : "VI";
  }

  var current = document.documentElement.lang === "vi" ? "vi" : "en";
  apply(current);

  var langButton = document.getElementById("lang");
  if (langButton) {
    langButton.addEventListener("click", function () {
      current = current === "vi" ? "en" : "vi";
      apply(current);
      try { localStorage.setItem("neko-lang", current); } catch (e) { /* private mode */ }
    });
  }

  /* ---------- platform ---------- */
  var RELEASE = "https://github.com/meiiie/neko-core/releases/latest/download/";
  var PLATFORMS = {
    windows: { name: "Windows", file: "neko-windows-x64.exe", size: "87 MB", row: "windows" },
    // Apple Silicon is not distinguishable from Intel in a browser, so the default follows the
    // overwhelmingly likely case and the full table right below it carries the Intel build.
    macos: { name: "macOS", file: "neko-macos-arm64", size: "64 MB", row: "macos-arm64" },
    linux: { name: "Linux", file: "neko-linux-x64", size: "81 MB", row: "linux-x64" }
  };

  function detect() {
    var hint = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || "";
    var agent = hint + " " + (navigator.userAgent || "");
    if (/mac|iphone|ipad|ipod/i.test(agent)) return "macos";
    if (/linux|android|cros/i.test(agent)) return "linux";
    if (/win/i.test(agent)) return "windows";
    return "windows";
  }

  var platform = PLATFORMS[detect()];
  [].forEach.call(document.querySelectorAll("[data-os-name]"), function (node) { node.textContent = platform.name; });
  [].forEach.call(document.querySelectorAll("[data-os-size]"), function (node) { node.textContent = platform.size; });
  var main = document.getElementById("mainDownload");
  if (main) main.href = RELEASE + platform.file;
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
  // Show the tab that matches the visitor's machine rather than always Windows.
  if (platform !== PLATFORMS.windows) {
    var shellTab = document.getElementById("tab-sh");
    if (shellTab) shellTab.click();
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
