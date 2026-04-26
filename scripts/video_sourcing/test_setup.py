"""Quick test to verify the pipeline setup."""
from search import load_keywords
from config import VIDEOS_DIR, YOUTUBE_API_KEY

kw = load_keywords()
print(f"Loaded {len(kw)} scenes")
for scene, words in kw.items():
    print(f"  {scene}: {len(words)} keywords")

print(f"\nVideos dir: {VIDEOS_DIR}")
print(f"YouTube API key set: {bool(YOUTUBE_API_KEY)}")
print(f"Key prefix: {YOUTUBE_API_KEY[:10]}..." if YOUTUBE_API_KEY else "Key: NOT SET")

# Test imports
from filter import filter_video
from transcribe import get_youtube_subtitles
print("\nAll imports OK!")
