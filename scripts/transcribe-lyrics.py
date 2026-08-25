#!/usr/bin/env python3
"""
Local, offline lyric transcription — Cadence's last-resort fallback.

Used only when the online lyrics databases have no match for a track (obscure
releases, regional catalogues, brand-new uploads). Downloads the track's audio
with yt-dlp, transcribes it with faster-whisper, and prints timed lines as JSON.

Everything happens on this machine: the audio is written to a temp file, deleted
when we're done, and nothing is uploaded anywhere. The result is a machine
transcription of singing, so it is APPROXIMATE by nature — Whisper is trained on
speech, and vocals over instrumentation are much harder than a podcast. Cadence
labels these lyrics as locally transcribed so they're never mistaken for a
proper synced-lyrics match.

Protocol: one JSON object per line on stdout.
  {"event":"downloading"}
  {"event":"transcribing","duration":213.4}
  {"event":"progress","done":97.2,"total":213.4}
  {"event":"done","lines":[{"time":12.3,"text":"..."}],"language":"en"}
  {"event":"error","message":"..."}
"""

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

# Long Whisper segments are one wall of text; a singable line is short. Split
# anything longer than this using the word-level timestamps.
MAX_LINE_CHARS = 42
MAX_LINE_WORDS = 9


def emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def download_audio(video_id, workdir):
    """Fetch the smallest usable audio stream for this video id."""
    out = os.path.join(workdir, "audio.%(ext)s")
    cmd = [
        "yt-dlp",
        # Plain `bestaudio` on purpose: bitrate-filtered selectors (e.g.
        # abr<=128) silently exclude YouTube's standard 128.93 kbps opus stream
        # and fail the whole download.
        "-f", "bestaudio/best",
        "--no-playlist",
        "--no-warnings",
        "--quiet",
        "-o", out,
        f"https://music.youtube.com/watch?v={video_id}",
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        raise RuntimeError((proc.stderr or "yt-dlp failed").strip().splitlines()[-1][:300])
    for name in os.listdir(workdir):
        if name.startswith("audio."):
            return os.path.join(workdir, name)
    raise RuntimeError("yt-dlp produced no audio file")


def split_segment(seg):
    """Break one Whisper segment into short, singable lines on word boundaries."""
    words = [w for w in (getattr(seg, "words", None) or []) if (w.word or "").strip()]
    text = (seg.text or "").strip()
    if not words:
        return [{"time": round(seg.start, 2), "text": text}] if text else []

    lines, buf = [], []
    for w in words:
        buf.append(w)
        joined = "".join(x.word for x in buf).strip()
        if len(joined) >= MAX_LINE_CHARS or len(buf) >= MAX_LINE_WORDS:
            lines.append({"time": round(buf[0].start, 2), "text": joined})
            buf = []
    if buf:
        joined = "".join(x.word for x in buf).strip()
        if joined:
            lines.append({"time": round(buf[0].start, 2), "text": joined})
    return lines


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--video-id", required=True)
    ap.add_argument("--model", default="base", choices=["tiny", "base", "small"])
    ap.add_argument("--language", default=None, help="force a language code, else auto-detect")
    args = ap.parse_args()

    workdir = tempfile.mkdtemp(prefix="cadence-lyrics-")
    try:
        emit({"event": "downloading"})
        audio = download_audio(args.video_id, workdir)

        from faster_whisper import WhisperModel

        # int8 on CPU: the whole point is that this stays cheap enough to run in
        # the background while music plays.
        model = WhisperModel(args.model, device="cpu", compute_type="int8")

        segments, info = model.transcribe(
            audio,
            word_timestamps=True,
            vad_filter=True,          # skip instrumental stretches
            beam_size=1,              # speed over marginal accuracy
            # Music makes Whisper loop on a phrase for minutes if it can see its
            # own previous output. Disabling that is essential here.
            condition_on_previous_text=False,
        )
        total = float(getattr(info, "duration", 0) or 0)
        emit({"event": "transcribing", "duration": round(total, 2)})

        lines, last_emit = [], 0.0
        for seg in segments:
            lines.extend(split_segment(seg))
            if total and seg.end - last_emit > 15:
                last_emit = seg.end
                emit({"event": "progress", "done": round(seg.end, 1), "total": round(total, 1)})

        # Drop lines with no letters/digits at all (stray punctuation artefacts).
        lines = [l for l in lines if re.search(r"[^\W_]", l["text"], re.UNICODE)]
        emit({
            "event": "done",
            "lines": lines,
            "language": getattr(info, "language", "") or "",
            "model": args.model,
        })
    except Exception as exc:  # noqa: BLE001 - the parent only needs the message
        emit({"event": "error", "message": str(exc)[:300]})
        return 1
    finally:
        shutil.rmtree(workdir, ignore_errors=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
