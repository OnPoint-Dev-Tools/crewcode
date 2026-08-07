#!/usr/bin/env python3
"""Generate site favicons for the marketing site and the docs site.

Source of truth is the two brand marks in src/renderer/src/assets:
  icon-logo-light.png — black mark, for LIGHT backgrounds
  icon-logo-dark.png  — white mark, for DARK backgrounds

Both are 1080x1080 RGBA with real transparency. We trim to the alpha bounding
box and re-pad, so the mark stays optically centered and as large as possible
at 16px instead of inheriting whatever slack the export had.

Light/dark switching happens *inside* favicon.svg via an embedded
prefers-color-scheme media query, not through `media` attributes on separate
<link> tags. Browsers break ties between equally-matching icon links by
document order, and Starlight emits its own favicon link last — so a
media-attribute approach silently loses to the fallback in dark mode.

apple-touch/maskable icons are flattened onto the brand background because iOS
composites transparency to black.

Usage: python3 scripts/generate-favicons.py
"""

import base64
from io import BytesIO
from pathlib import Path
from PIL import Image

REPO = Path(__file__).resolve().parent.parent
ASSETS = REPO / "src/renderer/src/assets"
TARGETS = [
    REPO / "website/public",
    REPO / "docs-website/crewcode-docs/public",
]

# Brand background — must match --background in colors_and_type.css.
BRAND_BG = (15, 18, 15, 255)  # #0f120f


def load_trimmed(name: str) -> Image.Image:
    """Load a mark and crop it down to its alpha bounding box."""
    im = Image.open(ASSETS / name).convert("RGBA")
    bbox = im.getchannel("A").getbbox()
    if bbox is None:
        raise SystemExit(f"{name} is fully transparent")
    return im.crop(bbox)


def render(mark: Image.Image, size: int, margin: float, bg=None) -> Image.Image:
    """Fit the mark inside a square canvas, preserving aspect ratio."""
    inner = max(1, int(size * (1 - 2 * margin)))
    w, h = mark.size
    scale = inner / max(w, h)
    resized = mark.resize((max(1, round(w * scale)), max(1, round(h * scale))), Image.LANCZOS)

    canvas = Image.new("RGBA", (size, size), bg if bg else (0, 0, 0, 0))
    canvas.alpha_composite(resized, ((size - resized.width) // 2, (size - resized.height) // 2))
    return canvas


def data_uri(im: Image.Image) -> str:
    buf = BytesIO()
    im.save(buf, format="PNG", optimize=True)
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode("ascii")


def dual_mode_svg(light: Image.Image, dark: Image.Image, size: int = 64) -> str:
    """One favicon that swaps variants itself, so <link> order can't break it."""
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">'
        "<style>"
        ".d{display:none}"
        "@media (prefers-color-scheme:dark){.l{display:none}.d{display:inline}}"
        "</style>"
        f'<image class="l" width="64" height="64" href="{data_uri(render(light, size, 0.04))}"/>'
        f'<image class="d" width="64" height="64" href="{data_uri(render(dark, size, 0.04))}"/>'
        "</svg>"
    )


def main() -> None:
    light = load_trimmed("icon-logo-light.png")  # black mark
    dark = load_trimmed("icon-logo-dark.png")    # white mark

    for out in TARGETS:
        out.mkdir(parents=True, exist_ok=True)

        # Primary favicon: self-switching, transparent, tight margin so the
        # mark still reads at 16px.
        (out / "favicon.svg").write_text(dual_mode_svg(light, dark), encoding="utf-8")

        # PNG fallback for browsers without SVG favicon support.
        render(light, 32, 0.04).save(out / "favicon-32.png")

        # Legacy .ico — black mark, the safe default on light chrome.
        render(light, 48, 0.04).save(
            out / "favicon.ico", sizes=[(16, 16), (32, 32), (48, 48)]
        )

        # iOS/Android: opaque, wider margin to survive rounded-corner masking.
        render(dark, 180, 0.18, BRAND_BG).convert("RGB").save(out / "apple-touch-icon.png")
        render(dark, 192, 0.18, BRAND_BG).convert("RGB").save(out / "icon-192.png")
        render(dark, 512, 0.18, BRAND_BG).convert("RGB").save(out / "icon-512.png")

        print(f"wrote favicons -> {out.relative_to(REPO)}")


if __name__ == "__main__":
    main()
