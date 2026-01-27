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

### Initial setup (config + default location)

This tool reads config from:

- `~/.config/bom-nowcast/config.json`

Create it (only needed once):

```bash
node bom-nowcast.js config-init
```

The default config includes a `Default` location. (You can edit the JSON directly or use the commands below.)

### Locations (home/work/uni)

List locations:

```bash
node bom-nowcast.js locations
```

Add a location:

```bash
node bom-nowcast.js location-add --name Work --lat -27.XXXX --lon 153.XXXX
```

Add a location with an emoji marker:

```bash
node bom-nowcast.js location-add --name Work --lat -27.XXXX --lon 153.XXXX --emoji 🧭
```

Set a location as the default:

```bash
node bom-nowcast.js location-add --name Default --lat -27.874798 --lon 153.296172 --set-default
```

### List supported radars

```bash
node bom-nowcast.js radars
```

### Fetch latest frames (cached + auto-prune)

Fetches and caches the most recent frames for a radar product. Old cached frames are automatically deleted (default: 3 days).

```bash
node bom-nowcast.js fetch --radar IDR663 --frames 10
```

Cache location:

- `~/.cache/bom-nowcast/<RADAR_ID>/`

### Build a human-friendly radar loop GIF (with map underlay + labels + location emojis)

This renders each frame as:

1) BOM background underlay
2) the timestamped radar frame
3) BOM place-name labels
4) **emoji markers** for all configured locations

Then creates a GIF.

```bash
node bom-nowcast.js loop --radar IDR663 --frames 7 --out /tmp/bom-nowcast-context.gif
```

Open it:

```bash
open /tmp/bom-nowcast-context.gif
```

### Nowcast (MVP)

Nowcast supports either:

- a named location from your config (recommended), or
- an explicit `--lat/--lon`

```bash
# Use your default configured location
node bom-nowcast.js nowcast --frames 7 --mode local

# Use a named location
node bom-nowcast.js nowcast --location Work --frames 7 --mode local

# Or pass lat/lon explicitly
node bom-nowcast.js nowcast --lat -27.874798 --lon 153.296172 --frames 7 --mode local
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
