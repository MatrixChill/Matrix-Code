import argparse
import os

from huggingface_hub import snapshot_download


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True)
    parser.add_argument("--model", default="Systran/faster-whisper-base")
    args = parser.parse_args()

    os.makedirs(args.output, exist_ok=True)
    snapshot_download(
        repo_id=args.model,
        local_dir=args.output,
        allow_patterns=[
            "config.json",
            "model.bin",
            "preprocessor_config.json",
            "tokenizer.json",
            "vocabulary.*",
        ],
    )


if __name__ == "__main__":
    main()
