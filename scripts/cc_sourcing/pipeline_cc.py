"""Unified CC pipeline runner — execute all steps in sequence or individually.

Usage:
    python pipeline_cc.py 1 2 3           # Run steps 1-3 (search, filter, transcribe)
    python pipeline_cc.py --all           # Run all steps 1-5
    python pipeline_cc.py 2               # Run step 2 only (filter)

Steps:
    1: Search YouTube for CC videos → cc_search_results.json
    2: Filter by duration/keywords  → cc_filtered_results.json
    3: Download subtitles + Whisper → cc_transcribed_results.json
    4: AI analysis (Claude API)     → cc_analyzed_results.json + cc_review_report.md
    5: Download approved videos     → cc-video/{scene}/{video_id}/
"""

import sys
import os
import argparse

# Ensure cc_sourcing is importable
sys.path.insert(0, os.path.dirname(__file__))


def run_step(step_num):
    """Run a specific step by number."""
    if step_num == 1:
        print("=" * 60, flush=True)
        print("CC STEP 1: YouTube CC Search", flush=True)
        print("=" * 60, flush=True)
        from search_cc import main as search_main
        # Reset sys.argv for the submodule
        old_argv = sys.argv
        sys.argv = ["search_cc.py"]
        search_main()
        sys.argv = old_argv

    elif step_num == 2:
        print("=" * 60, flush=True)
        print("CC STEP 2: Filter CC Results", flush=True)
        print("=" * 60, flush=True)
        from filter_cc import filter_all
        filter_all()

    elif step_num == 3:
        print("=" * 60, flush=True)
        print("CC STEP 3: Subtitle Retrieval / Whisper Transcription", flush=True)
        print("=" * 60, flush=True)
        from transcribe_cc import transcribe_all
        transcribe_all()

    elif step_num == 4:
        print("=" * 60, flush=True)
        print("CC STEP 4: AI Analysis (Claude)", flush=True)
        print("=" * 60, flush=True)
        from analyze_cc import analyze_all
        result = analyze_all()
        if result is None:
            print("Skipped — set ANTHROPIC_API_KEY to enable.", flush=True)
            print("Or use Claude Code agents for this step.", flush=True)

    elif step_num == 5:
        print("=" * 60, flush=True)
        print("CC STEP 5: Download Approved Videos", flush=True)
        print("=" * 60, flush=True)
        from download_cc import download_approved
        download_approved(min_score=4)

    else:
        print(f"Unknown step: {step_num}", flush=True)
        print("Valid steps: 1 (search), 2 (filter), 3 (transcribe), "
              "4 (analyze), 5 (download)", flush=True)
        sys.exit(1)


def main():
    parser = argparse.ArgumentParser(description="Eversay CC Video Sourcing Pipeline")
    parser.add_argument(
        "steps",
        nargs="*",
        type=int,
        help="Step numbers to run (1-5). Leave empty to run steps 1-3.",
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
        steps = [1, 2, 3]
        print("Running steps 1-3 (search, filter, transcribe).", flush=True)
        print("Use --all to include AI analysis and download.\n", flush=True)

    for step in steps:
        run_step(step)
        print(flush=True)

    print("CC Pipeline complete.", flush=True)


if __name__ == "__main__":
    main()
