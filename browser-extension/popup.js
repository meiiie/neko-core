const $ = (selector) => document.querySelector(selector);

async function request(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok) throw new Error(response?.error || "Neko extension request failed");
  return response.value;
}

function render(state) {
  const attached = !!state.attached;
  const ready = state.connection === "ready";
  $("#status").textContent = state.connection;
  $("#status").className = `pill ${state.connection}`;
  $(".dot").className = `dot ${state.connection}`;
  $("#tab-title").textContent = attached ? state.tabTitle || "Attached tab" : "No tab attached";
  $("#tab-host").textContent = attached ? state.tabHost : "Open Neko bridge, then attach this tab.";
  $("#read-grant").checked = attached;
  $("#click-grant").checked = !!state.grants.click;
  $("#type-grant").checked = !!state.grants.type;
  $("#attach").textContent = attached ? ready ? "Attached to Neko" : state.connection === "connecting" ? "Connecting..." : "Reconnect this tab" : "Attach this tab to Neko";
  $("#attach").disabled = attached && state.connection !== "offline";
  $("#detach").disabled = !attached;
  $("#stop").disabled = !attached;
  $("#session").textContent = `session ${state.session || "-"}`;
  const audit = state.audit || [];
  const list = $("#audit");
  list.replaceChildren();
  for (const item of audit.length ? audit : [{ action: "No actions yet", status: "" }]) {
    const row = document.createElement("li");
    const action = document.createElement("span");
    const status = document.createElement("small");
    action.textContent = item.action;
    status.textContent = item.status;
    row.append(action, status);
    list.append(row);
  }
}

async function act(message) {
  $("#error").textContent = "";
  try { render(await request(message)); }
  catch (error) { $("#error").textContent = error.message; }
}

$("#attach").addEventListener("click", () => act({ type: "attach" }));
$("#detach").addEventListener("click", () => act({ type: "detach" }));
$("#stop").addEventListener("click", () => act({ type: "stop" }));
for (const input of [$("#click-grant"), $("#type-grant")]) {
  input.addEventListener("change", () => act({ type: "grants", click: $("#click-grant").checked, typePermission: $("#type-grant").checked }));
}

void act({ type: "status" });
