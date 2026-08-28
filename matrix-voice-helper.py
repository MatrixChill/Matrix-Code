import argparse
import os
import sys
import time

import numpy as np
import sounddevice as sd
from scipy.io.wavfile import write
from faster_whisper import WhisperModel

RATE = 16000

parser = argparse.ArgumentParser()
parser.add_argument("--stop-file", required=True)
args = parser.parse_args()

stop_file = args.stop_file

try:
    if os.path.exists(stop_file):
        os.remove(stop_file)
except OSError:
    pass

frames = []

def callback(indata, frame_count, time_info, status):
    if status:
        print(status, file=sys.stderr)
    frames.append(indata.copy())

try:
    device = sd.default.device[0]

    with sd.InputStream(
        samplerate=RATE,
        channels=1,
        dtype="float32",
        device=device,
        callback=callback,
    ):
        while not os.path.exists(stop_file):
            time.sleep(0.05)

    if not frames:
        sys.exit(2)

    audio = np.concatenate(frames, axis=0)

    wav_path = stop_file + ".wav"
    write(wav_path, RATE, (audio * 32767).astype(np.int16))

    model = WhisperModel(
        "base",
        device="cpu",
        compute_type="int8",
    )

    segments, info = model.transcribe(
        wav_path,
        language="pt",
        vad_filter=True,
        beam_size=5,
    )

    text = " ".join(
        segment.text.strip()
        for segment in segments
    ).strip()

    try:
        os.remove(wav_path)
    except OSError:
        pass

    try:
        os.remove(stop_file)
    except OSError:
        pass

    if not text:
        sys.exit(3)

    # stdout deve conter SOMENTE a transcrição,
    # porque o Matrix Code irá capturá-la.
    print(text, flush=True)

except KeyboardInterrupt:
    pass
except Exception as exc:
    print(str(exc), file=sys.stderr)
    sys.exit(1)
