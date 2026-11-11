// 公開相簿頁邏輯：合併所有已啟用專案中的照片/影片，依時間排序顯示，
// 並在照片/影片實際被載入時，呼叫 track_egress 估算流量消耗（供 admin 監控用）。

import { loadProjects, formatBytes } from "./config.js";

const gridEl = document.getElementById("gallery-grid");
const emptyEl = document.getElementById("gallery-empty");
const statusEl = document.getElementById("gallery-status");

const lightbox = document.getElementById("lightbox");
const lightboxContent = document.getElementById("lightbox-content");
const lightboxMeta = document.getElementById("lightbox-meta");
const lightboxClose = document.getElementById("lightbox-close");
const lightboxPrev = document.getElementById("lightbox-prev");
const lightboxNext = document.getElementById("lightbox-next");

let items = [];
let currentIndex = -1;
const trackedIds = new Set();

function setStatus(message, type = "info") {
  statusEl.innerHTML = message ? `<div class="status-msg ${type}">${message}</div>` : "";
}

async function fetchApprovedForProject(project) {
  const { data, error } = await project.client
    .from("media")
    .select("id, storage_path, media_type, size_bytes, uploader_name, caption, created_at, seq")
    .eq("status", "approved")
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data || []).map((row) => {
    const { data: urlData } = project.client.storage.from("approved").getPublicUrl(row.storage_path);
    return {
      ...row,
      projectLabel: project.label,
      client: project.client,
      publicUrl: urlData.publicUrl,
    };
  });
}

function trackEgressOnce(item) {
  if (trackedIds.has(item.id)) return;
  trackedIds.add(item.id);
  item.client.rpc("track_egress", { bytes: item.size_bytes }).then(
    () => {},
    () => {} // 估算流量失敗不影響瀏覽體驗，靜默忽略即可
  );
}

function buildTile(item, index) {
  const tile = document.createElement("div");
  tile.className = "gallery-tile";
  tile.addEventListener("click", () => openLightbox(index));

  if (item.media_type === "image") {
    const img = document.createElement("img");
    img.loading = "lazy";
    img.alt = item.caption || `由 ${item.uploader_name || "訪客"} 上傳`;
    img.src = item.publicUrl;
    img.addEventListener("load", () => trackEgressOnce(item), { once: true });
    tile.appendChild(img);
  } else {
    const placeholder = document.createElement("div");
    placeholder.className = "video-placeholder";
    placeholder.textContent = "▶";
    tile.appendChild(placeholder);
  }

  if (item.uploader_name || item.seq) {
    const overlay = document.createElement("div");
    overlay.className = "caption-overlay";
    overlay.textContent = [item.seq ? `#${item.seq}` : "", item.uploader_name || ""]
      .filter(Boolean)
      .join(" ");
    tile.appendChild(overlay);
  }

  return tile;
}

function renderGrid() {
  gridEl.innerHTML = "";
  if (items.length === 0) {
    emptyEl.style.display = "block";
    return;
  }
  emptyEl.style.display = "none";
  items.forEach((item, index) => gridEl.appendChild(buildTile(item, index)));
}

function openLightbox(index) {
  currentIndex = index;
  renderLightbox();
  lightbox.classList.remove("hidden");
}

function closeLightbox() {
  lightbox.classList.add("hidden");
  lightboxContent.innerHTML = "";
}

function renderLightbox() {
  const item = items[currentIndex];
  if (!item) return;
  lightboxContent.innerHTML = "";

  let mediaEl;
  if (item.media_type === "image") {
    mediaEl = document.createElement("img");
    mediaEl.src = item.publicUrl;
    mediaEl.addEventListener("load", () => trackEgressOnce(item), { once: true });
  } else {
    mediaEl = document.createElement("video");
    mediaEl.src = item.publicUrl;
    mediaEl.controls = true;
    mediaEl.autoplay = true;
    mediaEl.addEventListener("loadeddata", () => trackEgressOnce(item), { once: true });
  }
  lightboxContent.appendChild(mediaEl);

  const parts = [];
  if (item.seq) parts.push(`#${item.seq}`);
  if (item.uploader_name) parts.push(`👤 ${escapeHtml(item.uploader_name)}`);
  if (item.caption) parts.push(escapeHtml(item.caption));
  const downloadLink = `<a href="${item.publicUrl}" download style="color:#fff;text-decoration:underline;">下載</a>`;
  lightboxMeta.innerHTML = `${parts.join(" · ")}${parts.length ? " · " : ""}${downloadLink}`;
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

lightboxClose.addEventListener("click", closeLightbox);
lightbox.addEventListener("click", (e) => {
  if (e.target === lightbox) closeLightbox();
});
lightboxPrev.addEventListener("click", () => {
  currentIndex = (currentIndex - 1 + items.length) % items.length;
  renderLightbox();
});
lightboxNext.addEventListener("click", () => {
  currentIndex = (currentIndex + 1) % items.length;
  renderLightbox();
});
document.addEventListener("keydown", (e) => {
  if (lightbox.classList.contains("hidden")) return;
  if (e.key === "Escape") closeLightbox();
  if (e.key === "ArrowLeft") lightboxPrev.click();
  if (e.key === "ArrowRight") lightboxNext.click();
});

async function init() {
  setStatus("載入相簿中…", "info");
  try {
    const projects = await loadProjects();
    const results = await Promise.allSettled(projects.map(fetchApprovedForProject));
    const merged = [];
    let anyFailed = false;
    results.forEach((r) => {
      if (r.status === "fulfilled") merged.push(...r.value);
      else anyFailed = true;
    });
    merged.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    items = merged;
    renderGrid();
    setStatus(
      anyFailed ? "部分相簿來源暫時無法連線，可能無法顯示全部照片" : "",
      "warn"
    );
  } catch (err) {
    setStatus(`載入相簿失敗：${err.message}`, "error");
  }
}

init();
