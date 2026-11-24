# bom-nowcast

Fast Australian Bureau of Meteorology (BOM) radar CLI. Pull up a live radar loop and rain ETA from your terminal or desktop hotkey in a fraction of a second.

Avoids BOM FTP (which regularly hangs) and scrapes BOM HTTPS loop pages with keep-alive pooling, parallel downloads, native-zlib PNG decoding, and cached loop rendering.

![BOM Nowcast CLI screenshot](assets/screenshot.png)

## Highlights

- **Fast hotkey launch**: single scrape, parallel frame/overlay/emoji downloads, cached composite frames and GIFs, and instant repeat runs (< 150 ms warm).
- **Rain nowcast**: multi-frame motion tracking using actual UTC frame timestamps, ETA window, intensity (likely + peak), storm speed/direction, clear-time estimate when already raining, and nearest-rain distance when dry.
- **Readable loops**: map background, place labels, Twemoji location pins, and a longer hold on the latest frame so you immediately see where rain is now.
- **Offline resilience**: falls back to nearby covering radars first, and serves cached frames with a warning if BOM is temporarily unreachable.
- **Zero extra dependencies**: uses Node.js built-ins alongside `commander` and `pngjs`, with `ffmpeg`, ImageMagick (`magick`/`convert`), or a built-in JS GIF encoder as fallback.

## Prerequisites

- Node.js 20+
- `mpv` (optional, recommended for default loop playback)
- `ffmpeg` or ImageMagick (`magick` / `convert`) (optional, faster GIF encoding; falls back to a built-in JS GIF encoder)

## Install

```bash
npm install
npm link
```

Or run directly with `node bom-nowcast.js ...`.

## Quick start

```bash
bom-nowcast setup
bom-nowcast
```

Config lives at `~/.config/bom-nowcast/config.json`. Cache lives under `~/.cache/bom-nowcast/`.

## Instant desktop hotkey setup (optional)

Running `bom-nowcast` with no arguments prints the nowcast and opens the radar loop in `mpv` with `--wayland-app-id=org.tongy.bom-nowcast` (handy for Wayland/Hyprland floating window rules).

To make hotkey launches near-instant even after 5+ minutes away, run `bom-nowcast prefetch` on a 5-minute user timer:

```bash
bom-nowcast prefetch
```

## Commands

### Default run (nowcast + `mpv` loop)

```bash
bom-nowcast
bom-nowcast --fresh        # bypass short scrape/render cache
bom-nowcast --no-player    # print nowcast and build GIF without opening mpv
```

### Nowcast

```bash
# Default location
bom-nowcast nowcast --frames 7 --mode local

# Named location or all locations
bom-nowcast nowcast --location Work
bom-nowcast nowcast --all

# Explicit coordinates or JSON output (for scripts / status bars)
bom-nowcast nowcast --lat -27.874798 --lon 153.296172 --json
```

### Loop GIF

```bash
bom-nowcast loop --radar IDR664 --frames 7 --out /tmp/bom-nowcast-loop.gif
bom-nowcast loop --delay 500 --hold 1500
```

### Fetch and prefetch

```bash
bom-nowcast fetch --radar IDR664 --frames 10
bom-nowcast prefetch
```

### Locations and setup

```bash
bom-nowcast setup
bom-nowcast config-init
bom-nowcast locations
bom-nowcast location-add --name Work --lat -27.4705 --lon 153.0260 --emoji 🏢
bom-nowcast location-add --name Home --lat -27.8748 --lon 153.2962 --set-default
bom-nowcast location-remove --name Work
bom-nowcast radars
```

## Testing

```bash
npm test
```

## References

- BOM loop pages: https://reg.bom.gov.au/products/
- BOM radar transparencies: https://reg.bom.gov.au/products/radar_transparencies/
