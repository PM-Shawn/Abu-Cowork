"use strict";
(() => {
  // src/popup/popup.ts
  var statusDot = document.getElementById("statusDot");
  var statusLabel = document.getElementById("statusLabel");
  var statusDetail = document.getElementById("statusDetail");
  var reconnectBtn = document.getElementById("reconnectBtn");
  var infoRow = document.getElementById("infoRow");
  var logList = document.getElementById("logList");
  function updateUI(s) {
    statusDot.className = "status-dot";
    if (s.connected) {
      statusDot.classList.add("connected");
      statusLabel.textContent = "Connected";
      statusDetail.textContent = `Port ${s.port ?? "?"}`;
    } else if (s.reconnecting) {
      statusDot.classList.add("reconnecting");
      statusLabel.textContent = "Reconnecting...";
      statusDetail.textContent = s.error ? s.error : s.discoveryOk ? "Bridge found, connecting..." : "Looking for abu-browser-bridge...";
    } else {
      statusDot.classList.add("disconnected");
      statusLabel.textContent = "Disconnected";
      statusDetail.textContent = s.error ?? "Make sure abu-browser-bridge is running";
    }
    const tags = [];
    if (s.discoveryOk) {
      tags.push(`<span class="tag ok">Discovery OK</span>`);
    } else {
      tags.push(`<span class="tag err">No Discovery</span>`);
    }
    if (s.connected) {
      tags.push(s.authenticated ? `<span class="tag ok">Auth OK</span>` : `<span class="tag warn">No Auth</span>`);
    }
    infoRow.innerHTML = tags.join("");
    const ops = s.recentOps ?? [];
    if (ops.length === 0) {
      logList.innerHTML = '<div class="log-empty">No operations yet</div>';
    } else {
      logList.innerHTML = ops.map((op) => {
        const cls = op.success ? "success" : "error";
        const icon = op.success ? "\u2713" : "\u2717";
        const timeStr = formatTime(op.time);
        return `<div class="log-item ${cls}"><span class="action">${icon} ${escapeHtml(op.action)}</span><span class="time">${timeStr}</span></div>`;
      }).join("");
    }
  }
  function formatTime(ts) {
    const d = new Date(ts);
    return d.toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }
  function escapeHtml(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  function refreshStatus() {
    chrome.runtime.sendMessage({ type: "get_status" }, (response) => {
      if (response) updateUI(response);
    });
  }
  reconnectBtn.addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "reconnect" }, () => {
      setTimeout(refreshStatus, 1e3);
    });
  });
  refreshStatus();
  setInterval(refreshStatus, 2e3);
})();
//# sourceMappingURL=popup.js.map
