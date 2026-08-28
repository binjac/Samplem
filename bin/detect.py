#!/usr/bin/env python3
"""
Detect BPM and musical key for a single audio file.
Usage: detect.py <path>
Outputs JSON: {"bpm": 120.0, "key": "C major", "confidence": 0.87}
Requires: aubio (pip install aubio)
"""
import json
import sys
from pathlib import Path


def detect(path: str) -> dict:
    try:
        import aubio
    except ImportError:
        return {"bpm": None, "key": None, "confidence": 0.0, "error": "aubio not installed — run: pip install aubio"}

    p = Path(path)
    if not p.exists():
        return {"bpm": None, "key": None, "confidence": 0.0, "error": "File not found"}

    result = {"bpm": None, "key": None, "confidence": 0.0}

    # ── BPM via tempo detection ──
    try:
        win    = 512
        hop    = 256
        src    = aubio.source(str(p), channels=1, hop_size=hop)
        tempo  = aubio.tempo("default", win, hop, src.samplerate)
        beats: list[float] = []
        while True:
            samples, read = src()
            is_beat = tempo(samples)
            if is_beat:
                beats.append(tempo.get_last_ms())
            if read < hop:
                break
        bpm = float(tempo.get_bpm())
        result["bpm"] = round(bpm, 1) if bpm > 10 else None
        src.close()
    except Exception:
        pass

    # ── Key via chroma / pitch-class profile ──
    try:
        NOTES  = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
        win    = 4096
        hop    = 512
        src    = aubio.source(str(p), channels=1, hop_size=hop)
        pvoc   = aubio.pvoc(win, hop)
        notes  = aubio.notes("default", win, hop, src.samplerate)
        chroma = [0.0] * 12
        while True:
            samples, read = src()
            note_out = notes(samples)
            midi = int(note_out[0])
            if midi > 0:
                chroma[midi % 12] += 1.0
            if read < hop:
                break
        src.close()
        total = sum(chroma)
        if total > 0:
            # Krumhansl-Schmuckler key profiles (major / minor)
            major_profile = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]
            minor_profile = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]

            def correlate(chroma_norm: list, profile: list) -> float:
                mean_c = sum(chroma_norm) / 12
                mean_p = sum(profile) / 12
                num    = sum((c - mean_c) * (p - mean_p) for c, p in zip(chroma_norm, profile))
                den    = (sum((c - mean_c) ** 2 for c in chroma_norm) *
                          sum((p - mean_p) ** 2 for p in profile)) ** 0.5
                return num / den if den else 0.0

            norm = [c / total for c in chroma]
            best_score, best_key = -9, "?"
            for i in range(12):
                rotated = norm[i:] + norm[:i]
                for mode, profile in (("major", major_profile), ("minor", minor_profile)):
                    score = correlate(rotated, profile)
                    if score > best_score:
                        best_score, best_key = score, f"{NOTES[i]} {mode}"
            result["key"]        = best_key
            result["confidence"] = round(max(0.0, min(1.0, (best_score + 1) / 2)), 2)
    except Exception:
        pass

    return result


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Usage: detect.py <path>"}))
        sys.exit(1)
    print(json.dumps(detect(sys.argv[1])))
