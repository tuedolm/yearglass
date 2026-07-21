# Timeline

A once-a-day web game: five photographs, drag a slider to guess the year each
was taken, score by how close you were, share a spoiler-free result grid.

Static site, no build step, no backend required. State (streaks, stats,
resume) lives in localStorage.

## Run locally

```sh
python3 -m http.server 8471
# open http://localhost:8471
```

## Architecture

| Path | What it is |
|---|---|
| `index.html` / `styles.css` / `app.js` | The game client |
| `content/library.json` | Canonical curated library: exact year, blurb, credit, difficulty, **audited license** per image |
| `puzzles/YYYY-MM-DD.json` | Pre-generated daily blobs; the client fetches only today's, so future answers never ship |
| `tools/generate_puzzles.py` | library.json → daily blobs, with PRD-criteria validation (`--check` to lint only) |
| `tools/curate.html` | Curation UI: paste a Commons file → fetches license/artist/size via API, gates on free license + resolution, exports JSON |
| `tools/fetch_images.py` | Localizes images into `assets/` for CDN upload (run before launch; hotlinking Commons is prototype-only) |
| `infra/worker.js` | Cloudflare Worker scaffold for anonymous score-distribution analytics (client stub is `track()` in app.js, off by default) |

## Daily cycle

The client keys everything off the UTC date. `generate_puzzles.py` turns the
hand-authored `schedule` in library.json into per-day blobs; puzzle #001 is
2026-07-21. Six days are currently banked (30 images, each used once).
`tools/curate.html` is how the bank grows: target ~90 banked days before a
public launch.

## Tuning knobs (all in `app.js`)

- **`DECAY = 12`** — `points = round(5000 · e^(−|error|/DECAY))`. The single
  most important parameter; retune from real playtest data (median total
  should land in 12,000–18,000).
- **`ANCHORS`** — non-linear slider mapping; 1970–present gets ~58% of travel.
- **`band()`** — share-grid thresholds: 🟩 ≤5 yrs, 🟨 ≤10, 🟧 ≤20, 🟥 ≤40, ⬛ wild.
- **`CONFIG.name`** — single point of rename (also update index.html meta,
  manifest.webmanifest, and the OG image).

## Playtest deployment

Live at **https://tuedolm.github.io/timeline/** (GitHub Pages from `main`).
Deploy updates with `git push` (regenerate puzzles first if content changed).

## Launch checklist

- [x] Self-hosted images (`assets/`, in-repo; move to a CDN if traffic grows)
- [x] Privacy + photo credits page (`about.html`, linked from results)
- [x] Absolute `og:image` URL
- [x] CC attribution rendered on every reveal + credits page
- [x] Hint mechanic (decade reveal, −40% of round score)
- [ ] **Decide the name.** "Timeline" collides with Asmodee/Zygomatic's
  Timeline card game (chronology guessing, actively sold). Cleared
  candidates as of Jul 2026: "Yearglass", "Yearshot". Rename =
  `CONFIG.name` + index meta + manifest + OG image + repo/domain.
- [ ] Bank ≥90 days of puzzles via `tools/curate.html` (8 days banked now;
  puzzle #009+ shows "no puzzle" until scheduled)
- [ ] Deploy `infra/worker.js` (needs a Cloudflare account), set
  `CONFIG.analyticsEndpoint`
- [ ] Custom domain once named
- [ ] Optional: service worker for offline/instant-load PWA

## Content rules (from the PRD, enforced by the generator)

Exact verified year — never "circa". Clear license with attribution captured.
One-line reveal blurb. ≥1200px wide. Difficulty 1–5, five images per day
ordered easy → hard. Weight the library toward 1970–2015 and hunt for
photos that *feel* like the wrong decade — a representative sample of history
makes a boring game.
