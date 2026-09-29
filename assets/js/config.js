// 共用設定模組：讀取 supabase/projects.json，建立各專案的 supabase-js client。
// 依賴全域 `supabase`（由 CDN 載入的 @supabase/supabase-js UMD build 提供）。

const CONFIG_URL = new URL("../../supabase/projects.json", import.meta.url).href;

/** 快取已載入的原始設定清單（不含 client），避免每次都重新 fetch。 */
let _rawConfigPromise = null;

/**
 * 讀取 supabase/projects.json，過濾出 enabled 且設定完整的專案，依 priority 由小到大排序。
 * @returns {Promise<Array<{label:string, url:string, anonKey:string, priority:number}>>}
 */
function fetchProjectConfigs() {
  if (!_rawConfigPromise) {
    _rawConfigPromise = fetch(CONFIG_URL, { cache: "no-store" })
      .then((res) => {
        if (!res.ok) throw new Error("無法讀取 supabase/projects.json");
        return res.json();
      })
      .then((data) => {
        const list = (data.projects || [])
          .filter((p) => p.enabled && p.url && p.anonKey)
          .sort((a, b) => a.priority - b.priority);
        if (list.length === 0) {
          throw new Error(
            "目前沒有任何啟用中的 Supabase 專案設定，請檢查 supabase/projects.json"
          );
        }
        return list;
      });
  }
  return _rawConfigPromise;
}

/**
 * 讀取專案設定並各自建立一個 supabase-js client。
 * @param {{persistSession?: boolean}} [options] persistSession 預設為 false
 *   （匿名訪客的上傳頁/相簿頁不需要保留登入狀態；admin 頁登入時會傳入 true）。
 * @returns {Promise<Array<{label:string, url:string, anonKey:string, priority:number, client:object}>>}
 */
export async function loadProjects(options = {}) {
  const persistSession = options.persistSession ?? false;
  const configs = await fetchProjectConfigs();
  return configs.map((p) => ({
    ...p,
    client: window.supabase.createClient(p.url, p.anonKey, {
      auth: { persistSession, storageKey: `sb-auth-${p.label}` },
    }),
  }));
}

/** 將 bytes 轉成人類可讀的字串，例如 1536 -> "1.5 KB"。 */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / Math.pow(1024, i);
  return `${value.toFixed(value >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

/** 產生一個相對安全、不重複的檔案儲存路徑。 */
export function generateStoragePath(originalName, ext) {
  const id =
    typeof crypto !== "undefined" && crypto.randomUUID
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${id}.${ext}`;
}

/** 依 MIME type 判斷是圖片還是影片，不支援的回傳 null。 */
export function detectMediaType(mimeType) {
  if (!mimeType) return null;
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("video/")) return "video";
  return null;
}
