// 審核後台邏輯：用同一組帳密登入所有已啟用的 Supabase 專案，
// 顯示每個專案的待審核項目、儲存容量/估算流量用量，並可個別開關上傳功能。

import { loadProjects, formatBytes } from "./config.js";

const STORAGE_LIMIT_BYTES = 1 * 1024 * 1024 * 1024; // 1GB，Supabase 免費方案的 Storage 上限
const EGRESS_LIMIT_BYTES = 5 * 1024 * 1024 * 1024; // 5GB，Supabase 免費方案的流量上限

const loginSection = document.getElementById("login-section");
const loginForm = document.getElementById("login-form");
const loginStatus = document.getElementById("login-status");
const dashboardSection = document.getElementById("dashboard-section");
const dashboardStatus = document.getElementById("dashboard-status");
const panelsEl = document.getElementById("project-panels");
const refreshAllBtn = document.getElementById("refresh-all-btn");
const logoutBtn = document.getElementById("logout-btn");

/** 已成功登入的專案：{label, url, anonKey, priority, client} */
let activeProjects = [];

/** 快取已建立的 client 清單，避免每次登入嘗試都重新建立 GoTrueClient 實例。 */
let _clientsPromise = null;
function getClients() {
  if (!_clientsPromise) {
    _clientsPromise = loadProjects({ persistSession: true });
  }
  return _clientsPromise;
}

function setLoginStatus(message, type = "info") {
  loginStatus.innerHTML = message ? `<div class="status-msg ${type}">${message}</div>` : "";
}

function setDashboardStatus(message, type = "info") {
  dashboardStatus.innerHTML = message ? `<div class="status-msg ${type}">${message}</div>` : "";
}

loginForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  setLoginStatus("登入中…", "info");
  const email = document.getElementById("login-email").value.trim();
  const password = document.getElementById("login-password").value;

  let projects;
  try {
    projects = await getClients();
  } catch (err) {
    setLoginStatus(`無法讀取專案設定：${err.message}`, "error");
    return;
  }

  const results = await Promise.all(
    projects.map(async (p) => {
      try {
        const { error } = await p.client.auth.signInWithPassword({ email, password });
        return { project: p, ok: !error, error };
      } catch (err) {
        return { project: p, ok: false, error: err };
      }
    })
  );

  activeProjects = results.filter((r) => r.ok).map((r) => r.project);
  const failed = results.filter((r) => !r.ok);

  if (activeProjects.length === 0) {
    setLoginStatus("登入失敗，請確認帳號密碼是否正確，且已在該專案建立管理員帳號", "error");
    return;
  }

  loginSection.style.display = "none";
  dashboardSection.style.display = "block";

  if (failed.length > 0) {
    setDashboardStatus(
      `⚠️ 以下專案登入失敗（可能尚未在該專案建立管理員帳號）：${failed
        .map((f) => f.project.label)
        .join("、")}`,
      "warn"
    );
  } else {
    setDashboardStatus("");
  }

  await renderAllPanels();
});

logoutBtn.addEventListener("click", async () => {
  await Promise.all(activeProjects.map((p) => p.client.auth.signOut().catch(() => {})));
  activeProjects = [];
  panelsEl.innerHTML = "";
  dashboardSection.style.display = "none";
  loginSection.style.display = "block";
  setLoginStatus("");
});

refreshAllBtn.addEventListener("click", renderAllPanels);

async function renderAllPanels() {
  panelsEl.innerHTML = "";
  for (const project of activeProjects) {
    const panel = await buildProjectPanel(project);
    panelsEl.appendChild(panel);
  }
}

/** 重新整理單一專案的面板（審核/移除動作完成後用來更新用量數字與清單）。 */
async function refreshProjectPanel(project, oldPanelEl) {
  const newPanel = await buildProjectPanel(project);
  oldPanelEl.replaceWith(newPanel);
}

async function fetchProjectData(project) {
  const [mediaRes, settingsRes] = await Promise.all([
    project.client.from("media").select("*"),
    project.client.from("project_settings").select("*").eq("id", 1).single(),
  ]);
  if (mediaRes.error) throw mediaRes.error;
  if (settingsRes.error) throw settingsRes.error;

  const allRows = mediaRes.data || [];
  const pending = allRows
    .filter((r) => r.status === "pending")
    .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  const approved = allRows
    .filter((r) => r.status === "approved")
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  const storageUsedBytes = allRows.reduce((sum, r) => sum + (r.size_bytes || 0), 0);

  return { pending, approved, storageUsedBytes, settings: settingsRes.data };
}

function usageBarHtml(label, used, limit) {
  const pct = Math.min(100, (used / limit) * 100);
  let cls = "";
  if (pct >= 90) cls = "danger";
  else if (pct >= 70) cls = "warn";
  return `
    <div class="usage-bar">
      <div class="usage-bar-label">
        <span>${label}</span>
        <span>${formatBytes(used)} / ${formatBytes(limit)}</span>
      </div>
      <div class="usage-bar-track">
        <div class="usage-bar-fill ${cls}" style="width:${pct}%"></div>
      </div>
    </div>
  `;
}

async function buildProjectPanel(project) {
  const panel = document.createElement("div");
  panel.className = "project-panel";

  let data;
  try {
    data = await fetchProjectData(project);
  } catch (err) {
    panel.innerHTML = `
      <div class="project-panel-header"><h3>${escapeHtml(project.label)}</h3></div>
      <div class="project-panel-body">
        <div class="status-msg error">讀取失敗：${escapeHtml(err.message)}</div>
      </div>
    `;
    return panel;
  }

  const header = document.createElement("div");
  header.className = "project-panel-header";
  header.innerHTML = `
    <h3>${escapeHtml(project.label)}</h3>
    <label class="toggle-switch">
      <input type="checkbox" ${data.settings.uploads_enabled ? "checked" : ""} />
      開放上傳
    </label>
  `;
  const toggleInput = header.querySelector("input");
  toggleInput.addEventListener("change", async () => {
    const newVal = toggleInput.checked;
    toggleInput.disabled = true;
    const { error } = await project.client
      .from("project_settings")
      .update({ uploads_enabled: newVal })
      .eq("id", 1);
    toggleInput.disabled = false;
    if (error) {
      toggleInput.checked = !newVal;
      alert(`更新失敗：${error.message}`);
    }
  });

  const body = document.createElement("div");
  body.className = "project-panel-body";

  const usageWrap = document.createElement("div");
  usageWrap.className = "usage-bars";
  usageWrap.innerHTML =
    usageBarHtml("Storage 容量", data.storageUsedBytes, STORAGE_LIMIT_BYTES) +
    usageBarHtml("估算流量（Egress）", data.settings.estimated_egress_bytes, EGRESS_LIMIT_BYTES);
  body.appendChild(usageWrap);

  const pendingHeading = document.createElement("h4");
  pendingHeading.textContent = `待審核 (${data.pending.length})`;
  pendingHeading.style.margin = "16px 0 8px";
  body.appendChild(pendingHeading);

  if (data.pending.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = "目前沒有待審核的項目 🎉";
    empty.style.padding = "12px 0";
    body.appendChild(empty);
  } else {
    const grid = document.createElement("div");
    grid.className = "pending-grid";
    data.pending.forEach((row) => grid.appendChild(buildPendingItem(project, row, () => refreshProjectPanel(project, panel))));
    body.appendChild(grid);
  }

  const approvedHeading = document.createElement("button");
  approvedHeading.className = "btn btn-secondary btn-small";
  approvedHeading.style.margin = "20px 0 12px";
  approvedHeading.textContent = `顯示已通過相片 (${data.approved.length})`;

  const approvedGrid = document.createElement("div");
  approvedGrid.className = "pending-grid";
  approvedGrid.style.display = "none";
  data.approved.forEach((row) =>
    approvedGrid.appendChild(buildApprovedItem(project, row, () => refreshProjectPanel(project, panel)))
  );

  approvedHeading.addEventListener("click", () => {
    const showing = approvedGrid.style.display !== "none";
    approvedGrid.style.display = showing ? "none" : "grid";
    approvedHeading.textContent = showing
      ? `顯示已通過相片 (${data.approved.length})`
      : `隱藏已通過相片 (${data.approved.length})`;
  });

  body.appendChild(approvedHeading);
  body.appendChild(approvedGrid);

  panel.appendChild(header);
  panel.appendChild(body);
  return panel;
}

function buildPendingItem(project, row, onDone) {
  const item = document.createElement("div");
  item.className = "pending-item";

  const thumbWrap = document.createElement("div");
  thumbWrap.className = "thumb-wrap";

  // pending bucket 是私有的，用簽名網址（短時效）給管理員預覽。
  project.client.storage
    .from("pending")
    .createSignedUrl(row.storage_path, 300)
    .then(({ data, error }) => {
      if (error || !data) return;
      if (row.media_type === "image") {
        const img = document.createElement("img");
        img.src = data.signedUrl;
        thumbWrap.appendChild(img);
      } else {
        const video = document.createElement("video");
        video.src = data.signedUrl;
        video.controls = true;
        thumbWrap.appendChild(video);
      }
    });

  const meta = document.createElement("div");
  meta.className = "meta";
  meta.innerHTML = `
    <strong>${escapeHtml(row.uploader_name || "匿名")}</strong>
    ${row.caption ? escapeHtml(row.caption) : ""}
    <div>${formatBytes(row.size_bytes)} · ${new Date(row.created_at).toLocaleString()}</div>
  `;

  const actions = document.createElement("div");
  actions.className = "actions";

  const approveBtn = document.createElement("button");
  approveBtn.className = "btn btn-success btn-small";
  approveBtn.textContent = "通過";
  approveBtn.addEventListener("click", () => handleApprove(project, row, approveBtn, rejectBtn, onDone));

  const rejectBtn = document.createElement("button");
  rejectBtn.className = "btn btn-danger btn-small";
  rejectBtn.textContent = "拒絕";
  rejectBtn.addEventListener("click", () => handleReject(project, row, approveBtn, rejectBtn, onDone));

  actions.append(approveBtn, rejectBtn);

  item.append(thumbWrap, meta, actions);
  return item;
}

function buildApprovedItem(project, row, onDone) {
  const item = document.createElement("div");
  item.className = "pending-item";

  const thumbWrap = document.createElement("div");
  thumbWrap.className = "thumb-wrap";
  const { data: urlData } = project.client.storage.from("approved").getPublicUrl(row.storage_path);
  if (row.media_type === "image") {
    const img = document.createElement("img");
    img.src = urlData.publicUrl;
    thumbWrap.appendChild(img);
  } else {
    const video = document.createElement("video");
    video.src = urlData.publicUrl;
    video.controls = true;
    thumbWrap.appendChild(video);
  }

  const meta = document.createElement("div");
  meta.className = "meta";
  meta.innerHTML = `
    <strong>${escapeHtml(row.uploader_name || "匿名")}</strong>
    ${row.caption ? escapeHtml(row.caption) : ""}
    <div>${formatBytes(row.size_bytes)} · ${new Date(row.created_at).toLocaleString()}</div>
  `;

  const actions = document.createElement("div");
  actions.className = "actions";

  const removeBtn = document.createElement("button");
  removeBtn.className = "btn btn-danger btn-small";
  removeBtn.textContent = "移除";
  removeBtn.addEventListener("click", () => handleRemoveApproved(project, row, removeBtn, onDone));

  actions.append(removeBtn);

  item.append(thumbWrap, meta, actions);
  return item;
}

async function handleApprove(project, row, approveBtn, rejectBtn, onDone) {
  approveBtn.disabled = true;
  rejectBtn.disabled = true;
  approveBtn.textContent = "處理中…";
  try {
    const { error: moveError } = await project.client.storage
      .from("pending")
      .move(row.storage_path, row.storage_path, { destinationBucket: "approved" });
    if (moveError) throw moveError;

    const { error: updateError } = await project.client
      .from("media")
      .update({ status: "approved", bucket: "approved", approved_at: new Date().toISOString() })
      .eq("id", row.id);
    if (updateError) throw updateError;

    await onDone();
  } catch (err) {
    alert(`通過失敗：${err.message}`);
    approveBtn.disabled = false;
    rejectBtn.disabled = false;
    approveBtn.textContent = "通過";
  }
}

async function handleReject(project, row, approveBtn, rejectBtn, onDone) {
  if (!confirm("確定要拒絕並刪除這個檔案嗎？此動作無法復原。")) return;
  approveBtn.disabled = true;
  rejectBtn.disabled = true;
  rejectBtn.textContent = "處理中…";
  try {
    await project.client.storage.from("pending").remove([row.storage_path]);
    const { error } = await project.client.from("media").delete().eq("id", row.id);
    if (error) throw error;
    await onDone();
  } catch (err) {
    alert(`拒絕失敗：${err.message}`);
    approveBtn.disabled = false;
    rejectBtn.disabled = false;
    rejectBtn.textContent = "拒絕";
  }
}

async function handleRemoveApproved(project, row, removeBtn, onDone) {
  if (!confirm("確定要把這張已公開的照片下架並刪除嗎？此動作無法復原。")) return;
  removeBtn.disabled = true;
  removeBtn.textContent = "處理中…";
  try {
    await project.client.storage.from("approved").remove([row.storage_path]);
    const { error } = await project.client.from("media").delete().eq("id", row.id);
    if (error) throw error;
    await onDone();
  } catch (err) {
    alert(`移除失敗：${err.message}`);
    removeBtn.disabled = false;
    removeBtn.textContent = "移除";
  }
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str ?? "";
  return div.innerHTML;
}
