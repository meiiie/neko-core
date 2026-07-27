// Design-system audit. Runs inside an iframe of the site at a given width and reports every value
// that is off the declared scales, plus tap targets and measure. Returns a compact object.
(function auditDoc(doc, win, label) {
  var SPACE = [0, 4, 8, 12, 16, 24, 32, 48, 64, 96, 128];
  var TYPE = [11, 12, 13, 14, 16, 17, 18, 20, 24, 30, 36, 48, 60, 72];
  var offSpace = {};
  var offType = {};
  var smallTargets = [];
  var wideText = [];
  var seen = 0;

  function tag(el) {
    var c = (el.className && String(el.className).trim().split(/\s+/)[0]) || "";
    return el.tagName.toLowerCase() + (c ? "." + c : "");
  }

  var all = doc.querySelectorAll("body *");
  for (var i = 0; i < all.length; i++) {
    var el = all[i];
    var r = el.getBoundingClientRect();
    if (!r.width && !r.height) continue;
    seen++;
    var cs = win.getComputedStyle(el);

    // spacing: padding, margin, gap
    ["paddingTop", "paddingBottom", "paddingLeft", "paddingRight",
     "marginTop", "marginBottom", "rowGap", "columnGap"].forEach(function (prop) {
      var v = parseFloat(cs[prop]);
      if (!isFinite(v) || v === 0) return;
      var rounded = Math.round(v * 100) / 100;
      if (SPACE.indexOf(Math.round(rounded)) === -1 || Math.abs(rounded - Math.round(rounded)) > 0.02) {
        var k = tag(el) + " " + prop + "=" + rounded;
        offSpace[k] = (offSpace[k] || 0) + 1;
      }
    });

    // type
    var fs = Math.round(parseFloat(cs.fontSize) * 100) / 100;
    if (isFinite(fs) && el.childNodes.length && TYPE.indexOf(Math.round(fs)) === -1) {
      var kt = tag(el) + "=" + fs;
      offType[kt] = (offType[kt] || 0) + 1;
    }

    // tap targets
    if (/^(a|button|summary|input|select)$/i.test(el.tagName) && r.width > 0) {
      if (r.height < 44 || r.width < 44) {
        smallTargets.push(tag(el) + " " + Math.round(r.width) + "x" + Math.round(r.height));
      }
    }

    // measure: paragraphs wider than ~75ch
    if (/^(p|li|span)$/i.test(el.tagName) && el.textContent.trim().length > 80) {
      var ch = r.width / (parseFloat(cs.fontSize) * 0.5);
      if (ch > 78) wideText.push(tag(el) + " ~" + Math.round(ch) + "ch");
    }
  }

  return {
    at: label,
    elements: seen,
    offScaleSpacing: Object.keys(offSpace).slice(0, 22),
    offScaleType: Object.keys(offType).slice(0, 16),
    smallTapTargets: smallTargets.slice(0, 16),
    overWideText: wideText.slice(0, 8),
    docWidth: doc.documentElement.scrollWidth,
  };
})(document, window, "self");
