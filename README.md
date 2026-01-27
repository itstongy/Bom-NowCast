# bom-nowcast-js

Small CLI for fetching BOM radar frames (Mt Stapylton primary, Marburg fallback), rendering a human-friendly loop, and (next) producing a basic nowcast.

This project intentionally avoids BOM FTP (which is often the source of hangs/timeouts) and instead scrapes the BOM **loop pages** and downloads the timestamped PNG frames over HTTPS.

## Prerequisites

- Node.js (recommended: the one already on this Mac)
- ImageMagick (`magick` or `convert`) **optional but recommended** for GIF loops

## Install

From this folder:

```bash
npm install
```

## Commands

### List supported radars

```bash
node bom-nowcast.js radars
```

### Fetch latest frames (cached)

Fetches and caches the most recent frames for a radar product.

```bash
node bom-nowcast.js fetch --radar IDR663 --frames 10
```

Cache location:

- `~/.cache/bom-nowcast/<RADAR_ID>/`

### Build a human-friendly radar loop GIF (with map underlay + labels)

This renders each frame as:

1) BOM background underlay
2) the timestamped radar frame
3) BOM place-name labels

Then creates a GIF.

```bash
node bom-nowcast.js loop --radar IDR663 --frames 7 --out /tmp/bom-nowcast-context.gif
```

Open it:

```bash
open /tmp/bom-nowcast-context.gif
```

### Nowcast (MVP)

This currently returns a basic analysis for a target lat/lon:

- whether precipitation is currently over the target pixel
- a crude ETA (only when motion is detectable)
- a confidence score

```bash
# Oxenford approx
node bom-nowcast.js nowcast --lat -27.89033 --lon 153.3131 --frames 7 --mode local
```

Notes:
- `--mode local` focuses on a window around the target (better for “is it coming toward me?”)
- `--mode global` uses the broader precip field (can be noisier)

## Design notes

We keep **machine-readable** frames separate from **human-readable** composites:

- Machine-readable: raw timestamped PNG frames from the loop page (best for analysis)
- Human-readable: composited frames (background + labels) for GIF output

## Next planned features

- Interpret precipitation intensity using BOM legend colour bands ("light/moderate/heavy")
- Better motion estimation (optical-flow-ish / block matching in a local window)
- “Approaching / receding / parallel” classification + ETA
- Option to auto-send the loop GIF + summary back into Discord on demand

## References

- Mt Stapylton 128 km loop page: https://reg.bom.gov.au/products/IDR663.loop.shtml
- Marburg loop page: https://reg.bom.gov.au/products/IDR503.loop.shtml
- BOM radar transparencies (legend/background/labels): https://reg.bom.gov.au/products/radar_transparencies/
