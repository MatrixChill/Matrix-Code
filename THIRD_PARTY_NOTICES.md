# Third-Party Notices

Matrix Code is built on [OpenCode](https://github.com/anomalyco/opencode),
which is licensed under the MIT License. The original copyright notice is
reproduced in the LICENSE file at the root of this repository, as required
by the MIT License terms.

## OpenCode

Copyright (c) 2025 opencode

Licensed under the MIT License. See LICENSE for the full text.

## Whisper Model (faster-whisper)

Matrix Voice uses the `faster-whisper` library and a CTranslate2-converted
Whisper model from Systran (`Systran/faster-whisper-base`).

- **faster-whisper**: MIT License
  https://github.com/SYSTRAN/faster-whisper
- **CTranslate2**: MIT License
  https://github.com/OpenNMT/CTranslate2
- **Whisper** (original model by OpenAI): MIT License
  https://github.com/openai/whisper

## PyInstaller

Matrix Voice is packaged with PyInstaller.

- **PyInstaller**: GPL-2.0 with linking exception (the bootloader
  exception allows distributing compiled applications without
  applying GPL to the application itself).
  https://pyinstaller.org/en/stable/license.html

## sounddevice

- **sounddevice**: MIT License
  https://github.com/spatialaudio/python-sounddevice

## PortAudio

sounddevice bundles PortAudio.

- **PortAudio**: MIT License
  http://www.portaudio.com/license.html

## Node.js / Bun Runtime

The compiled CLI binary includes a Bun runtime.

- **Bun**: MIT License
  https://github.com/oven-sh/bun
