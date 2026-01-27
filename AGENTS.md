# Repository Guidelines

## Project Structure & Module Organization
- `bom-nowcast.js` is the single-file CLI entry point (fetch, loop rendering, and nowcast logic).
- `package.json` holds dependencies and scripts; `node_modules/` is checked in locally for this repo.
- User data is written outside the repo: config at `~/.config/bom-nowcast/config.json` and cached frames at `~/.cache/bom-nowcast/<RADAR_ID>/`.

## Build, Test, and Development Commands
- `npm install` installs runtime dependencies.
- `node bom-nowcast.js config-init` writes the default config file (required once per machine).
- `node bom-nowcast.js fetch --radar IDR663 --frames 10` downloads the latest radar frames into the cache.
- `node bom-nowcast.js loop --radar IDR663 --frames 7 --out /tmp/bom.gif` renders a labeled GIF loop.
- `node bom-nowcast.js nowcast --location Default --frames 7 --mode local` runs the MVP nowcast.
- `npm test` currently exits with a placeholder error (no test runner configured).

## Coding Style & Naming Conventions
- JavaScript is CommonJS (`require`, `module.exports`), with 2-space indentation and semicolons.
- Prefer clear, descriptive function names and constants in `SCREAMING_SNAKE_CASE` for fixed values.
- Keep CLI options consistent with Commander conventions (kebab-case flags, e.g., `--set-default`).

## Testing Guidelines
- No automated tests are configured yet. If you add tests, document the runner and add an npm script.
- Suggested conventions: `test/*.test.js` with explicit cases for parsing, caching, and image compositing.

## Commit & Pull Request Guidelines
- Commits are short, imperative, and action-oriented (e.g., “Add config + locations + cache pruning”).
- PRs should include: a brief summary, key commands run, and example output paths (e.g., generated GIFs).

## Configuration & External Dependencies
- ImageMagick (`magick` or `convert`) is optional but recommended for GIF creation.
- Avoid BOM FTP; the tool scrapes BOM loop pages over HTTPS for stability.
