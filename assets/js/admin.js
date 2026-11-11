// 管理後台邏輯：用同一組帳密登入所有已啟用的 Supabase 專案，
// 顯示每個專案的相片清單（可移除）、儲存容量/估算流量用量，並可個別開關上傳功能；
// 另外在主要專案上設定中獎號碼、查看中獎者。沒有審核機制，上傳後即公開。

import { loadProjects, formatBytes } from "./config.js";

const STORAGE_LIMIT_BYTES = 1 * 1024 * 1024 * 1024; // 1GB，Supabase 免費方案的 Storage 上限
const EGRESS_LIMIT_BYTES = 5 * 1024 * 1024 * 1024; // 5GB，Supabase 免費方案的流量上限

const loginSection = document.getElementById("login-section");
const loginForm = document.getElementById("login-form");
const loginStatus = document.getElementById("login-status");
const dashboardSection = document.getElementById("dashboard-section");
const dashboardStatus = document.getElementById("dashboard-status");
const panelsEl = document.getElementById("project-panels");
const lotteryEl = document.getElementById("lottery-panel");
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
  lotteryEl.innerHTML = "";
  dashboardSection.style.display = "none";
  loginSection.style.display = "block";
  setLoginStatus("");
});

refreshAllBtn.addEventListener("click", renderAllPanels);

async function renderAllPanels() {
  panelsEl.innerHTML = "";
  await renderLotteryPanel();
  for (const project of activeProjects) {
    const panel = await buildProjectPanel(project);
    panelsEl.appendChild(panel);
  }
}

/** 重新整理單一專案的面板（移除動作完成後用來更新用量數字與清單）。 */
async function refreshProjectPanel(project, oldPanelEl) {
  const newPanel = await buildProjectPanel(project);
  oldPanelEl.replaceWith(newPanel);
}

/** 抽獎設定：中獎號碼只存在「主要專案」（projects.json 裡 priority 最小的專案）。 */
async function renderLotteryPanel() {
  const panel = lotteryEl;
  panel.innerHTML = "";

  const allProjects = await getClients();
  const primaryLabel = allProjects[0].label;
  const primary = activeProjects.find((p) => p.label === primaryLabel);
  if (!primary) {
    panel.innerHTML = `<div class="status-msg error">無法登入主要專案「${escapeHtml(primaryLabel)}」，抽獎設定暫時無法使用。</div>`;
    return;
  }

  const [slotsRes, claimsRes] = await Promise.all([
    primary.client.from("winning_numbers").select("*").order("seq", { ascending: true }),
    primary.client.from("upload_claims").select("seq").order("seq", { ascending: false }).limit(1),
  ]);
  if (slotsRes.error || claimsRes.error) {
    const msg = (slotsRes.error || claimsRes.error).message;
    panel.innerHTML = `<div class="status-msg error">讀取抽獎設定失敗：${escapeHtml(msg)}（是否已在主要專案重新執行 setup.sql？）</div>`;
    return;
  }

  const slots = slotsRes.data || [];
  const lastSeq = claimsRes.data && claimsRes.data[0] ? claimsRes.data[0].seq : 0;

  const rowsHtml = slots.length
    ? slots
        .map((s) => {
          const status = s.awarded_upload_id
            ? `🏆 <strong>${escapeHtml(s.winner_name || "匿名")}</strong>（上傳 #${s.awarded_seq}${
                s.awarded_seq !== s.seq ? "，順延" : ""
              }，${new Date(s.awarded_at).toLocaleString()}）`
            : lastSeq >= s.seq
            ? "⏳ 已到號碼，等待符合資格的上傳者"
            : "尚未到達";
          return `<tr>
            <td>#${s.seq}</td>
            <td>${escapeHtml(s.label || "")}</td>
            <td>${status}</td>
            <td><button class="btn btn-danger btn-small" data-seq="${s.seq}">刪除</button></td>
          </tr>`;
        })
        .join("")
    : `<tr><td colspan="4" class="empty-state">還沒有設定中獎號碼</td></tr>`;

  panel.innerHTML = `
    <div class="project-panel">
      <div class="project-panel-header"><h3>🎁 抽獎設定（${escapeHtml(primaryLabel)}）</h3></div>
      <div class="project-panel-body">
        <p style="margin:0 0 12px;">目前已發出的上傳序號：<strong>${lastSeq}</strong></p>
        <form id="slot-form" style="display:flex; gap:8px; flex-wrap:wrap; align-items:flex-end; margin-bottom:12px;">
          <div><label class="field-label" for="slot-seq">中獎號碼</label>
            <input type="number" id="slot-seq" min="1" step="1" required style="width:120px;" /></div>
          <div><label class="field-label" for="slot-label">備註（選填）</label>
            <input type="text" id="slot-label" maxlength="30" placeholder="例如：頭獎" /></div>
          <button type="submit" class="btn btn-small">新增</button>
        </form>
        <div style="overflow-x:auto;">
          <table class="lottery-table">
            <thead><tr><th>號碼</th><th>備註</th><th>狀態</th><th></th></tr></thead>
            <tbody>${rowsHtml}</tbody>
          </table>
        </div>
        <p style="color:var(--color-muted); font-size:0.85rem; margin:12px 0 0;">
          規則：第 N 號上傳的賓客中獎；若他已經中過獎（同一個裝置），名額會順延給之後第一位還沒中過獎的上傳者。
        </p>
      </div>
    </div>
  `;

  panel.querySelector("#slot-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const seq = parseInt(panel.querySelector("#slot-seq").value, 10);
    const label = panel.querySelector("#slot-label").value.trim();
    if (!Number.isInteger(seq) || seq < 1) return;
    const { error } = await primary.client
      .from("winning_numbers")
      .insert({ seq, label: label || null });
    if (error) {
      alert(error.code === "23505" ? "這個號碼已經設定過了" : `新增失敗：${error.message}`);
      return;
    }
    await renderLotteryPanel();
  });

  panel.querySelectorAll("button[data-seq]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (!confirm(`確定要刪除中獎號碼 #${btn.dataset.seq} 嗎？`)) return;
      const { error } = await primary.client
        .from("winning_numbers")
        .delete()
        .eq("seq", Number(btn.dataset.seq));
      if (error) {
        alert(`刪除失敗：${error.message}`);
        return;
      }
      await renderLotteryPanel();
    });
  });
}

async function fetchProjectData(project) {
  const [mediaRes, settingsRes] = await Promise.all([
    project.client.from("media").select("*"),
    project.client.from("project_settings").select("*").eq("id", 1).single(),
  ]);
  if (mediaRes.error) throw mediaRes.error;
  if (settingsRes.error) throw settingsRes.error;

  const allRows = mediaRes.data || [];
  const photos = allRows
    .filter((r) => r.status === "approved")
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  const storageUsedBytes = allRows.reduce((sum, r) => sum + (r.size_bytes || 0), 0);

  return { photos, storageUsedBytes, settings: settingsRes.data };
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

  const photosToggle = document.createElement("button");
  photosToggle.className = "btn btn-secondary btn-small";
  photosToggle.style.margin = "20px 0 12px";
  photosToggle.textContent = `顯示相片 (${data.photos.length})`;

  const photosGrid = document.createElement("div");
  photosGrid.className = "pending-grid";
  photosGrid.style.display = "none";
  data.photos.forEach((row) =>
    photosGrid.appendChild(buildPhotoItem(project, row, () => refreshProjectPanel(project, panel)))
  );

  photosToggle.addEventListener("click", () => {
    const showing = photosGrid.style.display !== "none";
    photosGrid.style.display = showing ? "none" : "grid";
    photosToggle.textContent = showing
      ? `顯示相片 (${data.photos.length})`
      : `隱藏相片 (${data.photos.length})`;
  });

  body.appendChild(photosToggle);
  body.appendChild(photosGrid);

  panel.appendChild(header);
  panel.appendChild(body);
  return panel;
}

function buildPhotoItem(project, row, onDone) {
  const item = document.createElement("div");
  item.className = "pending-item";

  const thumbWrap = document.createElement("div");
  thumbWrap.className = "thumb-wrap";
  const { data: urlData } = project.client.storage.from("approved").getPublicUrl(row.storage_path);
  if (row.media_type === "image") {
    const img = document.createElement("img");
    img.loading = "lazy";
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
    <strong>${row.seq ? `#${row.seq} ` : ""}${escapeHtml(row.uploader_name || "匿名")}</strong>
    ${row.caption ? escapeHtml(row.caption) : ""}
    <div>${formatBytes(row.size_bytes)} · ${new Date(row.created_at).toLocaleString()}</div>
  `;

  const actions = document.createElement("div");
  actions.className = "actions";

  const removeBtn = document.createElement("button");
  removeBtn.className = "btn btn-danger btn-small";
  removeBtn.textContent = "移除";
  removeBtn.addEventListener("click", () => handleRemovePhoto(project, row, removeBtn, onDone));

  actions.append(removeBtn);

  item.append(thumbWrap, meta, actions);
  return item;
}

async function handleRemovePhoto(project, row, removeBtn, onDone) {
  if (!confirm("確定要把這張照片從相簿移除並刪除嗎？此動作無法復原。")) return;
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
