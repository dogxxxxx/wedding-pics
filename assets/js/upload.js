// 上傳頁邏輯：挑選目前開放中的 Supabase 專案 → 驗證/壓縮檔案 → 上傳到 approved bucket → 向主要專案取得上傳序號 → 寫入 media 紀錄。
// 若上傳失敗（例如該專案容量已滿），會自動改試下一個開放中的專案。
// 沒有審核機制：上傳完成就直接公開。

import { loadProjects, formatBytes, detectMediaType } from "./config.js";
import { compressImageIfPossible } from "./imageCompress.js";
import { getDeviceToken, initWinnerUi } from "./lottery.js";

const MAX_IMAGE_BYTES = 20 * 1024 * 1024; // 20MB（壓縮前的原始檔案上限）
const MAX_VIDEO_BYTES = 100 * 1024 * 1024; // 100MB，對齊 Storage bucket 的 file_size_limit

const form = document.getElementById("upload-form");
const fileInput = document.getElementById("file-input");
const fileDrop = document.getElementById("file-drop");
const nameInput = document.getElementById("uploader-name");
const captionInput = document.getElementById("caption");
const submitBtn = document.getElementById("submit-btn");
const queueEl = document.getElementById("upload-queue");
const statusEl = document.getElementById("form-status");
const fileListLabel = document.getElementById("file-list-label");

let selectedFiles = [];
let projectsCache = null;
const winnerUi = initWinnerUi();

function setStatus(message, type = "info") {
  if (!message) {
    statusEl.innerHTML = "";
    return;
  }
  statusEl.innerHTML = `<div class="status-msg ${type}">${message}</div>`;
}

function updateFileListLabel() {
  if (selectedFiles.length === 0) {
    fileListLabel.textContent = "點此選擇或拖曳照片／影片到這裡（可一次選多個）";
  } else {
    fileListLabel.textContent = `已選擇 ${selectedFiles.length} 個檔案，點此可重新選擇`;
  }
}

fileDrop.addEventListener("click", () => fileInput.click());
fileDrop.addEventListener("dragover", (e) => {
  e.preventDefault();
  fileDrop.classList.add("dragover");
});
fileDrop.addEventListener("dragleave", () => fileDrop.classList.remove("dragover"));
fileDrop.addEventListener("drop", (e) => {
  e.preventDefault();
  fileDrop.classList.remove("dragover");
  selectedFiles = Array.from(e.dataTransfer.files);
  updateFileListLabel();
});
fileInput.addEventListener("change", () => {
  selectedFiles = Array.from(fileInput.files);
  updateFileListLabel();
});

async function getProjects() {
  if (!projectsCache) {
    projectsCache = await loadProjects();
  }
  return projectsCache;
}

/** 依 priority 依序找出目前 uploads_enabled = true 的專案清單（保留順序，供失敗時重試下一個）。 */
async function getUploadableProjectsInOrder() {
  const projects = await getProjects();
  const checks = await Promise.all(
    projects.map(async (p) => {
      try {
        const { data, error } = await p.client
          .from("project_settings")
          .select("uploads_enabled")
          .eq("id", 1)
          .single();
        if (error) return null;
        return data && data.uploads_enabled ? p : null;
      } catch {
        return null;
      }
    })
  );
  return checks.filter(Boolean);
}

function validateFile(file) {
  const mediaType = detectMediaType(file.type);
  if (!mediaType) {
    return { ok: false, reason: `不支援的檔案類型：${file.type || "未知"}` };
  }
  if (mediaType === "image" && file.size > MAX_IMAGE_BYTES) {
    return { ok: false, reason: `照片超過 ${formatBytes(MAX_IMAGE_BYTES)} 上限` };
  }
  if (mediaType === "video" && file.size > MAX_VIDEO_BYTES) {
    return { ok: false, reason: `影片超過 ${formatBytes(MAX_VIDEO_BYTES)} 上限` };
  }
  return { ok: true, mediaType };
}

function createQueueItem(file) {
  const row = document.createElement("div");
  row.className = "upload-item state-uploading";
  const thumb = document.createElement(file.type.startsWith("video/") ? "div" : "img");
  thumb.className = "thumb";
  if (file.type.startsWith("image/")) {
    thumb.src = URL.createObjectURL(file);
  } else {
    thumb.textContent = "🎬";
    thumb.style.display = "flex";
    thumb.style.alignItems = "center";
    thumb.style.justifyContent = "center";
  }
  const name = document.createElement("div");
  name.className = "name";
  name.textContent = file.name;
  const state = document.createElement("div");
  state.className = "state";
  state.innerHTML = `<span class="spinner"></span>`;
  row.append(thumb, name, state);
  queueEl.appendChild(row);
  return {
    setSuccess(seq) {
      row.className = "upload-item state-success";
      state.textContent = seq ? `已上傳 · 編號 #${seq}` : "已上傳";
    },
    setError(msg) {
      row.className = "upload-item state-error";
      state.textContent = msg || "上傳失敗";
    },
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 向主要專案取得全站上傳序號並得知是否中獎。以 uploadId 為鍵，重試或換專案時會拿到同一組結果。
 * 取不到時（例如主要專案暫時連不上）回傳 null，檔案仍會照常上傳，只是沒有編號。
 */
async function claimNumber(primary, uploadId, deviceToken, uploaderName) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const { data, error } = await primary.client.rpc("claim_upload_number", {
        p_upload_id: uploadId,
        p_token: deviceToken,
        p_name: uploaderName,
      });
      if (error) throw error;
      const row = Array.isArray(data) ? data[0] : data;
      if (row) return { seq: Number(row.out_seq), isWinner: !!row.out_is_winner };
    } catch {
      // 稍等一下再重試
    }
    await sleep(400 * (attempt + 1));
  }
  return null;
}

/** 嘗試把單一檔案上傳到「可用專案清單」中依序的每一個，直到成功為止。 */
async function uploadOneFile(file, mediaType, uploaderName, caption, uploadableProjects, primary) {
  let blob = file;
  let ext;
  let mimeType = file.type;
  try {
    if (mediaType === "image") {
      const compressed = await compressImageIfPossible(file);
      blob = compressed.blob;
      ext = compressed.ext;
      mimeType = compressed.mimeType;
    } else {
      const map = { "video/mp4": "mp4", "video/quicktime": "mov", "video/webm": "webm" };
      ext = map[file.type] || "mp4";
    }
  } catch (err) {
    return { ok: false, error: err };
  }

  const uploadId = crypto.randomUUID();
  const path = `${uploadId}.${ext}`;
  const deviceToken = getDeviceToken();
  let claim = null;
  let claimed = false;
  let lastError = null;

  for (const project of uploadableProjects) {
    try {
      const { error: uploadError } = await project.client.storage
        .from("approved")
        .upload(path, blob, { contentType: mimeType, upsert: false });
      if (uploadError) throw uploadError;

      // 檔案確定上傳成功後才取號，失敗的上傳不會浪費號碼（尤其是中獎號碼）。
      if (!claimed) {
        claim = await claimNumber(primary, uploadId, deviceToken, uploaderName);
        claimed = true;
      }

      const { error: insertError } = await project.client.from("media").insert({
        bucket: "approved",
        storage_path: path,
        media_type: mediaType,
        size_bytes: blob.size,
        uploader_name: uploaderName,
        caption: caption || null,
        status: "approved",
        seq: claim ? claim.seq : null,
      });
      if (insertError) {
        // 資料表寫入失敗的話，把剛剛上傳的檔案清掉，避免留下孤兒檔案。
        await project.client.storage.from("approved").remove([path]);
        throw insertError;
      }

      return { ok: true, project, seq: claim ? claim.seq : null, isWinner: !!(claim && claim.isWinner) };
    } catch (err) {
      lastError = err;
      // 換下一個可用專案繼續嘗試。
    }
  }
  return { ok: false, error: lastError };
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  setStatus("");

  const uploaderName = nameInput.value.trim();
  const caption = captionInput.value.trim();

  if (!uploaderName) {
    setStatus("請填寫你的名字，讓新人知道是誰上傳的 😊", "error");
    return;
  }
  if (selectedFiles.length === 0) {
    setStatus("請至少選擇一張照片或一段影片", "error");
    return;
  }

  submitBtn.disabled = true;
  queueEl.innerHTML = "";
  setStatus(`正在準備上傳 ${selectedFiles.length} 個檔案…`, "info");

  let uploadableProjects;
  try {
    uploadableProjects = await getUploadableProjectsInOrder();
  } catch (err) {
    setStatus(`無法連線到相簿服務：${err.message}`, "error");
    submitBtn.disabled = false;
    return;
  }

  if (uploadableProjects.length === 0) {
    setStatus("目前上傳功能暫時關閉（可能容量已滿），請稍後再試，或聯絡新人 🙏", "error");
    submitBtn.disabled = false;
    return;
  }

  let successCount = 0;
  let errorCount = 0;
  let win = null;
  const primary = (await getProjects())[0];

  for (const file of selectedFiles) {
    const item = createQueueItem(file);
    const validation = validateFile(file);
    if (!validation.ok) {
      item.setError(validation.reason);
      errorCount++;
      continue;
    }
    const result = await uploadOneFile(
      file,
      validation.mediaType,
      uploaderName,
      caption,
      uploadableProjects,
      primary
    );
    if (result.ok) {
      item.setSuccess(result.seq);
      successCount++;
      if (result.isWinner && !win) win = { seq: result.seq, name: uploaderName };
    } else {
      item.setError("上傳失敗，請檢查網路後重試");
      errorCount++;
    }
  }

  if (successCount > 0 && errorCount === 0) {
    setStatus(`🎉 成功上傳 ${successCount} 個檔案，已經出現在公開相簿囉！`, "success");
    form.reset();
    selectedFiles = [];
    updateFileListLabel();
  } else if (successCount > 0 && errorCount > 0) {
    setStatus(`成功上傳 ${successCount} 個，失敗 ${errorCount} 個，請檢查上方清單`, "warn");
  } else {
    setStatus("上傳失敗，請檢查網路連線後再試一次", "error");
  }

  submitBtn.disabled = false;

  if (win) winnerUi.showWinner(win);
});

updateFileListLabel();
