import { invoke } from "@tauri-apps/api/core";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";

// ─────────────────────────────────────────────
//  Helpers
// ─────────────────────────────────────────────
function byId<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}
function show(el: HTMLElement) { el.classList.remove("hidden"); }
function hide(el: HTMLElement) { el.classList.add("hidden"); }

// ─────────────────────────────────────────────
//  Element refs — Convert tab
// ─────────────────────────────────────────────
const dropEl       = byId<HTMLDivElement>("drop");
const folderInput  = byId<HTMLInputElement>("folder");
const chooseBtn    = byId<HTMLButtonElement>("choose");
const runBtn       = byId<HTMLButtonElement>("run");
const cancelBtn    = byId<HTMLButtonElement>("cancel");
const normalizeEl  = byId<HTMLInputElement>("normalize");
const trimEl       = byId<HTMLInputElement>("trim");
const layoutEl     = byId<HTMLSelectElement>("layout");
const logEl        = byId<HTMLTextAreaElement>("log");
const logDetails   = byId<HTMLDetailsElement>("log-details");

const queueSection = byId<HTMLDivElement>("queue-section");
const queueList    = byId<HTMLUListElement>("queue-list");
const queueClear   = byId<HTMLButtonElement>("queue-clear");

const panelRunning = byId<HTMLDivElement>("panel-running");
const panelDone    = byId<HTMLDivElement>("panel-done");
const panelError   = byId<HTMLDivElement>("panel-error");
const runLabel     = byId<HTMLSpanElement>("run-label");
const runCount     = byId<HTMLSpanElement>("run-count");
const progressBar  = byId<HTMLDivElement>("progress-bar");
const nowFile      = byId<HTMLSpanElement>("now-file");
const recentList   = byId<HTMLUListElement>("recent-list");
const statFiles    = byId<HTMLSpanElement>("stat-files");
const statTime     = byId<HTMLSpanElement>("stat-time");
const statPath     = byId<HTMLElement>("stat-path");
const revealBtn      = byId<HTMLButtonElement>("reveal-btn");
const autoClassifyEl = byId<HTMLInputElement>("auto-classify");

// ─────────────────────────────────────────────
//  Tabs
// ─────────────────────────────────────────────
document.querySelectorAll<HTMLButtonElement>(".tab").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
    btn.classList.add("active");
    const target = btn.dataset["tab"]!;
    document.querySelectorAll<HTMLDivElement>(".tab-content").forEach(tc => {
      tc.id === `tab-${target}` ? show(tc) : hide(tc);
    });
  });
});

// ─────────────────────────────────────────────
//  Layout description
// ─────────────────────────────────────────────
const layoutDescs: Record<string, string> = {
  "keep":        "Output mirrors the original subfolder tree inside SAMPLEM-REPACKED.",
  "flat-prefix": "All files in one folder, prefixed with their original subfolder name.",
  "flat":        "All files in one flat folder. Duplicated filenames get a numeric suffix.",
};

const layoutDesc = byId<HTMLSpanElement>("layout-desc");
function updateLayoutDesc() { layoutDesc.textContent = layoutDescs[layoutEl.value] ?? ""; }
layoutEl.addEventListener("change", updateLayoutDesc);
updateLayoutDesc();

// ─────────────────────────────────────────────
//  Folder selection
// ─────────────────────────────────────────────
async function chooseFolder() {
  const sel = await open({ directory: true, multiple: false });
  if (typeof sel === "string") addToQueue(sel);
}
chooseBtn.addEventListener("click", chooseFolder);
byId<HTMLButtonElement>("choose2").addEventListener("click", chooseFolder);

function addToQueue(path: string) {
  if (!queue.includes(path)) {
    queue.push(path);
    renderQueue();
  }
}

// ─────────────────────────────────────────────
//  Queue (multi-folder)
// ─────────────────────────────────────────────
const queue: string[] = [];

function renderQueue() {
  if (queue.length === 0) {
    queueSection.classList.remove("visible");
    dropEl.classList.remove("has-queue");
    return;
  }
  queueSection.classList.remove("hidden");
  // rAF so transition plays after display:block kicks in
  requestAnimationFrame(() => queueSection.classList.add("visible"));
  dropEl.classList.add("has-queue");
  queueList.innerHTML = queue.map((p, i) =>
    `<li data-idx="${i}">
      <span class="queue-item-icon">📁</span>
      <div class="queue-item-info">
        <span class="queue-item-name">${p.split("/").pop()}</span>
        <span class="queue-item-path">${p}</span>
      </div>
      <button class="queue-remove" data-idx="${i}" title="Remove">×</button>
    </li>`
  ).join("");
  queueList.querySelectorAll<HTMLButtonElement>(".queue-remove").forEach(btn => {
    btn.addEventListener("click", () => {
      const idx = parseInt(btn.dataset["idx"]!);
      queue.splice(idx, 1);
      renderQueue();
    });
  });
}

queueClear.addEventListener("click", () => { queue.length = 0; renderQueue(); });

// ─────────────────────────────────────────────
//  Smooth log details
// ─────────────────────────────────────────────
// Replace native <details> with JS-controlled smooth version
const logSummary = logDetails.querySelector("summary")!;
logDetails.addEventListener("toggle", (e) => {
  e.preventDefault();
  // We control it manually via animation
}, true);
logSummary.addEventListener("click", (e) => {
  e.preventDefault();
  const isOpen = logDetails.open;
  if (!isOpen) {
    logDetails.open = true;
    const inner = logEl;
    inner.style.maxHeight = "0";
    inner.style.opacity   = "0";
    inner.style.overflow  = "hidden";
    inner.style.transition = "max-height .3s ease, opacity .3s ease";
    requestAnimationFrame(() => {
      inner.style.maxHeight = "130px";
      inner.style.opacity   = "1";
    });
    inner.addEventListener("transitionend", () => {
      inner.style.overflow = "auto";
      inner.style.maxHeight = "130px";
    }, { once: true });
  } else {
    const inner = logEl;
    inner.style.maxHeight = "130px";
    inner.style.overflow  = "hidden";
    inner.style.transition = "max-height .3s ease, opacity .3s ease";
    requestAnimationFrame(() => {
      inner.style.maxHeight = "0";
      inner.style.opacity   = "0";
    });
    inner.addEventListener("transitionend", () => {
      logDetails.open = false;
      inner.style.maxHeight = "";
      inner.style.opacity   = "";
      inner.style.overflow  = "";
      inner.style.transition = "";
    }, { once: true });
  }
});

// ─────────────────────────────────────────────
//  Run (single or queue)
// ─────────────────────────────────────────────
runBtn.addEventListener("click", async () => {
  const targets = queue.length > 0
    ? [...queue]
    : folderInput.value.trim() ? [folderInput.value.trim()] : [];
  if (targets.length === 0) { logEl.value = "Please add a folder to the queue first.\n"; return; }

  runBtn.disabled    = true;
  cancelBtn.disabled = false;
  logEl.value        = "";
  recentList.innerHTML = "";
  nowFile.textContent  = "—";
  progressBar.style.width = "0%";

  // Shrink drop zone
  dropEl.classList.add("shrunk");
  hide(panelDone);
  hide(panelError);
  show(panelRunning);

  let totalConverted = 0;
  let startTime = Date.now();

  for (let qi = 0; qi < targets.length; qi++) {
    const target = targets[qi];
    const isLast = qi === targets.length - 1;

    runLabel.textContent = targets.length > 1
      ? `Converting… (${qi + 1}/${targets.length})`
      : "Converting…";
    runCount.textContent = "";
    progressBar.style.width = "0%";
    nowFile.textContent = "—";

    // Highlight current in queue
    queueList.querySelectorAll("li").forEach((li, i) => {
      li.classList.toggle("active", i === qi);
      if (i < qi) li.classList.add("done");
    });

    let fileCount  = 0;
    let totalFiles = 0;
    const recentFiles: string[] = [];

    const updateFeed = (filename: string) => {
      nowFile.textContent = filename;
      recentFiles.unshift(filename);
      if (recentFiles.length > 12) recentFiles.pop();
      recentList.innerHTML = recentFiles.map(f => `<li>${f}</li>`).join("");
    };

    let unlisten: UnlistenFn | undefined;
    try {
      unlisten = await listen<string>("samplem-log", (e) => {
        const line = e.payload;
        const pm = line.match(/^PROGRESS:(\d+)\/(\d+)$/);
        if (pm) {
          const done = parseInt(pm[1], 10);
          totalFiles = parseInt(pm[2], 10);
          progressBar.style.width = `${((done / totalFiles) * 100).toFixed(1)}%`;
          runCount.textContent    = `${done.toLocaleString()} / ${totalFiles.toLocaleString()}`;
          return;
        }
        const fm = line.match(/^• (?:Convert|Copy)\s+:: .+ → (.+)$/);
        if (fm) {
          fileCount++;
          updateFeed((fm[1].trim().split("/").pop() ?? fm[1].trim()));
        }
        logEl.value += line + "\n";
        logEl.scrollTop = logEl.scrollHeight;
      });

      const code = await invoke<number>("run_samplem", {
        path: target, normalize: normalizeEl.checked,
        trim: trimEl.checked, layout: layoutEl.value,
      });

      totalConverted += totalFiles > 0 ? totalFiles : fileCount;
      if (code !== 0 && isLast) { show(panelError); }
    } catch (e) {
      logEl.value += `Error: ${String(e)}\n`;
      if (isLast) { show(panelError); }
    } finally {
      if (unlisten) unlisten();
    }
  }

  // Done
  const elapsed   = Date.now() - startTime;
  const mins      = Math.floor(elapsed / 60000);
  const secs      = Math.floor((elapsed % 60000) / 1000);
  const timeStr   = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
  const lastTarget = targets[targets.length - 1].replace(/\/+$/, "");
  const packName  = lastTarget.split("/").pop() ?? lastTarget;
  const outPath   = `${lastTarget}/SAMPLEM-REPACKED/${packName}`;

  statFiles.textContent = totalConverted.toLocaleString();
  statTime.textContent  = timeStr;
  statPath.textContent  = outPath;

  hide(panelRunning);
  if (panelError.classList.contains("hidden")) {
    show(panelDone);

    // Auto-classify the output if checkbox is ticked
    if (autoClassifyEl.checked) {
      const classifiedDest = outPath + "-classified";
      try {
        await invoke("run_classify", { source: outPath, dest: classifiedDest });
        statPath.textContent = classifiedDest;
      } catch (e) {
        console.warn("Auto-classify failed:", e);
      }
    }
  }

  runBtn.disabled    = false;
  cancelBtn.disabled = true;
  runLabel.textContent = "Done";
  queue.length = 0;
  renderQueue();
  dropEl.classList.remove("shrunk");
});

// ─────────────────────────────────────────────
//  Cancel
// ─────────────────────────────────────────────
cancelBtn.addEventListener("click", async () => {
  cancelBtn.disabled   = true;
  runLabel.textContent = "Cancelling…";
  try { await invoke("cancel_samplem"); } catch (e) { console.error(e); }
});

// ─────────────────────────────────────────────
//  Show in Finder
// ─────────────────────────────────────────────
revealBtn.addEventListener("click", async () => {
  const path = statPath.textContent ?? "";
  try { await revealItemInDir(path); }
  catch { try { await revealItemInDir(folderInput.value); } catch {} }
});

// ─────────────────────────────────────────────
//  Drag-and-drop (Tauri v2)
// ─────────────────────────────────────────────
getCurrentWindow().onDragDropEvent((event) => {
  if (event.payload.type === "enter" || event.payload.type === "over") {
    dropEl.classList.add("hover");
  } else if (event.payload.type === "leave") {
    dropEl.classList.remove("hover");
  } else if (event.payload.type === "drop") {
    dropEl.classList.remove("hover");
    const paths = event.payload.paths;
    if (!paths?.length) return;
    paths.forEach(p => addToQueue(p));
  }
});

// ═══════════════════════════════════════════════════════════
//  LIBRARY TAB
// ═══════════════════════════════════════════════════════════

interface SampleEntry {
  path: string; filename: string; folder: string; ext: string;
  channels: number; sample_rate: number; bit_depth: number;
  duration: number; size_bytes: number;
  bpm?: number | null; key?: string | null;
}

const libChooseBtn   = byId<HTMLButtonElement>("lib-choose");
const libRootLabel   = byId<HTMLSpanElement>("lib-root-label");
const libSearch      = byId<HTMLInputElement>("lib-search");
const libFormat      = byId<HTMLSelectElement>("lib-format");
const libCount       = byId<HTMLSpanElement>("lib-count");
const libRescan      = byId<HTMLButtonElement>("lib-rescan");
const libScanning    = byId<HTMLDivElement>("lib-scanning");
const libScanBar     = byId<HTMLDivElement>("lib-scan-bar");
const libScanLabel   = byId<HTMLSpanElement>("lib-scan-label");
const libTbody       = byId<HTMLTableSectionElement>("lib-tbody");
const libEmpty       = byId<HTMLDivElement>("lib-empty");
const libPlayer      = byId<HTMLDivElement>("lib-player");
const libStop        = byId<HTMLButtonElement>("lib-stop");
const libRestart     = byId<HTMLButtonElement>("lib-restart");
const libPlayPause   = byId<HTMLButtonElement>("lib-playpause");
const libWaveform    = document.getElementById("lib-waveform") as unknown as SVGSVGElement;
const libPlayerName  = byId<HTMLSpanElement>("lib-player-name");

let allSamples:     SampleEntry[] = [];
let filteredSamples: SampleEntry[] = [];
let currentLibRoot  = "";

// Load persisted library on startup
invoke<SampleEntry[]>("get_library").then(entries => {
  if (entries.length > 0) {
    allSamples = entries;
    currentLibRoot = entries[0]?.folder ?? "";
    libRootLabel.textContent = currentLibRoot;
    show(libRescan);
    filterAndRender();
    refreshClassifyBtn();
  }
}).catch(() => {});

// Progress listener
listen<{ done: number; total: number }>("library-progress", (e) => {
  const { done, total } = e.payload;
  const pct = total > 0 ? (done / total) * 100 : 0;
  libScanBar.style.width  = `${pct.toFixed(1)}%`;
  libScanLabel.textContent = `Scanning… ${done.toLocaleString()} / ${total.toLocaleString()}`;
});

libChooseBtn.addEventListener("click", async () => {
  const sel = await open({ directory: true, multiple: false });
  if (typeof sel !== "string") return;
  currentLibRoot = sel;
  libRootLabel.textContent = sel;
  show(libRescan);
  await doScan(sel);
});

libRescan.addEventListener("click", async () => {
  if (currentLibRoot) await doScan(currentLibRoot);
});

async function doScan(path: string) {
  show(libScanning);
  libScanBar.style.width  = "0%";
  libScanLabel.textContent = "Scanning…";
  try {
    const entries = await invoke<SampleEntry[]>("scan_library", { path });
    allSamples = entries;
    filterAndRender();
  } catch (e) {
    console.error("scan failed", e);
  } finally {
    hide(libScanning);
    refreshClassifyBtn();
  }
}

libSearch.addEventListener("input", filterAndRender);
libFormat.addEventListener("change", filterAndRender);

// ── Column sorting ──
const SORT_KEYS: (keyof SampleEntry)[] = ["filename", "ext", "duration", "sample_rate", "channels", "folder"];
let sortCol: keyof SampleEntry = "filename";
let sortDir = 1;

const libThead = libTbody.closest("table")!.querySelector("thead tr")!;
libThead.querySelectorAll<HTMLTableCellElement>("th").forEach((th, i) => {
  if (i >= SORT_KEYS.length) return;
  th.dataset["col"] = SORT_KEYS[i];
  th.addEventListener("click", () => {
    const col = SORT_KEYS[i];
    if (sortCol === col) { sortDir *= -1; } else { sortCol = col; sortDir = 1; }
    libThead.querySelectorAll("th").forEach(t => t.removeAttribute("data-sort"));
    th.dataset["sort"] = sortDir > 0 ? "asc" : "desc";
    filterAndRender();
  });
});

function filterAndRender() {
  const q   = libSearch.value.toLowerCase();
  const fmt = libFormat.value.toLowerCase();

  filteredSamples = allSamples.filter(e => {
    const matchQ   = !q   || e.filename.toLowerCase().includes(q) || e.folder.toLowerCase().includes(q);
    const matchFmt = !fmt || e.ext.toLowerCase().startsWith(fmt.replace("aif", "ai"));
    return matchQ && matchFmt;
  });

  filteredSamples.sort((a, b) => {
    const av = a[sortCol], bv = b[sortCol];
    if (typeof av === "number" && typeof bv === "number") return (av - bv) * sortDir;
    return String(av).localeCompare(String(bv)) * sortDir;
  });

  libCount.textContent = filteredSamples.length === allSamples.length
    ? `${allSamples.length.toLocaleString()} samples`
    : `${filteredSamples.length.toLocaleString()} / ${allSamples.length.toLocaleString()} samples`;

  if (filteredSamples.length === 0) {
    libTbody.innerHTML = "";
    show(libEmpty);
    return;
  }
  hide(libEmpty);
  vsRender();
}

// ── Virtual scroll ──
const VS_ROW_H    = 28;  // must match CSS tr height
const VS_OVERSCAN = 10;  // extra rows above/below viewport

let vsScrollTop = 0;
let vsViewH     = 0;

const libTableWrap = byId<HTMLDivElement>("lib-table-wrap");

libTableWrap.addEventListener("scroll", () => {
  vsScrollTop = libTableWrap.scrollTop;
  vsRender();
});

function vsRender() {
  if (!filteredSamples.length) return;
  vsViewH = libTableWrap.clientHeight;

  const total    = filteredSamples.length;
  const firstVis = Math.max(0, Math.floor(vsScrollTop / VS_ROW_H) - VS_OVERSCAN);
  const lastVis  = Math.min(total - 1, Math.ceil((vsScrollTop + vsViewH) / VS_ROW_H) + VS_OVERSCAN);

  const paddingTop    = firstVis * VS_ROW_H;
  const paddingBottom = (total - 1 - lastVis) * VS_ROW_H;

  renderRows(filteredSamples.slice(firstVis, lastVis + 1));

  // Spacer rows keep the scrollbar proportional
  const topSpacer = libTbody.querySelector<HTMLTableRowElement>(".vs-spacer-top");
  const botSpacer = libTbody.querySelector<HTMLTableRowElement>(".vs-spacer-bottom");
  if (topSpacer) topSpacer.style.height = `${paddingTop}px`;
  else {
    const tr = document.createElement("tr");
    tr.className = "vs-spacer-top";
    tr.style.height = `${paddingTop}px`;
    libTbody.prepend(tr);
  }
  if (botSpacer) botSpacer.style.height = `${paddingBottom}px`;
  else {
    const tr = document.createElement("tr");
    tr.className = "vs-spacer-bottom";
    tr.style.height = `${paddingBottom}px`;
    libTbody.append(tr);
  }
}

function fmtDur(s: number): string {
  if (!s) return "—";
  const m = Math.floor(s / 60);
  const sec = (s % 60).toFixed(1);
  return m > 0 ? `${m}:${sec.padStart(4, "0")}` : `${sec}s`;
}
function fmtSr(hz: number): string {
  return hz ? `${(hz / 1000).toFixed(1)}k` : "—";
}

function renderRows(rows: SampleEntry[]) {
  libTbody.innerHTML = rows.map(e => {
    const bpmCell = e.bpm != null
      ? `<span class="meta-tag">${e.bpm}</span>`
      : `<button class="detect-btn" data-path="${e.path.replace(/"/g, "&quot;")}" title="Detect BPM & Key">?</button>`;
    const keyCell = e.key != null ? `<span class="meta-tag">${e.key}</span>` : "";
    return `
    <tr data-path="${e.path.replace(/"/g, "&quot;")}" data-dur="${e.duration}">
      <td title="${e.filename}">${e.filename}</td>
      <td>${e.ext.toUpperCase()}</td>
      <td>${fmtDur(e.duration)}</td>
      <td>${fmtSr(e.sample_rate)}</td>
      <td>${e.channels || "—"}</td>
      <td class="bpm-cell">${bpmCell}</td>
      <td class="key-cell">${keyCell}</td>
      <td title="${e.folder}" style="color:var(--text-muted);font-size:10px">${e.folder.split("/").slice(-2).join("/")}</td>
      <td class="lib-actions-cell">
        <button class="play-btn" data-path="${e.path.replace(/"/g, "&quot;")}">▶</button>
        <button class="reveal-lib-btn" data-path="${e.path.replace(/"/g, "&quot;")}" title="Reveal in Finder"><svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="4.8" cy="4.8" r="3.2"/><line x1="7.2" y1="7.2" x2="11" y2="11"/></svg></button>
      </td>
    </tr>`;
  }).join("");

  libTbody.querySelectorAll<HTMLButtonElement>(".play-btn").forEach(btn => {
    btn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      const row = btn.closest("tr") as HTMLTableRowElement | null;
      const dur = parseFloat(row?.dataset["dur"] ?? "0");
      playSample(btn.dataset["path"]!, dur);
    });
  });
  libTbody.querySelectorAll<HTMLButtonElement>(".reveal-lib-btn").forEach(btn => {
    btn.addEventListener("click", async (ev) => {
      ev.stopPropagation();
      try { await revealItemInDir(btn.dataset["path"]!); } catch (e) { console.error(e); }
    });
  });
  libTbody.querySelectorAll<HTMLButtonElement>(".detect-btn").forEach(btn => {
    btn.addEventListener("click", async (ev) => {
      ev.stopPropagation();
      const path = btn.dataset["path"]!;
      btn.textContent = "…";
      btn.disabled = true;
      try {
        const res = await invoke<{ bpm?: number; key?: string }>("detect_bpm_key", { path });
        const entry = allSamples.find(e => e.path === path);
        if (entry) { entry.bpm = res.bpm ?? null; entry.key = res.key ?? null; }
        const row = btn.closest("tr")!;
        const bpmCell = row.querySelector(".bpm-cell")!;
        const keyCell = row.querySelector(".key-cell")!;
        bpmCell.innerHTML = res.bpm != null ? `<span class="meta-tag">${res.bpm}</span>` : "—";
        keyCell.innerHTML = res.key ? `<span class="meta-tag">${res.key}</span>` : "—";
      } catch {
        btn.textContent = "✗";
      }
    });
  });
  libTbody.querySelectorAll<HTMLTableRowElement>("tr").forEach(row => {
    row.addEventListener("click", () => {
      const dur = parseFloat(row.dataset["dur"] ?? "0");
      playSample(row.dataset["path"]!, dur);
    });
  });
}

// ── Player ──────────────────────────────────────
let _curPath   = "";
let _curDur    = 0;   // sample duration in seconds (from SampleEntry)
let _playStart = 0;   // performance.now() when play started
let _playRAF   = 0;
let _playing   = false;

const SVG_PLAY  = `<svg width="10" height="12" viewBox="0 0 10 12"><polygon points="0,0 10,6 0,12" fill="currentColor"/></svg>`;
const SVG_PAUSE = `<svg width="10" height="12" viewBox="0 0 10 12"><rect x="0" y="0" width="3.5" height="12" rx="1" fill="currentColor"/><rect x="6.5" y="0" width="3.5" height="12" rx="1" fill="currentColor"/></svg>`;

function _updateHead(frac: number) {
  const ph = (libWaveform as unknown as Element).querySelector<SVGLineElement>(".lib-playhead");
  if (!ph) return;
  const x = (Math.max(0, Math.min(1, frac)) * 400).toFixed(1);
  ph.setAttribute("x1", x); ph.setAttribute("x2", x);
}

function _tickHead() {
  const elapsed = (performance.now() - _playStart) / 1000;
  const frac    = _curDur > 0 ? elapsed / _curDur : 0;
  _updateHead(frac);
  if (frac < 1) {
    _playRAF = requestAnimationFrame(_tickHead);
  } else {
    _playing = false;
    libPlayPause.innerHTML = SVG_PLAY;
    _updateHead(0);
  }
}

async function playSample(path: string, dur = 0) {
  // Stop any running animation and previous afplay
  cancelAnimationFrame(_playRAF);
  try { await invoke("stop_playback"); } catch {}

  _curPath = path;
  _curDur  = dur;

  libTbody.querySelectorAll("tr").forEach(r =>
    r.classList.toggle("playing", r.dataset["path"] === path));
  libPlayerName.textContent = path.split("/").pop() ?? path;
  show(libPlayer);

  // Kick off waveform render (async, doesn't block audio)
  libWaveform.innerHTML = `<line x1="0" y1="20" x2="400" y2="20" stroke="var(--teal-border)" stroke-width="1"/>`;
  invoke<[number, number][]>("get_waveform", { path })
    .then(env => renderWaveform(env))
    .catch(() => {});

  // Play audio natively via afplay
  try { await invoke("play_sample", { path }); } catch (e) { console.error(e); }

  // Start timer-based playhead
  _playStart = performance.now();
  _playing   = true;
  libPlayPause.innerHTML = SVG_PAUSE;
  cancelAnimationFrame(_playRAF);
  _playRAF = requestAnimationFrame(_tickHead);
}

function renderWaveform(envelope: [number, number][]) {
  if (!envelope.length) return;
  const W = 400, H = 40, mid = H / 2;
  const n = envelope.length;

  const maxAbs = envelope.reduce((m, [mn, mx]) => Math.max(m, Math.abs(mn), Math.abs(mx)), 0.001);
  const scale  = (mid * 0.8) / maxAbs;

  const xOf    = (i: number) => ((i / Math.max(n - 1, 1)) * W).toFixed(1);
  const topPts = envelope.map(([, mx], i) => `${xOf(i)},${(mid - mx * scale).toFixed(1)}`).join(" ");
  const botPts = [...envelope].reverse().map(([mn], i) => `${xOf(n - 1 - i)},${(mid - mn * scale).toFixed(1)}`).join(" ");

  // Keep playhead at current position when redrawing
  const curFrac = _playing && _curDur > 0
    ? Math.min(1, (performance.now() - _playStart) / 1000 / _curDur)
    : 0;
  const phX = (curFrac * W).toFixed(1);

  libWaveform.innerHTML = `
    <line x1="0" y1="${mid}" x2="${W}" y2="${mid}" stroke="var(--teal-border)" stroke-width="0.5"/>
    <polygon points="${topPts} ${botPts}" fill="var(--teal)" fill-opacity="0.28" stroke="none"/>
    <polyline points="${topPts}" fill="none" stroke="var(--teal)" stroke-width="0.9" opacity="0.85"/>
    <polyline points="${botPts}" fill="none" stroke="var(--teal)" stroke-width="0.9" opacity="0.85"/>
    <line class="lib-playhead" x1="${phX}" y1="0" x2="${phX}" y2="${H}" stroke="white" stroke-width="1.5" opacity="0.85" stroke-linecap="round"/>`;
}

// Seek: click adjusts timer origin so playhead jumps to clicked position
(libWaveform as unknown as SVGSVGElement).addEventListener("click", async (e: MouseEvent) => {
  if (!_curPath) return;
  const rect  = (libWaveform as unknown as SVGSVGElement).getBoundingClientRect();
  const frac  = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  // afplay can't seek, so restart audio from 0 but offset timer visually
  if (!_playing) await playSample(_curPath, _curDur);
  _playStart = performance.now() - frac * _curDur * 1000;
  _updateHead(frac);
});

// Play / Pause (toggle)
libPlayPause.addEventListener("click", async () => {
  if (_playing) {
    cancelAnimationFrame(_playRAF);
    _playing = false;
    libPlayPause.innerHTML = SVG_PLAY;
    try { await invoke("stop_playback"); } catch {}
  } else if (_curPath) {
    await playSample(_curPath, _curDur);
  }
});

// Stop
libStop.addEventListener("click", async () => {
  cancelAnimationFrame(_playRAF);
  _playing = false;
  libTbody.querySelectorAll("tr").forEach(r => r.classList.remove("playing"));
  _updateHead(0);
  hide(libPlayer);
  try { await invoke("stop_playback"); } catch {}
});

// Restart |◀
libRestart.addEventListener("click", async () => {
  if (_curPath) await playSample(_curPath, _curDur);
});

// ═══════════════════════════════════════════════════════════
//  CLASSIFY TAB
// ═══════════════════════════════════════════════════════════

const classifySource   = byId<HTMLSpanElement>("classify-source");
const classifyDest     = byId<HTMLSpanElement>("classify-dest");
const classifyPickSrc  = byId<HTMLButtonElement>("classify-pick-source");
const classifyPickDest = byId<HTMLButtonElement>("classify-pick-dest");
const classifyRunBtn   = byId<HTMLButtonElement>("classify-run-btn");
const classifyStatus   = byId<HTMLSpanElement>("classify-status");
const classifyChart    = byId<HTMLDivElement>("classify-chart-wrap");

let classifySrcPath  = "";
let classifyDestPath = "";

// Pre-fill source from library root when switching to Classify tab
document.querySelectorAll<HTMLButtonElement>(".tab").forEach(btn => {
  btn.addEventListener("click", () => {
    if (btn.dataset["tab"] === "classify" && currentLibRoot && !classifySrcPath) {
      classifySrcPath = currentLibRoot;
      classifySource.textContent = currentLibRoot;
      classifySource.classList.remove("classify-path-muted");
      doClassifyPreview();
    }
  });
});

function refreshClassifyBtn() { /* no-op: classify lives in its own tab now */ }

async function doClassifyPreview() {
  if (!classifySrcPath) return;
  classifyChart.innerHTML = `<span class="classify-chart-hint">Scanning…</span>`;
  classifyRunBtn.disabled = true;
  classifyStatus.textContent = "";
  try {
    const counts = await invoke<Record<string, number>>("classify_preview", { path: classifySrcPath });
    renderClassifyChart(counts);
    if (classifyDestPath) classifyRunBtn.disabled = false;
  } catch (e) {
    classifyChart.innerHTML = `<span class="classify-chart-hint classify-error">Error: ${String(e)}</span>`;
  }
}

classifyPickSrc.addEventListener("click", async () => {
  const sel = await open({ directory: true, multiple: false });
  if (typeof sel !== "string") return;
  classifySrcPath = sel;
  classifySource.textContent = sel;
  classifySource.classList.remove("classify-path-muted");
  doClassifyPreview();
});

classifyPickDest.addEventListener("click", async () => {
  const sel = await open({ directory: true, multiple: false });
  if (typeof sel !== "string") return;
  if (sel === classifySrcPath) { classifyStatus.textContent = "⚠ Destination must differ from source."; return; }
  classifyDestPath = sel;
  classifyDest.textContent = sel;
  classifyDest.classList.remove("classify-path-muted");
  classifyStatus.textContent = "";
  if (classifySrcPath) classifyRunBtn.disabled = false;
});

classifyRunBtn.addEventListener("click", async () => {
  if (!classifySrcPath || !classifyDestPath) return;
  classifyRunBtn.disabled = true;
  classifyStatus.textContent = "Copying…";
  let unlisten: (() => void) | undefined;
  try {
    unlisten = await listen<string>("classify-log", (e) => {
      classifyStatus.textContent = e.payload.replace(/^[✅❌•]\s*/, "");
    });
    await invoke("run_classify", { source: classifySrcPath, dest: classifyDestPath });
    classifyStatus.textContent = "✅ Done — files copied to destination.";
  } catch (e) {
    classifyStatus.textContent = `❌ ${String(e)}`;
  } finally {
    if (unlisten) unlisten();
    classifyRunBtn.disabled = false;
  }
});

const CATEGORY_COLORS: Record<string, string> = {
  Kick: "#e05c5c", Snare: "#e08c3c", HiHat: "#d4c43a", Clap: "#7acc54",
  Tom: "#3abfd4", Perc: "#5c9ce0", Bass: "#9c5ce0", FX: "#d45cb8",
  Vocal: "#e05c8c", Pad: "#5ce0b8", Synth: "#5c8ce0", Loop: "#b8e05c",
  Other: "#888", Unknown: "#666",
};

function renderClassifyChart(counts: Record<string, number>) {
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  if (!entries.length) { classifyChart.innerHTML = `<span class="classify-chart-hint">No samples found.</span>`; return; }
  const total = entries.reduce((s, [, n]) => s + n, 0);
  const max   = entries[0][1];
  const ROW_H = 28, LABEL_W = 62, BAR_MAX = 200, COUNT_W = 44;
  const SVG_W = LABEL_W + BAR_MAX + COUNT_W + 8;
  const SVG_H = entries.length * ROW_H + 4;

  const rows = entries.map(([cat, n], i) => {
    const y    = i * ROW_H + ROW_H / 2;
    const barW = Math.max(2, Math.round((n / max) * BAR_MAX));
    const color = CATEGORY_COLORS[cat] ?? "#2ddb76";
    const pct   = ((n / total) * 100).toFixed(0);
    return `
      <text x="${LABEL_W - 6}" y="${y + 5}" text-anchor="end" class="cls-label">${cat}</text>
      <rect x="${LABEL_W}" y="${y - 9}" width="${barW}" height="18" rx="3" fill="${color}" opacity="0.82"/>
      <text x="${LABEL_W + barW + 5}" y="${y + 5}" class="cls-count">${n} <tspan class="cls-pct">${pct}%</tspan></text>`;
  }).join("");

  classifyChart.innerHTML = `
    <div class="classify-chart-total">${total.toLocaleString()} samples total</div>
    <svg viewBox="0 0 ${SVG_W} ${SVG_H}" width="${SVG_W}" height="${SVG_H}" class="classify-chart-svg">
      <style>
        .cls-label { font: 11px system-ui; fill: var(--text-muted); }
        .cls-count  { font: 11px system-ui; fill: var(--text); }
        .cls-pct    { fill: var(--text-muted); font-size: 10px; }
      </style>
      ${rows}
    </svg>`;
}
