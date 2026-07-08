"use strict";

const FILE_PROTOCOL = window.location.protocol === "file:";
const IOS_DEVICE = /iPad|iPhone|iPod/.test(window.navigator.userAgent)
  || (window.navigator.platform === "MacIntel" && window.navigator.maxTouchPoints > 1);
const STANDALONE_MODE = window.matchMedia("(display-mode: standalone)").matches
  || window.navigator.standalone === true;
const DB_NAME = "radDiagQuizV1";
const DB_VERSION = 1;
const BACKUP_SCHEMA = "rad-quiz-backup-v1";
const LEGACY_MEMO_MIGRATION_KEY = "legacy-memo-migration-v1";
const LEGACY_MEMOS = Array.isArray(window.__LEGACY_MEMOS__) ? window.__LEGACY_MEMOS__ : [];
const MAX_SESSIONS = 50;
const TEMPLATE_INSERTIONS = {
  full: "鑑別:\nひっかけ:\n覚え方:\n次回確認点:\n",
  diff: "鑑別:\n",
  trap: "ひっかけ:\n",
  memory: "覚え方:\n",
  next: "次回確認点:\n"
};
const CAT_ORDER = [
  "医学物理学",
  "放射線生物学",
  "放射線防護・安全管理",
  "画像診断学総論（モダリティ・造影剤）",
  "中枢神経（脳・脊髄）",
  "頭頸部",
  "呼吸器・縦隔",
  "心臓・大血管",
  "乳房",
  "消化器（肝・胆・膵・脾）",
  "消化器（消化管・腹壁）",
  "泌尿器・生殖器",
  "脊椎・脊髄・骨関節・軟部",
  "小児",
  "核医学",
  "放射線治療",
  "IVR",
  "医の倫理・医療の質",
  "未分類"
];

let QUESTIONS = [];
let QUESTION_MAP = new Map();
let YEARS = [];
let CATEGORIES = [];
let progressState = blankProgress();
let sessionState = null;
let modalTarget = null;
let srsTarget = null;
let memoSaveTimer = null;
let currentMemo = blankMemo("");
let currentMemoUrls = [];
let wrongMemoUrls = [];
let confirmResolver = null;

function $(id) {
  return document.getElementById(id);
}

function show(id) {
  const el = $(id);
  if (el) el.classList.remove("hidden");
}

function hide(id) {
  const el = $(id);
  if (el) el.classList.add("hidden");
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function pad(num) {
  return String(num).padStart(2, "0");
}

function localDateKey(date = new Date()) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function parseDateKey(dateKey) {
  const parts = String(dateKey).split("-").map(Number);
  return new Date(parts[0] || 1970, (parts[1] || 1) - 1, parts[2] || 1);
}

function addDaysToKey(dateKey, days) {
  const next = parseDateKey(dateKey);
  next.setDate(next.getDate() + days);
  return localDateKey(next);
}

const EXAM_DATE_STORAGE_KEY = "radQuizExamDate";
const DEFAULT_EXAM_DATE = "2026-08-21";

function getExamDate() {
  try {
    const stored = localStorage.getItem(EXAM_DATE_STORAGE_KEY);
    if (stored && /^\d{4}-\d{2}-\d{2}$/.test(stored)) return stored;
  } catch (error) {
    /* localStorage不可でもデフォルトで動作 */
  }
  return DEFAULT_EXAM_DATE;
}

function setExamDate(dateKey) {
  try {
    localStorage.setItem(EXAM_DATE_STORAGE_KEY, dateKey);
  } catch (error) {
    /* 保存失敗時もセッション中は表示だけ更新される */
  }
}

function renderExamCard() {
  const main = $("exam-date-main");
  const countdown = $("exam-countdown");
  if (!main || !countdown) return;
  const examKey = getExamDate();
  const exam = parseDateKey(examKey);
  const today = parseDateKey(localDateKey());
  const diff = Math.round((exam - today) / 86400000);
  const dow = "日月火水木金土"[exam.getDay()];
  main.innerHTML = `${exam.getMonth() + 1}/${exam.getDate()}<small>（${dow}）</small>`;
  if (diff > 1) {
    countdown.innerHTML = `あと <strong>${diff}</strong> 日`;
  } else if (diff === 1) {
    countdown.innerHTML = `<strong>明日</strong> が試験日！`;
  } else if (diff === 0) {
    countdown.innerHTML = `<strong>本日試験日</strong> 🔥`;
  } else {
    countdown.textContent = "お疲れさまでした";
  }
}

function formatDuration(sec) {
  const mins = Math.floor(sec / 60);
  const rem = sec % 60;
  return `${mins}:${rem < 10 ? "0" : ""}${rem}`;
}

function formatTimestamp(ms) {
  if (!ms) return "-";
  const date = new Date(ms);
  return `${date.getMonth() + 1}/${date.getDate()} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function questionId(question) {
  return `${question.year}-${question.num}`;
}

function blankProgress() {
  return { perQ: {}, sessions: [], savedSessions: [] };
}

function blankMemo(id) {
  return { id, text: "", images: [] };
}

/* 中断保存の対象キー: 年度・カテゴリ・全問ごとに1枠 */
function sessionTargetKey(session) {
  return session.year ? `year:${session.year}` : session.category ? `cat:${session.category}` : "all";
}

function normalizeProgress(raw) {
  const safe = raw && typeof raw === "object" ? raw : {};
  const savedSessions = Array.isArray(safe.savedSessions) ? safe.savedSessions : [];
  // 旧形式（単一スロット saved）からの移行（同じ対象が既にあれば重複させない）
  if (safe.saved && typeof safe.saved === "object") {
    const legacyKey = safe.saved.targetKey || sessionTargetKey(safe.saved);
    if (!savedSessions.some((entry) => (entry.targetKey || sessionTargetKey(entry)) === legacyKey)) {
      savedSessions.push(safe.saved);
    }
  }
  savedSessions.forEach((entry) => {
    if (!entry.targetKey) entry.targetKey = sessionTargetKey(entry);
    if (!entry.savedAt) entry.savedAt = Date.now();
  });
  return {
    perQ: safe.perQ && typeof safe.perQ === "object" ? safe.perQ : {},
    sessions: Array.isArray(safe.sessions) ? safe.sessions : [],
    savedSessions
  };
}

function normalizeQuestion(raw) {
  const normalized = {
    id: `${raw.year}-${raw.num}`,
    year: Number(raw.year),
    num: Number(raw.num),
    text: String(raw.text || ""),
    choices: raw.choices && typeof raw.choices === "object" ? raw.choices : {},
    answer: typeof raw.answer === "string" ? raw.answer : "",
    multi: Boolean(raw.multi),
    explanation: String(raw.explanation || ""),
    category: raw.category ? String(raw.category) : "未分類"
  };
  if (Array.isArray(raw.images)) normalized.images = raw.images.slice();
  if (typeof raw.image === "string") normalized.image = raw.image;
  return normalized;
}

function getCorrectChoices(question) {
  if (!question.answer) return [];
  return question.answer.split(",").map((item) => item.trim()).filter(Boolean);
}

function hydrateQuestionIds(ids) {
  return (Array.isArray(ids) ? ids : [])
    .map((id) => QUESTION_MAP.get(id))
    .filter(Boolean);
}

function showPage(id) {
  ["pg-home", "pg-quiz", "pg-result", "pg-stats", "pg-search"].forEach((pageId) => {
    const el = $(pageId);
    if (el) el.classList.add("hidden");
  });
  const page = $(id);
  if (page) page.classList.remove("hidden");
  updateBottomNav(id);
  window.scrollTo({ top: 0, left: 0, behavior: "auto" });
}

const NAV_PAGE_MAP = { "pg-home": "bn-home", "pg-stats": "bn-stats", "pg-search": "bn-search" };

function updateBottomNav(pageId) {
  const nav = $("bottom-nav");
  if (!nav) return;
  const activeBtn = NAV_PAGE_MAP[pageId];
  if (activeBtn) {
    nav.classList.remove("hidden");
    Object.values(NAV_PAGE_MAP).forEach((btnId) => {
      const btn = $(btnId);
      if (btn) btn.classList.toggle("active", btnId === activeBtn);
    });
  } else {
    nav.classList.add("hidden");
  }
}

function cleanupObjectUrls(list) {
  list.forEach((url) => {
    if (typeof url === "string" && url.startsWith("blob:")) {
      URL.revokeObjectURL(url);
    }
  });
}

function cleanupCurrentMemoUrls() {
  cleanupObjectUrls(currentMemoUrls);
  currentMemoUrls = [];
}

function cleanupWrongMemoUrls() {
  cleanupObjectUrls(wrongMemoUrls);
  wrongMemoUrls = [];
}

function showToast(message, tone = "info", timeoutMs = 2600) {
  const zone = $("toast-zone");
  if (!zone) return;
  const toast = document.createElement("div");
  toast.className = `toast ${tone}`;
  toast.textContent = message;
  zone.appendChild(toast);
  window.setTimeout(() => {
    toast.remove();
  }, timeoutMs);
}

function openOverlay(id) {
  show(id);
}

function closeOverlay(id) {
  hide(id);
}

function askConfirm(options) {
  const title = $("confirm-title");
  const message = $("confirm-message");
  const ok = $("confirm-ok");
  if (!title || !message || !ok) return Promise.resolve(false);
  title.textContent = options.title || "確認";
  message.textContent = options.message || "";
  ok.textContent = options.confirmText || "続行";
  openOverlay("confirm-modal-bg");
  return new Promise((resolve) => {
    confirmResolver = resolve;
  });
}

function resolveConfirm(result) {
  closeOverlay("confirm-modal-bg");
  if (confirmResolver) {
    confirmResolver(result);
    confirmResolver = null;
  }
}

const Database = {
  db: null,

  init() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains("keyval")) {
          db.createObjectStore("keyval", { keyPath: "key" });
        }
        if (!db.objectStoreNames.contains("memos")) {
          db.createObjectStore("memos", { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains("memoAssets")) {
          db.createObjectStore("memoAssets", { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains("srs")) {
          db.createObjectStore("srs", { keyPath: "id" });
        }
      };
      request.onsuccess = (event) => {
        this.db = event.target.result;
        resolve();
      };
      request.onerror = () => reject(request.error || new Error("IndexedDB open failed"));
    });
  },

  store(name, mode) {
    return this.db.transaction(name, mode).objectStore(name);
  },

  getKey(key) {
    return new Promise((resolve, reject) => {
      const request = this.store("keyval", "readonly").get(key);
      request.onsuccess = () => resolve(request.result ? request.result.value : null);
      request.onerror = () => reject(request.error || new Error(`Failed to get key ${key}`));
    });
  },

  setKey(key, value) {
    return new Promise((resolve, reject) => {
      const request = this.store("keyval", "readwrite").put({ key, value });
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error || new Error(`Failed to set key ${key}`));
    });
  },

  getRecord(storeName, id) {
    return new Promise((resolve, reject) => {
      const request = this.store(storeName, "readonly").get(id);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error || new Error(`Failed to get ${storeName}:${id}`));
    });
  },

  putRecord(storeName, value) {
    return new Promise((resolve, reject) => {
      const request = this.store(storeName, "readwrite").put(value);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error || new Error(`Failed to put ${storeName}`));
    });
  },

  deleteRecord(storeName, id) {
    return new Promise((resolve, reject) => {
      const request = this.store(storeName, "readwrite").delete(id);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error || new Error(`Failed to delete ${storeName}:${id}`));
    });
  },

  getAll(storeName) {
    return new Promise((resolve, reject) => {
      const request = this.store(storeName, "readonly").getAll();
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error || new Error(`Failed to getAll ${storeName}`));
    });
  },

  clearStore(storeName) {
    return new Promise((resolve, reject) => {
      const request = this.store(storeName, "readwrite").clear();
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error || new Error(`Failed to clear ${storeName}`));
    });
  }
};

async function loadProgressState() {
  progressState = normalizeProgress(await Database.getKey("progress"));
}

async function saveProgressState() {
  await Database.setKey("progress", progressState);
}

async function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error || new Error("Failed to read blob"));
    reader.readAsDataURL(blob);
  });
}

async function dataUrlToBlob(dataUrl) {
  const response = await fetch(dataUrl);
  return response.blob();
}

function downloadBlob(filename, blob) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function exportBackup() {
  const memos = await Database.getAll("memos");
  const assets = await Database.getAll("memoAssets");
  const srs = await Database.getAll("srs");
  const serialisedAssets = [];
  for (const asset of assets) {
    serialisedAssets.push({
      id: asset.id,
      name: asset.name || "memo-image",
      type: asset.type || (asset.blob && asset.blob.type) || "application/octet-stream",
      createdAt: asset.createdAt || 0,
      dataUrl: await blobToDataUrl(asset.blob)
    });
  }
  const payload = {
    schema: BACKUP_SCHEMA,
    exportedAt: Date.now(),
    progress: progressState,
    memos,
    assets: serialisedAssets,
    srs
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  downloadBlob(`rad-quiz-backup-${localDateKey().replace(/-/g, "")}.json`, blob);
  closeOverlay("backup-modal-bg");
  showToast("バックアップを書き出しました。", "success");
}

async function importBackupFromFile(file) {
  const raw = await file.text();
  const payload = JSON.parse(raw);
  if (!payload || payload.schema !== BACKUP_SCHEMA) {
    throw new Error("バックアップ形式が一致しません。");
  }

  await Database.clearStore("memos");
  await Database.clearStore("memoAssets");
  await Database.clearStore("srs");

  const nextProgress = normalizeProgress(payload.progress);
  progressState = nextProgress;
  await saveProgressState();

  for (const memo of Array.isArray(payload.memos) ? payload.memos : []) {
    await Database.putRecord("memos", {
      id: memo.id,
      text: memo.text || "",
      imageIds: Array.isArray(memo.imageIds) ? memo.imageIds : [],
      updatedAt: memo.updatedAt || 0
    });
  }

  for (const asset of Array.isArray(payload.assets) ? payload.assets : []) {
    const blob = await dataUrlToBlob(asset.dataUrl);
    await Database.putRecord("memoAssets", {
      id: asset.id,
      name: asset.name || "memo-image",
      type: asset.type || blob.type,
      createdAt: asset.createdAt || 0,
      blob
    });
  }

  for (const record of Array.isArray(payload.srs) ? payload.srs : []) {
    await Database.putRecord("srs", record);
  }

  cleanupCurrentMemoUrls();
  cleanupWrongMemoUrls();
  sessionState = null;
  closeOverlay("backup-modal-bg");
  await renderHome();
  showPage("pg-home");
  showToast("バックアップを復元しました。", "success", 3200);
}

function normaliseLegacyMemoEntry(entry) {
  if (!entry || typeof entry !== "object") return null;
  const id = typeof entry.id === "string" ? entry.id : "";
  if (!id) return null;
  const text = typeof entry.text === "string" ? entry.text : "";
  const images = Array.isArray(entry.images)
    ? entry.images
      .filter((image) => image && typeof image.dataUrl === "string" && image.dataUrl.startsWith("data:"))
      .map((image, index) => ({
        name: typeof image.name === "string" && image.name.trim() ? image.name : `${id}-legacy-${index + 1}.png`,
        dataUrl: image.dataUrl
      }))
    : [];
  if (!text.trim() && images.length === 0) return null;
  return {
    id,
    text,
    images,
    updatedAt: Number(entry.updatedAt) || 0
  };
}

async function importLegacyMemosIfNeeded() {
  const migrationKey = `${LEGACY_MEMO_MIGRATION_KEY}:${DB_NAME}`;
  const existingStatus = await Database.getKey(migrationKey);
  if (existingStatus) return null;

  const entries = LEGACY_MEMOS
    .map((entry) => normaliseLegacyMemoEntry(entry))
    .filter(Boolean);
  if (!entries.length) {
    await Database.setKey(migrationKey, { doneAt: Date.now(), imported: 0 });
    return null;
  }

  let touched = 0;
  for (const entry of entries) {
    const memoRecord = await Database.getRecord("memos", entry.id);
    const existingText = memoRecord && typeof memoRecord.text === "string" ? memoRecord.text : "";
    const existingImageIds = memoRecord && Array.isArray(memoRecord.imageIds) ? memoRecord.imageIds.slice() : [];
    let nextText = existingText;
    let changed = false;

    if (entry.text.trim()) {
      if (!existingText.trim()) {
        nextText = entry.text;
        changed = true;
      } else if (!existingText.includes(entry.text.trim())) {
        nextText = `${existingText.trimEnd()}\n\n[旧版メモから引き継ぎ]\n${entry.text}`;
        changed = true;
      }
    }

    for (let index = 0; index < entry.images.length; index += 1) {
      const image = entry.images[index];
      const assetId = `${entry.id}:legacy:${index + 1}`;
      if (existingImageIds.includes(assetId)) continue;
      const blob = await dataUrlToBlob(image.dataUrl);
      await Database.putRecord("memoAssets", {
        id: assetId,
        name: image.name,
        type: blob.type || "image/png",
        createdAt: entry.updatedAt || Date.now(),
        blob
      });
      existingImageIds.push(assetId);
      changed = true;
    }

    if (!memoRecord && (!nextText.trim() && existingImageIds.length === 0)) {
      continue;
    }
    if (changed) {
      await Database.putRecord("memos", {
        id: entry.id,
        text: nextText,
        imageIds: existingImageIds,
        updatedAt: Math.max(memoRecord && memoRecord.updatedAt ? memoRecord.updatedAt : 0, entry.updatedAt || Date.now())
      });
      touched += 1;
    }
  }

  await Database.setKey(migrationKey, { doneAt: Date.now(), imported: touched });
  return touched > 0 ? { imported: touched } : null;
}

function isCorrect(question, userSelection) {
  const correctChoices = getCorrectChoices(question);
  if (!correctChoices.length) return null;
  const expected = correctChoices.slice().sort().join(",");
  const actual = (userSelection || []).slice().sort().join(",");
  return expected === actual;
}

function modeLabel(mode) {
  const map = {
    seq: "順番",
    rand: "ランダム",
    rand10: "10問",
    retry: "再挑戦",
    wrong: "苦手",
    unseen: "未解答"
  };
  return map[mode] || mode;
}

function shuffle(array) {
  for (let i = array.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = array[i];
    array[i] = array[j];
    array[j] = tmp;
  }
  return array;
}

function getCategoryOrder(categories) {
  const extras = categories.filter((cat) => !CAT_ORDER.includes(cat)).sort((a, b) => a.localeCompare(b, "ja"));
  return CAT_ORDER.filter((cat) => categories.includes(cat)).concat(extras);
}

function recordForQuestion(question) {
  return progressState.perQ[question.id] || null;
}

function buildWeakCategoryStats() {
  const stats = new Map();
  for (const question of QUESTIONS) {
    const category = question.category || "未分類";
    if (!stats.has(category)) {
      stats.set(category, { category, attempted: 0, correct: 0, wrong: 0, total: 0 });
    }
    stats.get(category).total += 1;
  }
  Object.keys(progressState.perQ).forEach((qid) => {
    const question = QUESTION_MAP.get(qid);
    if (!question) return;
    const entry = stats.get(question.category);
    const result = progressState.perQ[qid];
    entry.attempted += 1;
    if (result && result.correct) {
      entry.correct += 1;
    } else {
      entry.wrong += 1;
    }
  });
  return Array.from(stats.values())
    .filter((item) => item.attempted > 0)
    .map((item) => ({
      ...item,
      pct: item.attempted > 0 ? Math.round((item.correct / item.attempted) * 100) : 0
    }))
    .sort((a, b) => a.pct - b.pct || b.attempted - a.attempted || a.category.localeCompare(b.category, "ja"));
}

function buildSearchIndex(question) {
  return [
    question.text,
    question.explanation,
    question.category,
    ...Object.values(question.choices || {})
  ]
    .join("\n")
    .toLowerCase();
}

function getQuestionImages(question) {
  if (!question) return [];
  const fallbackAlt = `${question.year}年 Q${question.num} 図`;

  if (Array.isArray(question.images)) {
    return question.images
      .map((image) => {
        if (typeof image === "string" && image.trim()) {
          return { src: image.trim(), alt: fallbackAlt, caption: "" };
        }
        if (!image || typeof image.src !== "string" || !image.src.trim()) return null;
        return {
          src: image.src.trim(),
          alt: typeof image.alt === "string" && image.alt.trim() ? image.alt.trim() : fallbackAlt,
          caption: typeof image.caption === "string" ? image.caption.trim() : ""
        };
      })
      .filter(Boolean);
  }

  if (typeof question.image === "string" && question.image.trim()) {
    return [{ src: question.image.trim(), alt: fallbackAlt, caption: "" }];
  }

  return [];
}

function renderQuestionImages(question) {
  const container = $("q-media");
  if (!container) return;

  container.innerHTML = "";
  const images = getQuestionImages(question);
  if (!images.length) {
    container.classList.add("hidden");
    return;
  }

  images.forEach((image, index) => {
    const figure = document.createElement("figure");
    figure.className = "q-media-figure";

    const img = document.createElement("img");
    img.src = image.src;
    img.alt = image.alt || `${question.year}年 Q${question.num} 図${images.length > 1 ? ` ${index + 1}` : ""}`;
    img.loading = index === 0 ? "eager" : "lazy";
    figure.appendChild(img);

    if (image.caption) {
      const figcaption = document.createElement("figcaption");
      figcaption.className = "q-media-caption";
      figcaption.textContent = image.caption;
      figure.appendChild(figcaption);
    }

    container.appendChild(figure);
  });

  container.classList.remove("hidden");
}

const SRS = {
  POOL_MAX: 100,

  async all() {
    return Database.getAll("srs");
  },

  async get(id) {
    return Database.getRecord("srs", id);
  },

  async put(record) {
    await Database.putRecord("srs", record);
  },

  async addToPool(question) {
    const id = question.id;
    const existing = await this.get(id);
    const today = localDateKey();
    if (existing) {
      // 既出問題を再度間違えた＝つまずき（lapse）。難易度を下げ、当日から復習対象へ前倒しする。
      // これにより、どのモードで間違えても忘却曲線のスケジュールに即反映される。
      const history = Array.isArray(existing.recentHistory) ? existing.recentHistory.slice(-2) : [];
      history.push(0);
      await this.put({
        ...existing,
        easeFactor: Math.max(1.3, Number(existing.easeFactor || 2.5) - 0.2),
        interval: 1,
        nextDue: today,
        recentHistory: history,
        totalWrong: (existing.totalWrong || 0) + 1,
        lapses: (existing.lapses || 0) + 1,
        inPool: true
      });
      return;
    }

    const all = await this.all();
    const pool = all.filter((item) => item.inPool);
    if (pool.length >= this.POOL_MAX) {
      pool.sort((a, b) => (b.easeFactor || 0) - (a.easeFactor || 0) || (b.interval || 0) - (a.interval || 0));
      const kick = pool[0];
      kick.inPool = false;
      await this.put(kick);
    }

    await this.put({
      id,
      year: question.year,
      num: question.num,
      category: question.category || "未分類",
      easeFactor: 2.5,
      interval: 0,
      nextDue: today,
      recentHistory: [0],
      totalWrong: 1,
      lapses: 0,
      inPool: true,
      addedDate: today
    });
  },

  async update(question, rating) {
    const current = await this.get(question.id);
    if (!current) return;

    const history = Array.isArray(current.recentHistory) ? current.recentHistory.slice(-2) : [];
    history.push(rating);
    const easeFactor = Number(current.easeFactor || 2.5);
    const interval = Number(current.interval || 0);
    let nextEase = easeFactor;
    let nextInterval = interval;

    if (rating === 0) {
      nextEase = Math.max(1.3, easeFactor - 0.2);
      nextInterval = 1;
    } else if (rating === 1) {
      nextInterval = interval <= 0 ? 1 : interval === 1 ? 3 : Math.round(interval * 1.2);
    } else {
      nextEase = Math.min(3.0, easeFactor + 0.1);
      nextInterval = interval <= 0 ? 1 : interval === 1 ? 3 : Math.round(interval * nextEase);
    }

    await this.put({
      ...current,
      easeFactor: nextEase,
      interval: nextInterval,
      nextDue: addDaysToKey(localDateKey(), nextInterval),
      recentHistory: history,
      totalWrong: rating === 0 ? (current.totalWrong || 0) + 1 : current.totalWrong || 0,
      inPool: !(nextEase >= 2.8 && nextInterval >= 30)
    });
  },

  async getDue() {
    const today = localDateKey();
    return (await this.all())
      .filter((item) => item.inPool && item.nextDue <= today)
      .sort((a, b) => a.nextDue.localeCompare(b.nextDue) || (a.easeFactor || 0) - (b.easeFactor || 0));
  },

  async getEaseSorted(limit) {
    const pool = (await this.all())
      .filter((item) => item.inPool)
      .sort((a, b) => (a.easeFactor || 0) - (b.easeFactor || 0) || (a.interval || 0) - (b.interval || 0));
    return typeof limit === "number" ? pool.slice(0, limit) : pool;
  },

  async getRecentWrong(limit) {
    const pool = (await this.all())
      .filter((item) => item.inPool && Array.isArray(item.recentHistory) && item.recentHistory.includes(0))
      .sort((a, b) => {
        const aWrong = (a.recentHistory || []).filter((value) => value === 0).length;
        const bWrong = (b.recentHistory || []).filter((value) => value === 0).length;
        return bWrong - aWrong || (a.easeFactor || 0) - (b.easeFactor || 0);
      });
    return typeof limit === "number" ? pool.slice(0, limit) : pool;
  },

  async getStats() {
    const today = localDateKey();
    const tomorrow = addDaysToKey(today, 1);
    const weekEnd = addDaysToKey(today, 6);
    const all = await this.all();
    const pool = all.filter((item) => item.inPool);
    return {
      poolSize: pool.length,
      dueCount: pool.filter((item) => item.nextDue <= today).length,
      overdueCount: pool.filter((item) => item.nextDue < today).length,
      dueTomorrow: pool.filter((item) => item.nextDue === tomorrow).length,
      dueThisWeek: pool.filter((item) => item.nextDue > today && item.nextDue <= weekEnd).length,
      recentWrongCount: pool.filter((item) => (item.recentHistory || []).includes(0)).length
    };
  }
};

async function loadQuestions() {
  if (!FILE_PROTOCOL) {
    try {
      const response = await fetch("questions.json", { cache: "no-store" });
      if (response.ok) {
        return (await response.json()).map(normalizeQuestion);
      }
    } catch (error) {
      console.warn("questions.json fetch failed, using generated fallback", error);
    }
  }

  if (Array.isArray(window.__QUESTIONS__)) {
    return window.__QUESTIONS__.map(normalizeQuestion);
  }

  throw new Error("問題データを読み込めませんでした。");
}

function setRuntimeBanner() {
  const banner = $("runtime-banner");
  if (!banner) return;
  if (IOS_DEVICE && !STANDALONE_MODE) {
    banner.innerHTML = "<strong>iPad / iPhoneで使う場合:</strong> Safariの共有メニューから <strong>ホーム画面に追加</strong> を選ぶと、アプリとして起動できます。";
    banner.classList.remove("hidden");
  } else {
    banner.classList.add("hidden");
  }
}

const CAT_GROUPS = [
  { label: "基礎", cats: ["医学物理学", "放射線生物学", "放射線防護・安全管理", "画像診断学総論（モダリティ・造影剤）", "医の倫理・医療の質"] },
  { label: "画像診断", cats: ["中枢神経（脳・脊髄）", "頭頸部", "呼吸器・縦隔", "心臓・大血管", "乳房", "消化器（肝・胆・膵・脾）", "消化器（消化管・腹壁）", "泌尿器・生殖器", "脊椎・脊髄・骨関節・軟部", "小児"] },
  { label: "核医学・治療・IVR", cats: ["核医学", "放射線治療", "IVR"] }
];

function collectProgress(questions) {
  const attempted = questions.filter((question) => Boolean(recordForQuestion(question))).length;
  const correct = questions.filter((question) => {
    const record = recordForQuestion(question);
    return record && record.correct;
  }).length;
  return {
    total: questions.length,
    attempted,
    correct,
    pct: attempted > 0 ? Math.round((correct / attempted) * 100) : 0,
    fill: questions.length > 0 ? Math.round((attempted / questions.length) * 100) : 0
  };
}

/* ★評価: ★=全問未了または正答率60%未満 / ★★=全問解答＋正答率60〜79% / ★★★=全問解答＋正答率80%以上 */
function progressStars(stats) {
  if (stats.attempted === 0) return 0;
  if (stats.attempted < stats.total || stats.pct < 60) return 1;
  return stats.pct >= 80 ? 3 : 2;
}

function starMarkup(stars) {
  let html = "";
  for (let i = 1; i <= 3; i += 1) {
    html += `<span class="${i <= stars ? "on" : "off"}">★</span>`;
  }
  return html;
}

/* 正答率の信号色（弱点カテゴリと共通） */
function accuracyColor(pct) {
  return pct >= 80 ? "#16a34a" : pct >= 60 ? "#d97706" : "#dc2626";
}

function buildCatCard(category) {
  const stats = collectProgress(QUESTIONS.filter((question) => question.category === category));
  const stars = progressStars(stats);
  const button = document.createElement("button");
  button.className = "year-card cat-card";
  // 年度カードと同じ構成: 名前 / 問数・正答率 / ★評価 / 進捗バー
  button.innerHTML =
    `<div class="cc-name">${escapeHtml(category)}</div>` +
    `<div class="yc-info">${stats.attempted}/${stats.total}問${stats.attempted > 0 ? ` 正答率${stats.pct}%` : ""}</div>` +
    `<div class="yc-stars">${starMarkup(stars)}</div>` +
    `<div class="yc-bar"><div class="yc-fill" style="width:${stats.fill}%"></div></div>`;
  button.addEventListener("click", () => openModeModal(`cat:${category}`));
  return button;
}

async function renderHome() {
  const totalQuestions = QUESTIONS.length;
  const yearGrid = $("year-grid");
  const catGrid = $("cat-grid");
  const weakCats = $("weak-cats");
  const subtitle = $("home-subtitle");
  if (!yearGrid || !catGrid || !weakCats || !subtitle) return;

  subtitle.textContent = YEARS.length > 1
    ? `${YEARS[0]}〜${YEARS[YEARS.length - 1]}年 計${totalQuestions}問`
    : `${YEARS[0]}年 計${totalQuestions}問`;
  $("all-btn-desc").textContent = `${totalQuestions}問から選択`;

  yearGrid.innerHTML = "";
  YEARS.slice().reverse().forEach((year) => {
    const stats = collectProgress(QUESTIONS.filter((question) => question.year === year));
    const stars = progressStars(stats);
    const button = document.createElement("button");
    button.className = "year-card";
    button.innerHTML =
      `<div class="yc-year">${year}</div>` +
      `<div class="yc-info">${stats.attempted}/${stats.total}問${stats.attempted > 0 ? ` ${stats.pct}%` : ""}</div>` +
      `<div class="yc-stars">${starMarkup(stars)}</div>` +
      `<div class="yc-bar"><div class="yc-fill" style="width:${stats.fill}%"></div></div>`;
    button.addEventListener("click", () => openModeModal(year));
    yearGrid.appendChild(button);
  });

  catGrid.innerHTML = "";
  const groupedCats = new Set();
  const appendCatScroll = (labelText, cats) => {
    const label = document.createElement("div");
    label.className = "cat-group-label";
    label.textContent = labelText;
    catGrid.appendChild(label);
    const row = document.createElement("div");
    row.className = "year-scroll";
    cats.forEach((category) => row.appendChild(buildCatCard(category)));
    catGrid.appendChild(row);
  };
  CAT_GROUPS.forEach((group) => {
    const cats = group.cats.filter((category) => CATEGORIES.includes(category));
    if (!cats.length) return;
    cats.forEach((category) => groupedCats.add(category));
    appendCatScroll(group.label, cats);
  });
  const leftoverCats = CATEGORIES.filter((category) => !groupedCats.has(category));
  if (leftoverCats.length) {
    appendCatScroll("その他", leftoverCats);
  }

  renderExamCard();

  const srsStats = await SRS.getStats();
  renderHomeOverview(srsStats);
  renderRecoAction(srsStats);
  renderWeakCategories();

  renderResumeCards();
}

/* 中断中のセッションを「新しく進める」に対象ごとのカードとして並べる */
function renderResumeCards() {
  const modeGrid = $("new-mode-grid");
  if (!modeGrid) return;
  modeGrid.querySelectorAll(".resume-btn").forEach((el) => el.remove());
  progressState.savedSessions
    .slice()
    .sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0))
    .forEach((entry) => modeGrid.appendChild(buildResumeCard(entry)));
}

function buildResumeCard(entry) {
  const wrap = document.createElement("div");
  wrap.className = "mode-btn resume-btn";
  wrap.setAttribute("role", "button");
  wrap.tabIndex = 0;
  wrap.innerHTML =
    `<span class="mode-icon">▶</span>` +
    `<div>` +
      `<div class="mode-name">${escapeHtml(savedSessionLabel(entry))}</div>` +
      `<div class="mode-desc">${entry.index + 1}/${entry.questionIds.length}問目から再開</div>` +
    `</div>` +
    `<button class="resume-del" type="button" aria-label="この中断を削除">✕</button>`;
  const activate = () => { void resumeSession(entry); };
  wrap.addEventListener("click", (event) => {
    if (event.target.closest(".resume-del")) return;
    activate();
  });
  wrap.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      activate();
    }
  });
  wrap.querySelector(".resume-del").addEventListener("click", async (event) => {
    event.stopPropagation();
    const confirmed = await askConfirm({
      title: "中断データを削除しますか？",
      message: `「${savedSessionLabel(entry)} ${entry.index + 1}/${entry.questionIds.length}問目」の続きから再開できなくなります（解答済みの記録は残ります）。`,
      confirmText: "削除する"
    });
    if (!confirmed) return;
    progressState.savedSessions = progressState.savedSessions.filter((s) => s.sessionId !== entry.sessionId);
    await saveProgressState();
    await renderHome();
  });
  return wrap;
}

function renderHomeOverview(stats) {
  const attempted = Object.keys(progressState.perQ).length;
  const correct = Object.values(progressState.perQ).filter((record) => record.correct).length;
  const accuracy = attempted > 0 ? Math.round((correct / attempted) * 100) : 0;
  $("home-overview").innerHTML =
    `<div class="ov-card"><div class="ov-label">今日やる復習</div><div class="ov-val">${stats.dueCount}</div><div class="ov-sub">期限中＋超過</div></div>` +
    `<div class="ov-card"><div class="ov-label">明日</div><div class="ov-val">${stats.dueTomorrow}</div><div class="ov-sub">予定</div></div>` +
    `<div class="ov-card"><div class="ov-label">今後7日</div><div class="ov-val">${stats.dueThisWeek}</div><div class="ov-sub">予定</div></div>`;

  const accuracyEl = $("home-accuracy");
  const progressEl = $("home-progress");
  if (accuracyEl) accuracyEl.textContent = attempted > 0 ? `${accuracy}%` : "—";
  if (progressEl) progressEl.textContent = `${attempted}/${QUESTIONS.length}問 解答済`;

  $("srs-today-desc").textContent = stats.dueCount > 0
    ? `${stats.dueCount}問 待機中（期限超過${stats.overdueCount}問）`
    : `今日はゼロ（プール${stats.poolSize}問）`;
  $("srs-ease-desc").textContent = `弱点を苦手な順に総ざらい（プール${stats.poolSize}問）`;
  if (stats.dueCount > 0) {
    $("srs-today-badge").textContent = String(stats.dueCount);
    show("srs-today-badge");
  } else {
    hide("srs-today-badge");
  }
}

function renderRecoAction(stats) {
  const el = $("reco-action");
  if (!el) return;
  const unseen = QUESTIONS.filter((question) => !recordForQuestion(question)).length;
  if (stats.dueCount > 0) {
    el.className = "reco-action reco-review";
    el.innerHTML =
      `<div class="reco-head">📅 今日の復習</div>` +
      `<div class="reco-main">${stats.dueCount}<span class="reco-unit">問</span></div>` +
      `<div class="reco-sub">忘却曲線で「今」が復習の適期です${stats.overdueCount > 0 ? `（うち期限超過 ${stats.overdueCount}問）` : ""}</div>` +
      `<button class="reco-btn" id="reco-go">復習を始める</button>`;
  } else if (unseen > 0) {
    el.className = "reco-action reco-new";
    el.innerHTML =
      `<div class="reco-head">✅ 今日の復習は完了</div>` +
      `<div class="reco-main">未解答 ${unseen}<span class="reco-unit">問</span></div>` +
      `<div class="reco-sub">新しい問題を進めて、復習プールを育てましょう</div>` +
      `<button class="reco-btn" id="reco-go">新しい問題へ</button>`;
  } else {
    el.className = "reco-action reco-done";
    el.innerHTML =
      `<div class="reco-head">🎉 お疲れさまです</div>` +
      `<div class="reco-main">今日やることは完了</div>` +
      `<div class="reco-sub">全問クリア＆今日の復習も終わりました</div>`;
  }
  const go = $("reco-go");
  if (go) {
    go.addEventListener("click", () => {
      if (stats.dueCount > 0) {
        void startSrsReview();
      } else {
        openModeModal("unseen");
      }
    });
  }
}

function renderWeakCategories() {
  const target = $("weak-cats");
  const weakStats = buildWeakCategoryStats().slice(0, 4);
  target.innerHTML = "";

  if (!weakStats.length) {
    target.innerHTML = '<div class="empty"><div class="empty-icon">📈</div><div>学習が進むと、ここに弱点カテゴリが表示されます。</div></div>';
    return;
  }

  weakStats.forEach((item) => {
    const row = document.createElement("div");
    row.className = "yr-row";
    row.innerHTML =
      `<div class="yr-top"><span class="yr-name">${escapeHtml(item.category)}</span><span class="yr-pct">${item.pct}%</span></div>` +
      `<div class="yr-bar"><div class="yr-fill" style="width:${Math.max(item.pct, 8)}%;background:${accuracyColor(item.pct)}"></div></div>` +
      `<div class="yr-sub">${item.attempted}問挑戦 · ${item.correct}問正解 · ${item.wrong}問見直し候補</div>`;
    target.appendChild(row);
  });
}

function openModeModal(target) {
  modalTarget = target;
  const title = $("modal-title");
  if (target === "all") {
    title.textContent = "全問 — モード選択";
  } else if (target === "wrong") {
    title.textContent = "苦手問題 — モード選択";
  } else if (target === "unseen") {
    title.textContent = "未解答問題 — モード選択";
  } else if (typeof target === "string" && target.startsWith("cat:")) {
    title.textContent = `${target.slice(4)} — モード選択`;
  } else {
    title.textContent = `${target}年 — モード選択`;
  }
  openOverlay("modal-bg");
}

function closeModeModal() {
  closeOverlay("modal-bg");
}

function buildPool(target) {
  if (target === "all") return QUESTIONS.slice();
  if (target === "wrong") {
    return QUESTIONS.filter((question) => {
      const record = recordForQuestion(question);
      return record && record.correct === false;
    });
  }
  if (target === "unseen") {
    return QUESTIONS.filter((question) => !recordForQuestion(question));
  }
  if (typeof target === "string" && target.startsWith("cat:")) {
    const category = target.slice(4);
    return QUESTIONS.filter((question) => question.category === category);
  }
  return QUESTIONS.filter((question) => question.year === target);
}

async function startQuiz(mode) {
  closeModeModal();
  let pool = buildPool(modalTarget);
  if (!pool.length) {
    showToast("対象の問題がありません。", "warn");
    return;
  }
  if (mode === "rand" || mode === "rand10") {
    pool = shuffle(pool.slice());
  }
  if (mode === "rand10") {
    pool = pool.slice(0, 10);
  }
  sessionState = {
    sessionId: newSessionId(),
    questions: pool,
    index: 0,
    mode,
    year: typeof modalTarget === "number" ? modalTarget : null,
    category: typeof modalTarget === "string" && modalTarget.startsWith("cat:") ? modalTarget.slice(4) : null,
    srsMode: null,
    submitted: {},
    userAns: {},
    correct: 0,
    startMs: Date.now()
  };
  await renderQuestion();
  showPage("pg-quiz");
}

function newSessionId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function savedSessionLabel(saved) {
  return saved.year ? `${saved.year}年` : saved.category ? saved.category : "全問";
}

async function resumeSession(saved) {
  if (!saved) return;
  const questions = hydrateQuestionIds(saved.questionIds);
  if (!questions.length) {
    progressState.savedSessions = progressState.savedSessions.filter((s) => s !== saved);
    await saveProgressState();
    showToast("再開データを復元できなかったため、保存を解除しました。", "warn");
    await renderHome();
    return;
  }
  if (!saved.sessionId) {
    saved.sessionId = newSessionId();
    await saveProgressState();
  }
  sessionState = {
    sessionId: saved.sessionId,
    questions,
    index: Math.min(saved.index || 0, questions.length - 1),
    mode: saved.mode || "seq",
    year: saved.year || null,
    category: saved.category || null,
    srsMode: saved.srsMode || null,
    submitted: saved.submitted || {},
    userAns: saved.userAns || {},
    correct: saved.correct || 0,
    startMs: Date.now() - (saved.elapsed || 0)
  };
  await renderQuestion();
  showPage("pg-quiz");
}

async function saveSessionState() {
  if (!sessionState || sessionState.srsMode || sessionState.mode === "view") return;
  const key = sessionTargetKey(sessionState);
  const list = progressState.savedSessions;
  const idx = list.findIndex((s) => s.targetKey === key);
  // 進捗ゼロのセッションで、同じ対象の別セッションの保存を黙って上書きしない
  if (
    idx >= 0 &&
    list[idx].sessionId !== sessionState.sessionId &&
    Object.keys(sessionState.submitted).length === 0
  ) return;
  const entry = {
    sessionId: sessionState.sessionId,
    targetKey: key,
    questionIds: sessionState.questions.map((question) => question.id),
    index: sessionState.index,
    mode: sessionState.mode,
    year: sessionState.year,
    category: sessionState.category,
    srsMode: null,
    submitted: sessionState.submitted,
    userAns: sessionState.userAns,
    correct: sessionState.correct,
    elapsed: Date.now() - sessionState.startMs,
    savedAt: Date.now()
  };
  if (idx >= 0) list[idx] = entry;
  else list.push(entry);
  await saveProgressState();
}

async function ensureMemoSaved(showStatus = false) {
  clearTimeout(memoSaveTimer);
  memoSaveTimer = null;
  if (!sessionState || !currentMemo.id) return;
  await saveMemoNow(showStatus);
}

async function renderQuestion() {
  if (!sessionState) return;
  const index = sessionState.index;
  const question = sessionState.questions[index];
  const total = sessionState.questions.length;
  const done = Boolean(sessionState.submitted[index]);
  const userSelection = sessionState.userAns[index] || [];
  const correctChoices = getCorrectChoices(question);
  const isMulti = question.multi || correctChoices.length > 1;
  const need = isMulti ? Math.max(correctChoices.length, 1) : 1;

  const labels = {
    review: "今日の復習",
    ease: "試験直前",
    recent: "試験直前"
  };
  $("quiz-title").textContent = sessionState.srsMode
    ? `${labels[sessionState.srsMode]} (${total}問)`
    : `${sessionState.year ? `${sessionState.year}年` : sessionState.category || "全問"} 問題集`;
  $("q-counter").textContent = `${index + 1} / ${total}`;
  $("prog-fill").style.width = `${((index + 1) / total) * 100}%`;
  $("q-score-live").textContent = `✓ ${sessionState.correct}`;

  let badges = `<span class="badge badge-year">${question.year}年 Q${question.num}</span>`;
  if (question.category) badges += `<span class="badge badge-cat">${escapeHtml(question.category)}</span>`;
  if (isMulti) badges += `<span class="badge badge-multi">${need}つ選べ</span>`;
  $("q-badges").innerHTML = badges;
  $("q-text").textContent = question.text;
  renderQuestionImages(question);

  const choices = $("choices");
  choices.innerHTML = "";
  Object.keys(question.choices).forEach((label) => {
    const button = document.createElement("button");
    button.className = "choice";
    button.dataset.label = label;
    const labelSpan = document.createElement("span");
    labelSpan.className = "choice-lbl";
    labelSpan.textContent = label;
    const textSpan = document.createElement("span");
    textSpan.textContent = question.choices[label];
    button.appendChild(labelSpan);
    button.appendChild(textSpan);

    if (done) {
      button.disabled = true;
      if (correctChoices.includes(label)) {
        button.classList.add("is-correct");
      } else if (userSelection.includes(label)) {
        button.classList.add("is-wrong");
      }
    } else {
      if (userSelection.includes(label)) {
        button.classList.add("selected");
      }
      button.addEventListener("click", () => toggleChoice(label, need, isMulti));
    }
    choices.appendChild(button);
  });

  const feedback = $("feedback");
  const expArea = $("exp-area");
  if (done) {
    const result = isCorrect(question, userSelection);
    if (result === null) {
      feedback.className = "feedback fb-warn";
      feedback.textContent = "解答未登録 — この問題の正答はまだ登録されていません。";
    } else if (result) {
      feedback.className = "feedback fb-ok";
      feedback.innerHTML = '<span>✓ 正解</span><button class="btn-mark-wrong" id="btn-mark-wrong">未正解リストへ</button>';
      $("btn-mark-wrong")?.addEventListener("click", () => {
        void markAsWrong();
      });
    } else {
      feedback.className = "feedback fb-ng";
      feedback.textContent = `✗ 不正解 — 正解: ${correctChoices.join(", ")}`;
    }
    feedback.classList.remove("hidden");
    if (question.explanation.trim()) {
      $("exp-text").textContent = question.explanation;
      expArea.classList.remove("hidden");
    } else {
      expArea.classList.add("hidden");
    }
  } else {
    feedback.classList.add("hidden");
    expArea.classList.add("hidden");
  }

  const srsArea = $("srs-rating-area");
  if (done && sessionState.srsMode) {
    srsArea.classList.remove("hidden");
    $("srs-pool-note").textContent = sessionState.srsMode === "review"
      ? "評価すると次回の復習日を自動計算します"
      : "評価は記録しません（間違えた問題は自動で復習予定に入ります）";
  } else {
    srsArea.classList.add("hidden");
  }

  if (done) {
    show("memo-area");
    await renderMemo(question.id);
  } else {
    cleanupCurrentMemoUrls();
    currentMemo = blankMemo("");
    hide("memo-area");
  }

  const prev = $("btn-prev");
  const submit = $("btn-submit");
  const next = $("btn-next");
  if (index > 0) show("btn-prev");
  else hide("btn-prev");

  if (done) {
    hide("btn-submit");
    if (sessionState.srsMode) {
      hide("btn-next");
    } else {
      show("btn-next");
      next.textContent = index < total - 1 ? "次へ →" : sessionState.mode === "view" ? "← 検索に戻る" : "結果を見る";
    }
  } else {
    show("btn-submit");
    submit.disabled = userSelection.length === 0;
    hide("btn-next");
  }
}

function toggleChoice(label, need, isMulti) {
  if (!sessionState) return;
  const index = sessionState.index;
  if (!sessionState.userAns[index]) sessionState.userAns[index] = [];
  const selected = sessionState.userAns[index];
  if (!isMulti) {
    sessionState.userAns[index] = [label];
  } else {
    const position = selected.indexOf(label);
    if (position > -1) {
      selected.splice(position, 1);
    } else if (selected.length < need) {
      selected.push(label);
    }
  }
  void renderQuestion();
}

async function submitAnswer() {
  if (!sessionState) return;
  const index = sessionState.index;
  const question = sessionState.questions[index];
  const userSelection = sessionState.userAns[index] || [];
  if (!userSelection.length) return;

  sessionState.submitted[index] = true;
  const result = isCorrect(question, userSelection);
  if (result === true) {
    sessionState.correct += 1;
  }

  progressState.perQ[question.id] = {
    correct: result,
    userAnswer: userSelection.join(","),
    updatedAt: Date.now()
  };
  await saveProgressState();

  if (result === false && sessionState.srsMode !== "review") {
    // 「今日の復習」モードは評価（handleRating→SRS.update）でスケジュールを更新するため二重処理を避ける。
    // それ以外のモード（年度別・全問・未解答・試験直前など）で間違えた場合はここでプールへ前倒し登録する。
    await SRS.addToPool(question);
  }
  await renderQuestion();
}

async function nextQuestion() {
  if (!sessionState) return;
  await ensureMemoSaved(false);
  if (sessionState.index < sessionState.questions.length - 1) {
    sessionState.index += 1;
    await renderQuestion();
    window.scrollTo({ top: 0, left: 0, behavior: "auto" });
  } else if (sessionState.mode === "view") {
    sessionState = null;
    showPage("pg-search");
  } else {
    await finishSession();
  }
}

async function previousQuestion() {
  if (!sessionState || sessionState.index === 0) return;
  await ensureMemoSaved(false);
  sessionState.index -= 1;
  await renderQuestion();
  window.scrollTo({ top: 0, left: 0, behavior: "auto" });
}

async function finishSession() {
  if (!sessionState) return;
  cleanupWrongMemoUrls();
  const elapsed = Math.round((Date.now() - sessionState.startMs) / 1000);
  const total = Object.keys(sessionState.submitted).length;
  const correct = sessionState.correct;
  const pct = total > 0 ? Math.round((correct / total) * 100) : 0;

  // 「続きから再開」の保存は、このセッション自身の分だけ消す
  // （復習セッションや別のクイズを終えても、他の中断は保持する）
  if (sessionState.sessionId) {
    progressState.savedSessions = progressState.savedSessions.filter(
      (s) => s.sessionId !== sessionState.sessionId
    );
  }
  progressState.sessions.unshift({
    dateMs: Date.now(),
    year: sessionState.year,
    category: sessionState.category,
    mode: sessionState.mode,
    total,
    correct,
    pct,
    elapsed
  });
  progressState.sessions = progressState.sessions.slice(0, MAX_SESSIONS);
  await saveProgressState();

  $("res-pct").textContent = `${pct}%`;
  $("res-correct").textContent = String(correct);
  $("res-total").textContent = String(total);
  $("res-time").textContent = formatDuration(elapsed);
  const circumference = 345.4;
  const ring = $("sc-fill");
  setTimeout(() => {
    ring.style.strokeDashoffset = String(circumference * (1 - pct / 100));
    ring.style.stroke = pct >= 80 ? "#16a34a" : pct >= 60 ? "#d97706" : "#dc2626";
  }, 60);

  const wrongQuestions = [];
  sessionState.questions.forEach((question, idx) => {
    if (sessionState.submitted[idx] && isCorrect(question, sessionState.userAns[idx] || []) === false) {
      wrongQuestions.push({ question, userAnswer: sessionState.userAns[idx] || [] });
    }
  });

  $("wrong-count").textContent = String(wrongQuestions.length);
  const wrongList = $("wrong-list");
  wrongList.innerHTML = "";
  if (!wrongQuestions.length) {
    wrongList.innerHTML = '<div class="empty"><div class="empty-icon">🎉</div><div>不正解問題はありません。</div></div>';
    $("btn-retry").style.display = "none";
  } else {
    $("btn-retry").style.display = "";
    for (const item of wrongQuestions) {
      const wrapper = document.createElement("div");
      wrapper.className = "wrong-item";
      wrapper.innerHTML =
        `<div class="wi-head">${item.question.year}年 Q${item.question.num}</div>` +
        `<div class="wi-text">${escapeHtml(item.question.text)}</div>` +
        `<div class="wi-ans"><span class="tag tag-ng">あなた: ${escapeHtml(item.userAnswer.join(", ") || "未")}</span><span class="tag tag-ok">正解: ${escapeHtml(getCorrectChoices(item.question).join(", "))}</span></div>`;
      if (item.question.explanation.trim()) {
        const exp = document.createElement("div");
        exp.className = "wi-exp";
        exp.textContent = item.question.explanation.length > 220
          ? `${item.question.explanation.slice(0, 220)}…`
          : item.question.explanation;
        wrapper.appendChild(exp);
      }
      const memoContainer = document.createElement("div");
      memoContainer.className = "wi-memo hidden";
      memoContainer.dataset.qid = item.question.id;
      memoContainer.innerHTML = '<div class="wi-memo-label">学習メモ</div>';
      wrapper.appendChild(memoContainer);
      wrongList.appendChild(wrapper);
      await appendWrongMemo(memoContainer, item.question.id);
    }
  }

  showPage("pg-result");
}

async function retryWrong() {
  if (!sessionState) return;
  const wrong = [];
  sessionState.questions.forEach((question, idx) => {
    if (sessionState.submitted[idx] && isCorrect(question, sessionState.userAns[idx] || []) === false) {
      wrong.push(question);
    }
  });
  if (!wrong.length) {
    showToast("再挑戦する不正解問題はありません。", "info");
    return;
  }
  sessionState = {
    questions: shuffle(wrong.slice()),
    index: 0,
    mode: "retry",
    year: null,
    category: null,
    srsMode: null,
    submitted: {},
    userAns: {},
    correct: 0,
    startMs: Date.now()
  };
  await renderQuestion();
  showPage("pg-quiz");
}

async function renderStats() {
  const total = QUESTIONS.length;
  const attempted = Object.keys(progressState.perQ).length;
  const correct = Object.values(progressState.perQ).filter((record) => record.correct).length;
  const pct = attempted > 0 ? Math.round((correct / attempted) * 100) : 0;

  $("ov-grid").innerHTML =
    `<div class="ov-card"><div class="ov-label">総正解率</div><div class="ov-val">${pct}%</div><div class="ov-sub">${correct}/${attempted}問</div></div>` +
    `<div class="ov-card"><div class="ov-label">解答済み</div><div class="ov-val">${attempted}</div><div class="ov-sub">全${total}問中</div></div>` +
    `<div class="ov-card"><div class="ov-label">未解答</div><div class="ov-val">${total - attempted}</div><div class="ov-sub">問</div></div>` +
    `<div class="ov-card"><div class="ov-label">セッション数</div><div class="ov-val">${progressState.sessions.length}</div><div class="ov-sub">回</div></div>`;

  const yearBreakdown = $("yr-breakdown");
  yearBreakdown.innerHTML = "";
  YEARS.forEach((year) => {
    const questions = QUESTIONS.filter((question) => question.year === year);
    const answered = questions.filter((question) => Boolean(recordForQuestion(question))).length;
    const correctCount = questions.filter((question) => {
      const record = recordForQuestion(question);
      return record && record.correct;
    }).length;
    const yearPct = answered > 0 ? Math.round((correctCount / answered) * 100) : 0;
    const color = yearPct >= 80 ? "#16a34a" : yearPct >= 60 ? "#d97706" : "#1d4ed8";
    yearBreakdown.innerHTML +=
      `<div class="yr-row"><div class="yr-top"><span class="yr-name">${year}年</span><span class="yr-pct" style="color:${color}">${answered > 0 ? `${yearPct}%` : "未挑戦"}</span></div><div class="yr-bar"><div class="yr-fill" style="width:${Math.round((answered / questions.length) * 100)}%;background:${color}"></div></div><div class="yr-sub">${answered}/${questions.length}問解答 · 正解 ${correctCount}問</div></div>`;
  });

  const catBreakdown = $("cat-breakdown");
  catBreakdown.innerHTML = "";
  CATEGORIES.forEach((category) => {
    const questions = QUESTIONS.filter((question) => question.category === category);
    const answered = questions.filter((question) => Boolean(recordForQuestion(question))).length;
    const correctCount = questions.filter((question) => {
      const record = recordForQuestion(question);
      return record && record.correct;
    }).length;
    const catPct = answered > 0 ? Math.round((correctCount / answered) * 100) : 0;
    const color = catPct >= 80 ? "#16a34a" : catPct >= 60 ? "#d97706" : "#7c3aed";
    catBreakdown.innerHTML +=
      `<div class="yr-row"><div class="yr-top"><span class="yr-name">${escapeHtml(category)}</span><span class="yr-pct" style="color:${color}">${answered > 0 ? `${catPct}%` : "未挑戦"}</span></div><div class="yr-bar"><div class="yr-fill" style="width:${Math.round((answered / questions.length) * 100)}%;background:${color}"></div></div><div class="yr-sub">${answered}/${questions.length}問解答 · 正解 ${correctCount}問</div></div>`;
  });

  const history = $("hist-list");
  history.innerHTML = "";
  if (!progressState.sessions.length) {
    history.innerHTML = '<div class="empty"><div class="empty-icon">📋</div><div>まだセッション履歴がありません。</div></div>';
    return;
  }
  progressState.sessions.slice(0, 15).forEach((session) => {
    const title = session.year ? `${session.year}年 ${modeLabel(session.mode)}` : session.category ? `${session.category} ${modeLabel(session.mode)}` : `全問 ${modeLabel(session.mode)}`;
    history.innerHTML +=
      `<div class="hist-item"><div><div class="hi-title">${escapeHtml(title)}</div><div class="hi-meta">${formatTimestamp(session.dateMs)} · ${formatDuration(session.elapsed || 0)}</div></div><div class="hi-score">${session.correct}/${session.total} (${session.pct}%)</div></div>`;
  });
}

async function startSrsReview() {
  const due = await SRS.getDue();
  if (!due.length) {
    showToast("今日の復習はありません。通常モードで新しい問題を進めましょう。", "info", 3400);
    return;
  }
  const questions = hydrateQuestionIds(due.map((item) => item.id));
  sessionState = {
    questions,
    index: 0,
    mode: "srs",
    year: null,
    category: null,
    srsMode: "review",
    submitted: {},
    userAns: {},
    correct: 0,
    startMs: Date.now()
  };
  await renderQuestion();
  showPage("pg-quiz");
}

async function openSrsModal(type) {
  srsTarget = type;
  const pool = type === "recent" ? await SRS.getRecentWrong() : await SRS.getEaseSorted();
  if (!pool.length) {
    showToast("復習プールがまだ空です。問題を解いて間違えると、ここに弱点が溜まります。", "info", 3400);
    return;
  }
  $("srs-modal-title").textContent = "試験直前（弱点まとめ）";
  $("srs-modal-info").textContent = `苦手な順に ${pool.length}問。何問やりますか？`;
  openOverlay("srs-modal-bg");
}

function closeSrsModal() {
  closeOverlay("srs-modal-bg");
}

async function startSrsCram(limit) {
  closeSrsModal();
  const pool = srsTarget === "ease" ? await SRS.getEaseSorted(limit) : await SRS.getRecentWrong(limit);
  if (!pool.length) {
    showToast("対象の問題がありません。", "warn");
    return;
  }
  const questions = hydrateQuestionIds(pool.map((item) => item.id));
  sessionState = {
    questions,
    index: 0,
    mode: "srs",
    year: null,
    category: null,
    srsMode: srsTarget === "ease" ? "ease" : "recent",
    submitted: {},
    userAns: {},
    correct: 0,
    startMs: Date.now()
  };
  await renderQuestion();
  showPage("pg-quiz");
}

async function handleRating(rating) {
  if (!sessionState) return;
  const question = sessionState.questions[sessionState.index];
  if (sessionState.srsMode === "review") {
    await SRS.update(question, rating);
    const rec = await SRS.get(question.id);
    if (rec && !rec.inPool) {
      showToast("この問題は習得済みに移行しました 🎉", "info", 2600);
    } else if (rec && rec.nextDue) {
      const d = parseDateKey(rec.nextDue);
      showToast(`次回の復習: ${d.getMonth() + 1}/${d.getDate()}`, "info", 2200);
    }
  }
  hide("srs-rating-area");
  await renderHome();
  await nextQuestion();
}

async function markAsWrong() {
  if (!sessionState) return;
  const index = sessionState.index;
  const question = sessionState.questions[index];
  const wasCorrect = isCorrect(question, sessionState.userAns[index] || []) === true;
  progressState.perQ[question.id] = {
    correct: false,
    userAnswer: (sessionState.userAns[index] || []).join(","),
    updatedAt: Date.now()
  };
  await saveProgressState();
  await SRS.addToPool(question);
  if (wasCorrect && sessionState.correct > 0) {
    sessionState.correct -= 1;
  }
  $("q-score-live").textContent = `✓ ${sessionState.correct}`;
  const feedback = $("feedback");
  feedback.className = "feedback fb-warn";
  feedback.textContent = "未正解リストへ移動しました。";
  await renderHome();
}

function openBackupModal() {
  openOverlay("backup-modal-bg");
}

function closeBackupModal() {
  closeOverlay("backup-modal-bg");
}

function updateMemoRendered() {
  const rendered = $("memo-rendered");
  const text = currentMemo.text || "";
  if (!rendered) return;
  if (!text.trim()) {
    rendered.innerHTML = '<span class="memo-rendered-empty">学習メモを記入してください...</span>';
    return;
  }
  const escaped = escapeHtml(text);
  rendered.innerHTML = escaped.replace(
    /(https?:\/\/[^\s<>"\u3000-\u30ff\u4e00-\u9fff]+)/g,
    '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>'
  );
}

function enterMemoEdit() {
  const rendered = $("memo-rendered");
  const textarea = $("memo-text");
  if (!rendered || !textarea) return;
  rendered.classList.add("hidden");
  textarea.classList.remove("hidden");
  textarea.focus();
}

function exitMemoEdit() {
  const rendered = $("memo-rendered");
  const textarea = $("memo-text");
  if (!rendered || !textarea) return;
  textarea.classList.add("hidden");
  rendered.classList.remove("hidden");
  updateMemoRendered();
}

async function loadMemoAssetImage(assetId) {
  const asset = await Database.getRecord("memoAssets", assetId);
  if (!asset || !asset.blob) return null;
  const url = URL.createObjectURL(asset.blob);
  currentMemoUrls.push(url);
  return {
    id: asset.id,
    name: asset.name || "memo-image",
    mimeType: asset.type || asset.blob.type || "image/*",
    size: asset.blob.size || 0,
    url
  };
}

async function renderMemo(qid) {
  cleanupCurrentMemoUrls();
  const memoRecord = await Database.getRecord("memos", qid);
  const text = memoRecord && typeof memoRecord.text === "string" ? memoRecord.text : "";
  const imageIds = memoRecord && Array.isArray(memoRecord.imageIds) ? memoRecord.imageIds : [];
  const images = [];
  for (const imageId of imageIds) {
    const image = await loadMemoAssetImage(imageId);
    if (image) images.push(image);
  }
  currentMemo = { id: qid, text, images };

  const textarea = $("memo-text");
  textarea.value = currentMemo.text;
  textarea.classList.add("hidden");
  $("memo-rendered").classList.remove("hidden");
  updateMemoRendered();
  renderMemoImages();
  $("memo-status").textContent = memoRecord && memoRecord.updatedAt ? `保存 ${formatTimestamp(memoRecord.updatedAt)}` : "";
}

function renderMemoImages() {
  const wrap = $("memo-imgs");
  wrap.innerHTML = "";
  currentMemo.images.forEach((image, index) => {
    const thumb = document.createElement("div");
    thumb.className = "memo-img-thumb";
    const img = document.createElement("img");
    img.src = image.url;
    img.alt = image.name;
    img.addEventListener("click", () => {
      window.open(image.url, "_blank", "noopener,noreferrer");
    });
    const remove = document.createElement("button");
    remove.className = "memo-img-del";
    remove.textContent = "✕";
    remove.addEventListener("click", (event) => {
      event.stopPropagation();
      void deleteMemoImage(index);
    });
    thumb.appendChild(img);
    thumb.appendChild(remove);
    wrap.appendChild(thumb);
  });
}

function scheduleMemoSave() {
  clearTimeout(memoSaveTimer);
  memoSaveTimer = setTimeout(() => {
    void saveMemoNow(true);
  }, 900);
}

async function saveMemoNow(showStatus) {
  if (!currentMemo.id) return;
  currentMemo.text = $("memo-text").value;
  updateMemoRendered();
  const record = {
    id: currentMemo.id,
    text: currentMemo.text,
    imageIds: currentMemo.images.map((image) => image.id),
    updatedAt: Date.now()
  };
  if (!record.text.trim() && record.imageIds.length === 0) {
    await Database.deleteRecord("memos", currentMemo.id);
    if (showStatus) $("memo-status").textContent = "";
    return;
  }
  await Database.putRecord("memos", record);
  if (showStatus) {
    $("memo-status").textContent = "保存済み ✓";
    setTimeout(() => {
      if ($("memo-status").textContent === "保存済み ✓") {
        $("memo-status").textContent = `保存 ${formatTimestamp(record.updatedAt)}`;
      }
    }, 1800);
  } else {
    $("memo-status").textContent = `保存 ${formatTimestamp(record.updatedAt)}`;
  }
}

async function addMemoImage(file) {
  if (!currentMemo.id) return;
  const assetId = `${currentMemo.id}:${Date.now()}:${Math.random().toString(16).slice(2, 8)}`;
  await Database.putRecord("memoAssets", {
    id: assetId,
    name: file.name || "memo-image",
    type: file.type || "image/png",
    createdAt: Date.now(),
    blob: file
  });
  const url = URL.createObjectURL(file);
  currentMemoUrls.push(url);
  currentMemo.images.push({
    id: assetId,
    name: file.name || "memo-image",
    mimeType: file.type || "image/png",
    size: file.size || 0,
    url
  });
  renderMemoImages();
  await saveMemoNow(true);
}

async function deleteMemoImage(index) {
  const target = currentMemo.images[index];
  if (!target) return;
  await Database.deleteRecord("memoAssets", target.id);
  if (target.url && target.url.startsWith("blob:")) {
    URL.revokeObjectURL(target.url);
  }
  currentMemo.images.splice(index, 1);
  renderMemoImages();
  await saveMemoNow(true);
}

function insertTemplate(kind) {
  const snippet = TEMPLATE_INSERTIONS[kind];
  if (!snippet) return;
  if ($("memo-text").classList.contains("hidden")) {
    enterMemoEdit();
  }
  const textarea = $("memo-text");
  const start = textarea.selectionStart || textarea.value.length;
  const end = textarea.selectionEnd || textarea.value.length;
  const nextValue = textarea.value.slice(0, start) + snippet + textarea.value.slice(end);
  textarea.value = nextValue;
  textarea.selectionStart = textarea.selectionEnd = start + snippet.length;
  currentMemo.text = textarea.value;
  scheduleMemoSave();
}

async function appendWrongMemo(container, qid) {
  const memoRecord = await Database.getRecord("memos", qid);
  if (!memoRecord || (!memoRecord.text && !(memoRecord.imageIds || []).length)) return;
  if (memoRecord.text) {
    const body = document.createElement("div");
    body.className = "wi-memo-text";
    body.textContent = memoRecord.text;
    container.appendChild(body);
  }
  if (Array.isArray(memoRecord.imageIds) && memoRecord.imageIds.length) {
    const wrap = document.createElement("div");
    wrap.className = "wi-memo-imgs";
    for (const imageId of memoRecord.imageIds) {
      const asset = await Database.getRecord("memoAssets", imageId);
      if (!asset || !asset.blob) continue;
      const url = URL.createObjectURL(asset.blob);
      wrongMemoUrls.push(url);
      const image = document.createElement("img");
      image.src = url;
      image.alt = asset.name || "memo-image";
      image.addEventListener("click", () => {
        window.open(url, "_blank", "noopener,noreferrer");
      });
      wrap.appendChild(image);
    }
    if (wrap.children.length) {
      container.appendChild(wrap);
    }
  }
  container.classList.remove("hidden");
}

async function searchMemos(term) {
  const all = await Database.getAll("memos");
  const normalized = term.toLowerCase();
  return all
    .filter((memo) => memo.text && memo.text.toLowerCase().includes(normalized))
    .map((memo) => ({
      id: memo.id,
      memoText: memo.text
    }));
}

async function doSearch() {
  const term = $("search-input").value.trim();
  const output = $("search-results");
  if (!term) {
    output.innerHTML = "";
    return;
  }
  output.innerHTML = '<div class="empty">検索中...</div>';
  const normalized = term.toLowerCase();
  const questionResults = QUESTIONS.filter((question) => buildSearchIndex(question).includes(normalized));
  const memoResults = await searchMemos(term);
  renderSearchResults(questionResults, memoResults, term);
}

function makeSearchResultCard(question, extraHtml) {
  const div = document.createElement("div");
  div.className = "search-result-item";
  let head = `<div class="sri-head"><span class="badge badge-year">${question.year}年 Q${question.num}</span>`;
  if (question.category) head += `<span class="badge badge-cat">${escapeHtml(question.category)}</span>`;
  head += "</div>";
  const text = `<div class="sri-qtext">${escapeHtml(question.text.length > 120 ? `${question.text.slice(0, 120)}…` : question.text)}</div>`;
  div.innerHTML = head + text + (extraHtml || "");
  div.addEventListener("click", () => {
    void viewQuestion(question.year, question.num);
  });
  return div;
}

function renderSearchResults(questionResults, memoResults, term) {
  const output = $("search-results");
  output.innerHTML = "";
  if (!questionResults.length && !memoResults.length) {
    output.innerHTML = `<div class="empty"><div class="empty-icon">🔍</div><div>「${escapeHtml(term)}」に一致する結果はありません。</div></div>`;
    return;
  }

  const questionSection = document.createElement("div");
  const questionLabel = document.createElement("div");
  questionLabel.className = "section-label";
  questionLabel.textContent = `問題欄 — ${questionResults.length}件`;
  questionSection.appendChild(questionLabel);
  if (!questionResults.length) {
    questionSection.innerHTML += '<div class="empty" style="padding:10px 0;font-size:.85rem">問題文・解説・選択肢・カテゴリに一致する結果はありません。</div>';
  } else {
    questionResults.forEach((question) => {
      questionSection.appendChild(makeSearchResultCard(question, ""));
    });
  }
  output.appendChild(questionSection);

  const memoSection = document.createElement("div");
  memoSection.style.marginTop = "16px";
  const memoLabel = document.createElement("div");
  memoLabel.className = "section-label";
  memoLabel.textContent = `メモ欄 — ${memoResults.length}件`;
  memoSection.appendChild(memoLabel);
  if (!memoResults.length) {
    memoSection.innerHTML += '<div class="empty" style="padding:10px 0;font-size:.85rem">メモに一致する結果はありません。</div>';
  } else {
    memoResults.forEach((item) => {
      const question = QUESTION_MAP.get(item.id);
      if (!question) return;
      const preview = escapeHtml(item.memoText.length > 180 ? `${item.memoText.slice(0, 180)}…` : item.memoText);
      memoSection.appendChild(makeSearchResultCard(question, `<div class="sri-memo">${preview}</div>`));
    });
  }
  output.appendChild(memoSection);
}

async function viewQuestion(year, num) {
  const question = QUESTION_MAP.get(`${year}-${num}`);
  if (!question) return;
  const record = recordForQuestion(question);
  sessionState = {
    questions: [question],
    index: 0,
    mode: "view",
    year: null,
    category: null,
    srsMode: null,
    submitted: {},
    userAns: {},
    correct: 0,
    startMs: Date.now()
  };
  if (record) {
    sessionState.submitted[0] = true;
    sessionState.userAns[0] = record.userAnswer ? record.userAnswer.split(",").filter(Boolean) : [];
    if (record.correct) sessionState.correct = 1;
  }
  await renderQuestion();
  showPage("pg-quiz");
}

async function goHome() {
  if (sessionState && Object.keys(sessionState.submitted).length > 0 && sessionState.mode !== "view") {
    let message = "進捗は「続きから再開」として保存されます。";
    if (sessionState.srsMode) {
      message = "評価済みの分は記録されています（復習の途中経過は保存されません）。";
    } else {
      const existing = progressState.savedSessions.find(
        (s) => s.targetKey === sessionTargetKey(sessionState) && s.sessionId !== sessionState.sessionId
      );
      if (existing) {
        message = `同じ対象の中断「${savedSessionLabel(existing)} ${existing.index + 1}/${existing.questionIds.length}問目」は上書きされます。`;
      }
    }
    const confirmed = await askConfirm({
      title: "ホームへ戻りますか？",
      message,
      confirmText: sessionState.srsMode ? "戻る" : "保存して戻る"
    });
    if (!confirmed) return;
    await saveSessionState();
  }
  await renderHome();
  showPage("pg-home");
}

async function pauseSession() {
  if (sessionState && sessionState.mode === "view") {
    sessionState = null;
    showPage("pg-search");
    return;
  }
  const savable = sessionState && !sessionState.srsMode;
  if (savable && Object.keys(sessionState.submitted).length > 0) {
    const existing = progressState.savedSessions.find(
      (s) => s.targetKey === sessionTargetKey(sessionState) && s.sessionId !== sessionState.sessionId
    );
    if (existing) {
      const confirmed = await askConfirm({
        title: "同じ対象の中断を上書きしますか？",
        message: `「${savedSessionLabel(existing)} ${existing.index + 1}/${existing.questionIds.length}問目」の保存は消え、今のセッションに置き換わります。`,
        confirmText: "上書きして中断"
      });
      if (!confirmed) return;
    }
  }
  await ensureMemoSaved(false);
  await saveSessionState();
  await renderHome();
  showPage("pg-home");
  showToast(
    savable ? "中断しました。ホームから続きに戻れます。" : "ホームに戻りました。評価済みの分は記録されています。",
    "success"
  );
}

async function handleImportSelection(event) {
  const file = event.target.files && event.target.files[0];
  event.target.value = "";
  if (!file) return;
  const confirmed = await askConfirm({
    title: "バックアップを復元しますか？",
    message: "現在の学習履歴、メモ、SRSはバックアップ内容で置き換わります。",
    confirmText: "復元する"
  });
  if (!confirmed) return;
  try {
    await importBackupFromFile(file);
  } catch (error) {
    console.error(error);
    showToast(error.message || "バックアップの復元に失敗しました。", "error", 3600);
  }
}

async function registerServiceWorker() {
  if (FILE_PROTOCOL || !("serviceWorker" in navigator)) return;
  try {
    await navigator.serviceWorker.register("./service-worker.js");
  } catch (error) {
    console.warn("service worker registration failed", error);
  }
}

async function requestPersistentStorage() {
  if (navigator.storage && navigator.storage.persist) {
    try {
      await navigator.storage.persist();
    } catch (error) {
      console.warn("storage persistence request failed", error);
    }
  }
}

function wireEvents() {
  $("bn-home")?.addEventListener("click", async () => {
    await renderHome();
    showPage("pg-home");
  });
  $("bn-stats")?.addEventListener("click", async () => {
    await renderStats();
    showPage("pg-stats");
  });
  $("bn-search")?.addEventListener("click", () => {
    $("search-input").value = "";
    $("search-results").innerHTML = "";
    showPage("pg-search");
  });

  $("exam-card")?.addEventListener("click", () => {
    const input = $("exam-date-input");
    if (input) input.value = getExamDate();
    $("exam-modal-bg")?.classList.remove("hidden");
  });
  $("exam-save")?.addEventListener("click", () => {
    const input = $("exam-date-input");
    if (input && /^\d{4}-\d{2}-\d{2}$/.test(input.value)) {
      setExamDate(input.value);
      renderExamCard();
      showToast("受験日を更新しました", "success");
    }
    $("exam-modal-bg")?.classList.add("hidden");
  });
  $("exam-cancel")?.addEventListener("click", () => {
    $("exam-modal-bg")?.classList.add("hidden");
  });
  $("exam-modal-bg")?.addEventListener("click", (event) => {
    if (event.target === $("exam-modal-bg")) $("exam-modal-bg").classList.add("hidden");
  });

  $("btn-backup")?.addEventListener("click", openBackupModal);
  $("btn-all")?.addEventListener("click", () => openModeModal("all"));

  $("modal-seq")?.addEventListener("click", () => {
    void startQuiz("seq");
  });
  $("modal-rand")?.addEventListener("click", () => {
    void startQuiz("rand");
  });
  $("modal-rand10")?.addEventListener("click", () => {
    void startQuiz("rand10");
  });
  $("modal-cancel")?.addEventListener("click", closeModeModal);
  $("modal-bg")?.addEventListener("click", (event) => {
    if (event.target === $("modal-bg")) closeModeModal();
  });

  $("btn-pause")?.addEventListener("click", () => {
    void pauseSession();
  });
  $("btn-quiz-home")?.addEventListener("click", () => {
    void goHome();
  });
  $("btn-submit")?.addEventListener("click", () => {
    void submitAnswer();
  });
  $("btn-next")?.addEventListener("click", () => {
    void nextQuestion();
  });
  $("btn-prev")?.addEventListener("click", () => {
    void previousQuestion();
  });

  $("btn-result-home")?.addEventListener("click", async () => {
    sessionState = null;
    await renderHome();
    showPage("pg-home");
  });
  $("btn-result-home2")?.addEventListener("click", async () => {
    sessionState = null;
    await renderHome();
    showPage("pg-home");
  });
  $("btn-retry")?.addEventListener("click", () => {
    void retryWrong();
  });

  $("btn-stats-home")?.addEventListener("click", async () => {
    await renderHome();
    showPage("pg-home");
  });

  $("btn-search-home")?.addEventListener("click", async () => {
    await renderHome();
    showPage("pg-home");
  });
  $("btn-do-search")?.addEventListener("click", () => {
    void doSearch();
  });
  $("search-input")?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      void doSearch();
    }
  });

  $("btn-srs-today")?.addEventListener("click", () => {
    void startSrsReview();
  });
  $("btn-srs-ease")?.addEventListener("click", () => {
    void openSrsModal("ease");
  });
  $("srs-modal-20")?.addEventListener("click", () => {
    void startSrsCram(20);
  });
  $("srs-modal-50")?.addEventListener("click", () => {
    void startSrsCram(50);
  });
  $("srs-modal-all")?.addEventListener("click", () => {
    void startSrsCram(null);
  });
  $("srs-modal-cancel")?.addEventListener("click", closeSrsModal);
  $("srs-modal-bg")?.addEventListener("click", (event) => {
    if (event.target === $("srs-modal-bg")) closeSrsModal();
  });

  $("btn-rate-0")?.addEventListener("click", () => {
    void handleRating(0);
  });
  $("btn-rate-1")?.addEventListener("click", () => {
    void handleRating(1);
  });
  $("btn-rate-2")?.addEventListener("click", () => {
    void handleRating(2);
  });

  $("memo-rendered")?.addEventListener("click", enterMemoEdit);
  $("memo-text")?.addEventListener("input", () => {
    currentMemo.text = $("memo-text").value;
    scheduleMemoSave();
  });
  $("memo-text")?.addEventListener("blur", () => {
    exitMemoEdit();
    void saveMemoNow(false);
  });
  $("memo-text")?.addEventListener("paste", (event) => {
    const items = Array.from((event.clipboardData || window.clipboardData).items || []);
    const imageItem = items.find((item) => item.type && item.type.includes("image"));
    if (imageItem) {
      event.preventDefault();
      const file = imageItem.getAsFile();
      if (file) {
        void addMemoImage(file);
      }
    }
  });
  $("memo-file-input")?.addEventListener("change", async (event) => {
    const files = Array.from(event.target.files || []);
    for (const file of files) {
      await addMemoImage(file);
    }
    event.target.value = "";
  });
  document.querySelectorAll(".template-chip").forEach((button) => {
    button.addEventListener("click", () => insertTemplate(button.dataset.template));
  });

  $("btn-export-data")?.addEventListener("click", () => {
    void exportBackup();
  });
  $("btn-import-data")?.addEventListener("click", () => {
    $("backup-import-input").click();
  });
  $("btn-backup-close")?.addEventListener("click", closeBackupModal);
  $("backup-modal-bg")?.addEventListener("click", (event) => {
    if (event.target === $("backup-modal-bg")) closeBackupModal();
  });
  $("backup-import-input")?.addEventListener("change", (event) => {
    void handleImportSelection(event);
  });

  $("confirm-cancel")?.addEventListener("click", () => resolveConfirm(false));
  $("confirm-ok")?.addEventListener("click", () => resolveConfirm(true));
  $("confirm-modal-bg")?.addEventListener("click", (event) => {
    if (event.target === $("confirm-modal-bg")) resolveConfirm(false);
  });

  window.addEventListener("pagehide", () => {
    void ensureMemoSaved(false);
    void saveSessionState();
  });
}

function showFatalError(error) {
  console.error(error);
  const home = $("pg-home");
  home.innerHTML =
    '<div class="page"><div class="scroll-area"><div class="inner"><div class="empty"><div class="empty-icon">⚠️</div><div>アプリの初期化に失敗しました。</div><div style="margin-top:8px;color:#64748b;font-size:.9rem">questions.json や IndexedDB の状態を確認してください。</div></div></div></div></div>';
}

async function init() {
  try {
    await Database.init();
    await loadProgressState();
    const legacyImportResult = await importLegacyMemosIfNeeded();
    QUESTIONS = await loadQuestions();
    QUESTION_MAP = new Map(QUESTIONS.map((question) => [question.id, question]));
    YEARS = Array.from(new Set(QUESTIONS.map((question) => question.year))).sort((a, b) => a - b);
    CATEGORIES = getCategoryOrder(Array.from(new Set(QUESTIONS.map((question) => question.category))));
    setRuntimeBanner();
    wireEvents();
    await requestPersistentStorage();
    await renderHome();
    await registerServiceWorker();
    if (legacyImportResult && legacyImportResult.imported) {
      showToast(`旧版メモを ${legacyImportResult.imported} 件引き継ぎました。`, "success", 4200);
    }
  } catch (error) {
    showFatalError(error);
  }
}

document.addEventListener("DOMContentLoaded", () => {
  void init();
});
