// 上傳頁邏輯：挑選目前開放中的 Supabase 專案 → 驗證/壓縮檔案 → 上傳到 pending bucket → 寫入 media 紀錄。
// 若上傳失敗（例如該專案容量已滿），會自動改試下一個開放中的專案。

import { loadProjects, formatBytes, generateStoragePath, detectMediaType } from "./config.js";
import { compressImageIfPossible } from "./imageCompress.js";

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
    setSuccess() {
      row.className = "upload-item state-success";
      state.textContent = "已送出，等待審核";
    },
    setError(msg) {
      row.className = "upload-item state-error";
      state.textContent = msg || "上傳失敗";
    },
  };
}

/** 嘗試把單一檔案上傳到「可用專案清單」中依序的每一個，直到成功為止。 */
async function uploadOneFile(file, mediaType, uploaderName, caption, uploadableProjects) {
  let lastError = null;
  for (const project of uploadableProjects) {
    try {
      let blob = file;
      let ext;
      let mimeType = file.type;
      if (mediaType === "image") {
        const compressed = await compressImageIfPossible(file);
        blob = compressed.blob;
        ext = compressed.ext;
        mimeType = compressed.mimeType;
      } else {
        const map = { "video/mp4": "mp4", "video/quicktime": "mov", "video/webm": "webm" };
        ext = map[file.type] || "mp4";
      }

      const path = generateStoragePath(file.name, ext);
      const { error: uploadError } = await project.client.storage
        .from("pending")
        .upload(path, blob, { contentType: mimeType, upsert: false });
      if (uploadError) throw uploadError;

      const { error: insertError } = await project.client.from("media").insert({
        bucket: "pending",
        storage_path: path,
        media_type: mediaType,
        size_bytes: blob.size,
        uploader_name: uploaderName,
        caption: caption || null,
        status: "pending",
      });
      if (insertError) {
        // 資料表寫入失敗的話，把剛剛上傳的檔案清掉，避免留下孤兒檔案。
        await project.client.storage.from("pending").remove([path]);
        throw insertError;
      }

      return { ok: true, project };
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
      uploadableProjects
    );
    if (result.ok) {
      item.setSuccess();
      successCount++;
    } else {
      item.setError("上傳失敗，請檢查網路後重試");
      errorCount++;
    }
  }

  if (successCount > 0 && errorCount === 0) {
    setStatus(`🎉 成功上傳 ${successCount} 個檔案，等待新人審核後就會出現在相簿囉！`, "success");
    form.reset();
    selectedFiles = [];
    updateFileListLabel();
  } else if (successCount > 0 && errorCount > 0) {
    setStatus(`成功上傳 ${successCount} 個，失敗 ${errorCount} 個，請檢查上方清單`, "warn");
  } else {
    setStatus("上傳失敗，請檢查網路連線後再試一次", "error");
  }

  submitBtn.disabled = false;
});

updateFileListLabel();
