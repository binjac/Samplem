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
const revealBtn    = byId<HTMLButtonElement>("reveal-btn");

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

  const showing = Math.min(filteredSamples.length, 500);
  libCount.textContent = showing < filteredSamples.length
    ? `showing ${showing.toLocaleString()} of ${filteredSamples.length.toLocaleString()} (${allSamples.length.toLocaleString()} total)`
    : `${filteredSamples.length.toLocaleString()} / ${allSamples.length.toLocaleString()} samples`;

  if (filteredSamples.length === 0) {
    libTbody.innerHTML = "";
    show(libEmpty);
    return;
  }
  hide(libEmpty);
  renderRows(filteredSamples.slice(0, 500));
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
  libTbody.innerHTML = rows.map(e => `
    <tr data-path="${e.path.replace(/"/g, "&quot;")}">
      <td title="${e.filename}">${e.filename}</td>
      <td>${e.ext.toUpperCase()}</td>
      <td>${fmtDur(e.duration)}</td>
      <td>${fmtSr(e.sample_rate)}</td>
      <td>${e.channels || "—"}</td>
      <td title="${e.folder}" style="color:var(--text-muted);font-size:10px">${e.folder.split("/").slice(-2).join("/")}</td>
      <td><button class="play-btn" data-path="${e.path.replace(/"/g, "&quot;")}">▶</button></td>
    </tr>`).join("");

  libTbody.querySelectorAll<HTMLButtonElement>(".play-btn").forEach(btn => {
    btn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      playSample(btn.dataset["path"]!);
    });
  });
  libTbody.querySelectorAll<HTMLTableRowElement>("tr").forEach(row => {
    row.addEventListener("click", () => playSample(row.dataset["path"]!));
  });
}

async function playSample(path: string) {
  // Highlight row
  libTbody.querySelectorAll("tr").forEach(r =>
    r.classList.toggle("playing", r.dataset["path"] === path));

  const name = path.split("/").pop() ?? path;
  libPlayerName.textContent = name;
  show(libPlayer);

  try { await invoke("play_sample", { path }); } catch (e) { console.error(e); }

  // Load waveform async
  libWaveform.innerHTML = `<line x1="0" y1="20" x2="400" y2="20" stroke="var(--teal-border)" stroke-width="1"/>`;
  try {
    const samples = await invoke<number[]>("get_waveform", { path });
    renderWaveform(samples);
  } catch {}
}

function renderWaveform(raw: number[]) {
  if (!raw.length) return;
  const W = 400, H = 40, mid = H / 2;
  // Subsample to 400 points
  const step   = Math.max(1, Math.floor(raw.length / W));
  const points = Array.from({ length: Math.min(W, raw.length) }, (_, i) => {
    const v = raw[Math.min(i * step, raw.length - 1)];
    const x = (i / (W - 1)) * W;
    const y = (mid - v * (mid - 2));
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  libWaveform.innerHTML = `
    <line x1="0" y1="${mid}" x2="${W}" y2="${mid}" stroke="var(--teal-border)" stroke-width="0.5"/>
    <polyline points="${points}" fill="none" stroke="var(--teal)" stroke-width="0.9" opacity="0.85"/>`;
}

libStop.addEventListener("click", async () => {
  libTbody.querySelectorAll("tr").forEach(r => r.classList.remove("playing"));
  hide(libPlayer);
  try { await invoke("stop_playback"); } catch {}
});
