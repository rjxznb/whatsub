"""
One-shot icon builder for whatsub.
Reads the raw whatsub.jpg, crops the central region around the wordmark
(effectively scaling it up), applies a 17.5% rounded-rectangle mask, and
writes a 1024x1024 RGBA source.png that `pnpm tauri icon` consumes.

Usage:  python _make_icon.py
Run from anywhere; paths are relative to this file.
"""
from pathlib import Path
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[2]   # client/
SRC = ROOT / "19596619a0881cc038abe853c85d2451.jpg"
OUT = ROOT / "src-tauri" / "icons" / "source.png"

img = Image.open(SRC).convert("RGB")
W, H = img.size
print(f"source size: {W}x{H}")

# The "whatsub" wordmark sits roughly horizontally-centered (the "S" of
# "Sub" lands right at the center column) and slightly below mid-height.
# Crop a 240px square (33% of source) tightly around it so the wordmark
# fills ~75% of the resulting icon — this is the "enlarge" the user asked for.
TEXT_CX = int(W * 0.555)   # ~400 in 720px source
TEXT_CY = int(H * 0.515)   # ~371 in 720px source
CROP = int(min(W, H) * 0.33)   # ~238px window
left = max(0, TEXT_CX - CROP // 2)
top = max(0, TEXT_CY - CROP // 2)
right = min(W, left + CROP)
bottom = min(H, top + CROP)
cropped = img.crop((left, top, right, bottom))
print(f"cropped: {cropped.size} from box ({left},{top},{right},{bottom})")

# Resize to 1024x1024 (Tauri's recommended source size)
TARGET = 1024
scaled = cropped.resize((TARGET, TARGET), Image.LANCZOS).convert("RGBA")

# Build a rounded-rectangle alpha mask. iOS-style "squircle" radius is
# ~22.37% of the side. macOS uses ~17%. Windows is fine with anything.
# We pick 18% — looks balanced on Win taskbar + Mac dock.
RADIUS = int(TARGET * 0.18)
mask = Image.new("L", (TARGET, TARGET), 0)
ImageDraw.Draw(mask).rounded_rectangle(
    (0, 0, TARGET, TARGET), radius=RADIUS, fill=255
)

# Composite onto a fully-transparent canvas using the mask, so the four
# corners outside the rounded rectangle are transparent.
out = Image.new("RGBA", (TARGET, TARGET), (0, 0, 0, 0))
out.paste(scaled, (0, 0), mask)
out.save(OUT)
print(f"wrote {OUT}")
