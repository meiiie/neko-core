(() => {
  const HOST_ID = "__neko_browser_control__";
  let host = document.getElementById(HOST_ID);
  if (!host) {
    host = document.createElement("div");
    host.id = HOST_ID;
    host.setAttribute("data-neko-browser-control", "active");
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = `
      <style>
        :host { all: initial; }
        .panel {
          position: fixed; top: 12px; right: 12px; z-index: 2147483647;
          display: flex; align-items: center; gap: 8px; min-height: 34px;
          padding: 5px 6px 5px 10px; border: 1px solid rgba(245,158,11,.58);
          border-radius: 9px; background: rgba(11,11,11,.94); color: #e7e5e4;
          box-shadow: 0 8px 28px rgba(0,0,0,.3); backdrop-filter: blur(12px);
          font: 600 12px/1.2 ui-monospace, "SFMono-Regular", Consolas, monospace;
        }
        .pulse { width: 7px; height: 7px; border-radius: 50%; background: #22c55e; box-shadow: 0 0 0 4px rgba(34,197,94,.13); }
        .label { white-space: nowrap; }
        .grants { color: #a8a29e; font-size: 10px; font-weight: 500; }
        button {
          min-width: 44px; height: 25px; padding: 0 8px; border: 1px solid #7f1d1d;
          border-radius: 6px; background: #2a1111; color: #fca5a5; cursor: pointer;
          font: 600 11px/1 ui-monospace, "SFMono-Regular", Consolas, monospace;
        }
        button:hover, button:focus-visible { background: #451a1a; outline: 2px solid rgba(248,113,113,.45); outline-offset: 1px; }
        @media (max-width: 520px) {
          .panel { top: max(8px, env(safe-area-inset-top)); right: 8px; }
          .label { display: none; }
        }
        @media (prefers-reduced-motion: reduce) { .pulse { box-shadow: none; } }
      </style>
      <div class="panel" role="status" aria-live="polite">
        <span class="pulse" aria-hidden="true"></span>
        <span class="label">Neko is using this tab</span>
        <span class="grants">read</span>
        <button type="button" aria-label="Emergency detach Neko from this tab">Stop</button>
      </div>`;
    root.querySelector("button").addEventListener("click", () => {
      chrome.runtime.sendMessage({ type: "stop" }).catch(() => {});
    });
    document.documentElement.append(host);
    chrome.runtime.onMessage.addListener((message) => {
      if (message?.type !== "neko-indicator-update") return;
      const parts = ["read"];
      if (message.grants?.click) parts.push("act");
      if (message.grants?.type) parts.push("type");
      root.querySelector(".grants").textContent = parts.join(" + ");
      root.querySelector(".pulse").style.background = message.connected ? "#22c55e" : "#f59e0b";
    });
  }
})();
