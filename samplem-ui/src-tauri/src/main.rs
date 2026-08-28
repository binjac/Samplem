#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{
  fs,
  io::{BufRead, BufReader, Read},
  path::{Path, PathBuf},
  process::{Command, Stdio},
  sync::Mutex,
};
use tauri::{AppHandle, Emitter, State};

// ═══════════════════════════════════════════════
//  Shared state
// ═══════════════════════════════════════════════

struct ActivePid(Mutex<Option<u32>>);
struct PlaybackPid(Mutex<Option<u32>>);

// ═══════════════════════════════════════════════
//  Data types
// ═══════════════════════════════════════════════

#[derive(serde::Serialize, serde::Deserialize, Clone)]
struct SampleEntry {
  path:        String,
  filename:    String,
  folder:      String,
  ext:         String,
  channels:    i64,
  sample_rate: i64,
  bit_depth:   i64,
  duration:    f64,
  size_bytes:  i64,
}

// ═══════════════════════════════════════════════
//  Convert: run / cancel
// ═══════════════════════════════════════════════

#[tauri::command]
async fn run_samplem(
  pid_state: State<'_, ActivePid>,
  app: AppHandle,
  path: String,
  normalize: bool,
  trim: bool,
  layout: String,
) -> Result<i32, String> {
  let home = std::env::var("HOME").unwrap_or_default();
  let search_path = format!(
    "{}/.local/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin",
    home
  );
  let mut cmd = Command::new("samplem");
  cmd.env("PATH", &search_path)
    .arg("repack")
    .arg("--path").arg(&path)
    .arg(if normalize { "--normalize" } else { "--no-normalize" })
    .arg(if trim     { "--trim"      } else { "--no-trim"      })
    .arg("--layout").arg(&layout)
    .stdout(Stdio::piped())
    .stderr(Stdio::piped());

  let mut child = cmd.spawn().map_err(|e| e.to_string())?;
  *pid_state.0.lock().unwrap() = Some(child.id());

  if let Some(stdout) = child.stdout.take() {
    let app_clone = app.clone();
    std::thread::spawn(move || {
      for line in BufReader::new(stdout).lines().flatten() {
        let _ = app_clone.emit("samplem-log", line);
      }
    });
  }
  if let Some(stderr) = child.stderr.take() {
    let app_clone = app.clone();
    std::thread::spawn(move || {
      for line in BufReader::new(stderr).lines().flatten() {
        let _ = app_clone.emit("samplem-log", line);
      }
    });
  }

  let status = child.wait().map_err(|e| e.to_string())?;
  *pid_state.0.lock().unwrap() = None;
  Ok(status.code().unwrap_or(-1))
}

#[tauri::command]
fn cancel_samplem(pid_state: State<'_, ActivePid>) -> Result<(), String> {
  if let Some(pid) = *pid_state.0.lock().unwrap() {
    Command::new("kill")
      .args(["-TERM", &format!("-{}", pid)])
      .status()
      .or_else(|_| Command::new("kill").args([&pid.to_string()]).status())
      .map_err(|e| e.to_string())?;
  }
  Ok(())
}

// ═══════════════════════════════════════════════
//  Audio header parsing (no extra crates)
// ═══════════════════════════════════════════════

fn read_wav_meta(path: &Path) -> Option<(i64, i64, i64, f64)> {
  let mut f = fs::File::open(path).ok()?;
  let mut buf = [0u8; 512];
  let n = f.read(&mut buf).ok()?;
  let buf = &buf[..n];
  if n < 44 || &buf[0..4] != b"RIFF" || &buf[8..12] != b"WAVE" { return None; }

  let (mut ch, mut sr, mut bits, mut data_sz) = (0i64, 0i64, 0i64, 0u64);
  let mut i = 12usize;
  while i + 8 <= n {
    let id   = &buf[i..i+4];
    let size = u32::from_le_bytes(buf[i+4..i+8].try_into().ok()?) as usize;
    if id == b"fmt " && i + 24 <= n {
      ch   = u16::from_le_bytes(buf[i+10..i+12].try_into().ok()?) as i64;
      sr   = u32::from_le_bytes(buf[i+12..i+16].try_into().ok()?) as i64;
      bits = u16::from_le_bytes(buf[i+22..i+24].try_into().ok()?) as i64;
    } else if id == b"data" {
      data_sz = size as u64;
    }
    let next = i + 8 + size + (size & 1);
    if next <= i { break; }
    i = next;
  }
  if sr == 0 || ch == 0 || bits == 0 { return None; }
  Some((ch, sr, bits, data_sz as f64 / (sr as f64 * ch as f64 * bits as f64 / 8.0)))
}

fn read_aif_meta(path: &Path) -> Option<(i64, i64, i64, f64)> {
  let mut f = fs::File::open(path).ok()?;
  let mut buf = [0u8; 512];
  let n = f.read(&mut buf).ok()?;
  let buf = &buf[..n];
  if n < 12 || &buf[0..4] != b"FORM" { return None; }
  let ft = &buf[8..12];
  if ft != b"AIFF" && ft != b"AIFC" { return None; }

  let mut i = 12usize;
  while i + 8 <= n {
    let id   = &buf[i..i+4];
    let size = u32::from_be_bytes(buf[i+4..i+8].try_into().ok()?) as usize;
    if id == b"COMM" && i + 26 <= n {
      let ch     = i16::from_be_bytes(buf[i+8..i+10].try_into().ok()?) as i64;
      let frames = u32::from_be_bytes(buf[i+10..i+14].try_into().ok()?) as u64;
      let bits   = i16::from_be_bytes(buf[i+14..i+16].try_into().ok()?) as i64;
      let sr_b: [u8; 10] = buf[i+16..i+26].try_into().ok()?;
      let sr = parse_80bit(sr_b);
      if sr > 0.0 {
        return Some((ch, sr as i64, bits, frames as f64 / sr));
      }
    }
    let next = i + 8 + size + (size & 1);
    if next <= i { break; }
    i = next;
  }
  None
}

fn parse_80bit(b: [u8; 10]) -> f64 {
  let exp  = (((b[0] as i32) & 0x7f) << 8) | (b[1] as i32);
  let mant = u64::from_be_bytes(b[2..10].try_into().unwrap());
  if exp == 0 && mant == 0 { return 0.0; }
  let v = (mant as f64) * 2f64.powi(exp - 16383 - 63);
  if b[0] & 0x80 != 0 { -v } else { v }
}

fn read_flac_meta(path: &Path) -> Option<(i64, i64, i64, f64)> {
  let mut f = fs::File::open(path).ok()?;
  let mut buf = [0u8; 64];
  f.read_exact(&mut buf).ok()?;
  if &buf[0..4] != b"fLaC" { return None; }
  // STREAMINFO block header: byte 4 = type (bit7=last|bits6-0=type), bytes 5-7 = length
  // type 0 = STREAMINFO; it must be the first block
  if buf[4] & 0x7f != 0 { return None; }
  // STREAMINFO data starts at byte 8, 34 bytes total
  // bytes 8-17 contain the packed sample_rate/channels/bit_depth/total_samples
  let packed = u64::from_be_bytes(buf[18..26].try_into().ok()?);
  let sr     = ((packed >> 44) & 0xFFFFF) as i64;
  let ch     = (((packed >> 41) & 0x7) + 1) as i64;
  let bd     = (((packed >> 36) & 0x1F) + 1) as i64;
  let total  = (packed & 0xFFFFFFFFF) as f64;
  if sr == 0 { return None; }
  Some((ch, sr, bd, total / sr as f64))
}

// ═══════════════════════════════════════════════
//  Library: scan / load / persist
// ═══════════════════════════════════════════════

fn library_file() -> PathBuf {
  let home = std::env::var("HOME").unwrap_or_default();
  let dir  = PathBuf::from(home).join(".samplem");
  fs::create_dir_all(&dir).ok();
  dir.join("library.json")
}

fn load_lib() -> std::collections::HashMap<String, SampleEntry> {
  let p = library_file();
  if p.exists() {
    let s = fs::read_to_string(&p).unwrap_or_default();
    serde_json::from_str::<Vec<SampleEntry>>(&s)
      .unwrap_or_default()
      .into_iter()
      .map(|e| (e.path.clone(), e))
      .collect()
  } else {
    std::collections::HashMap::new()
  }
}

fn save_lib(map: &std::collections::HashMap<String, SampleEntry>) {
  let entries: Vec<&SampleEntry> = map.values().collect();
  if let Ok(json) = serde_json::to_string(&entries) {
    fs::write(library_file(), json).ok();
  }
}

fn walk_audio(dir: &Path, out: &mut Vec<PathBuf>) {
  if let Ok(rd) = fs::read_dir(dir) {
    for e in rd.flatten() {
      let p = e.path();
      if p.is_dir() {
        walk_audio(&p, out);
      } else if let Some(ext) = p.extension() {
        let x = ext.to_string_lossy().to_lowercase();
        if matches!(x.as_str(), "wav" | "aif" | "aiff" | "flac") {
          out.push(p);
        }
      }
    }
  }
}

#[tauri::command]
async fn scan_library(app: AppHandle, path: String) -> Result<Vec<SampleEntry>, String> {
  let root = PathBuf::from(&path);
  let mut lib = load_lib();

  let mut files = Vec::new();
  walk_audio(&root, &mut files);
  let total = files.len();

  let _ = app.emit("library-progress",
    serde_json::json!({ "done": 0, "total": total }));

  for (i, file) in files.iter().enumerate() {
    let key = file.to_string_lossy().to_string();
    if !lib.contains_key(&key) {
      let ext  = file.extension().map(|e| e.to_string_lossy().to_lowercase().to_string()).unwrap_or_default();
      let name = file.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
      let dir  = file.parent().map(|p| p.to_string_lossy().to_string()).unwrap_or_default();
      let sz   = fs::metadata(file).map(|m| m.len() as i64).unwrap_or(0);
      let (ch, sr, bd, dur) = match ext.as_str() {
        "wav"        => read_wav_meta(file).unwrap_or((0,0,0,0.0)),
        "aif"|"aiff" => read_aif_meta(file).unwrap_or((0,0,0,0.0)),
        "flac"       => read_flac_meta(file).unwrap_or((0,0,0,0.0)),
        _            => (0,0,0,0.0),
      };
      lib.insert(key.clone(), SampleEntry {
        path: key, filename: name, folder: dir, ext,
        channels: ch, sample_rate: sr, bit_depth: bd, duration: dur, size_bytes: sz,
      });
    }
    if (i + 1) % 100 == 0 || i + 1 == total {
      let _ = app.emit("library-progress",
        serde_json::json!({ "done": i + 1, "total": total }));
    }
  }

  save_lib(&lib);

  let mut result: Vec<SampleEntry> = lib.into_values()
    .filter(|e| e.path.starts_with(&path))
    .collect();
  result.sort_by(|a, b| a.folder.cmp(&b.folder).then(a.filename.cmp(&b.filename)));
  Ok(result)
}

#[tauri::command]
fn get_library() -> Result<Vec<SampleEntry>, String> {
  let mut v: Vec<SampleEntry> = load_lib().into_values().collect();
  v.sort_by(|a, b| a.folder.cmp(&b.folder).then(a.filename.cmp(&b.filename)));
  Ok(v)
}

// ═══════════════════════════════════════════════
//  Playback
// ═══════════════════════════════════════════════

#[tauri::command]
fn play_sample(path: String, pb: State<'_, PlaybackPid>) -> Result<(), String> {
  if let Some(pid) = pb.0.lock().unwrap().take() {
    Command::new("kill").args([&pid.to_string()]).status().ok();
  }
  let child = Command::new("afplay").arg(&path)
    .stdout(Stdio::null()).stderr(Stdio::null())
    .spawn().map_err(|e| e.to_string())?;
  *pb.0.lock().unwrap() = Some(child.id());
  Ok(())
}

#[tauri::command]
fn stop_playback(pb: State<'_, PlaybackPid>) -> Result<(), String> {
  if let Some(pid) = pb.0.lock().unwrap().take() {
    Command::new("kill").args([&pid.to_string()]).status().ok();
  }
  Ok(())
}

/// Read a local audio file and return its raw bytes for Web Audio decoding.
#[tauri::command]
fn read_file_bytes(path: String) -> Result<Vec<u8>, String> {
  fs::read(&path).map_err(|e| e.to_string())
}

// ═══════════════════════════════════════════════
//  Waveform (downsample via sox → raw PCM)
// ═══════════════════════════════════════════════

#[tauri::command]
fn get_waveform(path: String) -> Result<Vec<[f32; 2]>, String> {
  // Decode to mono 16-bit PCM at a high sample count, then compute min/max per pixel block
  let out = Command::new("sox")
    .args(["-V0", &path,
           "-t", "raw", "-e", "signed-integer", "-b", "16", "-r", "22050", "-c", "1", "-"])
    .output().map_err(|e| e.to_string())?;
  let samples: Vec<f32> = out.stdout.chunks_exact(2)
    .map(|c| i16::from_le_bytes([c[0], c[1]]) as f32 / 32768.0)
    .collect();
  if samples.is_empty() {
    return Ok(vec![[0.0, 0.0]; 400]);
  }
  const PIXELS: usize = 400;
  let block = (samples.len() + PIXELS - 1) / PIXELS;
  let envelope: Vec<[f32; 2]> = (0..PIXELS).map(|i| {
    let start = i * block;
    let end   = ((i + 1) * block).min(samples.len());
    if start >= samples.len() { return [0.0_f32, 0.0_f32]; }
    let slice = &samples[start..end];
    let mn = slice.iter().cloned().fold(f32::INFINITY, f32::min);
    let mx = slice.iter().cloned().fold(f32::NEG_INFINITY, f32::max);
    [mn, mx]
  }).collect();
  Ok(envelope)
}

// ═══════════════════════════════════════════════
//  BPM / Key detection
// ═══════════════════════════════════════════════

#[tauri::command]
fn detect_bpm_key(path: String) -> Result<serde_json::Value, String> {
  let home = std::env::var("HOME").unwrap_or_default();
  // locate detect.py next to the samplem bin, or fall back to PATH
  let script = PathBuf::from(&home).join(".local/bin/detect.py");
  let script_arg = if script.exists() {
    script.to_string_lossy().to_string()
  } else {
    // try same dir as samplem
    let samplem_bin = std::env::current_exe().ok()
      .and_then(|e| e.parent().map(|p| p.join("detect.py")));
    samplem_bin.filter(|p| p.exists())
      .map(|p| p.to_string_lossy().to_string())
      .unwrap_or_else(|| "detect.py".to_string())
  };
  let search_path = format!("{}/.local/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin", home);
  let out = Command::new("python3")
    .env("PATH", &search_path)
    .arg(&script_arg)
    .arg(&path)
    .output()
    .map_err(|e| format!("python3 not found: {}", e))?;
  let s = String::from_utf8_lossy(&out.stdout);
  serde_json::from_str(&s).map_err(|e| format!("Bad JSON: {}\nraw: {}", e, s))
}

// ═══════════════════════════════════════════════
//  Classify
// ═══════════════════════════════════════════════

fn classify_search_path() -> String {
  let home = std::env::var("HOME").unwrap_or_default();
  format!("{}/.local/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin", home)
}

/// Try `sample-cd-classify` first; fall back to `python3 classify.py` next to the project.
fn classify_cmd(extra_args: &[&str]) -> Result<std::process::Command, String> {
  let search_path = classify_search_path();
  // Probe: does sample-cd-classify exist on PATH?
  let probe = Command::new("sample-cd-classify")
    .env("PATH", &search_path)
    .arg("--help")
    .stdout(Stdio::null()).stderr(Stdio::null())
    .status();
  if probe.is_ok() {
    let mut cmd = Command::new("sample-cd-classify");
    cmd.env("PATH", &search_path);
    for a in extra_args { cmd.arg(a); }
    return Ok(cmd);
  }
  // Fallback: look for classify.py next to this binary or in ~/binjac/samplem/
  let home = std::env::var("HOME").unwrap_or_default();
  let candidates: Vec<PathBuf> = vec![
    PathBuf::from(&home).join("binjac/samplem/classify.py"),
    std::env::current_exe().ok()
      .and_then(|e| e.canonicalize().ok())
      .map(|e| e.join("../../../../../classify.py"))
      .unwrap_or_default(),
  ];
  for script in candidates {
    if script.exists() {
      let mut cmd = Command::new("python3");
      cmd.env("PATH", &search_path).arg(&script);
      for a in extra_args { cmd.arg(a); }
      return Ok(cmd);
    }
  }
  Err("classify.py not found — run `pip install -e .` in the samplem folder".to_string())
}

#[tauri::command]
fn classify_preview(path: String) -> Result<std::collections::HashMap<String, u32>, String> {
  let out = classify_cmd(&[&path, "--json-summary"])?
    .output().map_err(|e| e.to_string())?;
  if !out.status.success() {
    return Err(String::from_utf8_lossy(&out.stderr).to_string());
  }
  let s = String::from_utf8_lossy(&out.stdout);
  serde_json::from_str(&s).map_err(|e| format!("Bad JSON: {}", e))
}

#[tauri::command]
async fn run_classify(app: AppHandle, source: String, dest: String) -> Result<(), String> {
  let mut child = classify_cmd(&[&source, "--copy-into", &dest])?
    .stdout(Stdio::piped()).stderr(Stdio::piped())
    .spawn().map_err(|e| e.to_string())?;
  if let Some(stdout) = child.stdout.take() {
    let a = app.clone();
    std::thread::spawn(move || {
      for line in BufReader::new(stdout).lines().flatten() {
        let _ = a.emit("classify-log", line);
      }
    });
  }
  if let Some(stderr) = child.stderr.take() {
    let a = app.clone();
    std::thread::spawn(move || {
      for line in BufReader::new(stderr).lines().flatten() {
        let _ = a.emit("classify-log", line);
      }
    });
  }
  child.wait().map_err(|e| e.to_string())?;
  Ok(())
}

// ═══════════════════════════════════════════════
//  main
// ═══════════════════════════════════════════════

fn main() {
  tauri::Builder::default()
    .manage(ActivePid(Mutex::new(None)))
    .manage(PlaybackPid(Mutex::new(None)))
    .plugin(tauri_plugin_opener::init())
    .plugin(tauri_plugin_dialog::init())
    .invoke_handler(tauri::generate_handler![
      run_samplem, cancel_samplem,
      scan_library, get_library,
      play_sample, stop_playback, read_file_bytes,
      get_waveform,
      classify_preview, run_classify,
      detect_bpm_key,
    ])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
