#!/usr/bin/env python3
"""Compose detailed sakura art + crisp typography into GitHub banner PNG."""
from __future__ import annotations

import base64
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DOCS = ROOT / "docs"
ART = DOCS / "_banner-art.jpg"
SRC_FALLBACK = Path(
    r"C:\Users\matve\.grok\sessions\C%3A%5CWINDOWS%5Csystem32\019f6c49-558e-7450-bc37-f64480fbaeb1\images\1.jpg"
)
OUT_SVG = DOCS / "banner-detail.svg"
OUT_PNG = DOCS / "banner-detail.png"
README_PNG = DOCS / "banner-sakura.png"
LEGACY_PNG = DOCS / "github-banner.png"


def main() -> int:
    if not ART.exists():
        if SRC_FALLBACK.exists():
            shutil.copy(SRC_FALLBACK, ART)
        else:
            print("missing art", file=sys.stderr)
            return 1

    b64 = base64.b64encode(ART.read_bytes()).decode("ascii")
    svg = f"""<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="1280" height="640" viewBox="0 0 1280 640">
  <defs>
    <linearGradient id="scrim" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="#0c0a09" stop-opacity="0.78"/>
      <stop offset="34%" stop-color="#0c0a09" stop-opacity="0.52"/>
      <stop offset="58%" stop-color="#0c0a09" stop-opacity="0.12"/>
      <stop offset="100%" stop-color="#0c0a09" stop-opacity="0"/>
    </linearGradient>
    <linearGradient id="ink" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#fffaf5"/>
      <stop offset="100%" stop-color="#e8ddd0"/>
    </linearGradient>
    <linearGradient id="line" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#e8a090"/>
      <stop offset="100%" stop-color="#c45c3e"/>
    </linearGradient>
    <filter id="softText" x="-8%" y="-8%" width="116%" height="120%">
      <feDropShadow dx="0" dy="2" stdDeviation="8" flood-color="#000" flood-opacity="0.6"/>
    </filter>
  </defs>

  <image href="data:image/jpeg;base64,{b64}" x="0" y="0" width="1280" height="640" preserveAspectRatio="xMidYMid slice"/>
  <rect width="1280" height="640" fill="url(#scrim)"/>

  <rect x="96" y="168" width="3" height="268" rx="1.5" fill="url(#line)" opacity="0.95" filter="url(#softText)"/>

  <g filter="url(#softText)" font-family="Georgia, 'Times New Roman', 'Noto Serif JP', serif">
    <text x="130" y="252" fill="url(#ink)" font-size="100" font-weight="500" letter-spacing="6">miura</text>
  </g>

  <g filter="url(#softText)" font-family="'Segoe UI', 'Hiragino Sans', 'Noto Sans JP', system-ui, sans-serif">
    <text x="130" y="302" fill="#d4c4b4" font-size="20" font-weight="400" letter-spacing="12">音 の 余 白</text>
    <text x="130" y="362" fill="#f5efe6" font-size="28" font-weight="500" letter-spacing="0.4">One player · every source</text>
    <text x="130" y="404" fill="#b8a898" font-size="17" font-weight="400" letter-spacing="1.8">Local  ·  SoundCloud  ·  YouTube</text>
  </g>

  <g font-family="'Segoe UI', system-ui, sans-serif" transform="translate(130, 452)" filter="url(#softText)">
    <rect width="92" height="38" rx="19" fill="#1a1410" fill-opacity="0.58" stroke="#f5efe6" stroke-opacity="0.25"/>
    <circle cx="24" cy="19" r="5" fill="#a3e635"/>
    <text x="58" y="24" text-anchor="middle" fill="#f5efe6" font-size="13" font-weight="600">Local</text>

    <g transform="translate(108,0)">
      <rect width="128" height="38" rx="19" fill="#1a1410" fill-opacity="0.58" stroke="#ff6a33" stroke-opacity="0.55"/>
      <circle cx="24" cy="19" r="5" fill="#ff5500"/>
      <text x="76" y="24" text-anchor="middle" fill="#f5efe6" font-size="13" font-weight="600">SoundCloud</text>
    </g>

    <g transform="translate(252,0)">
      <rect width="108" height="38" rx="19" fill="#1a1410" fill-opacity="0.58" stroke="#ff3355" stroke-opacity="0.5"/>
      <circle cx="24" cy="19" r="5" fill="#ff0033"/>
      <text x="66" y="24" text-anchor="middle" fill="#f5efe6" font-size="13" font-weight="600">YouTube</text>
    </g>
  </g>

  <text x="130" y="562" fill="#9a8e82" font-size="13" font-family="'Segoe UI', system-ui, sans-serif" letter-spacing="2.5" filter="url(#softText)">ELECTRON  ·  REACT  ·  TYPESCRIPT  ·  MIT</text>

  <g transform="translate(1148, 528)" filter="url(#softText)">
    <rect width="56" height="56" rx="4" fill="#1a1410" fill-opacity="0.45" stroke="#c45c3e" stroke-width="1.6" stroke-opacity="0.9"/>
    <text x="28" y="37" text-anchor="middle" fill="#e07058" font-size="22" font-family="Georgia, 'Noto Serif JP', serif" font-weight="600">音</text>
  </g>
</svg>
"""
    OUT_SVG.write_text(svg, encoding="utf-8")
    print("wrote", OUT_SVG, "bytes", OUT_SVG.stat().st_size)

    # Render via resvg-js-cli
    r = subprocess.run(
        ["npx", "--yes", "@resvg/resvg-js-cli", str(OUT_SVG), str(OUT_PNG)],
        cwd=ROOT,
        capture_output=True,
        text=True,
        shell=True,
    )
    print(r.stdout)
    print(r.stderr)
    if r.returncode != 0 or not OUT_PNG.exists():
        print("resvg failed", r.returncode, file=sys.stderr)
        return 1

    shutil.copy(OUT_PNG, README_PNG)
    shutil.copy(OUT_PNG, LEGACY_PNG)
    print("png", OUT_PNG.stat().st_size)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
