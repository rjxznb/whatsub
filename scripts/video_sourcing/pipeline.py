"""Unified pipeline runner — execute all steps in sequence or individually."""

import sys
import argparse


def run_step(step_num):
    """Run a specific step by number."""
    if step_num == 1:
        print("=" * 60)
        print("STEP 1: YouTube Search")
        print("=" * 60)
        from search import search_all_scenes
        search_all_scenes()

    elif step_num == 2:
        print("=" * 60)
        print("STEP 2: Auto Filter")
        print("=" * 60)
        from filter import filter_all
        filter_all()

    elif step_num == 3:
        print("=" * 60)
        print("STEP 3: Subtitle Retrieval / Whisper Transcription")
        print("=" * 60)
        from transcribe import transcribe_all
        transcribe_all()

    elif step_num == 4:
        print("=" * 60)
        print("STEP 4: AI Analysis (Claude)")
        print("=" * 60)
        from analyze import analyze_all
        result = analyze_all()
        if result is None:
            print("Skipped — set ANTHROPIC_API_KEY to enable.")

    elif step_num == 5:
        print("=" * 60)
        print("STEP 5: Download Videos")
        print("=" * 60)
        from download import download_approved
        download_approved(min_score=4)

    else:
        print(f"Unknown step: {step_num}")
        print("Valid steps: 1 (search), 2 (filter), 3 (transcribe), 4 (analyze), 5 (download)")
        sys.exit(1)


def main():
    parser = argparse.ArgumentParser(description="Eversay Video Sourcing Pipeline")
    parser.add_argument(
        "steps",
        nargs="*",
        type=int,
        help="Step numbers to run (1-5). Leave empty to run all steps 1-3.",
    )
    parser.add_argument(
        "--all",
        action="store_true",
        help="Run all steps 1-5 (including AI analysis and download).",
    )

    args = parser.parse_args()

    if args.all:
        steps = [1, 2, 3, 4, 5]
    elif args.steps:
        steps = args.steps
    else:
        # Default: run the non-API-key-dependent steps
        steps = [1, 2, 3]
        print("Running steps 1-3 (search, filter, transcribe).")
        print("Use --all to include AI analysis and download.\n")

    for step in steps:
        run_step(step)
        print()

    print("Pipeline complete.")


if __name__ == "__main__":
    main()
