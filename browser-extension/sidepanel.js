// Neko side-panel chat client. The BRAIN is the neko CLI: this panel only renders Neko's transcript
// and sends the user's prompts. It talks to the service worker over a long-lived runtime port; the
// service worker relays to/from the neko bridge WebSocket (loopback, token-authenticated). No model
// or network of its own - Neko's file/bash/computer-use tools all run in the CLI, not here.
const log = document.getElementById("log");
const form = document.getElementById("form");
const input = document.getElementById("input");
const send = document.getElementById("send");
const dot = document.getElementById("dot");
const sub = document.getElementById("sub");

let streamEl = null; // the live "assistant is typing" bubble, replaced by a final line on completion
let pendingUserEcho = null; // text we optimistically showed; Neko echoes a "user" line - skip it once

function atBottom() { return log.scrollHeight - log.scrollTop - log.clientHeight < 40; }
function scroll() { log.scrollTop = log.scrollHeight; }

function addMsg(kind, text) {
  const stick = atBottom();
  const el = document.createElement("div");
  el.className = "msg " + (kind || "info");
  el.textContent = text;
  log.appendChild(el);
  if (stick) scroll();
  return el;
}

function renderStream(text) {
  const stick = atBottom();
  if (!streamEl) { streamEl = document.createElement("div"); streamEl.className = "msg stream"; log.appendChild(streamEl); }
  streamEl.textContent = text;
  if (!text) { streamEl.remove(); streamEl = null; return; } // empty stream = turn ended; final line arrives via "line"
  if (stick) scroll();
}

// A Neko-side event (mirrors the CLI transcript). Shapes: {type:"line",line}, {type:"stream",text},
// {type:"snapshot",lines}, {type:"activity",id,text}.
function onEvent(event) {
  if (!event || typeof event !== "object") return;
  if (event.type === "snapshot" && Array.isArray(event.lines)) {
    log.innerHTML = ""; streamEl = null;
    for (const line of event.lines) addMsg(line.kind, line.text || "");
    scroll();
  } else if (event.type === "line" && event.line) {
    streamEl = null; // a committed line ends any live stream
    // Neko echoes the user's prompt as a "user" line; if we already showed it optimistically, skip once.
    if (event.line.kind === "user" && pendingUserEcho !== null && (event.line.text || "") === pendingUserEcho) {
      pendingUserEcho = null;
      return;
    }
    addMsg(event.line.kind, event.line.text || "");
  } else if (event.type === "stream") {
    renderStream(String(event.text || ""));
  } else if (event.type === "activity" && event.text) {
    // transient tool activity; shown dim, not persisted specially
    addMsg("tool_call", "· " + event.text);
  }
}

function setConnected(on) {
  dot.classList.toggle("on", on);
  sub.textContent = on ? "connected" : "waiting for Neko…";
  send.disabled = !on;
}

// Long-lived port to the service worker; it forwards bridge events here and our prompts there.
let port = null;
function connect() {
  try { port = chrome.runtime.connect({ name: "neko-panel" }); }
  catch { setConnected(false); setTimeout(connect, 1500); return; }
  port.onMessage.addListener((msg) => {
    if (msg && msg.type === "connected") setConnected(!!msg.online);
    else if (msg && msg.type === "panel") onEvent(msg.event);
  });
  port.onDisconnect.addListener(() => { setConnected(false); port = null; setTimeout(connect, 1500); });
  port.postMessage({ type: "hello" });
}
connect();

function submit() {
  const text = input.value.trim();
  if (!text || send.disabled) return;
  addMsg("user", text);
  pendingUserEcho = text; // Neko will echo this as a "user" line; suppress that one duplicate
  try { port && port.postMessage({ type: "prompt", prompt: text }); } catch {}
  input.value = ""; input.style.height = "auto";
}
form.addEventListener("submit", (e) => { e.preventDefault(); submit(); });
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); }
});
input.addEventListener("input", () => { input.style.height = "auto"; input.style.height = Math.min(140, input.scrollHeight) + "px"; });
