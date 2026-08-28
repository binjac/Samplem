#!/usr/bin/env python3
import argparse
import csv
import os
import re
import shlex
import subprocess
import sys
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Tuple


CATEGORY_KEYWORDS: Dict[str, List[str]] = {
    "Kick": ["kick", "bd", "bassdrum", "kik", "kck"],
    "Snare": ["snare", "sd", "snr"],
    "HiHat": ["hihat", "hh", "hat", "hats", "oh", "ch", "ride", "shaker"],
    "Clap": ["clap"],
    "Tom": ["tom"],
    "Perc": ["perc", "cowbell", "rim", "conga", "bongo", "tamb"],
    "Bass": ["bass", "808", "sub"],
    "FX": ["fx", "sfx", "impact", "sweep", "ris", "down", "noise"],
    "Vocal": ["vocal", "vox", "chant", "adlib"],
    "Pad": ["pad", "wash", "texture", "amb"],
    "Synth": ["synth"],
    "Loop": ["loop", "groove", "break"],
}


def which(cmd: str) -> Optional[str]:
    from shutil import which as _which

    return _which(cmd)


def list_audio_files(root: Path) -> List[Path]:
    exts = {".wav", ".aiff", ".aif", ".flac"}
    files: List[Path] = []
    for p in root.rglob("*"):
        if p.is_file() and p.suffix.lower() in exts:
            files.append(p)
    return files


def get_sox_info(path: Path) -> Tuple[Optional[float], Optional[int]]:
    # returns (duration_sec, channels)
    try:
        dur_proc = subprocess.run(
            ["sox", "--i", "-D", str(path)],
            capture_output=True,
            text=True,
            check=False,
        )
        ch_proc = subprocess.run(
            ["sox", "--i", "-c", str(path)],
            capture_output=True,
            text=True,
            check=False,
        )
        dur = float(dur_proc.stdout.strip()) if dur_proc.returncode == 0 else None
        ch = int(ch_proc.stdout.strip()) if ch_proc.returncode == 0 else None
        return dur, ch
    except Exception:
        return None, None


def spectral_centroid_via_sox(path: Path) -> Optional[float]:
    # crude proxy using stat - freq rolloff by scanning spectrogram not available; fallback to rms-based heuristic
    # we attempt "sox ... stat -freq" isn't available; instead use rms and peak ratio as a rough brightness proxy
    try:
        proc = subprocess.run(
            [
                "sox",
                str(path),
                "-n",
                "stat",
            ],
            stderr=subprocess.PIPE,
            stdout=subprocess.DEVNULL,
            text=True,
            check=False,
        )
        rms_amplitude = None
        peak = None
        for line in proc.stderr.splitlines():
            if "RMS amplitude" in line:
                rms_amplitude = float(line.split(":")[-1].strip())
            if "Maximum amplitude" in line:
                peak = float(line.split(":")[-1].strip())
        if rms_amplitude is None or peak is None or peak == 0:
            return None
        # The ratio serves as a rough proxy: noisier/bright content often has higher RMS/peak
        return rms_amplitude / peak
    except Exception:
        return None


def classify_name(basename: str) -> Optional[str]:
    name = basename.lower()
    for cat, kws in CATEGORY_KEYWORDS.items():
        for kw in kws:
            # whole word or token-ish match
            if re.search(rf"(^|[^a-z]){re.escape(kw)}([^a-z]|$)", name):
                return cat
    return None


def classify_heuristic(path: Path) -> Tuple[str, float, Dict[str, float]]:
    """Return (category, confidence, features)."""
    basename = path.name
    features: Dict[str, float] = {}

    duration, channels = get_sox_info(path)
    if duration is not None:
        features["duration"] = float(duration)

    bright = spectral_centroid_via_sox(path)
    if bright is not None:
        features["rms_peak_ratio"] = float(bright)

    # 1) Name-based strong prior
    name_cat = classify_name(basename)
    if name_cat:
        conf = 0.9
        # small adjustments by duration
        if name_cat in {"Kick", "Snare", "Clap", "HiHat", "Tom", "Perc"} and duration and duration > 4.0:
            conf = 0.6
        if name_cat in {"Pad"} and duration and duration < 1.0:
            conf = 0.6
        return name_cat, conf, features

    # 2) Duration-based
    if duration is not None:
        if duration < 0.35:
            return "HiHat", 0.55, features
        if 0.35 <= duration <= 1.5:
            return "Perc", 0.5, features
        if duration > 3.0:
            return "Pad", 0.5, features

    # 3) Brightness proxy
    if bright is not None:
        if bright > 0.35:
            return "HiHat", 0.5, features
        else:
            return "Kick", 0.45, features

    return "Other", 0.3, features


def preview(path: Path, seconds: float = 1.0) -> None:
    # Prefer afplay on macOS; fallback to sox play if available
    if which("afplay"):
        # -t trim start dur
        cmd = ["afplay", str(path)]
        try:
            # No native trim; rely on afplay with -t is not supported; play whole if short
            subprocess.run(cmd, check=False)
        except Exception:
            pass
        return
    if which("play"):
        cmd = ["play", str(path), "trim", "0", str(seconds)]
        subprocess.run(cmd, check=False)


def write_csv(rows: Iterable[Dict[str, str]], out_csv: Path) -> None:
    out_csv.parent.mkdir(parents=True, exist_ok=True)
    fieldnames = [
        "path",
        "basename",
        "category",
        "confidence",
        "duration",
        "rms_peak_ratio",
    ]
    with out_csv.open("w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fieldnames)
        w.writeheader()
        for r in rows:
            w.writerow(r)


def main(argv: Optional[List[str]] = None) -> int:
    p = argparse.ArgumentParser(
        description="Classify audio samples into categories (Kick, Snare, HiHat, etc.)",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    p.add_argument("root", help="Folder containing samples")
    p.add_argument("--csv", dest="csv_out", default="REPACKED/tags.csv", help="Output CSV path")
    p.add_argument("--preview", action="store_true", help="Play a short preview while classifying")
    p.add_argument("--copy-into", dest="copy_into", default=None, help="If set, copy files into subfolders by predicted category")
    p.add_argument("--min-confidence", type=float, default=0.0, help="Minimum confidence to sort into category; else 'Unknown'")
    p.add_argument("--json-summary", action="store_true", help="Print JSON {category: count} to stdout and exit; no copy, no CSV")
    args = p.parse_args(argv)

    root = Path(args.root).expanduser().resolve()
    if not root.exists() or not root.is_dir():
        print(f"❌ Folder not found: {root}", file=sys.stderr)
        return 1

    files = list_audio_files(root)
    if not files:
        print("No audio files found.")
        return 0

    rows: List[Dict[str, str]] = []
    # --json-summary is a read-only preview: never copy files
    copy_root: Optional[Path] = None if args.json_summary else (Path(args.copy_into).resolve() if args.copy_into else None)
    if copy_root:
        copy_root.mkdir(parents=True, exist_ok=True)

    for f in files:
        category, conf, feats = classify_heuristic(f)
        chosen_category = category if conf >= args.min_confidence else "Unknown"

        if args.preview:
            preview(f)

        if copy_root:
            dest_dir = copy_root / chosen_category
            dest_dir.mkdir(parents=True, exist_ok=True)
            dest = dest_dir / f.name
            if not dest.exists():
                try:
                    # Use Python copy for portability
                    with open(f, "rb") as src, open(dest, "wb") as dst:
                        dst.write(src.read())
                except Exception:
                    pass

        rows.append(
            {
                "path": str(f),
                "basename": f.name,
                "category": category,
                "confidence": f"{conf:.2f}",
                "duration": f"{feats.get('duration', '')}",
                "rms_peak_ratio": f"{feats.get('rms_peak_ratio', '')}",
            }
        )

    if args.json_summary:
        import json
        from collections import Counter
        counts = Counter(r["category"] for r in rows)
        print(json.dumps(dict(sorted(counts.items(), key=lambda x: -x[1]))))
        return 0

    out_csv = Path(args.csv_out).expanduser().resolve()
    write_csv(rows, out_csv)
    print(f"✅ Wrote {out_csv}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())


