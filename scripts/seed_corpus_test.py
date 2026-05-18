"""Unit tests for scripts/seed_corpus.py.

Only the pure parsing + filesystem-walk helpers are exercised here; the
HTTP transport (`post_contribute`, `post_scene_sidecar`) is left to a
manual smoke test against a running backend. Run with:

    PYTHONUTF8=1 PYTHONIOENCODING=utf-8 pytest scripts/seed_corpus_test.py -v
"""

from __future__ import annotations

import json
import tempfile
from pathlib import Path

# Import via path so the script doesn't need a setup.py / pyproject.
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))

from seed_corpus import (  # noqa: E402
    CURATOR_ID,
    dedup_phrase_scenes,
    extract_contributions,
    iter_analysis_files,
)


def make_fixture(tmp: Path) -> Path:
    """Write a single analysis.json under data_root/campus/vidABC/."""
    data_root = tmp / "videos"
    video_dir = data_root / "campus" / "vidABC"
    video_dir.mkdir(parents=True)
    analysis = {
        "title": "Budgeting at uni",
        "subtitles": [
            {
                "text": "I really need to save up money.",
                "time": 46.0,
                "highlightWords": ["save up money"],
            },
            {
                "text": "Tuition keeps going up.",
                "time": 51.0,
                "highlightWords": ["going up"],
            },
            # No highlightWords → skipped entirely.
            {"text": "Nothing important here.", "time": 60.0},
            # Empty text → skipped.
            {"text": "", "time": 70.0, "highlightWords": ["x"]},
            # highlightWords with empty string entry → that entry skipped.
            {
                "text": "Multiple words example.",
                "time": 80.0,
                "highlightWords": ["", "multiple words"],
            },
        ],
    }
    (video_dir / "vidABC.analysis.json").write_text(
        json.dumps(analysis), encoding="utf-8"
    )
    return data_root


def test_iter_analysis_files_finds_one_file() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        root = make_fixture(Path(tmp))
        files = list(iter_analysis_files(root))
        assert len(files) == 1
        scene, path = files[0]
        assert scene == "campus"
        assert path.name == "vidABC.analysis.json"


def test_iter_analysis_files_handles_missing_root() -> None:
    """A non-existent data_root yields nothing (no exception)."""
    assert list(iter_analysis_files(Path("/tmp/does/not/exist/12345"))) == []


def test_extract_emits_one_payload_per_highlight_word() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        root = make_fixture(Path(tmp))
        scene, path = next(iter(iter_analysis_files(root)))
        payloads = extract_contributions(path, scene)
        # 3 cues with valid highlightWords: "save up money", "going up",
        # "multiple words" (the empty entry in the 5th cue is filtered out).
        assert len(payloads) == 3
        phrase_raws = [p["phraseRaw"] for p in payloads]
        assert phrase_raws == ["save up money", "going up", "multiple words"]


def test_extract_skips_cues_without_text_or_words() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        root = make_fixture(Path(tmp))
        scene, path = next(iter(iter_analysis_files(root)))
        payloads = extract_contributions(path, scene)
        # Empty-text cue and no-highlightWords cue produce nothing.
        assert all(p["contextSentence"] for p in payloads)


def test_extract_attaches_curator_id_and_canonical_url() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        root = make_fixture(Path(tmp))
        scene, path = next(iter(iter_analysis_files(root)))
        payloads = extract_contributions(path, scene)
        first = payloads[0]
        assert first["contributorId"] == CURATOR_ID
        assert first["source"]["kind"] == "curator"
        assert first["source"]["url"] == "https://youtu.be/vidABC?t=46"
        assert first["source"]["title"] == "Budgeting at uni"
        assert first["_scene"] == "campus"


def test_dedup_phrase_scenes_keeps_first_occurrence() -> None:
    payloads = [
        {"phraseRaw": "Save up money", "_scene": "campus"},
        {"phraseRaw": "save up money", "_scene": "banking"},  # dup by lowercase
        {"phraseRaw": "going up", "_scene": "shopping"},
    ]
    pairs = dedup_phrase_scenes(payloads)
    assert pairs == [("Save up money", "campus"), ("going up", "shopping")]
