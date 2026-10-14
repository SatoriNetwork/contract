#!/usr/bin/env bash
# build-video.sh — transcode the recorded WebM walkthrough to an H.264 MP4 and
# mux in the placeholder soundtrack. Idempotent; re-run any time to RE-RENDER
# the final video from the existing recording + audio (no chain/dapp needed).
#
# To SWAP the music: replace demo/placeholder-track.wav with your track (any
# ffmpeg-readable audio works — wav/mp3/m4a/flac) and re-run this script. The
# audio is trimmed/ended to the video length via -shortest, so a longer track
# is fine; a shorter one ends early (add `-stream_loop -1` before the audio -i
# to loop it).
#
# ffmpeg: prefers a full system ffmpeg (H.264 + AAC). The Playwright-bundled
# ffmpeg is VP8/WebM-only with NO audio encoder, so it cannot produce this MP4 —
# see README.md for the codec notes and fallbacks.
set -euo pipefail
cd "$(dirname "$0")"

FFMPEG="${FFMPEG:-$(command -v ffmpeg || true)}"
if [ -z "$FFMPEG" ]; then
  echo "ERROR: no ffmpeg on PATH. Install one (apt-get install ffmpeg) or set FFMPEG=/path/to/ffmpeg." >&2
  echo "NOTE: the Playwright-bundled ffmpeg (~/.cache/ms-playwright/ffmpeg-*/ffmpeg-linux)" >&2
  echo "      is VP8/WebM-only with no audio encoder and cannot build this MP4." >&2
  exit 1
fi

WEBM="$(ls -t recording/*.webm 2>/dev/null | head -1 || true)"
AUDIO="the-pot.flac"
OUT="satori-hype.mp4"

[ -n "$WEBM" ]   || { echo "ERROR: no recording/*.webm found. Run: node record-demo.js" >&2; exit 1; }
[ -f "$AUDIO" ]  || { echo "ERROR: $AUDIO missing. Run: python3 make_audio.py" >&2; exit 1; }

echo "ffmpeg : $FFMPEG"
echo "video  : $WEBM"
echo "audio  : $AUDIO"
echo "output : $OUT"

# Map video from the WebM, audio from the track; transcode video to H.264
# (yuv420p for broad player compatibility) and audio to AAC. -shortest ends the
# mux at the shorter of the two streams (the ~129s video), trimming the 150s bed.
"$FFMPEG" -y \
  -i "$WEBM" \
  -i "$AUDIO" \
  -map 0:v:0 -map 1:a:0 \
  -c:v libx264 -preset medium -crf 20 -pix_fmt yuv420p \
  -c:a aac -b:a 192k \
  -movflags +faststart \
  -shortest \
  "$OUT"

echo "---"
"$FFMPEG" -hide_banner -i "$OUT" 2>&1 | grep -E "Duration|Stream" || true
echo "Wrote $(pwd)/$OUT"
