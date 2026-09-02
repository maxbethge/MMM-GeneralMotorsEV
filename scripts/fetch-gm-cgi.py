#!/usr/bin/env python3
"""Download official GM studio CGI the same way the bundled Sierra EV and Bolt images were made.

Example (2025 GMC Sierra EV Denali, Thunderstorm Gray, 3/4 left):

  python scripts/fetch-gm-cgi.py ^
    --id "2025/TT35843/TT35843__5SD/GNO_HTAgmds10.jpg" ^
    --deg 2 ^
    --out images/cars/gmc-sierra-ev-denali-thunderstorm-gray.png ^
    --trim

Paste a dealer/configurator image URL instead of --id:

  python scripts/fetch-gm-cgi.py --url "https://cgi.gm.com/mmgprod-us/dynres/prove/image.gen?i=..." --preview-angles
"""

from __future__ import annotations

import argparse
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
)
DEFAULT_HOST = "https://cgi.gm.com/mmgprod-us/dynres/prove/image.gen"


def cgi_url(image_id: str, deg: int, host: str = DEFAULT_HOST) -> str:
    query = urllib.parse.urlencode(
        {
            "i": image_id,
            "v": f"deg{deg:02d}",
            "std": "true",
            "country": "US",
            "transparentBackgroundPng": "true",
        }
    )
    return f"{host}?{query}"


def parse_source(url: str) -> tuple[str, str]:
    """Return (image.gen endpoint, i= id) from a full CGI URL."""
    parts = urllib.parse.urlsplit(url)
    qs = urllib.parse.parse_qs(parts.query)
    image_id = (qs.get("i") or [None])[0]
    if not image_id:
        raise SystemExit("URL is missing the i= CGI id (year/style/trim/color.jpg).")
    endpoint = urllib.parse.urlunsplit((parts.scheme, parts.netloc, parts.path, "", ""))
    return endpoint, image_id


def download(url: str, dest: Path) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=45) as resp:
            data = resp.read()
            content_type = resp.headers.get("Content-Type", "")
    except urllib.error.HTTPError as err:
        raise SystemExit(f"Download failed ({err.code}): {url}") from err
    except urllib.error.URLError as err:
        raise SystemExit(f"Download failed: {err.reason}") from err
    if len(data) < 2000 or "html" in content_type.lower():
        raise SystemExit(f"Not an image ({len(data)} bytes, {content_type}): {url}")
    dest.write_bytes(data)
    print(f"wrote {dest} ({len(data)} bytes)")


def trim_padding(path: Path, margin: int = 16, threshold: int = 12) -> None:
    """Crop studio black/transparent padding, keeping a small margin so dark tires stay."""
    try:
        from PIL import Image
    except ImportError:
        print("skip --trim (install Pillow: pip install pillow)", file=sys.stderr)
        return

    im = Image.open(path).convert("RGBA")
    w, h = im.size
    px = im.load()
    x0, y0, x1, y1 = w, h, -1, -1
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            if a > 10 and (r > threshold or g > threshold or b > threshold):
                if x < x0:
                    x0 = x
                if y < y0:
                    y0 = y
                if x > x1:
                    x1 = x
                if y > y1:
                    y1 = y
    if x1 < 0:
        print(f"skip trim (empty image): {path}")
        return
    box = (
        max(0, x0 - margin),
        max(0, y0 - margin),
        min(w, x1 + 1 + margin),
        min(h, y1 + 1 + margin),
    )
    cropped = im.crop(box)
    cropped.save(path, "PNG")
    print(f"trimmed {path.name}: {w}x{h} -> {cropped.size[0]}x{cropped.size[1]} (margin {margin}px)")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    src = parser.add_mutually_exclusive_group(required=True)
    src.add_argument("--id", help="CGI i= path, e.g. 2025/TT35843/TT35843__5SD/GNO_HTAgmds10.jpg")
    src.add_argument("--url", help="Full cgi.gm.com / cgi.chevrolet.com image.gen URL from a dealer page")
    parser.add_argument("--deg", type=int, default=2, help="Camera angle 1-8 (Sierra used 2, Bolt used 1)")
    parser.add_argument("--out", type=Path, help="Output PNG (required unless --preview-angles)")
    parser.add_argument(
        "--preview-angles",
        action="store_true",
        help="Download deg01-deg08 next to --out (or images/cars/_cgi_degNN.png) so you can pick a 3/4 left view",
    )
    parser.add_argument("--trim", action="store_true", help="Crop empty studio padding, keep a 16px margin")
    parser.add_argument("--margin", type=int, default=16, help="Pixels of padding to keep when trimming")
    args = parser.parse_args()

    if args.url:
        host, image_id = parse_source(args.url)
        deg_from_url = urllib.parse.parse_qs(urllib.parse.urlsplit(args.url).query).get("v", [""])[0]
        match = re.match(r"deg0?(\d+)", deg_from_url or "", re.I)
        if match and args.deg == 2 and "--deg" not in sys.argv:
            args.deg = int(match.group(1))
    else:
        host, image_id = DEFAULT_HOST, args.id.strip()

    if args.preview_angles:
        base = args.out.parent if args.out else Path("images/cars")
        stem = args.out.stem if args.out else "_cgi"
        for deg in range(1, 9):
            dest = base / f"{stem}_deg{deg:02d}.png"
            download(cgi_url(image_id, deg, host), dest)
            if args.trim:
                trim_padding(dest, margin=args.margin)
        print("Open the _deg0N.png files and keep the 3/4 front view facing left (usually deg01 or deg02).")
        return

    if not args.out:
        parser.error("--out is required unless you pass --preview-angles")
    download(cgi_url(image_id, args.deg, host), args.out)
    if args.trim:
        trim_padding(args.out, margin=args.margin)


if __name__ == "__main__":
    main()
