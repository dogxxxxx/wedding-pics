// 抽獎相關的前端邏輯：裝置識別碼、中獎紀錄（存在 localStorage，重新整理後還看得到）、中獎畫面與彩帶動畫。
// 中獎與否由伺服器的 claim_upload_number() 決定，這裡只負責顯示。

const TOKEN_KEY = "wedding_device_token";
const WIN_KEY = "wedding_win";

let memoryToken = null;

function safeGet(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSet(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // 無痕模式等情況無法寫入，只會失去「重新整理後仍記得」的能力。
  }
}

/** 每個瀏覽器第一次造訪時產生一組隨機識別碼，用來讓同一個裝置不能重複中獎。 */
export function getDeviceToken() {
  if (memoryToken) return memoryToken;
  let token = safeGet(TOKEN_KEY);
  if (!token || token.length < 8) {
    token =
      typeof crypto !== "undefined" && crypto.randomUUID
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
    safeSet(TOKEN_KEY, token);
  }
  memoryToken = token;
  return token;
}

export function loadSavedWin() {
  try {
    const raw = safeGet(WIN_KEY);
    const win = raw ? JSON.parse(raw) : null;
    return win && Number.isFinite(win.seq) ? win : null;
  } catch {
    return null;
  }
}

export function saveWin(win) {
  safeSet(WIN_KEY, JSON.stringify(win));
}

function startConfetti(canvas) {
  if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    return () => {};
  }
  const ctx = canvas.getContext("2d");
  const colors = ["#f6c945", "#ef6f6c", "#5bc0be", "#a78bfa", "#ff9ecd", "#ffffff"];
  let w = 0;
  let h = 0;
  const resize = () => {
    w = canvas.width = window.innerWidth;
    h = canvas.height = window.innerHeight;
  };
  resize();
  window.addEventListener("resize", resize);

  const spawn = (initial) => ({
    x: Math.random() * w,
    y: initial ? -Math.random() * h : -20,
    size: 6 + Math.random() * 8,
    vx: -1 + Math.random() * 2,
    vy: 2 + Math.random() * 3.5,
    rot: Math.random() * Math.PI * 2,
    vr: -0.15 + Math.random() * 0.3,
    color: colors[Math.floor(Math.random() * colors.length)],
  });
  const particles = Array.from({ length: 150 }, () => spawn(true));

  let raf = 0;
  const frame = () => {
    ctx.clearRect(0, 0, w, h);
    for (let i = 0; i < particles.length; i++) {
      const p = particles[i];
      p.x += p.vx + Math.sin(p.y / 40);
      p.y += p.vy;
      p.rot += p.vr;
      if (p.y > h + 20) particles[i] = spawn(false);
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
      ctx.restore();
    }
    raf = requestAnimationFrame(frame);
  };
  frame();

  return () => {
    cancelAnimationFrame(raf);
    window.removeEventListener("resize", resize);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  };
}

/** 綁定中獎畫面的 DOM，回傳 showWinner(win) 與（重新）顯示已存的中獎紀錄用的函式。 */
export function initWinnerUi() {
  const overlay = document.getElementById("winner-overlay");
  const canvas = document.getElementById("confetti-canvas");
  const seqEl = document.getElementById("winner-seq");
  const nameEl = document.getElementById("winner-name");
  const photoFrame = document.getElementById("winner-photo-frame");
  const photo = document.getElementById("winner-photo");
  const closeBtn = document.getElementById("winner-close");
  const reopenBtn = document.getElementById("winner-reopen");

  let stopConfetti = () => {};
  let currentWin = null;

  // 找不到照片時（還沒放 assets/img/winner.jpg）就只顯示文字與彩帶，不出現破圖。
  photo.addEventListener("error", () => {
    photoFrame.classList.add("hidden");
  });
  photo.addEventListener("load", () => {
    photoFrame.classList.remove("hidden");
  });
  photo.src = "assets/img/winner.jpg";

  function close() {
    overlay.classList.add("hidden");
    stopConfetti();
    stopConfetti = () => {};
  }

  function show(win) {
    currentWin = win;
    seqEl.textContent = `#${win.seq}`;
    nameEl.textContent = win.name ? `${win.name}，恭喜你！` : "恭喜你！";
    overlay.classList.remove("hidden");
    stopConfetti();
    stopConfetti = startConfetti(canvas);
    if (navigator.vibrate) navigator.vibrate([200, 100, 200, 100, 400]);
    reopenBtn.classList.remove("hidden");
  }

  closeBtn.addEventListener("click", close);
  reopenBtn.addEventListener("click", () => {
    if (currentWin) show(currentWin);
  });

  const saved = loadSavedWin();
  if (saved) {
    currentWin = saved;
    reopenBtn.classList.remove("hidden");
  }

  return {
    showWinner(win) {
      saveWin(win);
      show(win);
    },
  };
}
