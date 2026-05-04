"""
Rebuild app icon resources from the latest icon source.

Reads:
    SRC — either an .svg (rasterized to 1024x1024 via cairosvg) or a
          1024x1024 .png. SVG is preferred because the source repo lives
          there and PNG can be re-derived; PNG fallback exists so this
          script still runs in environments without cairo / cairosvg.

Writes (all under client/src-tauri/icons/):
    source.png            archival copy of the rasterized 1024 input
    32x32.png             ┐
    64x64.png             │ Windows / Linux raster sizes — no padding,
    128x128.png           │ same as the source so the icon fills its
    128x128@2x.png (256)  ┘ taskbar/launcher slot edge-to-edge
    icon.ico              Windows multi-resolution
    icon.icns             macOS — same artwork but downscaled to
                          ~MAC_BODY_PCT of the canvas with transparent
                          padding so it doesn't tower over Apple's built-in
                          apps in the dock (HIG icon body ≈ 824/1024)

Run with:  python _apply_new_icon.py
(uses the ASR conda env's Pillow + cairosvg — no extra deps to install)
"""
import io
import struct
from pathlib import Path

from PIL import Image

THIS = Path(__file__).resolve().parent
NEW_ICON_DIR = Path(r"C:\Users\renjx\Desktop\whatsub-icon-src")
SRC = NEW_ICON_DIR / "whatsub-icon.svg"

# How much of the macOS canvas the icon body should fill. 0.82 leaves ~9%
# transparent padding on each side, matching the Apple HIG "icon grid"
# spec. Tweak smaller (e.g. 0.78) if the dock still feels oversized.
MAC_BODY_PCT = 0.82

# Multi-res list for the Windows .ico file. 256 is the largest size
# Windows recognizes for high-DPI taskbars; 16 covers Explorer list view.
ICO_SIZES = [(256, 256), (128, 128), (64, 64), (48, 48), (32, 32), (16, 16)]

# (type_code, pixel_size) entries to pack into the .icns container.
# Apple's modern icon uses these 8 slots; older slots (ICN#, etc.) are
# legacy and Tauri / macOS Big Sur+ doesn't need them.
ICNS_ENTRIES = [
    (b"ic07", 128),    # 128x128
    (b"ic08", 256),    # 256x256
    (b"ic09", 512),    # 512x512
    (b"ic10", 1024),   # 512x512@2x / 1024x1024
    (b"ic11", 32),     # 16x16@2x
    (b"ic12", 64),     # 32x32@2x
    (b"ic13", 256),    # 128x128@2x
    (b"ic14", 512),    # 256x256@2x
]


def with_mac_padding(src: Image.Image, canvas_size: int = 1024) -> Image.Image:
    """Scale src into the center of a transparent canvas of the given size.

    Crops the source to its tight opaque bounding box first — the supplied
    icon-1024.png has the squircle hugging the top of the canvas with a
    ~90px transparent strip at the bottom, which (without cropping)
    propagates into a visibly off-center icon in the dock with the bottom
    edge appearing to be clipped. Cropping to the bbox then re-centering
    guarantees the visible content sits at canvas center regardless of any
    asymmetric padding baked into the source PNG.
    """
    bbox = src.getbbox()
    cropped = src.crop(bbox) if bbox else src
    body = int(canvas_size * MAC_BODY_PCT)

    # Fit the cropped content into a body×body slot while preserving aspect
    # ratio. If the source content isn't square (it isn't — it's 1024×937),
    # we'd rather show it at its native proportions than stretch it into a
    # square; the mild non-squareness is invisible in the dock, but a
    # vertical stretch would warp the wordmark inside the squircle.
    bw, bh = cropped.size
    if bw >= bh:
        new_w = body
        new_h = max(1, round(body * bh / bw))
    else:
        new_h = body
        new_w = max(1, round(body * bw / bh))
    scaled = cropped.resize((new_w, new_h), Image.LANCZOS)

    canvas = Image.new("RGBA", (canvas_size, canvas_size), (0, 0, 0, 0))
    ox = (canvas_size - new_w) // 2
    oy = (canvas_size - new_h) // 2
    canvas.paste(scaled, (ox, oy), scaled)
    return canvas


def png_bytes(img: Image.Image, size: int) -> bytes:
    """Render img at the requested size into PNG bytes."""
    buf = io.BytesIO()
    img.resize((size, size), Image.LANCZOS).save(buf, format="PNG")
    return buf.getvalue()


def write_icns(path: Path, mac_src: Image.Image) -> None:
    """Pack mac_src at all ICNS_ENTRIES sizes into a single .icns file.

    Each chunk: 4-byte type code + 4-byte big-endian length (total chunk
    length, including the 8-byte header) + PNG payload. The whole file is
    wrapped in an 'icns' header with the same length convention.
    """
    chunks = []
    for type_code, size in ICNS_ENTRIES:
        png = png_bytes(mac_src, size)
        chunks.append(type_code + struct.pack(">I", 8 + len(png)) + png)
    body = b"".join(chunks)
    path.write_bytes(b"icns" + struct.pack(">I", 8 + len(body)) + body)


def load_source_as_png_bytes() -> bytes:
    """Load SRC and return 1024x1024 RGBA PNG bytes.

    SVG path: cairosvg rasterizes the vector into a clean 1024x1024 PNG.
    We rewrite the embedded `whatsub-logo.png` href to an absolute file://
    URL because cairosvg on Windows resolves bare relative paths against
    drive root (so 'whatsub-logo.png' becomes 'C:\\whatsub-logo.png' and
    fails); pinning the absolute path side-steps that.

    PNG path: read as-is.
    """
    if SRC.suffix.lower() == ".svg":
        import cairosvg  # imported lazily so PNG-only setups don't need it
        svg_text = SRC.read_text(encoding="utf-8")
        # Rewrite any bare-relative image hrefs to absolute file:// URLs
        # rooted next to the SVG. Covers both single- and double-quoted hrefs.
        for sibling in SRC.parent.iterdir():
            if sibling.suffix.lower() in {".png", ".jpg", ".jpeg"}:
                abs_url = sibling.as_uri()
                svg_text = svg_text.replace(f'href="{sibling.name}"', f'href="{abs_url}"')
                svg_text = svg_text.replace(f"href='{sibling.name}'", f"href='{abs_url}'")
        png = cairosvg.svg2png(
            bytestring=svg_text.encode("utf-8"),
            output_width=1024,
            output_height=1024,
            unsafe=True,
        )
        return png
    return SRC.read_bytes()


def main() -> None:
    if not SRC.exists():
        raise SystemExit(f"source not found: {SRC}")
    raw = load_source_as_png_bytes()
    src = Image.open(io.BytesIO(raw)).convert("RGBA")
    if src.size != (1024, 1024):
        print(f"warning: source is {src.size}, resampling to 1024x1024")
        src = src.resize((1024, 1024), Image.LANCZOS)

    # 1. Archive the rasterized source as source.png (lets `pnpm tauri icon`
    #    re-run from the same input later, even if the SVG toolchain is gone).
    (THIS / "source.png").write_bytes(raw)

    # 2. PNG resources (Win/Linux/iOS/Android use these; no padding).
    for filename, size in [
        ("32x32.png", 32),
        ("64x64.png", 64),
        ("128x128.png", 128),
        ("128x128@2x.png", 256),
    ]:
        src.resize((size, size), Image.LANCZOS).save(THIS / filename)
        print(f"wrote {filename}")

    # 3. Windows .ico — Pillow handles multi-res out of the box.
    src.save(THIS / "icon.ico", sizes=ICO_SIZES)
    print(f"wrote icon.ico (sizes: {[s[0] for s in ICO_SIZES]})")

    # 4. macOS .icns with body padding so the dock icon visually matches
    #    Apple's first-party apps. Manually packed to avoid depending on
    #    Pillow 11+ (which added .icns write support but isn't ubiquitous).
    mac_src = with_mac_padding(src)
    write_icns(THIS / "icon.icns", mac_src)
    print(
        f"wrote icon.icns "
        f"(body={int(MAC_BODY_PCT * 100)}%, padding={int((1 - MAC_BODY_PCT) * 50)}% per side)"
    )


if __name__ == "__main__":
    main()
