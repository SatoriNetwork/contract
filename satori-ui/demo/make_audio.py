#!/usr/bin/env python3
"""
make_audio.py — ORIGINAL royalty-free placeholder soundtrack for the Satori
hype reel, synthesized from scratch with the Python standard library only
(wave + struct + math). No external libraries, no samples, no melody modeled
on any existing song. This is a generic electronic/ambient bed for pacing.

Output: placeholder-track.wav (stereo, 44.1 kHz, 16-bit), ~150 seconds.

Musical design (all original, generic functional harmony):
  * Tempo ~90 BPM. A steady four-on-the-floor kick pulse (short sine-burst
    with a fast pitch-drop envelope).
  * A sustained pad: a minor i-VI-III-VII style loop (Am - F - C - G), each
    chord a few detuned sine/triangle partials for a soft chorused feel.
  * A soft triangle arpeggio tracing each chord, lightly swung, low in the mix.
  * Gentle master fade-in / fade-out and a soft limiter to avoid clipping.

Re-run:  python3 demo/make_audio.py
"""
import math
import struct
import wave

SAMPLE_RATE = 44100
BITS = 16
CHANNELS = 2
DURATION = 150.0           # seconds (covers the ~2-3 min video; trimmed at mux)
BPM = 90.0
BEAT = 60.0 / BPM          # seconds per quarter note
MAX_INT = 32767

# --- Note frequencies (equal temperament, A4 = 440 Hz) ---------------------
def note(semitones_from_a4):
    return 440.0 * (2.0 ** (semitones_from_a4 / 12.0))

# Chord progression: Am - F - C - G (each held 2 bars = 8 beats). Root + chord
# tones given as semitone offsets from A4. These are generic chord shapes, not
# a quotation of any tune.
A2 = note(-36); A3 = note(-24)
C3 = note(-21); C4 = note(-9)
E3 = note(-17); E4 = note(-5)
F3 = note(-16); F4 = note(-4)
G3 = note(-14); G4 = note(-2)
A4 = note(0)

PROGRESSION = [
    # (bass, [pad chord tones], [arp tones])
    (A2, [A3, C4, E4], [A3, C4, E4, A4]),   # Am
    (F3, [F3, A3, C4], [F3, A3, C4, F4]),   # F
    (C3, [C4, E4, G4], [C4, E4, G4, C4 * 2]),  # C
    (G3, [G3, note(2), note(-7)], [G3, note(2), note(-7), G4]),  # G  (B4, D4)
]
BEATS_PER_CHORD = 8        # 2 bars of 4/4

def env_adsr(t, dur, a=0.01, d=0.1, s=0.7, r=0.2):
    """Simple ADSR amplitude envelope, t and dur in seconds."""
    if t < a:
        return t / a
    if t < a + d:
        return 1.0 - (1.0 - s) * ((t - a) / d)
    if t < dur - r:
        return s
    if t < dur:
        return s * max(0.0, (dur - t) / r)
    return 0.0

def kick(t):
    """Short sine-burst kick with a fast pitch drop (~120Hz -> ~45Hz)."""
    if t < 0 or t > 0.28:
        return 0.0
    f = 120.0 * math.exp(-18.0 * t) + 45.0
    amp = math.exp(-10.0 * t)
    return math.sin(2 * math.pi * f * t) * amp

def tri(phase):
    """Triangle wave from a phase in turns (0..1)."""
    p = phase % 1.0
    return 4.0 * abs(p - 0.5) - 1.0

def main():
    total = int(DURATION * SAMPLE_RATE)
    chord_len = BEATS_PER_CHORD * BEAT
    fade = 2.5  # seconds fade in/out

    frames = bytearray()
    for n in range(total):
        t = n / SAMPLE_RATE

        # Which chord are we in (loop the 4-chord progression)?
        prog_len = chord_len * len(PROGRESSION)
        tp = t % prog_len
        ci = int(tp // chord_len)
        bass_f, pad_tones, arp_tones = PROGRESSION[ci]
        t_in_chord = tp - ci * chord_len

        # --- Pad: detuned partials, slow attack, sustained over the chord ---
        pad = 0.0
        pad_env = env_adsr(t_in_chord, chord_len, a=0.4, d=0.3, s=0.8, r=0.6)
        for f in pad_tones:
            # two slightly detuned sines per tone for a soft chorus
            pad += math.sin(2 * math.pi * f * t)
            pad += math.sin(2 * math.pi * (f * 1.004) * t)
            pad += 0.5 * tri(f * t)
        pad *= pad_env / (len(pad_tones) * 2.5)

        # --- Bass: soft sine following the chord root, plucked each half-bar ---
        half = (BEAT * 2)
        t_bass = t_in_chord % half
        bass_env = env_adsr(t_bass, half, a=0.01, d=0.25, s=0.5, r=0.3)
        bass = math.sin(2 * math.pi * bass_f * t) * bass_env

        # --- Kick: on each beat ---
        t_in_beat = t % BEAT
        k = kick(t_in_beat)

        # --- Arpeggio: one note per eighth, cycling chord tones, soft triangle
        eighth = BEAT / 2.0
        ai = int((t_in_chord // eighth)) % len(arp_tones)
        t_arp = t_in_chord % eighth
        arp_f = arp_tones[ai] * 2.0  # up an octave, sparkly
        arp_env = env_adsr(t_arp, eighth, a=0.005, d=0.05, s=0.25, r=0.04)
        arp = tri(arp_f * t) * arp_env

        # --- Mix (gains balanced so the bed stays low-key) ---
        left = 0.30 * pad + 0.55 * k + 0.22 * bass + 0.12 * arp
        right = 0.30 * pad + 0.55 * k + 0.22 * bass + 0.12 * arp
        # tiny stereo widening on the arp/pad
        left += 0.04 * math.sin(2 * math.pi * (pad_tones[0] * 0.999) * t)
        right += 0.04 * math.sin(2 * math.pi * (pad_tones[-1] * 1.001) * t)

        # Master fade in/out
        g = 1.0
        if t < fade:
            g = t / fade
        elif t > DURATION - fade:
            g = max(0.0, (DURATION - t) / fade)
        left *= g
        right *= g

        # Soft limiter (tanh) then scale to int16
        def lim(x):
            return math.tanh(x * 1.1)
        li = int(max(-1.0, min(1.0, lim(left))) * MAX_INT)
        ri = int(max(-1.0, min(1.0, lim(right))) * MAX_INT)
        frames += struct.pack('<hh', li, ri)

    out = __file__.rsplit('/', 1)[0] + '/placeholder-track.wav'
    with wave.open(out, 'wb') as w:
        w.setnchannels(CHANNELS)
        w.setsampwidth(BITS // 8)
        w.setframerate(SAMPLE_RATE)
        w.writeframes(bytes(frames))
    print(f"wrote {out}: {DURATION:.0f}s, {SAMPLE_RATE}Hz, {CHANNELS}ch, {BITS}-bit")

if __name__ == '__main__':
    main()
