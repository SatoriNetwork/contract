# Satori — Internal Hype/Demo Reel

A captioned ~2-minute walkthrough of the Satori dapp with an **original,
royalty-free placeholder soundtrack** (synthesized from scratch — see below).
This is an internal team hype reel.

## Files in this directory

| File | What it is |
|---|---|
| `satori-hype.mp4` | **The deliverable.** H.264 (yuv420p) 1280x720 + AAC stereo, ~2:09. |
| `recording/*.webm` | Intermediate continuous screen recording (VP8/WebM, no audio) from Playwright. The MP4 is transcoded from this. |
| `placeholder-track.wav` | The original placeholder soundtrack (stereo, 44.1 kHz, 16-bit PCM, ~150s). Swap this to change the music. |
| `make_audio.py` | Python-stdlib-only synth that generates `placeholder-track.wav`. No external libraries. |
| `record-demo.js` | Standalone Playwright script that drives the dapp and records the WebM. **Canonical reel producer.** |
| `build-video.sh` | Transcodes the WebM → MP4 and muxes the audio. Re-run to RE-RENDER or to SWAP music. |
| `demo-spec.md` | The storyboard: beats, caption copy, holds, and the seeded state it relies on. |

A self-contained Playwright spec also lives at
`../tests/demo-hype.spec.ts` for teammates who prefer the test runner
(`PORT=8544 npx playwright test demo-hype --video=on --workers=1`).

---

## How the final MP4 was produced

**Approach: CONTINUOUS recording** (the primary approach, not the slideshow
fallback). Playwright's `recordVideo` captured a continuous 1280x720 VP8 WebM of
the scripted, captioned walkthrough; `build-video.sh` transcoded it to H.264 and
muxed in the placeholder soundtrack.

- **Final codecs:** video `h264` (libx264, High profile, yuv420p), audio `aac`
  192 kb/s stereo 44.1 kHz, MP4 container, `+faststart`.
- **ffmpeg used:** the system ffmpeg at **`/usr/bin/ffmpeg`** (v5.1.8).
  > NOTE: the Playwright-bundled ffmpeg
  > (`~/.cache/ms-playwright/ffmpeg-*/ffmpeg-linux`) is a stripped build —
  > **VP8/WebM only, no H.264, no AAC, no audio encoder, no WAV demuxer** — so it
  > can produce the intermediate WebM but **cannot** build this MP4. We use a
  > full system ffmpeg for the transcode + mux. If you only have the Playwright
  > ffmpeg, you can still produce a silent VP8 WebM but not an H.264+AAC MP4.
- **Exact mux command** (what `build-video.sh` runs):
  ```bash
  ffmpeg -y \
    -i recording/<recording>.webm \
    -i placeholder-track.wav \
    -map 0:v:0 -map 1:a:0 \
    -c:v libx264 -preset medium -crf 20 -pix_fmt yuv420p \
    -c:a aac -b:a 192k \
    -movflags +faststart -shortest \
    satori-hype.mp4
  ```

---

## Re-render the video

### Just rebuild the MP4 from the existing recording + audio
No chain or dapp needed:
```bash
cd Satori/contract/satori-ui/demo
./build-video.sh
```

### Full re-render (re-record the walkthrough, then mux)
You must stand up the local stack first (the dapp reads a live local chain).
All paths are relative to `Satori/contract`.

```bash
# 1. Hardhat node on 8545 (the dapp's RPC auto-discovery = UI port + 1).
cd Satori/contract/satori
../node_modules/.bin/hardhat node --port 8545 --hostname 127.0.0.1 > /tmp/hh-node.log 2>&1 &
# poll until it answers:
until curl -s -X POST http://127.0.0.1:8545 -H 'Content-Type: application/json' \
  --data '{"jsonrpc":"2.0","method":"eth_chainId","params":[],"id":1}' | grep -q result; do sleep 0.5; done

# 2. Deploy (fills addresses.ts[31337]) + seed.
../node_modules/.bin/hardhat run scripts/deploy.js --network localhost
CONTRACT_ADDRESS=0x5FC8d32690cc91D4c39d9d3abcBD16989F875707 \
  ../node_modules/.bin/hardhat run scripts/seed-e2e-ui.js --network localhost
CONTRACT_ADDRESS=0x5FC8d32690cc91D4c39d9d3abcBD16989F875707 \
  ../node_modules/.bin/hardhat run scripts/seed-demo.js --network localhost

# 3. Serve the dapp in DEV mode on 8544 (must be dev mode: only the dev build
#    auto-connects the Hardhat dev signer + shows the dev account switcher).
cd ../satori-ui
PORT=8544 HOST=127.0.0.1 BROWSER=none npm start > /tmp/dapp.log 2>&1 &
until [ "$(curl -s -o /dev/null -w '%{http_code}' http://localhost:8544)" = "200" ]; do sleep 2; done

# 4. Record + build.
node demo/record-demo.js          # writes demo/recording/*.webm
./demo/build-video.sh             # writes demo/satori-hype.mp4
```

The recorder picks the newest `recording/*.webm`. Delete old ones first if you
want a clean dir: `rm -f demo/recording/*.webm`.

---

## Swap in a real music track later

1. Drop your track in this directory and **replace** `placeholder-track.wav`
   (or keep your file alongside and point `build-video.sh` at it). Any
   ffmpeg-readable format works — wav / mp3 / m4a / flac.
   ```bash
   cp /path/to/your-track.mp3 demo/placeholder-track.wav   # simplest: overwrite
   ```
   Or edit the `AUDIO=` line in `build-video.sh` to your filename.
2. Re-mux (no re-record needed):
   ```bash
   ./demo/build-video.sh
   ```
   The audio is trimmed to the video length via `-shortest`. If your track is
   **shorter** than the video and you want it to loop, add `-stream_loop -1`
   immediately before the audio `-i` in `build-video.sh`.

### Regenerate the placeholder bed
```bash
python3 demo/make_audio.py        # rewrites placeholder-track.wav
```
`make_audio.py` synthesizes an **original** instrumental bed (90 BPM kick pulse,
a sustained detuned pad over an Am–F–C–G loop, and a soft arpeggio) using only
the Python standard library (`wave`, `struct`, `math`). It is not modeled on any
existing song — it is generic functional harmony intended purely for pacing.
