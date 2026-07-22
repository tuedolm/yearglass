# Yearglass

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

## Keeping the bank full

The one failure that takes the game down for everyone at once is running out of
puzzles, and it happens silently. `.github/workflows/bank-check.yml` runs daily
and opens a GitHub issue when fewer than 14 days remain.

The refill loop — the filtering is automated, the taste is not:

```sh
python3 tools/harvest.py --years 1975-2015 --per-year 6   # 1. find candidates
# 2. open tools/curate.html → "Load harvest queue" → Use / Reject each
#    then Export images JSON and merge into content/library.json
python3 tools/schedule_next.py                            # 3. deal into days
python3 tools/generate_puzzles.py && python3 tools/fetch_images.py
git add -A && git commit && git push                      # 4. ship
python3 tools/check_bank.py                               # anytime: days left
```

`harvest.py` auto-rejects anything that isn't freely licensed, is under 1200px,
lacks exact-year evidence ("circa" is out), is already in the library, or was
previously rejected. What survives is a review queue — you still decide whether
each photo makes a *good puzzle*. `schedule_next.py` deals images round-robin by
difficulty so every day gets its own easy → hard curve.

Two presets target the material that actually makes good rounds:

```sh
python3 tools/harvest.py --preset outdoor   # street scenes, high streets, parades, seafronts
python3 tools/harvest.py --preset history   # non-US documentary archives (Anefo, Bundesarchiv, Deutsche Fotothek)
```

`outdoor` is deliberately outdoor-only. A street gives a player far more to
reason from — signage, vehicles, shopfronts, clothing — than a living room
does, so indoor categories were removed. `history` targets press and state
photography, which is where documented background stories live, and is
non-US on purpose. `--depth` (default 1) descends into subcategories, because
several of the richest archives hold no files directly.

### Datable, not famous

The harvester also drops **undatable subjects** — wildlife, flora, landscapes,
astronomy, micrographs. A cheetah in 1996 is identical to a cheetah in 2016:
the player can only guess, and the reveal has nothing to teach.

This is a filter on *datability*, not on fame, and the difference matters. The
photos with the biggest stories (Titanic, the Moon landing) are usually the
easiest to date, so a library selected for famous events drifts straight back
to being too easy. An anonymous 1989 kitchen has no story in the news sense and
is superb material: the appliances, worktops and television date it to within a
few years, and the reveal gets to explain exactly that.

### Never guess a year

A wrong year is scored against real players and is the one error the game
cannot survive, so the harvester refuses to guess. A photo's year is only
assigned when two independent sources agree (filename, description, metadata
date); otherwise the candidate arrives with the year **blank** and marked
"you must set it" in the review card. Anything hedged with *circa* or
*approx* is dropped outright, since it can never yield an honest answer.

This exists because a real harvest offered a Sarajevo street scene from the
1930s carrying the year **2022** — its date field was the scanner's timestamp,
and its description said "ca. 1933". Date fields with a clock time are now
treated as digitisation timestamps rather than evidence.

### Also dropped automatically

- **Atrocity and graphic death** — ghettos, camps, executions, Nazi subjects.
  Weighty history is fine (the library holds D-Day and Hindenburg); asking
  someone to guess the year of a massacre is not.
- **Non-photographs** — paintings, engravings, maps and manuscripts, which
  archives hold alongside photographs and which carry no photographic era
  cues. Terms include German, since the best non-US archives are German.
- **No description *and* no confirmable year** — fails both tests at once:
  nothing to build a story from, nothing to date it by.

Two guards keep quality honest:

- `generate_puzzles.py` **requires** a `story` for every image, so nothing
  without something worth saying can ship, undatable or not.
- The undatable filter is tuned conservatively and **logs every drop**, because
  a bad candidate you see gets rejected by you, whereas a good one wrongly
  filtered disappears silently. Terms that double as human-made things
  (`eagle`, `falcon`, `beetle`, `jaguar`, `sunset`) are deliberately excluded —
  each of them binned real material in testing. A photo with clear human
  subjects is never dropped for a stray animal word in its categories.
  Use `--allow-timeless` to bypass the filter entirely.

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
- **`HINT_TIERS`** — progressive hints: era ×0.8, keywords ×0.7, decade ×0.6.
  Tiers must stay ordered weakest→strongest *and* cheapest→dearest, or a tier
  becomes a dominated choice nobody takes. Keywords live in `library.json` and
  must be context clues only — a keyword naming the event would make tier 2
  stronger than tier 3 and break the ladder.
- **`CONFIG.name`** — single point of rename (also update index.html meta,
  manifest.webmanifest, and the OG image).

## Playtest deployment

Live at **https://tuedolm.github.io/yearglass/** (GitHub Pages from `main`).
Deploy updates with `git push` (regenerate puzzles first if content changed).

## Launch checklist

- [x] Self-hosted images (`assets/`, in-repo; move to a CDN if traffic grows)
- [x] Privacy + photo credits page (`about.html`, linked from results)
- [x] Absolute `og:image` URL
- [x] CC attribution rendered on every reveal + credits page
- [x] Hint mechanic (decade reveal, −40% of round score)
- [x] **Name: Yearglass** (renamed from Timeline, which collides with
  Asmodee/Zygomatic's Timeline card game)
- [ ] Bank ≥90 days of puzzles via `tools/curate.html` (8 days banked now;
  puzzle #009+ shows "no puzzle" until scheduled)
- [x] Analytics live: `infra/worker.js` on Cloudflare (D1). Aggregates at
  https://yearglass-analytics.tuedolm.workers.dev/stats
- [ ] Custom domain once named
- [ ] Optional: service worker for offline/instant-load PWA

## Content rules (from the PRD, enforced by the generator)

Exact verified year — never "circa". Clear license with attribution captured.
One-line reveal blurb. ≥1200px wide. Difficulty 1–5, five images per day
ordered easy → hard. Weight the library toward 1970–2015 and hunt for
photos that *feel* like the wrong decade — a representative sample of history
makes a boring game.
