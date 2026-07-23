const DEFAULT_PORT = 8766;
const RECONNECT_ALARM = "neko-browser-reconnect";
const state = {
  port: DEFAULT_PORT,
  session: "",
  token: "",
  tabId: null,
  tabHost: "",
  tabOrigin: "",
  tabTitle: "",
  createdGroupId: null,
  grants: { click: false, type: false },
  connection: "offline",
  audit: [],
};

let socket = null;
let readyPromise = null;
let pingTimer = null;
let sensitiveRefs = new Set();
let panelPort = null; // the open Neko side panel (chrome.runtime port), or null
let panelRetry = null; // gentle reconnect while the panel is open and Neko is offline

async function restore() {
  const saved = await chrome.storage.local.get(Object.keys(state));
  Object.assign(state, saved);
  state.grants = { click: false, type: false, ...(saved.grants || {}) };
  if (state.token && state.tabId != null) {
    armReconnect();
    void connect(false).catch(() => {});
  }
}

function armReconnect() {
  if (state.tabId != null) chrome.alarms.create(RECONNECT_ALARM, { delayInMinutes: 0.5, periodInMinutes: 0.5 });
}

function disarmReconnect() {
  void chrome.alarms.clear(RECONNECT_ALARM);
}

async function persist() {
  await chrome.storage.local.set({
    port: state.port,
    session: state.session,
    token: state.token,
    tabId: state.tabId,
    tabHost: state.tabHost,
    tabOrigin: state.tabOrigin,
    tabTitle: state.tabTitle,
    createdGroupId: state.createdGroupId,
    grants: state.grants,
    marked: state.tabId != null,
    audit: state.audit,
  });
}

function record(action, status) {
  state.audit.push({ at: new Date().toISOString(), action, status });
  state.audit = state.audit.slice(-20);
  void persist();
}

function publicState() {
  return {
    connection: state.connection,
    session: state.session ? state.session.slice(0, 8) : "",
    attached: state.tabId != null,
    tabHost: state.tabHost,
    tabTitle: state.tabTitle,
    grants: state.grants,
    audit: state.audit.slice(-8).reverse(),
  };
}

function badge(text, color) {
  void chrome.action.setBadgeText({ text });
  if (color) void chrome.action.setBadgeBackgroundColor({ color });
}

async function showIndicator() {
  if (state.tabId == null) return;
  await chrome.scripting.executeScript({ target: { tabId: state.tabId }, files: ["control-indicator.js"] });
  await chrome.tabs.sendMessage(state.tabId, {
    type: "neko-indicator-update",
    grants: state.grants,
    connected: state.connection === "ready",
  });
}

async function removeIndicator(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: () => document.getElementById("__neko_browser_control__")?.remove(),
    });
  } catch { /* The tab may already be closed or activeTab may have expired. */ }
}

async function markAttachedTab(tab) {
  const noGroup = chrome.tabGroups.TAB_GROUP_ID_NONE;
  state.createdGroupId = null;
  if (tab.groupId === noGroup) {
    const groupId = await chrome.tabs.group({ tabIds: tab.id });
    await chrome.tabGroups.update(groupId, { title: "Neko - AI active", color: "orange", collapsed: false });
    state.createdGroupId = groupId;
  }
  await chrome.action.setTitle({ tabId: tab.id, title: "Neko is using this tab - click for controls" });
  await showIndicator();
}

async function unmarkAttachedTab(tabId, createdGroupId) {
  await removeIndicator(tabId);
  try {
    const tab = await chrome.tabs.get(tabId);
    if (createdGroupId != null && tab.groupId === createdGroupId) await chrome.tabs.ungroup(tabId);
    await chrome.action.setTitle({ tabId, title: "Attach this tab to Neko" });
  } catch { /* The tab or Neko-created group may already be gone. */ }
}

async function connect(allowPair) {
  if (socket?.readyState === WebSocket.OPEN && state.connection === "ready") return;
  if (readyPromise) return readyPromise;
  state.connection = "connecting";
  readyPromise = new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${state.port}/bridge`);
    socket = ws;
    const timeout = setTimeout(() => { ws.close(); reject(new Error("Neko bridge connection timed out")); }, 8_000);
    ws.onopen = () => {
      ws.send(JSON.stringify(state.token
        ? { type: "hello", session: state.session, token: state.token }
        : allowPair ? { type: "pair" } : { type: "hello", session: "", token: "" }));
    };
    ws.onmessage = async (event) => {
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (message.type === "paired") {
        state.session = message.session;
        state.token = message.token;
        await persist();
      } else if (message.type === "ready") {
        clearTimeout(timeout);
        state.connection = "ready";
        try { panelPort?.postMessage({ type: "connected", online: true }); } catch {}
        badge(state.tabId == null ? "" : "AI", "#22c55e");
        if (state.tabId != null) void showIndicator().catch(() => {});
        clearInterval(pingTimer);
        pingTimer = setInterval(() => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ type: "ping" })), 20_000);
        armReconnect();
        if (panelPort && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "panel-ready" }));
        resolve();
      } else if (message.type === "command") {
        void execute(message);
      } else if (message.type === "panel") {
        // Neko-side transcript event -> forward to the open side panel (if any).
        try { panelPort?.postMessage({ type: "panel", event: message.event }); } catch {}
      }
    };
    ws.onerror = () => reject(new Error("Neko bridge is offline"));
    ws.onclose = (event) => {
      clearTimeout(timeout);
      clearInterval(pingTimer);
      pingTimer = null;
      socket = null;
      readyPromise = null;
      state.connection = "offline";
      try { panelPort?.postMessage({ type: "connected", online: false }); } catch {}
      badge(state.tabId == null ? "" : "!", "#ef4444");
      if (state.tabId != null) armReconnect();
      reject(new Error(event.reason || `Neko bridge closed (${event.code})`));
    };
  }).finally(() => { readyPromise = null; });
  return readyPromise;
}

function send(message) {
  if (socket?.readyState !== WebSocket.OPEN) throw new Error("Neko bridge is offline");
  socket.send(JSON.stringify(message));
}

async function attachActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !/^https?:/.test(tab.url || "")) throw new Error("Open an http(s) tab before attaching");
  const sameTab = state.tabId === tab.id;
  if (!sameTab && state.tabId != null) await detach("switch-tab");
  try {
    await connect(true);
  } catch (error) {
    // A deliberate attach gesture may repair a capability rotated with `neko browser rotate`.
    // Never discard a valid saved capability merely because the bridge is temporarily offline.
    if (!state.token || !/authentication failed/i.test(error?.message || String(error))) throw error;
    state.session = "";
    state.token = "";
    await persist();
    await connect(true);
    record("pair", "rotated");
  }
  const url = new URL(tab.url);
  if (sameTab) {
    state.tabHost = url.host;
    state.tabOrigin = url.origin;
    state.tabTitle = tab.title || url.host;
    await showIndicator();
    await persist();
    send({ type: "attached", tab: { id: tab.id, url: tab.url, title: state.tabTitle }, grants: state.grants });
    badge("AI", "#22c55e");
    record("attach", "resumed");
    return;
  }
  state.tabId = tab.id;
  state.tabHost = url.host;
  state.tabOrigin = url.origin;
  state.tabTitle = tab.title || url.host;
  armReconnect();
  try {
    await markAttachedTab(tab);
  } catch (error) {
    await unmarkAttachedTab(tab.id, state.createdGroupId);
    state.tabId = null;
    state.tabHost = "";
    state.tabOrigin = "";
    state.tabTitle = "";
    state.createdGroupId = null;
    throw error;
  }
  await persist();
  send({ type: "attached", tab: { id: tab.id, url: tab.url, title: state.tabTitle }, grants: state.grants });
  badge("AI", "#22c55e");
  record("attach", "ok");
}

async function detach(reason = "user") {
  const tabId = state.tabId;
  const createdGroupId = state.createdGroupId;
  if (socket?.readyState === WebSocket.OPEN) send({ type: "detached", reason });
  if (tabId != null) await unmarkAttachedTab(tabId, createdGroupId);
  state.tabId = null;
  state.tabHost = "";
  state.tabOrigin = "";
  state.tabTitle = "";
  state.createdGroupId = null;
  state.grants = { click: false, type: false };
  sensitiveRefs.clear();
  disarmReconnect();
  await persist();
  badge("", null);
  record("detach", reason);
}

async function emergencyStop() {
  await detach("emergency-stop");
  socket?.close(1000, "emergency stop");
  state.connection = "offline";
}

async function inTab(func, args = []) {
  if (state.tabId == null) throw new Error("no tab is attached");
  const [result] = await chrome.scripting.executeScript({ target: { tabId: state.tabId }, func, args });
  return result?.result;
}

function snapshotPage(maxItems) {
  let next = 0;
  const visible = (element) => {
    const box = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return box.width > 0 && box.height > 0 && box.bottom > 0 && box.top < innerHeight
      && style.visibility !== "hidden" && style.display !== "none";
  };
  const selector = "a[href],button,input,textarea,select,[role=button],[role=link],[role=textbox],[contenteditable=true]";
  const items = [...document.querySelectorAll(selector)].filter(visible).slice(0, maxItems).map((element) => {
    const ref = `n${++next}`;
    element.dataset.nekoRef = ref;
    const box = element.getBoundingClientRect();
    const type = (element.getAttribute("type") || "").toLowerCase();
    const autocomplete = (element.getAttribute("autocomplete") || "").toLowerCase();
    const fieldName = `${element.getAttribute("name") || ""} ${element.getAttribute("aria-label") || ""}`.toLowerCase();
    return {
      ref,
      role: element.getAttribute("role") || element.tagName.toLowerCase(),
      name: (element.getAttribute("aria-label") || element.getAttribute("placeholder") || element.innerText || element.value || "").trim().slice(0, 240),
      box: [Math.round(box.x), Math.round(box.y), Math.round(box.width), Math.round(box.height)],
      sensitive: type === "password" || /(password|passcode|otp|one-time|cc-number|cc-csc|card number|cvv)/.test(`${autocomplete} ${fieldName}`),
    };
  });
  const visibleText = [];
  const seenText = new Set();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  while (visibleText.length < maxItems && walker.nextNode()) {
    const element = walker.currentNode.parentElement;
    const text = (walker.currentNode.textContent || "").replace(/\s+/g, " ").trim();
    const editableRoot = element?.closest("input,textarea,select,[role=textbox],[contenteditable=true],[contenteditable=''],[contenteditable=plaintext-only]");
    if (!element || !text || seenText.has(text) || editableRoot || element.closest("script,style,noscript")) continue;
    const box = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    if (box.width <= 0 || box.height <= 0 || box.bottom <= 0 || box.top >= innerHeight
      || style.visibility === "hidden" || style.display === "none") continue;
    seenText.add(text);
    visibleText.push({
      role: element.getAttribute("role") || element.tagName.toLowerCase(),
      text: text.slice(0, 500),
      box: [Math.round(box.x), Math.round(box.y), Math.round(box.width), Math.round(box.height)],
    });
  }
  return { page: { title: document.title, url: location.origin + location.pathname }, items, visibleText };
}

function waitForVisibleChange(durationMs, settleMs) {
  const stateId = (text) => {
    let first = 0x811c9dc5;
    let second = 0x9e3779b9;
    for (let index = 0; index < text.length; index++) {
      const code = text.charCodeAt(index);
      first = Math.imul(first ^ code, 0x01000193);
      second = Math.imul(second ^ code, 0x85ebca6b);
    }
    return [first, second].map((value) => (value >>> 0).toString(16).padStart(8, "0")).join("");
  };
  const signature = () => {
    const root = document.querySelector("main,[role=main]") || document.body;
    return (root?.innerText || "").replace(/\s+/g, " ").trim().slice(-100_000);
  };
  const baseline = signature();
  const started = Date.now();
  return new Promise((resolve) => {
    let last = baseline;
    let detectedMs = -1;
    let settleTimer;
    let timeoutTimer;
    let finished = false;
    const finish = (status) => {
      if (finished) return;
      finished = true;
      observer.disconnect();
      clearTimeout(settleTimer);
      clearTimeout(timeoutTimer);
      resolve({ status, changed: last !== baseline, elapsedMs: Date.now() - started, detectedMs, state: stateId(last) });
    };
    const observer = new MutationObserver(() => {
      const next = signature();
      if (next === last) return;
      last = next;
      detectedMs = next === baseline ? -1 : Date.now() - started;
      clearTimeout(settleTimer);
      settleTimer = setTimeout(() => finish(last === baseline ? "timeout" : "changed"), settleMs);
    });
    observer.observe(document.body, { childList: true, characterData: true, subtree: true });
    timeoutTimer = setTimeout(() => finish(last === baseline ? "timeout" : "changed_unsettled"), durationMs);
  });
}

function clickRef(ref) {
  const element = document.querySelector(`[data-neko-ref="${CSS.escape(ref)}"]`);
  if (!element) throw new Error("element reference is stale; take a new snapshot");
  element.click();
  return { clicked: ref };
}

function typeRef(ref, text) {
  const element = document.querySelector(`[data-neko-ref="${CSS.escape(ref)}"]`);
  if (!element) throw new Error("element reference is stale; take a new snapshot");
  const type = (element.getAttribute("type") || "").toLowerCase();
  const autocomplete = (element.getAttribute("autocomplete") || "").toLowerCase();
  const name = `${element.getAttribute("name") || ""} ${element.getAttribute("aria-label") || ""}`.toLowerCase();
  if (type === "password" || /(password|passcode|otp|one-time|cc-number|cc-csc|card number|cvv)/.test(`${autocomplete} ${name}`)) {
    throw new Error("sensitive input is blocked; type it yourself");
  }
  element.focus();
  if (element.isContentEditable) {
    const selection = getSelection();
    const range = document.createRange();
    range.selectNodeContents(element);
    selection?.removeAllRanges();
    selection?.addRange(range);
    let inserted = false;
    try { inserted = document.execCommand("insertText", false, text); } catch { /* fallback below */ }
    if (!inserted) element.textContent = text;
  } else {
    const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
    setter ? setter.call(element, text) : (element.value = text);
  }
  element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
  const normalize = (value) => String(value || "").replace(/\u200b/g, "").replace(/\r\n/g, "\n").trimEnd();
  const actual = element.isContentEditable ? (element.innerText || element.textContent || "") : element.value;
  if (normalize(actual) !== normalize(text)) throw new Error("typing verification failed; take a fresh snapshot before retrying");
  return { typed: ref, length: text.length, verified: true };
}

async function execute(message) {
  const { id, action, args = {} } = message;
  try {
    let result;
    if (action === "status") result = publicState();
    else if (action === "snapshot") {
      result = await inTab(snapshotPage, [Math.max(1, Math.min(200, Number(args.maxItems) || 100))]);
      sensitiveRefs = new Set((result?.items || []).filter((item) => item.sensitive).map((item) => item.ref));
    }
    else if (action === "watch") {
      const durationMs = Number(args.durationMs) || 10_000;
      const settleMs = Number(args.settleMs) || 500;
      const maxItems = Math.max(1, Math.min(200, Number(args.maxItems) || 100));
      if (!Number.isInteger(durationMs) || durationMs < 250 || durationMs > 30_000) throw new Error("watch durationMs must be 250..30000");
      if (!Number.isInteger(settleMs) || settleMs < 100 || settleMs > 2_000 || settleMs >= durationMs) throw new Error("watch settleMs must be 100..2000 and less than durationMs");
      const watch = await inTab(waitForVisibleChange, [durationMs, settleMs]);
      const snapshot = await inTab(snapshotPage, [maxItems]);
      result = { watch, ...snapshot };
      sensitiveRefs = new Set((result?.items || []).filter((item) => item.sensitive).map((item) => item.ref));
    }
    else if (action === "click") {
      if (!state.grants.click) throw new Error("click permission is off in the Neko extension");
      result = await inTab(clickRef, [String(args.ref || "")]);
    } else if (action === "type") {
      if (!state.grants.type) throw new Error("typing permission is off in the Neko extension");
      if (sensitiveRefs.has(String(args.ref || ""))) throw new Error("sensitive input is blocked; type it yourself");
      result = await inTab(typeRef, [String(args.ref || ""), String(args.text || "")]);
    } else if (action === "scroll") {
      if (!state.grants.click) throw new Error("click/scroll permission is off in the Neko extension");
      result = await inTab((deltaY) => { scrollBy({ top: deltaY, behavior: "smooth" }); return { scrolled: deltaY }; }, [Math.max(-4000, Math.min(4000, Number(args.deltaY) || 0))]);
    } else if (action === "navigate") {
      if (!state.grants.click) throw new Error("navigation permission is off in the Neko extension");
      const url = new URL(String(args.url || ""));
      if (!/^https?:$/.test(url.protocol)) throw new Error("only http(s) navigation is allowed");
      await chrome.tabs.update(state.tabId, { url: url.href });
      result = { navigating: url.origin + url.pathname };
    } else if (action === "detach") {
      await detach("agent");
      result = { detached: true };
    } else throw new Error("unknown browser action");
    send({ type: "result", id, action, ok: true, result });
    record(action, "ok");
  } catch (error) {
    send({ type: "result", id, action, ok: false, error: error.message || String(error) });
    record(action, "error");
  }
}

chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  (async () => {
    if (message.type === "status") return publicState();
    if (message.type === "attach") { await attachActiveTab(); return publicState(); }
    if (message.type === "detach") { await detach("user"); return publicState(); }
    if (message.type === "stop") { await emergencyStop(); return publicState(); }
    if (message.type === "grants") {
      state.grants = { click: !!message.click, type: !!message.typePermission };
      await persist();
      if (socket?.readyState === WebSocket.OPEN && state.tabId != null) {
        send({ type: "attached", tab: { id: state.tabId, url: state.tabOrigin, title: state.tabTitle }, grants: state.grants });
      }
      if (state.tabId != null) await showIndicator();
      return publicState();
    }
    throw new Error("unknown extension message");
  })().then((value) => respond({ ok: true, value }), (error) => respond({ ok: false, error: error.message || String(error) }));
  return true;
});

chrome.tabs.onRemoved.addListener((tabId) => { if (tabId === state.tabId) void detach("tab-closed"); });
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (tabId !== state.tabId || !change.url) return;
  try { if (new URL(change.url).origin !== state.tabOrigin) void detach("cross-origin-navigation"); }
  catch { void detach("invalid-navigation"); }
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== RECONNECT_ALARM || state.tabId == null || !state.token || state.connection !== "offline") return;
  void connect(false).catch(() => {});
});

// Connect for presence only. Pairing identifies this extension; it never grants a tab. The user must
// click Attach in the toolbar popup, which supplies Chrome's short-lived activeTab capability.
function connectForPresence() {
  if (state.tabId != null) return; // an attached session manages its own connection
  void connect(true).catch(() => {});
}
chrome.runtime.onInstalled.addListener(connectForPresence);
chrome.runtime.onStartup.addListener(connectForPresence);

// Side panel: a long-lived port from sidepanel.js. Forward its prompts to the neko bridge and keep
// it posted on connection state; connect to the bridge so the panel works even before a tab attach.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "neko-panel") return;
  panelPort = port;
  connectForPresence();
  void connect(true).catch(() => {}); // ensure a bridge connection exists to carry transcript
  port.postMessage({ type: "connected", online: state.connection === "ready" });
  // Gentle keep-connecting while the panel is open: retry every 5s when offline (neko may not be
  // running yet), so the panel links up on its own the moment the user starts neko - no console spam.
  if (!panelRetry) panelRetry = setInterval(() => {
    if (!panelPort) { clearInterval(panelRetry); panelRetry = null; return; }
    if (state.connection !== "ready") void connect(true).catch(() => {});
  }, 5000);
  port.onMessage.addListener((msg) => {
    if (!msg) return;
    if (msg.type === "prompt" && typeof msg.prompt === "string") {
      try { send({ type: "panel-in", prompt: msg.prompt }); }
      catch { try { port.postMessage({ type: "panel", event: { type: "line", line: { kind: "error", text: "Neko is offline - start neko in a terminal, then try again." } } }); } catch {} }
    } else if (msg.type === "hello") {
      port.postMessage({ type: "connected", online: state.connection === "ready" });
      if (socket?.readyState === WebSocket.OPEN) send({ type: "panel-ready" });
    }
  });
  port.onDisconnect.addListener(() => {
    if (panelPort === port) panelPort = null;
    if (panelRetry) { clearInterval(panelRetry); panelRetry = null; }
  });
});
// Clicking the toolbar icon opens the side panel on the current tab (in addition to the popup menu).
try { chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }); } catch {}

void restore();
