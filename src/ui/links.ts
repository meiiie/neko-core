/**
 * OSC 8 terminal hyperlinks (clean-room, the Claude-Code affordance): wrap visible text in
 * `ESC ]8;;URI BEL text ESC ]8;; BEL` and a supporting terminal (Windows Terminal, WezTerm, iTerm2,
 * kitty) shows a hover tooltip + Ctrl+Click-to-open; terminals without support ignore the sequence and
 * show the text unchanged. The renderer's word-wrap (wrap-ansi, verified) RE-OPENS the link on every
 * wrapped segment, so a long product URL broken across lines still carries its full URI - which plain
 * terminal auto-detection cannot do. Width-wise the sequence is zero cells: string-width (Ink's
 * measurer) and the VT test oracle both skip OSC, and frame-diff's column math is OSC-aware.
 */

const BEL = "\x07";
const OSC8 = "\x1b]8;;";

/** A URI embedded in an escape sequence must never contain control bytes (an ESC/BEL inside would
 * terminate/corrupt the sequence - and is exactly what a hostile page would try). */
export function sanitizeUri(uri: string): string {
  // eslint-disable-next-line no-control-regex
  return uri.replace(/[\x00-\x1f\x7f]/g, "");
}

/** Hyperlink `text` to `uri`. Empty/unsafe URI -> the bare text (never a broken sequence). */
export function osc8(uri: string, text: string): string {
  const u = sanitizeUri(uri);
  return u ? `${OSC8}${u}${BEL}${text}${OSC8}${BEL}` : text;
}

/** An ABSOLUTE local path -> a file:// URI (what terminals expect for Ctrl+Click on local files).
 * Windows drive paths gain the leading slash (file:///E:/...); spaces and URI-special characters are
 * percent-encoded so the link survives tooltip/open intact. */
export function fileUri(path: string): string {
  let p = path.replace(/\\/g, "/");
  if (!p.startsWith("/")) p = "/" + p; // drive-letter form E:/... -> /E:/...
  return "file://" + encodeURI(p).replace(/#/g, "%23").replace(/\?/g, "%3F");
}

export interface LinkSegment { uri: string; text: string; }

// Bare web URLs and absolute Windows paths inside prose. Conservative by design: a path must start at
// a drive letter and contain no spaces (a spaced path in prose is ambiguous), and trailing sentence
// punctuation is not part of the target ("see https://x.vn/a." links to .../a).
// The drive-path alternative is boundary-guarded: the letter must not continue a word (else the "s"
// of a malformed "https://" would match as drive "s:"), and "C://" (double separator) is not a path.
const TARGET_RE = /(https?:\/\/[^\s<>"'`]+|(?<![A-Za-z0-9])[A-Za-z]:[\\/](?![\\/])[^\s<>"'`|()]+)/g;
const TRAIL_PUNCT_RE = /[.,;:!?…'")\]]+$/;

/** Split plain prose into text/link segments (strings stay strings; link targets become {uri, text}).
 * Callers render link segments through osc8() with their own styling. */
export function linkSegments(s: string): (string | LinkSegment)[] {
  const out: (string | LinkSegment)[] = [];
  let last = 0;
  TARGET_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TARGET_RE.exec(s)) !== null) {
    let target = m[0];
    const trail = TRAIL_PUNCT_RE.exec(target);
    if (trail) target = target.slice(0, -trail[0].length);
    // After the trim the target must still be a REAL destination: a URL with content past the scheme,
    // or a drive path with content past the separator ("C:\" alone is prose, not a link).
    if (!/^https?:\/\/./.test(target) && !/^[A-Za-z]:[\\/].+/.test(target)) continue;
    if (m.index > last) out.push(s.slice(last, m.index));
    out.push({ uri: target.startsWith("http") ? target : fileUri(target), text: target });
    last = m.index + target.length;
  }
  if (last < s.length) out.push(s.slice(last));
  return out.length ? out : [s];
}
