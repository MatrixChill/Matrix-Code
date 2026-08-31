import argparse
import os
import sys
import time

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")

import numpy as np
import sounddevice as sd
from faster_whisper import WhisperModel

RATE = 16000


def model_path(value):
    if value:
        return os.path.abspath(value)

    configured = os.environ.get("MATRIX_VOICE_MODEL_DIR")
    if configured:
        return os.path.abspath(configured)

    if getattr(sys, "frozen", False):
        return os.path.join(os.path.dirname(sys.executable), "model")
    return "base"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--stop-file")
    parser.add_argument("--model-dir")
    parser.add_argument("--language", default=os.environ.get("MATRIX_VOICE_LANGUAGE", "pt"))
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()

    model_dir = model_path(args.model_dir)
    if model_dir != "base" and not os.path.isdir(model_dir):
        print("Matrix Voice model directory was not found", file=sys.stderr)
        return 4

    if args.self_test:
        WhisperModel(model_dir, device="cpu", compute_type="int8")
        print("Matrix Voice ready", flush=True)
        return 0

    if not args.stop_file:
        parser.error("--stop-file is required unless --self-test is used")

    try:
        if os.path.exists(args.stop_file):
            os.remove(args.stop_file)
    except OSError:
        pass

    frames = []

    def callback(indata, _frame_count, _time_info, status):
        if status:
            print(status, file=sys.stderr)
        frames.append(indata.copy())

    try:
        with sd.InputStream(
            samplerate=RATE,
            channels=1,
            dtype="float32",
            device=sd.default.device[0],
            callback=callback,
        ):
            while not os.path.exists(args.stop_file):
                time.sleep(0.05)

        if not frames:
            return 2

        segments, _info = WhisperModel(model_dir, device="cpu", compute_type="int8").transcribe(
            np.concatenate(frames, axis=0).reshape(-1),
            language=None if args.language == "auto" else args.language,
            vad_filter=True,
            beam_size=5,
        )
        text = " ".join(segment.text.strip() for segment in segments).strip()
        if not text:
            return 3

        # stdout contains only the transcription because Matrix Code captures it.
        print(text, flush=True)
        return 0
    finally:
        try:
            os.remove(args.stop_file)
        except OSError:
            pass


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        raise SystemExit(130)
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        raise SystemExit(1) from exc
