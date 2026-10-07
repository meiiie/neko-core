/* English is the markup. This script only swaps in Vietnamese, and only after a choice. */
(function () {
  var KEY = "holilihu-lang";
  var VI = {
    "meta.title": "HoLiLiHu — công ty khởi nghiệp phần mềm tại Hải Phòng, Việt Nam",
    "skip": "Chuyển tới nội dung",
    "nav.about": "Giới thiệu",
    "nav.product": "Sản phẩm",
    "nav.team": "Đội ngũ",
    "nav.contact": "Liên hệ",
    "hero.kicker": "Công ty khởi nghiệp phần mềm · Hải Phòng, Việt Nam",
    "hero.lead": "HoLiLiHu xây dựng Neko Core, một coding agent chạy trong terminal, ưu tiên máy cục bộ, cho Windows, macOS và Linux.",
    "hero.facts": "Thông tin công ty",
    "about.title": "Về HoLiLiHu",
    "about.body": "HoLiLiHu là công ty khởi nghiệp phần mềm đặt tại Hải Phòng, Việt Nam. Công ty được thành lập ngày 11 tháng 11 năm 2025 và tự chủ về vốn (self-funded / bootstrapped). HoLiLiHu xây dựng Neko Core.",
    "facts.title": "Thông tin công ty",
    "facts.name": "Tên công ty",
    "facts.founded": "Ngày thành lập",
    "facts.founded.value": "11 tháng 11 năm 2025",
    "facts.location": "Địa điểm",
    "facts.funding": "Nguồn vốn",
    "facts.contact": "Liên hệ",
    "product.title": "Sản phẩm: Neko Core",
    "product.lead": "Neko Core là một coding agent chạy trong terminal, ưu tiên máy cục bộ, được đóng gói thành một tệp nhị phân độc lập cho Windows, macOS và Linux.",
    "product.loop.title": "Vòng lặp có kiểm soát",
    "product.loop.body": "Các sửa đổi thông thường vẫn được thực hiện. Hành động rủi ro — thông tin đăng nhập, lệnh shell mang tính phá hủy, và thay đổi chính sách — phải được phê duyệt và được ghi lại để kiểm tra. Thông tin đăng nhập và lệnh shell thảm họa vẫn bị từ chối hoàn toàn.",
    "product.extend.title": "MCP, skills, ACP, phiên làm việc",
    "product.extend.body": "Neko Core hỗ trợ MCP và skills, tích hợp trình soạn thảo qua ACP (Agent Client Protocol) cho Zed, JetBrains và các client khác, cùng phiên làm việc bền vững: có thể làm tiếp sau khi bị ngắt mà không tự chạy lại những thay đổi đã thực hiện.",
    "product.oracle.title": "Oracle",
    "product.oracle.body": "Chế độ oracle xin ý kiến thứ hai từ một mô hình khác. Mô hình đó không được trao công cụ: không mở tệp, không chạy lệnh, không sửa máy. Nó chỉ thấy những tệp đã được duyệt cho yêu cầu đó.",
    "product.claude.title": "Claude",
    "product.claude.body": "Claude là nhà cung cấp chính. Neko Core còn làm việc với các nhà cung cấp đã cấu hình khác; mô hình và endpoint là cấu hình, không phải sản phẩm tách riêng.",
    "team.title": "Đội ngũ",
    "team.lead": "Bốn người. Nguyễn Mạnh Hùng sáng lập HoLiLiHu. Hồng, Thảo và Linh là thành viên.",
    "team.founder": "Nhà sáng lập",
    "team.member": "Thành viên",
    "contact.title": "Liên hệ",
    "contact.lead": "Thư về công ty gửi tới email bên dưới. Neko Core có trang sản phẩm riêng, mã nguồn nằm trên GitHub.",
    "contact.email": "Email",
    "contact.place": "Địa điểm",
    "contact.product": "Sản phẩm",
    "contact.source": "Mã nguồn",
    "contact.founder": "Nhà sáng lập",
    "foot.sov": "Hoàng Sa và Trường Sa là của Việt Nam.",
    "notfound.meta": "Không tìm thấy trang — HoLiLiHu",
    "notfound.title": "Trang này không có trên website của HoLiLiHu.",
    "notfound.body": "Liên kết có thể đã cũ, hoặc địa chỉ bị gõ nhầm. Trang công ty vẫn ở đây.",
    "notfound.home": "Trang chủ"
  };

  function apply(lang) {
    var vi = lang === "vi";
    document.documentElement.lang = vi ? "vi" : "en";
    var nodes = document.querySelectorAll("[data-i18n]");
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      var key = el.getAttribute("data-i18n");
      if (!el.hasAttribute("data-en")) el.setAttribute("data-en", el.textContent);
      var translated = vi && Object.prototype.hasOwnProperty.call(VI, key) ? VI[key] : null;
      el.textContent = translated || el.getAttribute("data-en");
    }
    var buttons = document.querySelectorAll(".lang button");
    for (var j = 0; j < buttons.length; j++) {
      var on = buttons[j].getAttribute("data-lang") === (vi ? "vi" : "en");
      buttons[j].setAttribute("aria-pressed", on ? "true" : "false");
    }
    var groups = document.querySelectorAll(".lang");
    for (var g = 0; g < groups.length; g++) {
      groups[g].setAttribute("aria-label", vi ? "Ngôn ngữ" : "Language");
    }
    var nav = document.getElementById("site-nav");
    if (nav) nav.setAttribute("aria-label", vi ? "Mục" : "Sections");
    try { localStorage.setItem(KEY, vi ? "vi" : "en"); } catch (e) { /* private mode: the page stays as chosen this visit */ }
  }

  var buttons = document.querySelectorAll(".lang button");
  for (var i = 0; i < buttons.length; i++) {
    buttons[i].addEventListener("click", function () {
      apply(this.getAttribute("data-lang"));
    });
  }

  var saved = "en";
  try {
    var stored = localStorage.getItem(KEY);
    if (stored === "vi" || stored === "en") saved = stored;
  } catch (e) { /* English, which the markup already is */ }
  if (saved === "vi") apply("vi");
})();
