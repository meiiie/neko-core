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
    "announce": "Neko Core {v} đã ra.",
    "announce.link": "Có gì mới <span class=\"arrow\">&rarr;</span>",

    "nav.how": "Cách hoạt động",
    "nav.download": "Tải về",
    "nav.docs": "Tài liệu",
    "nav.cta": "Lấy Neko",

    "hero.eyebrow": "Tác tử lập trình chạy tại máy",
    "hero.lead": "Một tác tử trong terminal làm việc ngay trên máy bạn — với bất kỳ mô hình nào, kể cả mô hình chạy ngoại tuyến. Và nó hỏi trước khi đổi gì.",
    "copy": "Chép",
    "hero.download": "Tải cho",
    "hero.other": "Nền tảng khác",
    "hero.trust": "Miễn phí vĩnh viễn · giấy phép MIT · Windows, macOS và Linux · không cần tài khoản",

    "p.label": "Xem tận mắt",
    "p.title": "Một câu tiếng Việt vào, một bảng tính hoàn chỉnh ra.",
    "p.body": "Một tệp nhật ký điện 599 dòng, yêu cầu bằng tiếng Việt: làm sạch rồi dựng dashboard. Neko đọc workbook, sao lưu bản gốc, viết script, chạy, rồi kiểm lại kết quả.",
    "p.caption": "Phiên chạy thật, không cắt ghép — 30 giây trong đó. Ảnh tĩnh là dashboard lúc xong.",

    "s1.label": "Phê duyệt",
    "s1.title": "Nó hỏi trước khi chạm vào máy bạn.",
    "s1.body": "Công cụ chỉ nhìn nằm ở một nhóm, công cụ làm thay đổi nằm ở nhóm khác. Nhóm đầu chạy ngay, nhóm sau chờ bạn — và ranh giới ấy in ra được bằng một lệnh.",
    "s1.f1.t": "Đọc thì chạy ngay, ghi thì chờ duyệt",
    "s1.f1.d": "<code>read_file</code>, <code>search</code>, <code>glob</code> và <code>ls</code> chạy tức thì. <code>write_file</code>, <code>edit</code> và <code>bash</code> chờ bạn đồng ý.",
    "s1.f2.t": "Quyền tự chủ có tên gọi",
    "s1.f2.d": "Tắt phê duyệt là một chế độ bạn chủ động bước vào, và chân phiên làm việc hiển thị nó suốt thời gian còn bật.",
    "s1.f3.t": "Kiểm chứng được, không phải lời hứa",
    "s1.f3.d": "<code>neko policy</code> dựng lại ranh giới từ mã nguồn và thoát với mã lỗi khi có gì đó lệch đi.",
    "s1.panel": "KIỂM TOÁN QUYỀN",

    "s2.label": "Mô hình",
    "s2.title": "Thêm một mô hình chỉ là sửa một tệp.",
    "s2.body": "Neko nói chuyện với mọi endpoint tương thích OpenAI — dịch vụ đám mây, tài khoản công ty, hay một máy chủ mô hình chạy ngay trên máy bạn. Cái cuối cùng là thứ giúp nó vẫn làm việc khi rút mạng.",
    "s2.panel": "MỘT PROFILE CHẠY NỘI BỘ",
    "s2.f1.t": "Thuê bao hoặc khoá API",
    "s2.f1.d": "ChatGPT, Claude, Gemini, Grok, Kimi và DeepSeek đăng nhập ngay trong ứng dụng. Mọi thứ khác chỉ cách một dòng base URL.",
    "s2.f2.t": "Hoặc không cần ai cả",
    "s2.f2.d": "Trỏ một profile vào llama.cpp hay Ollama là mọi byte ở lại trên máy bạn.",
    "s2.f3.t": "Đổi giữa chừng",
    "s2.f3.d": "<code>/provider</code> và <code>/model</code> đổi endpoint khi phiên đang chạy. Cuộc trò chuyện được mang theo.",

    "s3.title": "Ý kiến thứ hai từ một mô hình không chạm được vào máy bạn.",
    "s3.body": "Khi bí, Neko gửi được một lát cắt bạn chọn của dự án sang một mô hình mạnh hơn để hỏi ý. Mô hình đó không được cấp công cụ nào: không mở được tệp, không chạy được lệnh, không sửa được dòng nào. Nó nhận đúng những tệp bạn đã duyệt và gửi lại chữ.",
    "s3.f1.t": "Bạn thấy bản kê khai trước",
    "s3.f1.d": "Mọi tệp trong gói đều được liệt kê trước khi yêu cầu đi ra, và <code>--dry-run</code> dừng lại đúng ở đó.",
    "s3.f2.t": "Tệp chứa bí mật bị bỏ nguyên tệp",
    "s3.f2.d": "<code>.env</code>, khoá riêng tư và mọi thứ dưới <code>.neko-core/</code> không bao giờ lọt vào gói.",
    "s3.f3.t": "Mã của bạn tới nơi vẫn đọc được",
    "s3.f3.d": "Chỉ giá trị chuỗi giống khoá bị che, nên <code>process.env.API_KEY</code> tới tay oracle đúng như bạn đã viết.",
    "s3.panel": "CHẠY THỬ KHÔNG GỬI",

    "s4.label": "Mở rộng",
    "s4.title": "Một tệp Markdown dạy nó một nghề mới.",
    "s4.body": "Lập trình là việc Neko làm được ngay khi mở hộp, còn kỹ năng là cách nó học mọi việc khác. Neko chỉ nạp khi công việc thực sự khớp, nên một thư viện rộng chẳng tốn gì để mang theo.",
    "s4.panel": "MỘT KỸ NĂNG",
    "s4.f1.t": "Kỹ năng",
    "s4.f1.d": "Mô tả một lần cách bạn muốn một việc được làm, lần sau gặp việc đó Neko tự tìm ra.",
    "s4.f2.t": "MCP",
    "s4.f2.d": "Máy chủ MCP nào cũng cắm vào được, và dự án đã có <code>.mcp.json</code> thì dùng luôn, không sửa gì.",
    "s4.f3.t": "Bộ nhớ",
    "s4.f3.d": "Quyết định sống qua nhiều phiên dưới dạng tệp thường, bạn mở, sửa hay xoá được.",

    "s5.label": "Năng lực",
    "s5.title": "Một công cụ cho cả vòng việc.",
    "c1.t": "Chế độ kế hoạch", "c1.d": "Neko trình bày cách làm, và mọi sửa đổi vẫn bị chặn cho tới khi bạn duyệt kế hoạch.",
    "c2.t": "Họp", "c2.d": "Ghi âm và gỡ băng sau khi bạn đồng ý. Âm thanh được xử lý tại máy bạn và ở lại đó.",
    "c3.t": "Tài liệu Office", "c3.d": "Tệp Word, Excel, PowerPoint được dựng, rồi mở ra kiểm chứng trước khi Neko coi là xong.",
    "c4.t": "Cầu nối trình duyệt", "c4.d": "Dùng đúng một tab Chrome đã đăng nhập, với trạng thái đồng ý hiện ngay trên trang.",
    "c5.t": "Điều khiển máy", "c5.d": "Trên Windows: UI Automation, gõ Unicode, và một con trỏ riêng để yên chuột của bạn.",
    "c6.t": "Giọng nói", "c6.d": "Nói với Neko trong terminal; nó trả lời, tra cứu, và vẫn làm việc trong lúc bạn nói.",
    "c7.t": "Chạy không giao diện", "c7.d": "<code>neko run</code> hợp với CI và script, còn <code>--loop</code> tự soát lại việc mình làm tới khi xong.",
    "c8.t": "Có đo đạc", "c8.d": "<code>neko bench lift</code> cho biết bao nhiêu phần kết quả đến từ bộ khung chứ không từ mô hình.",

    "s6.label": "Cài đặt",
    "dl.title": "Hai cách cài, cách nào cũng khoảng một phút.",
    "dl.body": "Neko là một tệp chạy độc lập. Node, Bun, Python và tài khoản đều là những thứ bạn bỏ qua được.",
    "dl.recommended": "NÊN DÙNG",
    "dl.a.title": "Dán một dòng",
    "dl.a.body": "Bộ cài chọn đúng bản cho máy bạn, đặt <code>neko</code> vào PATH để terminal nào cũng tìm thấy, và lo việc cập nhật về sau.",
    "dl.a.help": "<b>Chưa từng dùng terminal?</b> Bấm Start, gõ <b>PowerShell</b>, mở lên, dán dòng lệnh ở trên rồi bấm Enter. Xong thì gõ <code>neko</code> và bấm Enter lần nữa.",
    "dl.b.title": "Hoặc lấy tệp về",
    "dl.b.body": "Vẫn là chương trình đó dưới dạng tệp tải thẳng, dành cho lúc bạn thích tự đặt tệp hơn là chạy một dòng lệnh.",
    "dl.b.button": "Tải cho",
    "dl.b.all": "Tất cả nền tảng và mã kiểm tra",
    "dl.get": "Tải",
    "dl.b.help": "<b>Hai điều nên biết trước.</b> Neko chạy trong terminal, nên mở tệp ra bạn sẽ thấy một cửa sổ đầy chữ — cửa sổ đó chính là Neko. Và bản dựng chưa có chữ ký số, nên Windows sẽ hiện màn hình xanh \"ứng dụng không nhận dạng được\": chọn <b>More info</b>, rồi <b>Run anyway</b>.",
    "dl.foot": "Mọi bản dựng đều công bố trên GitHub kèm mã SHA-256, ra thẳng từ quy trình dựng công khai.",
    "dl.foot.link": "Tất cả bản phát hành <span class=\"arrow\">&rarr;</span>",

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
  // The Worker rewrites [data-release] spots on the way out, so the version in the page is the live
  // one. Read it BEFORE any translation runs and substitute it back into {v}, or switching language
  // would overwrite the injected number with whatever was baked into the dictionary.
  var liveVersion = (document.querySelector('[data-release="version"]') || {}).textContent || "";

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
      var html = value === undefined ? EN[key] : value; // untranslated stays English, never empty
      node.innerHTML = liveVersion ? html.split("{v}").join(liveVersion) : html;
    });
    document.documentElement.lang = lang;
    document.title = TITLES[lang];
    // Show which language is ON rather than which one a click would reach. A single button reading
    // "EN" above Vietnamese text is ambiguous, and readers took it as a label of the current state.
    [].forEach.call(document.querySelectorAll(".langswitch button"), function (b) {
      b.setAttribute("aria-pressed", String(b.getAttribute("data-lang") === lang));
    });
    current = lang;
  }

  apply(current);

  [].forEach.call(document.querySelectorAll(".langswitch button"), function (button) {
    button.addEventListener("click", function () {
      apply(button.getAttribute("data-lang"));
      try { localStorage.setItem("neko-lang", current); } catch (e) { /* private mode */ }
    });
  });

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

  // The download table carries the live sizes (the Worker rewrote them), so the buttons read theirs
  // from the page rather than keeping a second copy that can drift a release behind.
  function liveSize(asset, fallback) {
    var el = document.querySelector('[data-release="size:' + asset + '"]');
    var text = el && el.textContent ? el.textContent.trim() : "";
    return text || fallback;
  }

  var platform = PLATFORMS[detect()];
  platform.size = liveSize(platform.file, platform.size);
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
    [].forEach.call(document.querySelectorAll("#tab2-sh"), function (tab) { tab.click(); });
    // The hero box carries no tabs - it just shows the line that matches the machine.
    var ps = document.getElementById("cmd-ps"), sh = document.getElementById("cmd-sh");
    if (ps && sh) { ps.hidden = true; sh.hidden = false; }
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

  /*
   * Motion. Everything below is additive: the class that enables the hidden-then-revealed state is
   * added HERE, so a visitor with JavaScript off, or with reduced motion asked for, sees a complete
   * page rather than a blank one waiting for an observer that will never fire.
   */
  var still = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (still || !("IntersectionObserver" in window)) return;

  document.documentElement.classList.add("js-reveal");

  // A section's hairline draws itself and its number flickers in as the section arrives; blocks rise
  // 12px. Studied from cindy.cn, kept to the parts that mark structure rather than decorate it.
  var observer = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      if (!entry.isIntersecting) return;
      entry.target.classList.add("is-in");
      observer.unobserve(entry.target);
    });
  }, { rootMargin: "0px 0px -12% 0px", threshold: 0.1 });

  [].forEach.call(document.querySelectorAll(".reveal, .eyebrow"), function (node) { observer.observe(node); });

  // The nav steps out of the way going down and returns going up. Below the fold only: at the top of
  // the page it must always be present.
  var header = document.querySelector("header");
  var lastY = window.scrollY;
  var progress = document.getElementById("progress");
  var ticking = false;

  function onScroll() {
    var y = window.scrollY;
    if (header) {
      var goingDown = y > lastY;
      header.classList.toggle("is-hidden", goingDown && y > 320);
    }
    if (progress) {
      var max = document.documentElement.scrollHeight - window.innerHeight;
      progress.style.width = (max > 0 ? Math.min(100, (y / max) * 100) : 0) + "%";
    }
    lastY = y;
    ticking = false;
  }

  window.addEventListener("scroll", function () {
    if (ticking) return;
    ticking = true;
    window.requestAnimationFrame(onScroll);
  }, { passive: true });
  onScroll();
})();
