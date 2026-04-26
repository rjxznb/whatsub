"""Shared configuration for the video sourcing pipeline."""

import os
from pathlib import Path

# ── Paths ──
PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
DATA_DIR = PROJECT_ROOT / "data"
VIDEOS_DIR = DATA_DIR / "videos"
SUBTITLES_DIR = VIDEOS_DIR / "subtitles"
AUDIO_DIR = VIDEOS_DIR / "audio"
CC_VIDEO_DIR = DATA_DIR / "cc-video"
KEYWORDS_FILE = Path(__file__).resolve().parent / "keywords.yaml"
COOKIES_FILE = Path(__file__).resolve().parent / "cookies.txt"

# Ensure dirs exist
for d in [VIDEOS_DIR, SUBTITLES_DIR, AUDIO_DIR, CC_VIDEO_DIR]:
    d.mkdir(parents=True, exist_ok=True)

# ── API Keys ──
YOUTUBE_API_KEY = os.environ.get("YOUTUBE_API_KEY", "")
ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY", "")

# ── Filter rules ──
FILTER_RULES = {
    "min_duration_seconds": 60,
    "max_duration_seconds": 1200,
    "min_views": 100000,
    "exclude_title_keywords": [
        "learn english",
        "english lesson",
        "english class",
        "english teacher",
        "english grammar",
        "ielts",
        "toefl",
        "how to speak",
        "pronunciation",
        "vocabulary list",
        "english course",
        "tutorial",
        # Exclude India-related content (target is UK/US/AU/CA)
        "india",
        "indian",
        "hindi",
        "mumbai",
        "delhi",
        "bangalore",
        "hyderabad",
        "chennai",
        "kolkata",
        "pune",
        "desi",
    ],
    "prefer_title_keywords": [
        "vlog",
        "experience",
        "first time",
        "story",
        "day in my life",
        "international student",
        "moving to",
        "living in",
        "interview",
        "phone call",
        "haircut",
        "driving test",
        "road test",
        "hotel",
        "gym",
        "therapy",
        "plumber",
    ],
}

# ── Scene name mapping ──
SCENE_NAMES = {
    "immigration": "入境通关",
    "housing": "住房安家",
    "medical": "医疗健康",
    "campus": "校园学习",
    "banking": "银行财务",
    "shopping": "日常购物",
    "transport": "交通出行",
    "social": "社交日常",
    "dining": "餐饮",
    "emergency": "紧急情况",
    "job": "求职职场",
    "phone": "电话沟通",
    "salon": "美容美发",
    "driving": "驾照开车",
    "travel": "旅游度假",
    "fitness": "运动健身",
    "mental_health": "心理健康",
    "maintenance": "搬家维修",
}

# ── Whisper ──
WHISPER_MODEL = "base"       # base / small / medium / large-v3
WHISPER_DEVICE = "cuda"      # cuda / cpu
WHISPER_COMPUTE_TYPE = "float16"  # float16 for GPU, int8 for CPU
