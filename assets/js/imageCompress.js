// 圖片壓縮工具：在瀏覽器端把過大的照片縮小/重新編碼成 JPEG，節省 Storage 容量與上傳時間。
// 若瀏覽器無法解碼原始格式（例如部分 HEIC），會直接回傳原始檔案，不中斷上傳流程。

const MAX_DIMENSION = 1920; // 長邊最大像素
const JPEG_QUALITY = 0.82;

/**
 * 嘗試壓縮圖片檔案。失敗或不需要壓縮時回傳原始 File。
 * @param {File} file
 * @returns {Promise<{blob: Blob, ext: string, mimeType: string}>}
 */
export async function compressImageIfPossible(file) {
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, MAX_DIMENSION / Math.max(bitmap.width, bitmap.height));
    const targetW = Math.round(bitmap.width * scale);
    const targetH = Math.round(bitmap.height * scale);

    const canvas = document.createElement("canvas");
    canvas.width = targetW;
    canvas.height = targetH;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(bitmap, 0, 0, targetW, targetH);
    bitmap.close?.();

    const blob = await new Promise((resolve, reject) => {
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error("canvas.toBlob 失敗"))),
        "image/jpeg",
        JPEG_QUALITY
      );
    });

    // 如果壓縮後反而比原檔大（少見，例如原本就是高度壓縮的小圖），就用原檔。
    if (blob.size >= file.size) {
      return { blob: file, ext: extFromMime(file.type), mimeType: file.type };
    }
    return { blob, ext: "jpg", mimeType: "image/jpeg" };
  } catch (err) {
    // 瀏覽器不支援解碼（常見於 HEIC/HEIF）時，直接使用原始檔案。
    return { blob: file, ext: extFromMime(file.type), mimeType: file.type };
  }
}

function extFromMime(mimeType) {
  const map = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/heic": "heic",
    "image/heif": "heif",
    "video/mp4": "mp4",
    "video/quicktime": "mov",
    "video/webm": "webm",
  };
  return map[mimeType] || "bin";
}
