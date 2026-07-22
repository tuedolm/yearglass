#!/usr/bin/env python3
"""Harvest candidate photographs from Wikimedia Commons.

This automates the boring 80% of curation — finding freely licensed, well-dated,
high-resolution photographs — and deliberately automates none of the judgement.
It never writes to the library; it produces a review queue that a human accepts
or rejects in tools/curate.html. Taste is the moat; scripts are bad at it.

What gets filtered out automatically (the PRD's inclusion criteria):
  - anything not clearly free (public domain / CC0 / CC BY / CC BY-SA)
  - anything under --min-width pixels
  - anything whose date field doesn't evidence the exact year ("circa" is out)
  - anything already in content/library.json, or already reviewed and rejected
  - non-photographs (maps, documents, logos, diagrams) by filename heuristics

Usage:
    python3 tools/harvest.py --years 1975-2015 --per-year 8
    python3 tools/harvest.py --years 1985,1992,2003 --per-year 20
    python3 tools/harvest.py --category "Photographs by Documerica" --limit 60

Output: tools/candidates.json (merged with any existing queue, deduped).

Be a good citizen: Wikimedia returns HTTP 429 under its robot policy if you
hammer it, so requests are paced and backed off.
"""

import argparse
import json
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LIBRARY = ROOT / "content" / "library.json"
CANDIDATES = ROOT / "tools" / "candidates.json"
REJECTED = ROOT / "tools" / "rejected.json"

API = "https://commons.wikimedia.org/w/api.php"
USER_AGENT = (
    "YearglassHarvester/1.0 (daily photo puzzle; curation candidate search; "
    "contact via repository issues)"
)

FREE_LICENSE = re.compile(r"public domain|^cc0|^cc by(-sa)?[ -]?\d", re.I)
# Filenames that are almost never a usable photograph for this game.
JUNK_NAME = re.compile(
    r"\.(svg|pdf|djvu|ogv|webm|tif|tiff|gif)$|logo|map of|diagram|chart|"
    r"coat of arms|flag of|signature|stamp|banknote|poster|cover|screenshot",
    re.I,
)

# Subjects with no human-made time markers. A cheetah in 1996 is identical to a
# cheetah in 2016: the player cannot reason, only guess, and the reveal has
# nothing to teach. These are unguessable AND unrewarding, so they never reach
# review. Note this is about *datability*, not fame — an anonymous kitchen is
# excellent material because its appliances and decor date it to a few years.
# Tuned deliberately conservative. In a filter that feeds a human review queue,
# a false positive is far worse than a false negative: you will reject a bad
# candidate you can see, but a good one dropped here disappears without ever
# being shown. Terms that double as human-made things are therefore excluded —
# "eagle" and "falcon" are aircraft, "beetle" and "jaguar" are cars, "sunset"
# is a lighting condition, and all of them wrongly binned real material in
# testing. Everything dropped is logged so nothing vanishes unseen.
UNDATABLE = re.compile(
    r"\b("
    r"cheetah|leopard|giraffe|zebra|rhinoceros|hippopotamus|antelope|gazelle|"
    r"wildebeest|meerkat|orangutan|chimpanzee|gorilla|baboon|"
    r"squirrel|hedgehog|otter|badger|"
    r"owl|heron|flamingo|pelican|woodpecker|hummingbird|songbird|waterfowl|"
    r"moth|caterpillar|dragonfly|grasshopper|tarantula|"
    r"lizard|gecko|iguana|tortoise|tadpole|amphibian|"
    r"starfish|jellyfish|coral reef|plankton|mollusc|crustacean|"
    r"wildlife|fauna|flora|botanic|herbarium|"
    r"wildflower|orchid|fungus|mushroom|lichen|bryophyte|"
    r"waterfall|seascape|sand dune|natural landscape|landscape photograph|"
    r"rock formation|geological|mineral specimen|fossil|"
    # "galaxy" alone is excluded: it matches the Samsung Galaxy camera tag that
    # appears on countless modern photographs of historical subjects.
    r"nebula|star cluster|constellation|"
    r"micrograph|microscope|petri dish|electrophoresis|dna fragment"
    r")\b",
    re.I,
)

# Subjects that must never become a light daily puzzle. Asking someone to guess
# the year of a ghetto, a massacre or an execution is grotesque regardless of
# how well the photograph is documented, and archives are full of this material.
# Weighty history is fine — the library already holds D-Day and Hindenburg —
# the line is drawn at atrocity and graphic death.
SENSITIVE = re.compile(
    r"\b("
    r"holocaust|ghetto|concentration camp|extermination|genocide|massacre|"
    r"atrocity|atrocities|execution|executed|hanging|lynching|firing squad|"
    r"corpse|corpses|dead body|mass grave|torture|"
    r"hitler|nazi|ss-|gestapo|wehrmacht|auschwitz|dachau|buchenwald|"
    r"lynch|pogrom|deportation|internment"
    r")\b",
    re.I,
)

# Archives hold reproductions of artworks, maps and manuscripts alongside
# photographs. These have no photographic era cues and are often centuries
# older than their file date. Terms cover German too, since the richest
# non-US archives here are German-language.
NOT_A_PHOTOGRAPH = re.compile(
    r"\b("
    r"painting|portrait painting|engraving|lithograph|etching|woodcut|drawing|"
    r"sketch|illustration|manuscript|charter|deed|map|atlas|"
    r"gemälde|zeichnung|stich|kupferstich|holzschnitt|handschrift|karte|"
    r"ducatuum|tabula"
    r")\b",
    re.I,
)


# People and their things carry era cues — clothing, uniforms, vehicles, decor,
# signage. When any of these are present the photo is datable regardless of an
# animal or nature keyword appearing somewhere in its categories: a photo of
# teenagers at a wildlife refuge is dated by their clothes, not by the refuge.
# This override exists because "Wildlife" alone binned exactly that photo.
HUMAN_CONTEXT = re.compile(
    r"\b("
    r"people|person|men|women|man|woman|child|children|teen|youth|family|crowd|"
    r"portrait|uniform|fashion|clothing|dress|costume|"
    r"street|shop|store|market|mall|restaurant|cafe|bar|office|factory|school|"
    r"classroom|kitchen|living room|interior|bedroom|house|apartment|building|"
    r"car|automobile|bus|train|tram|bicycle|motorcycle|aircraft|airport|"
    r"television|computer|telephone|radio|advertising|signage|billboard|"
    r"protest|parade|concert|wedding|sport|match|game"
    r")\b",
    re.I,
)

# Sources chosen for the two things that make a good round: an outdoor scene
# full of era cues (signage, vehicles, shopfronts, clothing), or documentary
# material with real history behind it. All verified to return files directly.
#
# Indoor categories were deliberately removed: a living room or kitchen gives a
# player far fewer things to reason from than a street does.
PRESETS = {
    "outdoor": [
        "Street photography", "High streets", "Parades",
        "Construction sites", "Seaside resorts", "Car parks",
    ],
    # Non-US documentary archives — press and state photography, well described,
    # which is where the background stories live.
    #
    # Tyne & Wear Archives was tried and removed: its photographs carry Flickr
    # Commons' "No known copyright restrictions", which is a statement that an
    # institution is unaware of restrictions rather than a licence grant. It is
    # widely reused, but it is not the clear provenance this library requires.
    "history": [
        "Anefo", "Images from the German Federal Archive", "Deutsche Fotothek",
    ],
}

# Used to surface where a photo was taken, so the library can be balanced
# beyond the US at a glance during review.
COUNTRY = re.compile(
    r"\b(Afghanistan|Argentina|Australia|Austria|Bangladesh|Belgium|Bolivia|Bosnia|Brazil|"
    r"Bulgaria|Cambodia|Canada|Chile|China|Colombia|Croatia|Cuba|Czech|Denmark|Egypt|"
    r"Estonia|Ethiopia|Finland|France|Germany|Greece|Hungary|Iceland|India|Indonesia|Iran|"
    r"Iraq|Ireland|Israel|Italy|Japan|Kenya|Korea|Latvia|Lebanon|Lithuania|Malaysia|Mexico|"
    r"Mongolia|Morocco|Nepal|Netherlands|New Zealand|Nigeria|Norway|Pakistan|Peru|"
    r"Philippines|Poland|Portugal|Romania|Russia|Serbia|Singapore|Slovakia|Slovenia|"
    r"South Africa|Soviet Union|Spain|Sri Lanka|Sweden|Switzerland|Syria|Taiwan|Thailand|"
    r"Turkey|Ukraine|United Kingdom|United States|Vietnam|Yugoslavia|"
    r"England|Scotland|Wales|Hong Kong)\b",
    re.I,
)


def detect_place(meta: dict) -> str:
    """Best-effort country from categories or description; blank if unclear."""
    blob = " ".join(meta.get("categories", []) + [meta.get("description", "")])
    hit = COUNTRY.search(blob)
    return hit.group(0) if hit else ""

PAUSE = 1.5  # seconds between API calls


def api_get(params: dict, attempts: int = 4) -> dict:
    params = dict(params, format="json", formatversion="2")
    url = API + "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    for attempt in range(attempts):
        try:
            with urllib.request.urlopen(req, timeout=45) as resp:
                return json.loads(resp.read().decode())
        except urllib.error.HTTPError as e:
            if e.code == 429:
                time.sleep(10 * (attempt + 1))
                continue
            raise
        except Exception:
            if attempt == attempts - 1:
                raise
            time.sleep(3)
    return {}


def strip_html(s: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"<[^>]*>", "", s or "")).strip()


def subcategories(category: str, limit: int = 25) -> list:
    """Immediate subcategory names."""
    data = api_get(
        {
            "action": "query",
            "list": "categorymembers",
            "cmtitle": f"Category:{category}",
            "cmtype": "subcat",
            "cmlimit": limit,
        }
    )
    return [
        m["title"].replace("Category:", "")
        for m in data.get("query", {}).get("categorymembers", [])
    ]


def category_files_deep(category: str, limit: int, depth: int) -> list:
    """Files in a category, optionally descending into its subcategories.

    Many of the richest archives are container categories holding only
    subcategories, so a flat sweep silently returns nothing for them.
    """
    titles = category_files(category, limit)
    if depth > 0 and len(titles) < limit:
        for sub in subcategories(category):
            if len(titles) >= limit:
                break
            time.sleep(PAUSE)
            titles.extend(category_files(sub, limit - len(titles)))
    return titles[:limit]


def category_files(category: str, limit: int) -> list:
    """File titles in a category (non-recursive)."""
    out, cont = [], None
    while len(out) < limit:
        params = {
            "action": "query",
            "list": "categorymembers",
            "cmtitle": f"Category:{category}",
            "cmtype": "file",
            "cmlimit": min(500, limit - len(out)),
        }
        if cont:
            params["cmcontinue"] = cont
        data = api_get(params)
        members = data.get("query", {}).get("categorymembers", [])
        if not members:
            break
        out.extend(m["title"] for m in members)
        cont = data.get("continue", {}).get("cmcontinue")
        if not cont:
            break
        time.sleep(PAUSE)
    return out[:limit]


def file_metadata(titles: list) -> list:
    """Batch imageinfo lookup (the API accepts 50 titles per request)."""
    results = []
    for i in range(0, len(titles), 50):
        batch = titles[i : i + 50]
        data = api_get(
            {
                "action": "query",
                "prop": "imageinfo|categories",
                "iiprop": "extmetadata|size|mime",
                "iiextmetadatafilter": "LicenseShortName|Artist|DateTimeOriginal|ImageDescription",
                "cllimit": "500",
                "titles": "|".join(batch),
            }
        )
        for page in data.get("query", {}).get("pages", []):
            if "imageinfo" not in page:
                continue
            ii = page["imageinfo"][0]
            md = ii.get("extmetadata", {})
            cats = [
                c["title"].replace("Category:", "")
                for c in page.get("categories", [])
            ]
            results.append(
                {
                    "commonsFile": page["title"].replace("File:", ""),
                    "license": (md.get("LicenseShortName") or {}).get("value", ""),
                    "artist": strip_html((md.get("Artist") or {}).get("value", "")),
                    "dateOriginal": strip_html(
                        (md.get("DateTimeOriginal") or {}).get("value", "")
                    ),
                    "description": strip_html(
                        (md.get("ImageDescription") or {}).get("value", "")
                    )[:300],
                    "categories": cats[:25],
                    "width": ii.get("width", 0),
                    "height": ii.get("height", 0),
                    "mime": ii.get("mime", ""),
                }
            )
        time.sleep(PAUSE)
    return results


def years_in(text: str) -> set:
    return set(int(y) for y in re.findall(r"\b(1[89]\d{2}|20\d{2})\b", text or ""))


def is_approximate(*texts) -> bool:
    """True when any source hedges the date. An approximate year can never be
    an honest answer, so these are dropped rather than queued."""
    blob = " ".join(t or "" for t in texts).lower()
    return bool(re.search(r"\bcirca\b|\bca\.\s*\d{4}|\bapprox|\bbetween\b|\bunknown\b|\d{4}s\b", blob))


def looks_like_scan_timestamp(date_field: str) -> bool:
    """A full date *with a clock time* is usually the moment a scanner or camera
    wrote the file, not when a historical photograph was taken. This is exactly
    how a 1932 street scene arrived carrying the year 2022."""
    return bool(re.search(r"\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}", date_field or ""))


def confirm_year(meta: dict):
    """Return (year, confidence). Never guesses.

    A year is only assigned when two independent sources agree — typically the
    filename and the metadata date. Anything less returns None so the curator
    types the year themselves during review, because a silently wrong year is
    scored against real players and is the one error the game cannot survive.
    """
    date_field = meta.get("dateOriginal", "")
    name_years = years_in(meta["commonsFile"])
    desc_years = years_in(meta.get("description", ""))
    date_years = years_in(date_field)

    # A scanner timestamp is not evidence about the photograph itself.
    if looks_like_scan_timestamp(date_field):
        date_years = set()

    corroborated = (date_years & name_years) or (date_years & desc_years) or (name_years & desc_years)
    if len(corroborated) == 1:
        return corroborated.pop(), "confirmed"

    # A single clean year in a date field with no time is normal archive
    # practice ("1985") and is trustworthy on its own.
    if len(date_years) == 1 and not name_years and not desc_years:
        return date_years.pop(), "confirmed"

    return None, "unconfirmed"


def exact_year(date_field: str, want: int) -> bool:
    """Reject anything that doesn't evidence the exact year.

    'circa', 'or', ranges and decade forms are all disqualifying — an ambiguous
    answer makes the scoring dishonest, which is the one thing we can't ship.
    """
    if not date_field:
        return False
    low = date_field.lower()
    if any(w in low for w in ("circa", " ca.", "c.19", "c.20", "between", "or ", "unknown", "s]]", "190s", "0s")):
        return False
    years = set(re.findall(r"\b(1[89]\d{2}|20\d{2})\b", date_field))
    return years == {str(want)}


def derive_year(date_field: str):
    """Infer an unambiguous exact year, or None. Used for category sweeps."""
    if not date_field:
        return None
    low = date_field.lower()
    if any(w in low for w in ("circa", " ca.", "between", "unknown", "or ")):
        return None
    years = set(re.findall(r"\b(1[89]\d{2}|20\d{2})\b", date_field))
    return int(years.pop()) if len(years) == 1 else None


def timeless_match(meta: dict):
    """Return the matched term when nothing in frame could reveal the year.

    A cheetah is a cheetah in any decade: pure coin-flip to guess, and nothing
    to say in the reveal. Returns the matched word so the drop can be logged
    and audited rather than happening silently.
    """
    haystack = " ".join(
        [meta["commonsFile"], meta.get("description", "")] + meta.get("categories", [])
    )
    hit = UNDATABLE.search(haystack)
    if not hit:
        return None
    # Human subjects date a photo on their own; don't bin it for a stray
    # animal or nature word elsewhere in its metadata.
    if HUMAN_CONTEXT.search(haystack):
        return None
    return hit.group(0)


def load_json(path: Path, default):
    try:
        return json.loads(path.read_text())
    except Exception:
        return default


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--years", help="e.g. 1975-2015 or 1985,1992,2003")
    ap.add_argument("--category", help="a specific Commons category to sweep")
    ap.add_argument("--preset", choices=sorted(PRESETS),
                    help="sweep a curated set of everyday-life categories")
    ap.add_argument("--per-year", type=int, default=6, help="candidates to keep per category")
    ap.add_argument("--limit", type=int, default=120, help="files to inspect per category")
    ap.add_argument("--min-width", type=int, default=1200)
    ap.add_argument("--allow-timeless", action="store_true",
                    help="keep subjects with no era cues (wildlife, landscapes)")
    ap.add_argument("--depth", type=int, default=1,
                    help="subcategory levels to descend (0 = flat)")
    ap.add_argument("--from-year", type=int, default=1930,
                    help="ignore category-sweep photos before this year")
    ap.add_argument("--to-year", type=int, default=2015,
                    help="ignore category-sweep photos after this year")
    args = ap.parse_args()

    if not args.years and not args.category and not args.preset:
        ap.error("give --years, --category or --preset")

    lib = load_json(LIBRARY, {"images": []})
    known = {i["commonsFile"] for i in lib.get("images", [])}
    queue = load_json(CANDIDATES, [])
    known |= {c["commonsFile"] for c in queue}
    known |= set(load_json(REJECTED, []))

    targets = []
    if args.category:
        targets.append((None, args.category))
    if args.preset:
        targets.extend((None, c) for c in PRESETS[args.preset])
    if args.years:
        years = []
        for part in args.years.split(","):
            if "-" in part:
                a, b = part.split("-")
                years.extend(range(int(a), int(b) + 1))
            else:
                years.append(int(part))
        targets.extend((y, f"{y} photographs") for y in years)

    found_total = 0
    for year, category in targets:
        try:
            titles = category_files_deep(category, args.limit, args.depth)
        except Exception as e:  # noqa: BLE001 — report and continue to next year
            print(f"  {category}: lookup failed ({e})")
            continue
        if not titles:
            print(f"  {category}: no files")
            continue

        titles = [t for t in titles if not JUNK_NAME.search(t)]
        meta = file_metadata(titles)

        kept = []
        dropped = []
        for m in meta:
            if m["commonsFile"] in known:
                continue
            if not m["mime"].startswith("image/"):
                continue
            if not FREE_LICENSE.search(m["license"]):
                continue
            if m["width"] < args.min_width:
                continue
            blob = " ".join(
                [m["commonsFile"], m.get("description", "")] + m.get("categories", [])
            )
            hit = SENSITIVE.search(blob)
            if hit:
                dropped.append(f"{m['commonsFile']}  [sensitive: {hit.group(0)}]")
                continue
            hit = NOT_A_PHOTOGRAPH.search(blob)
            if hit:
                dropped.append(f"{m['commonsFile']}  [not a photograph: {hit.group(0)}]")
                continue

            # An approximate date can never yield an honest answer.
            if is_approximate(m["dateOriginal"], m.get("description", "")):
                dropped.append(f"{m['commonsFile']}  [approximate date]")
                continue

            if year is not None:
                if not exact_year(m["dateOriginal"], year):
                    continue
                m["year"] = year
                m["yearConfidence"] = "confirmed"
            else:
                # Category sweeps aren't year-scoped. Only accept a year that
                # two sources agree on; otherwise leave it blank for the
                # curator rather than shipping a guess.
                confirmed, confidence = confirm_year(m)
                m["year"] = confirmed
                m["yearConfidence"] = confidence
                if confirmed is not None and not (args.from_year <= confirmed <= args.to_year):
                    continue
                # No description and no confirmable year fails both tests at
                # once: nothing to write a story from, and nothing to date it
                # by. Not worth a slot in the review queue.
                if confirmed is None and not m.get("description", "").strip():
                    dropped.append(f"{m['commonsFile']}  [no story, no date]")
                    continue
            hit = None if args.allow_timeless else timeless_match(m)
            if hit:
                dropped.append(f"{m['commonsFile']}  [{hit}]")
                continue
            m["place"] = detect_place(m)
            m["thumb"] = (
                "https://commons.wikimedia.org/wiki/Special:FilePath/"
                + urllib.parse.quote(m["commonsFile"])
                + "?width=800"
            )
            m["full"] = (
                "https://commons.wikimedia.org/wiki/Special:FilePath/"
                + urllib.parse.quote(m["commonsFile"])
                + "?width=1600"
            )
            m["commonsPage"] = (
                "https://commons.wikimedia.org/wiki/File:"
                + urllib.parse.quote(m["commonsFile"])
            )
            kept.append(m)
            known.add(m["commonsFile"])
            if len(kept) >= args.per_year:
                break

        found_total += len(kept)
        queue.extend(kept)
        note = f", {len(dropped)} undatable" if dropped else ""
        print(f"  {category}: inspected {len(meta)}, kept {len(kept)}{note}")
        # Print every drop: a wrongly filtered photo is otherwise invisible.
        for d in dropped:
            print(f"      dropped: {d}")

    CANDIDATES.write_text(json.dumps(queue, indent=2, ensure_ascii=False) + "\n")
    print(f"\n{found_total} new candidate(s); queue now {len(queue)}")
    print(f"Review them in tools/curate.html → {CANDIDATES.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
