#!/usr/bin/env zsh
set -euo pipefail

# ────────────────────────────────────────────────
#  🏷️  Version / Help
# ────────────────────────────────────────────────
VERSION="0.9.0"

print_usage() {
  cat <<'USAGE'
Sample CD Repacker

Usage:
  ./repack_interactive.zsh           # interactive mode
  ./repack_interactive.zsh --help    # show help
  ./repack_interactive.zsh --version # show version

Description:
  Repack old sample CDs/folders into clean WAV folders.
  - Merges stereo pairs ("-L.wav"/"-R.wav")
  - Optionally normalizes and trims silence
  - Preserves or flattens folder tree
  - Writes a global REPACKED/index.csv
USAGE
}

if (( $# > 0 )); then
  case "${1:-}" in
    -h|--help)
      print_usage
      exit 0
      ;;
    -v|--version)
      echo "samplem v$VERSION"
      exit 0
      ;;
    --help)
      print_usage
      exit 0
      ;;
    --version)
      echo "samplem v$VERSION"
      exit 0
      ;;
  esac
fi

# ────────────────────────────────────────────────
#  ⚙️  Non-interactive flags (for GUI wrappers/CI)
# ────────────────────────────────────────────────
# Defaults match interactive prompts: normalize=yes, trim=no, layout=flat (alias of flat_noprefix)
NORMALIZE=${NORMALIZE:-}
TRIM=${TRIM:-}
STRUCTURE_MODE=${STRUCTURE_MODE:-}
PACK_PATH_ARG=""

NORM_SET=false
TRIM_SET=false
LAYOUT_SET=false

parse_layout_flag() {
  case "$1" in
    keep)
      STRUCTURE_MODE="keep_tree"
      ;;
    flat-prefix)
      STRUCTURE_MODE="flat_prefix"
      ;;
    flat)
      STRUCTURE_MODE="flat_noprefix"
      ;;
    *)
      echo "Unknown layout: $1 (expected keep|flat-prefix|flat)" >&2
      exit 1
      ;;
  esac
  LAYOUT_SET=true
}

while (( $# )); do
  case "$1" in
    --path)
      PACK_PATH_ARG="$2"; shift 2;;
    --normalize)
      NORMALIZE=true; NORM_SET=true; shift;;
    --no-normalize)
      NORMALIZE=false; NORM_SET=true; shift;;
    --trim)
      TRIM=true; TRIM_SET=true; shift;;
    --no-trim)
      TRIM=false; TRIM_SET=true; shift;;
    --layout)
      parse_layout_flag "$2"; shift 2;;
    --)
      shift; break;;
    *)
      break;;
  esac
done

# ────────────────────────────────────────────────
#  Intro / help
# ────────────────────────────────────────────────
echo "──────────────────────────────────────────────"
echo "Repacker"
echo "──────────────────────────────────────────────"
echo
echo "This repacks vintage sample CDs into clean modern folders:"
echo "• Merges stereo pairs ('-L.wav' + '-R.wav') into a single stereo WAV"
echo "• Removes 'Partition *' levels from the folder structure"
echo "• Optional normalization (peak to 0 dBFS) and silence trim (via SoX)"
echo
echo "Choose output structure:"
echo "  1) Keep parent subfolders"
echo "     → Preserves folders like '120 BPM', 'Kicks', etc."
echo "  2) Flatten with parent prefix"
echo "     → Single folder; filenames prefixed by their parent (e.g. '140_BPM_Loop1.wav')"
echo "  3) Flatten without prefix  (default)"
echo "     → Single folder; filenames unchanged"
echo "──────────────────────────────────────────────"
echo

# ────────────────────────────────────────────────
#  🎛️  Interactive input
# ────────────────────────────────────────────────
echo "Enter the full path of the sample pack you want to repack:"
if [[ -n "$PACK_PATH_ARG" ]]; then
  PACK_PATH="$PACK_PATH_ARG"
else
  read -r PACK_PATH
fi

# Strip optional quotes / surrounding spaces (handles drag-and-drop too)
PACK_PATH="${PACK_PATH#\'}"; PACK_PATH="${PACK_PATH%\'}"
PACK_PATH="${PACK_PATH#\"}"; PACK_PATH="${PACK_PATH%\"}"
PACK_PATH="$(echo "$PACK_PATH" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"

[[ -z "$PACK_PATH" ]] && { echo "❌ No path given."; exit 1; }
[[ ! -d "$PACK_PATH" ]] && { echo "❌ Folder not found: $PACK_PATH"; exit 1; }

# Resolve to absolute path and key paths
PACK_PATH="$(realpath "$PACK_PATH")"
PACK_NAME="$(basename "$PACK_PATH")"
OUT_ROOT="${PACK_PATH%/}/SAMPLEM-REPACKED"
OUT_DIR="$OUT_ROOT/$PACK_NAME"
mkdir -p "$OUT_DIR"

if ! $NORM_SET >/dev/null 2>&1; then
  echo "Normalize audio (peak to 0 dBFS, no clipping)? (y/n) [y]"
  read -r norm_choice
  [[ "${norm_choice:l}" != "n" ]] && NORMALIZE=true || NORMALIZE=false
fi

if ! $TRIM_SET >/dev/null 2>&1; then
  echo "Trim leading/trailing silence (soft)? (y/n) [n]"
  read -r trim_choice
  [[ "${trim_choice:l}" == "y" ]] && TRIM=true || TRIM=false
fi

if ! $LAYOUT_SET >/dev/null 2>&1; then
  echo
  echo "Choose output structure (enter 1, 2, or 3):"
  echo "  1 - Keep parent subfolders"
  echo "  2 - Flatten with parent prefix"
  echo "  3 - Flatten without prefix (default)"
  read -r org_choice

  case "$org_choice" in
    1) STRUCTURE_MODE="keep_tree" ;;
    2) STRUCTURE_MODE="flat_prefix" ;;
    *) STRUCTURE_MODE="flat_noprefix" ;;
  esac
fi

echo
echo "→ Selected mode: $STRUCTURE_MODE"
echo "──────────────────────────────────────────────"
echo

# ────────────────────────────────────────────────
#  ⚙️  Sox setup
# ────────────────────────────────────────────────
command -v sox >/dev/null 2>&1 || { echo "❌ sox is required (brew install sox)"; exit 1; }

typeset -a SOX_FX
$NORMALIZE && SOX_FX+=("gain" "-n")
$TRIM && SOX_FX+=("silence" "1" "0.01" "0.5%" "reverse" "silence" "1" "0.01" "0.5%" "reverse")

log() { print -r -- "• $*"; }

# ────────────────────────────────────────────────
#  🧠  Helpers
# ────────────────────────────────────────────────
rel_to_pack() {
  local p_abs="$(realpath "$1")"
  local pack_abs="$PACK_PATH"
  if [[ "$p_abs" == "$pack_abs" ]]; then
    print -r -- ""
    return 0
  fi
  local with_slash="$pack_abs/"
  if [[ "$p_abs" == $with_slash* ]]; then
    print -r -- "${p_abs#$with_slash}"
  else
    print -r -- "$(basename "$p_abs")"
  fi
}

strip_partitions_from_rel() {
  local rel="$1"
  local IFS='/'
  local -a parts out
  parts=(${rel})
  out=()
  for p in $parts; do
    if [[ "${p:l}" == partition\ * ]]; then
      continue
    fi
    out+=("$p")
  done
  print -r -- "${(j:/:)out}"
}

clean_rel_dir_from_absdir() {
  # returns a relative directory (may be ""), with Partition* removed
  local absdir="$1"
  local rel="$(rel_to_pack "$absdir")"
  local stripped="$(strip_partitions_from_rel "$rel")"
  print -r -- "$stripped"
}

parent_folder_name() { basename "$(dirname "$1")"; }

# Safe prefix for filenames (keep spaces, strip slashes)
safe_prefix() { print -r -- "$(echo "$1" | tr '/' '_' )"; }

# Decide output directory + filename prefixing strategy
decide_out_dir_and_prefix() {
  # args: src_file -> echoes "OUTDIR|PREFIX"
  local src="$1"
  local parent="$(parent_folder_name "$src")"
  local rel_dir="$(clean_rel_dir_from_absdir "$(dirname "$src")")"

  local outd prefix
  case "$STRUCTURE_MODE" in
    keep_tree)
      # keep subfolders (minus Partition*)
      if [[ -z "$rel_dir" || "$rel_dir" == "." ]]; then
        outd="$OUT_DIR"          # root of pack in REPACKED
      else
        outd="$OUT_DIR/$rel_dir" # preserved sub-tree
      fi
      prefix=""                  # no filename prefix needed
      ;;
    flat_prefix)
      # flatten into OUT_DIR, prefix with parent folder to keep grouping
      outd="$OUT_DIR"
      prefix="$(safe_prefix "$parent")_"
      ;;
    flat_noprefix|*)
      # flatten into OUT_DIR, filenames unchanged
      outd="$OUT_DIR"
      prefix=""
      ;;
  esac

  print -r -- "$outd|$prefix"
}

# Only run sox if FX were requested or input is AIF (needs conversion); otherwise just copy
copy_or_process() {
  local in="$1" out="$2"
  local is_aif=false
  [[ "${in:l}" == *.aif || "${in:l}" == *.aiff ]] && is_aif=true

  if (( ${#SOX_FX[@]} )) || $is_aif; then
    sox -V1 -G "$in" "$out" "${SOX_FX[@]}" || { $is_aif || cp -p "$in" "$out"; }
  else
    cp -p "$in" "$out"
  fi
}

# ────────────────────────────────────────────────
#  🔄  Process -L / -R stereo pairs
# ────────────────────────────────────────────────
typeset -A seen_names

while IFS= read -r -d '' L; do
  R="${L%-L.wav}-R.wav"
  [[ -f "$R" ]] || continue

  IFS='|' read -r out_dir name_prefix <<<"$(decide_out_dir_and_prefix "$L")"
  mkdir -p "$out_dir"

  base="$(basename "$L")"
  stem="$(print -r -- "$base" | sed -E 's/[[:space:]]*-L\.wav$//')"
  name_no_ext="${stem%.*}"

  # handle duplicate base names across the whole run
  if [[ -n "${seen_names[$name_no_ext]:-}" ]]; then
    [[ -z "$name_prefix" ]] && name_prefix="$(safe_prefix "$(parent_folder_name "$L")")_"
  else
    seen_names[$name_no_ext]=1
  fi

  out_file="$out_dir/${name_prefix}${name_no_ext}.wav"

  log "Stereo  :: ${L#$PACK_PATH/} + ${R#$PACK_PATH/} → ${out_file#$OUT_DIR/}"
  if (( ${#SOX_FX[@]} )); then
    sox -V1 -G -M "$L" "$R" "$out_file" "${SOX_FX[@]}" || true
  else
    # no FX: just merge channels fast & safe
    sox -V1 -G -M "$L" "$R" "$out_file" || true
  fi
done < <(find "$PACK_PATH" -type f -name "*-L.wav" ! -path "*/SAMPLEM-REPACKED/*" -print0)

# ────────────────────────────────────────────────
#  📦  Copy/convert mono WAVs and AIF files
# ────────────────────────────────────────────────
typeset -i _total_files _done_files
_total_files=$(find "$PACK_PATH" -type f \( -name "*.wav" -o -name "*.aif" -o -name "*.aiff" \) ! -path "*/SAMPLEM-REPACKED/*" | wc -l | tr -d ' ')
_done_files=0

while IFS= read -r -d '' F; do
  [[ "$F" == *"-L.wav" || "$F" == *"-R.wav" ]] && continue

  IFS='|' read -r out_dir name_prefix <<<"$(decide_out_dir_and_prefix "$F")"
  mkdir -p "$out_dir"

  base="$(basename "$F")"
  name_no_ext="${base%.*}"

  # AIF/AIFF → output as .wav
  out_base=""
  if [[ "${F:l}" == *.aif || "${F:l}" == *.aiff ]]; then
    out_base="${name_no_ext}.wav"
  else
    out_base="$base"
  fi

  if [[ -n "${seen_names[$name_no_ext]:-}" ]]; then
    [[ -z "$name_prefix" ]] && name_prefix="$(safe_prefix "$(parent_folder_name "$F")")_"
  else
    seen_names[$name_no_ext]=1
  fi

  out_file="$out_dir/${name_prefix}${out_base}"

  if [[ "${F:l}" == *.aif || "${F:l}" == *.aiff ]]; then
    log "Convert :: ${F#$PACK_PATH/} → ${out_file#$OUT_DIR/}"
  else
    log "Copy    :: ${F#$PACK_PATH/} → ${out_file#$OUT_DIR/}"
  fi
  copy_or_process "$F" "$out_file"

  (( ++_done_files ))
  echo "PROGRESS:${_done_files}/${_total_files}"
done < <(find "$PACK_PATH" -type f \( -name "*.wav" -o -name "*.aif" -o -name "*.aiff" \) ! -path "*/SAMPLEM-REPACKED/*" -print0)

# ────────────────────────────────────────────────
#  🗂️  CSV Index (global at REPACKED root)
# ────────────────────────────────────────────────
INDEX="$OUT_ROOT/index.csv"
echo "pack_name,path,channels,samplerate,bitdepth,duration_sec,basename" > "$INDEX"

while IFS= read -r -d '' f; do
  ch=$(sox --i -c "$f" 2>/dev/null || echo "?")
  sr=$(sox --i -r "$f" 2>/dev/null || echo "?")
  bd=$(sox --i -b "$f" 2>/dev/null || echo "?")
  du=$(sox --i -D "$f" 2>/dev/null || echo "?")
  bn="$(basename "$f")"
  echo "$PACK_NAME,$f,$ch,$sr,$bd,$du,$bn" >> "$INDEX"
done < <(find "$OUT_DIR" -type f -name "*.wav" -print0)

# ────────────────────────────────────────────────
#  ✅  Done
# ────────────────────────────────────────────────
echo
echo "✅ Repacking complete!"
echo "📁 Output folder: $OUT_DIR"
echo "📄 Index file (global): $INDEX"
