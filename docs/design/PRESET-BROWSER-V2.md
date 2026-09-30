# Preset Browser v2: master AVS folder, folder setups, search, sorting, Play folder

Status: design only, 2026-09-28. Nothing in this document is implemented. Every claim
is tagged **EXISTS** (verified by reading code or data in this checkout), **MEASURED**
(a throwaway CPU-only node script over the maintainer's local collection; not
committed, numbers are for orientation) or **PROPOSED**. No GPU, browser, player,
server or network was used. Nothing here claims visual, focus, DPI, native-build or
live acceptance.

Companion designs: [PRESET-TAXONOMY-AND-JEV](PRESET-TAXONOMY-AND-JEV.md) supplies the
optional style/energy/author facets this browser mounts (its section 6.3 is the
contract; section 4 below states what this document needs from it);
[TRANSITIONS-V2](TRANSITIONS-V2.md) owns the settings schema growth that folder
playback bundles reuse; [HUD-RESEARCH-GAPS](HUD-RESEARCH-GAPS.md) precedes the HUD
preset packs that will appear under "HUD packs". Existing behaviour is documented in
[PRESET-MANAGEMENT](../PRESET-MANAGEMENT.md) and
[AAAVS shared development](../AAAVS-SHARED-DEVELOPMENT.md).

## 1. Verdicts in one page

| Question | Verdict |
| --- | --- |
| Is the folder data already in the page? | **Partly.** `presets.json` already carries `occurrences[]` (package id + original path) for every AVS preset, but `parseLocalAvsCatalog` throws it away. `sources.json` (artist/repository/release per package) is never fetched. A parser extension plus one lazy, optional 311 KB fetch is enough; no catalog rebuild and no native change. |
| How is the master folder organised? | `AVS` with a **By source** branch (source group, artist, package, original sub-folders; 295 nodes, 242 after single-child chain collapse, deepest 8, widest 40 in the local collection) plus the taxonomy design's optional facet branches. `NERV` and `HUD packs` are sibling roots; smart folders and user folders follow. Presets stay deduplicated by `sha256`; a preset in several packages is listed in each and counted once above. |
| Where do user folders and folder setups persist? | **Recommended: a new private `folders.json`** through one generic pair of library ops (`load-state`/`save-state`), not new fields on `setups.json`. About 14 lines of C++ (in `AAAVSLibrary.h`), one `case` pair in `standalone-library.mjs`, an old page/host degrades to session-only. Rationale and the rejected alternative are in section 5.2. |
| Is search/sort a performance problem for 4,000+ rows? | **No; the DOM is the problem.** MEASURED: a linear scan of 12,000 records with three terms takes 1.5 ms; an integer-rank sort 1.2 ms. The current UI rebuilds the whole panel on every keystroke and pages 60 rows. Fix: struct-of-arrays records, precomputed name/path/package ranks, and a windowed (virtualised) list of about 30 DOM rows. |
| What does Play folder do? | Builds an ordered pool from the folder (recursive by default), replaces the active setup with a **transient, uncapped, in-memory folder setup** through the existing `setupOrder`/`selectionPool` machinery, and optionally applies the folder's saved playback bundle. Not subject to the 500-preset `parseSetups` cap. **Hidden cost found:** `sceneAt` is O(n) and runs about five times per frame; MEASURED 0.4 ms per call at 3,400 shuffled presets (about 2 ms/frame), so a pool cache is required for large folders with the song clock on. |
| New native surface? | One command `ID_AAAVS_PLAY_FOLDER` (Ctrl+F8, View menu item, "play last folder / open browser") wired exactly like F8; one message pair for state. Phase 1 (browser, search, sort, session-only Play folder) needs **no** native change. |

## 2. What exists today (verified) and the landmines it creates

### 2.1 Catalog and what the page receives

- **EXISTS.** `fetchLocalAvsCatalog()` (`visualizer/src/avs/local-collection.ts`) reads
  `avs presets/catalog/presets.json` (about 2.3 MB) and `parser-validation.json`
  (about 1.0 MB) with `boundedJson` (32 MiB cap, 50,000 entries). `parseLocalAvsCatalog`
  keeps only `id, name, fileName, sha256, bytes, url, kind, scene, parserStatus,
  autoEligible, rating, notWorking, unavailableReason`.
- **EXISTS, discarded today.** Each `presets.json` entry also has `version` and
  `occurrences[]` of `{package_id, path, original_path}` (about 1.1 MB of the file).
  `original_path` is the path inside the source archive, for example
  `<archive-root>/<sub-folder>/<file>.avs`. `path` is a private staging path and must
  never be kept or displayed.
- **EXISTS, never fetched.** `catalog/sources.json` (311 KB, 939 packages): `id`,
  `catalog` (`visbot-legacy` | `visbot-current` | `github` | ...), `file_name`,
  `artist_slug` (569 packages), `repository`+`branch` (the 6 GitHub sources),
  `release_id` (351 current releases). `packages.json` (1 MB) adds nothing this design
  needs.
- **MEASURED** on the local collection (3,409 unique presets): 3,051 have one
  occurrence, 305 two, 16 three, 37 four; 348 occur in more than one package;
  original paths are 1 to 6 segments deep (154 files sit at an archive root, 53 sit
  under `_nested/<12 hex>/`); source groups are 3,010 Visbot archive, 395 GitHub, 124
  local picks, 14 Visbot current releases (overlapping); 125 packages contribute
  presets; no folder holds more than 115 presets directly; 58 display names repeat;
  `bytes` runs 25 B to 364 KB; no preset is rated yet.
- **EXISTS.** `fileName` is the basename of `canonical_path`
  (`<16 hex>---<name>.avs`), not display-worthy. **There is no modification time, play
  count or last-played anywhere the page can read.** The native and standalone rate
  operations change the file's mtime, but the catalog entry does not record it.
- **EXISTS.** Public release and stock installs: the shipped catalog holds exactly the
  16 NERV entries (`kind: 'nerv'`, `canonical_path: presets/unique/NERV NN - Title.nerv`,
  `display_name: "NERV / NN - Title"`) with no `occurrences` and no `sources.json`
  (`tools/package-release.py`). Both origins and sources must therefore be optional.
- **EXISTS.** Kinds: `parseLocalAvsCatalog` maps any `kind` other than `'nerv'` to
  `'avs'` and throws for a malformed NERV entry. A future HUD kind would be silently
  treated as AVS (landmine L1, owned by the HUD preset-pack stream).
- **EXISTS.** No HUD scene preset is installed anywhere yet. The 488 local HUD kits
  (`visualizer/assets/hud-kits/<kit-id>/`, private) encode the platform as the last
  id token (counts: `neogeo` 153, `arcade` 89, `hud` 51, `saturn` 25, `pc` 24,
  `genesis` 22, `nes` 21, `ps1` 7, then many singletons).

### 2.2 Host selection machinery (`visualizer/src/mpc-host.ts`)

- `catalog` is loaded once; rating/not-working updates replace elements with
  `catalog.map(...)`, so **catalog indices are stable for a session** and unchanged
  elements keep object identity.
- `setupOrder: number[] | null` plus `selectionPool()` =
  `eligiblePresets(catalog, setupOrder ?? wholeOrder, presets.shuffle, minimumRating, failed)`
  (drops `!autoEligible`, `notWorking`, session `failed`; minimum rating only while
  shuffling). `candidate()`/`stepSetup` choose the next preset; the scene clock
  (`clockPhase()` -> `sceneAt`) only runs when `setupOrder` is set.
- `activateSetup(setup)` calls `setupIndices` (throws on a missing hash), throws if any
  member is `!autoEligible`, applies `settings` to the director/transition/rating
  state, sends `configure`, and `prepare()`s the first eligible preset. `parseSetups`
  is the only place the 100-setup and 500-preset caps live.
- The overlay line is `updateLabel()`: `index+1 / catalog.length · name ★★★`. It has no
  concept of an active source.
- `management.refresh()` is called from `eligibilityChanged()` (every rating, mark,
  shuffle or minimum-rating change) and from `commit()` (every preset change).

### 2.3 Persistence and native surface

- **EXISTS.** Native `State::Library` (`src/mpc-hc/AAAVSView.cpp`) dispatches a fixed op
  list; anything else throws `Unknown library request`, delivered as
  `{type:'library-error', operation, message}`. `load-setups` returns
  `setups.json` **verbatim**; `save-setups` writes the page's array verbatim (only the
  `<= 100` array check). Requests are capped at 4 MB, files at 16 MB.
  Root is `visualizer/avs presets` beside the executable.
- **EXISTS.** `tools/standalone-library.mjs` keeps private state under
  `avs presets/.aaavs-private/` (never served) and **rebuilds** each setup from its
  known keys, so an extra field on a setup would be silently dropped by the standalone
  server and by `parseSetups`; only native C++ round-trips unknown fields.
  `check-standalone-library.mjs` asserts acceptance parity between the TypeScript
  `parseSetups` and this server copy.
- **EXISTS.** Native command wiring: IDs `ID_AAAVS_*` 31000-31009 in
  `src/mpc-hc/resource.h`; `ON_COMMAND_RANGE(ID_AAAVS_PREVIOUS, ID_AAAVS_NOT_WORKING, ...)`
  and the matching `ON_UPDATE_COMMAND_UI_RANGE` in `MainFrm.cpp`; a default accelerator
  row per command in `AppSettings.cpp` (`Ctrl+F6` manager, `Ctrl+F7` setups, `F6`/`F7`
  rating, `F8` not working; **`Ctrl+F8` and `F9` are unused**); a menu item and a
  string-table row in `mpc-hc.rc` (**UTF-16 encoded**: a byte-level or non-encoding-aware
  edit corrupts it, landmine L7). The page owns key handling when the WebView has
  focus: `mpc-host.ts` posts `show-manager`/`rate-up`/`mark-not-working` strings, native
  turns them into `WM_COMMAND`, and `AAAVSView::Command` posts a JSON message back
  (`{"type":"rate","delta":1}`). The standalone bridge (`standalone-player.ts`
  `StandaloneBridge.postMessage`) emulates the same loop.
- **EXISTS.** Native `configure` only reads the fixed settings keys and clamps them
  (landmine L6: any new `SetupSettings` field from the timing design is invisible to
  the native "last used" settings unless C++ learns it; folder bundles are unaffected
  because they are stored verbatim).

### 2.4 Management UI (`visualizer/src/mpc-management.ts`)

- One class, `PresetManagement`, with `draw()` that calls `root.replaceChildren()` and
  rebuilds everything, including the search input (re-focused after each keystroke, so
  the caret is not preserved), and recomputes
  `catalog.map(...).filter(...).sort(localeCompare)` on every draw. Paging is 60 rows.
  The Setup Builder is the same class in mode 2 (`builder()`, `timingControls()`).
- `Actions` (top of the file) is the only host contract; `check-mpc-management.mjs`
  drives it with a minimal fake DOM (`append`, `prepend`, `replaceChildren`,
  `setAttribute`, `focus`, `all()`, a `querySelector` that only understands
  `'button'` and `'input[type=search]'`) and asserts exact button texts
  (`New setup`, `Add to setup`, `Save setup`, `Activate setup`, `Use entire library`,
  `Load preset`, `5 ★`, `Mark not working`, `Clear not-working mark`), aria-labels
  (`Shuffle minimum rating`, `List minimum star rating`, `Preset status`,
  `Setup shuffle minimum rating`), row text (`Preset 1 · not working`) and the empty
  text `No presets match.`. **Those are compatibility constraints for v2.**
- CSS is duplicated in `mpc.html` (CSP `style-src 'unsafe-inline'`, **no `'self'`**, so
  an external stylesheet is blocked, landmine L5) and `standalone.html`
  (`style-src 'self' 'unsafe-inline'`). `#management` is `position:absolute; inset:0`
  over the visualizer; the layout drops to one column at `max-width:480px`
  (`mpc.html`) or 600 px (`standalone.html`).
- The host's `keydown` closes the manager on Escape regardless of focus, and returns
  early (so Space etc. stay text-safe) while a panel is open.

### 2.5 Landmines this design must respect

| Id | Landmine | Consequence |
| --- | --- | --- |
| L1 | Unknown `kind` parses as `'avs'` | A HUD kind must be added to the parser before HUD entries are installed; the folder module reads `kind` as a string and never assumes two values. |
| L2 | `activateSetup` throws for any `!autoEligible` member and for missing hashes | Folder play needs its own activation path that filters instead of throwing. |
| L3 | `sceneAt` validates with `new Set(order)`, `order.some`, reshuffles the pool on every call. MEASURED per call: 16 presets 0.012 ms, 500 shuffled 0.05, 3,400 shuffled 0.375 (ordered 0.155), 6,000 shuffled 0.65 (ordered 0.45). `clockPhase()` is invoked about five times per frame (`frame`, `syncSceneClock` twice, `render`, `commit`) | Large folder plus the song clock costs about 2 ms of the 16 ms frame at 3,400 and 3+ ms at 6,000. A pool/phase memo is mandatory (section 8.4). |
| L4 | `management.refresh()` runs on every commit | A 4,000-row rebuild per preset change is unacceptable; refresh must be incremental. |
| L5 | `mpc.html` CSP blocks external CSS | The view injects a `<style>` element from a TypeScript string; no HTML edit needed. |
| L6 | Native `configure` drops unknown settings | Do not rely on it to persist folder options; do not change it in this work. |
| L7 | `mpc-hc.rc` is UTF-16 | Native edits must use an encoding-aware method. |
| L8 | `syncSceneClock` only pre-renders the next scene for NERV to NERV; for AVS the boundary switch pays the fetch+worker cost | Folder play of AVS folders defaults the song clock **off**; NERV and HUD folders may default it on. Generalising lookahead is the timing design's decision. |
| L9 | Old builds reject unknown/new values whole (forward-only, as TRANSITIONS-V2 section 7) | Folder playback entries that fail validation are kept opaque and re-emitted unchanged (section 5.4). |

## 3. Data model additions (PROPOSED)

### 3.1 `LocalAvsPreset` (in `visualizer/src/avs/local-collection.ts`)

Two optional, frozen additions; nothing else about the parser's strictness changes.

```ts
export interface PresetOrigin { readonly pkg: string; readonly path: string }   // path = original_path, never the staging path
export interface LocalAvsPreset { /* existing */ 
  readonly origins?: readonly PresetOrigin[];   // 0..32 items, pkg <= 200 chars, path <= 1024 chars
  readonly folder?: string;                     // optional catalog hint, see 3.3
}
export interface SourceInfo { readonly catalog?: string; readonly fileName?: string; readonly artist?: string; readonly repository?: string; readonly release?: string }
export type SourceMap = ReadonlyMap<string, SourceInfo>;
export async function fetchLocalAvsSources(): Promise<SourceMap>;            // lazy, optional, never throws (returns an empty map)
export function parseLocalAvsSources(json: unknown): SourceMap;              // pure, <= 5000 entries, ids <= 200 chars
```

Rules: malformed or oversize `occurrences` are **dropped, never thrown**: folder data
must not be able to make the catalog unloadable (the entry then lands in "Unsorted").
Memory cost is about 1.1 MB of strings. `origins[].path` is kept verbatim;
normalisation (dropping `_nested/<hex>`) happens in the tree builder.
`fetchLocalAvsSources` is called the first time the browser opens (not at startup), with
a 2 s soft timeout; a missing file (public and stock builds) yields an empty map and the
tree simply has no artist level.

### 3.2 Facet data from the taxonomy design (consumed, optional)

`PRESET-TAXONOMY-AND-JEV.md` section 6 defines `catalog/categories.json` and
`src/avs/preset-categories.ts`. This browser needs exactly:

```ts
export interface PresetTaxon { readonly c: string; readonly t: readonly string[]; readonly e: 'calm'|'steady'|'driving'|'intense'; readonly b: 1|2|3|4|5; readonly f: 'full'|'partial'; readonly a?: string }
export type TaxonMap = ReadonlyMap<string, PresetTaxon>;     // key = sha256
// plus the exported TAXONOMY table: id, label, family
```

The host loads it after the catalog and passes it to the manager as
`Actions.taxa?(): TaxonMap | null`. Absent map: the facet branches are not created.
This document never depends on how the map was produced (structure rules or Jev).

### 3.3 Folder hint for installed non-AVS packs (PROPOSED contract)

Catalog entries may carry `folder`: a `/`-separated **sub-path inside the entry's kind
root**, at most 6 segments of at most 80 characters, no control characters or empty
segments, validated at parse; an invalid hint is ignored. Examples:

| Entry | Root | `folder` | Result |
| --- | --- | --- | --- |
| NERV scene (today, no hint) | `NERV` | absent | flat under `NERV` |
| HUD scene | `HUD packs` | `Neo Geo/<game or kit title>` | `HUD packs / Neo Geo / <kit>` |
| Curated AVS pack | `AVS` | `Collections/<name>` | under `AVS / By source / Collections` |

The HUD preset-pack installer (owner: the HUD stream) writes `kind` (`'hud'`, added to
the parser union there) and `folder`. If `folder` is missing for a HUD entry, the
fallback derives the platform from the kit id's last token with a small table
(`arcade` Arcade, `neogeo` Neo Geo, `nes` NES, `genesis` Genesis, `saturn` Saturn,
`ps1` PlayStation, `pc` PC; everything else "Other") and the kit id as the leaf. An
explicit `folder` always wins over `occurrences`. NERV presets get a display shortcut:
when a row is shown inside a folder whose label equals the name's `"<label> / "`
prefix, the prefix is hidden in the list (full name remains in the detail pane).

## 4. The virtual folder tree (PROPOSED)

### 4.1 Top level

```
AVS                                 unique AVS presets (kind 'avs'); hidden if empty
  By source                         provenance tree (4.2)
  By style                          family > category      (taxonomy design; needs TaxonMap)
  By energy                         calm | steady | driving | intense
  By busyness                       1 .. 5
  By author                         heuristic author prefix (bucketed A-Z when > 60)
  By rating                         5 stars .. 1 star, Unrated (dynamic)
NERV                                the 16 scenes (kind 'nerv'); hidden if empty
HUD packs                           platform > game/kit     (kind 'hud'); hidden if empty
-- Smart folders --                 dynamic queries over every kind (4.4)
-- My folders --                    user folders (section 5)
```

A facet branch is built only when its data exists; **AVS never depends on the
taxonomy** (public and stock builds without `categories.json` show only By source, or
"Unsorted" for entries without origins). The `AVS` root count is the number of unique
AVS presets, computed from the catalog, not by summing facets.

### 4.2 By source (from `occurrences` + `sources.json`)

```
AVS / By source / <source group> / <artist or repository> / <package> / <original sub-folders...>
```

| Level | Label rule |
| --- | --- |
| Source group | `catalog` from `SourceMap`, else the package id prefix: `visbot-legacy` "Visbot archive", `visbot-current` "Visbot releases", `github` "GitHub", `local-existing` "Local picks", `author-pack` "Author packs", `internet-archive` "Internet Archive", anything else "Other sources". |
| Artist | `artist_slug`, else `repository` (GitHub), else `release_id`; **omitted when unknown** (no sources file, or local picks). |
| Package | If every occurrence in that package has depth >= 2 after normalisation and they share one first directory, that directory **is** the package node (label = its name) and is removed from the sub-path; otherwise the archive file stem (`file_name` without extension and a trailing `unofficial`), else the package id without its group prefix and 10-hex suffix. Sibling label collisions append ` . <last 4 of id>`. |
| Sub-folders | `original_path` segments after normalisation: a leading `_nested/<12 hex>/` is dropped; the file name is the leaf. |

Prototype over the local collection (**MEASURED**): 295 nodes, 242 rows after chain
collapse, maximum depth 8, maximum 40 children (Visbot archive artists), 115 presets in
the largest directory. `Visbot archive` 3,010 presets, GitHub 395, Local picks 124,
Visbot releases 14 (source groups overlap, the AVS root is 3,409).

**Several packages.** A preset is a direct member of the folder of *every* occurrence
(348 local presets appear in two or more places). Counts above a node use the
recursive unique union, so nothing is counted twice; "All AVS" lists it once. The
**primary location** used for the Path column, path sort and "Location" detail row is
the occurrence with the lowest tuple `(group rank: visbot-legacy, visbot-current,
github, local-existing, other; has `_nested`; depth; occurrence order)`. The detail
pane lists "Also in N other folders" and each is a link that selects that folder.
Entries with no `origins` (public NERV, curated additions) go to `By source / Unsorted`
or, with a `folder` hint, to the hinted path.

**Display collapse (view only).** A node with exactly one child and no direct presets
is rendered merged with that child (`tuggummi > allatuggummi`). The row's key is the
bottom node's key, and selection, expansion and saved options attach to that key
(membership is identical, so nothing is lost). **Buckets:** when a node has more than
60 children and they fall into at least 3 distinct first-letter groups, letter buckets
`0-9 A B ... Z` are inserted (keys `<parent>/#A`). Buckets apply to By author, HUD
platforms (Neo Geo has 153 kits) and any future wide node.

### 4.3 Stable keys

Folder keys are persisted (playback options, last folder, expansion). They derive from
data, never from counts or collapse decisions:

```
avs                          avs/src/c:visbot-legacy/a:tuggummi/p:<package id>/<raw dir>/...
avs/style/<family slug>/<category id>      avs/energy/calm      avs/busy/3      avs/author/#A/<slug>
avs/rating/5 ... avs/rating/0
nerv                          nerv/<hint segment>...                hud/<platform slug>/<kit or hint segment>...
smart:favorites  smart:rated  smart:unrated  smart:broken  smart:unavailable  smart:recent  smart:most-played
user:<uuid>
```

Raw directory names may contain any character but `/`; keys are limited to 400
characters and never used in URLs. Keys change only if the source data changes.

### 4.4 Smart folders (dynamic, no stored membership)

| Key | Definition | Note |
| --- | --- | --- |
| `smart:favorites` | rating >= 4 (`FAVORITE_MINIMUM = 4`) | ratings are the only favourite signal the app has; no new flag |
| `smart:rated` / `smart:unrated` | rating >= 1 / rating 0 | |
| `smart:broken` | marked not working | the existing status filter, promoted to a folder |
| `smart:unavailable` | `parserStatus === 'parse-error'` or failed to load/render this session | needs `Actions.failedIndices` |
| `smart:recent` | played in the last 30 days, newest first | Phase 3 (needs stats, 5.6) |
| `smart:most-played` | play count >= 1, highest first | Phase 3 |

They span every kind. Playing a smart folder snapshots its membership at that moment.

## 5. User folders, folder setups and persistence (PROPOSED)

### 5.1 What is being stored

1. **User folders.** `manual` (an ordered list of preset hashes, up to 5,000) or `smart`
   (a saved query plus optional scope). They appear under "My folders" and may nest up
   to 4 levels. This is what setups cannot be: a setup is capped at 500 presets and is
   a flat playlist.
2. **Folder setups.** An optional playback bundle attached to **any** folder key
   (virtual or user): include subfolders, sort order, `settings` (the exact
   `SetupSettings`: shuffle, minimum rating, transition, transition timing, phrase
   length, fades) and `timing` (the repeatable scene clock). Reuse, not a new schema:
   the bundle is validated by the same function that validates a setup's settings, so
   every timing/transition field the timing design adds is accepted automatically.
3. **Small UI state.** Expanded nodes, selected folder, list sort and scope, so the
   browser reopens where it was. Not `localStorage`: the standalone origin includes the
   loopback port, which is not stable, and native profile clearing must not lose it.

### 5.2 Options compared

| Criterion | A. Extend `setups.json` entries with an optional `folder` field | B. New `folders.json` (**recommended**) |
| --- | --- | --- |
| Unknown-field handling | Native C++ round-trips it; **`parseSetups` and `standalone-library.mjs` rebuild the object from known keys and drop it**. Both must change, and any older build silently strips the data on its next save. | Independent file; an older build never touches it. |
| Size caps | `<= 500` presets per setup and 100 setups: cannot hold a 5,000-member folder or one bundle per virtual folder. | Own caps (5.3). |
| Shape fit | A setup is an ordered hash list; a folder is a rule (path key, query) plus optional members. Bundles for virtual folders have no preset list at all (they would be empty setups, which `parseSetups` allows only with a name and `presets: []`, and Setup Builder refuses to save). | Natural. |
| Write amplification | Saving a folder option rewrites every setup and vice versa. | Separate atomic files. |
| Native C++ | none | About 14 lines, in `AAAVSLibrary.h` so `tools/check-aaavs-library.cpp` can test it. |
| Standalone server | small `setups()` change + parity cases | one `case` pair + a shallow validator |
| Old page with new native / new page with old native | n/a | New page on old native: `load-state` returns `Unknown library request`; the page reports "Folder persistence unavailable (session only)" and keeps working. |
| Downgrade | Data loss (fields stripped) | Old builds ignore the file |

Recommendation: **B**. The taxonomy design's statement that user-made folders "remain
setups" is compatible: setups are unchanged and stay the flat, portable playlist. Two
bridges are provided: **Save folder as setup** (first 500 eligible members, states how
many were omitted) and **Folder from setup** (unbounded manual folder). Owner question
Q2 lets the owner veto B.

### 5.3 Wire and file contract: `load-state` / `save-state`

One generic pair with a fixed name whitelist instead of two ops per file:

```jsonc
// page -> host (via the existing "library:" bridge string)
{"op":"load-state","name":"folders"}                 // name in {"folders","stats"}
{"op":"save-state","name":"folders","data":{...}}
// host -> page
{"type":"state-loaded","name":"folders","data":{...}|null}   // null: file does not exist yet
{"type":"state-saved","name":"folders"}
// failure: the existing {"type":"library-error","operation":"load-state"|"save-state","message":"..."}
```

Files: native `visualizer/avs presets/<name>.json` next to `setups.json`; standalone
`avs presets/.aaavs-private/<name>.json` (already denied to static serving; add
`folders|stats` to the legacy `/avs presets/(setups|settings).json` deny regex).
Writes are atomic (existing `AtomicWrite` / `atomicJson`). **Limit: 3.5 MiB
(3,670,016 bytes) per state file**, below the 4 MB request cap that both hosts enforce,
checked by the page before sending and by both hosts on receipt.

`folders.json` schema (version 1):

```jsonc
{
  "version": 1,
  "rev": 12,                                   // integer, incremented by the page on every save (diagnostic only)
  "folders": [                                 // user folders, at most 200
    { "id": "3f0c...", "name": "Late night", "parent": null,   // parent: another folder id or null; depth <= 4; no cycles
      "kind": "manual", "presets": ["<sha256>", "..."],       // manual only: unique 64-hex, at most 5000
      "sort": [{"key":"manual","dir":"asc"}], "created": 1790000000000 },
    { "id": "9a71...", "name": "Fast + rated", "parent": null,
      "kind": "smart", "query": "rating:>=3 -is:broken energy:driving", "scope": "avs",   // query <= 400 chars; scope: folder key or null
      "sort": [{"key":"rating","dir":"desc"},{"key":"name","dir":"asc"}], "created": 1790000000001 }
  ],
  "playback": {                                // folder setups, keyed by folder key, at most 300
    "avs/src/c:visbot-legacy/a:tuggummi": {
      "recursive": true,
      "sort": [{"key":"path","dir":"asc"},{"key":"name","dir":"asc"}],
      "skipPartial": false,                    // taxonomy fidelity 'partial' presets skipped when a TaxonMap exists
      "settings": { "enabled": true, "bars": 8, "shuffle": true, "minimumRating": 0, "transition": 0, "beats": 2,
                    "durationMs": 1000, "keepOld": true, "manualFade": true, "autoFade": true },
      "timing": { "enabled": false, "bpm": 120, "offsetSeconds": 0, "barsPerScene": 8, "seed": 1 }
    }
  },
  "last":  { "key": "avs/src/c:visbot-legacy/a:tuggummi", "recursive": true },   // for Ctrl+F8; null if none
  "ui":    { "expanded": ["avs","avs/src"], "selected": "avs", "sort": [{"key":"name","dir":"asc"}], "scopeAll": false }
}
```

Limits (`FOLDER_LIMITS`): folders 200, depth 4, members per folder 5,000, **members in
total 30,000** (about 2.0 MB), name 120, id 100, query 400, key 400, playback entries
300, `ui.expanded` 300, sort keys 3, file 3.5 MiB. `settings` and `timing` accept
whatever `parseSettings` and `parseSceneTiming` accept **today**; the transition and
timing designs extend those two functions, not this schema. `sort.key` is one of
`relevance|name|rating|path|package|size|recent|plays|random|manual|style|energy|busyness|author|fidelity`.

### 5.4 Validation and forward compatibility

- **Page (authority): `parseFolderState(value)`** in `mpc-folder-store.ts`. Strict on
  structure, caps, ids, hashes (`^[0-9a-f]{64}$`), parents/cycles, sort keys and query
  length. Unknown top-level fields are ignored (a field addition needs a `version`
  bump). `version` newer than 1 puts the store in **read-only** mode with a banner
  ("saved folders come from a newer version; editing is disabled to protect them").
- **Opaque playback.** A `playback` entry that fails validation (for example a
  transition index from a newer build, landmine L9) is kept verbatim in
  `state.opaquePlayback[key]`, shown as "options from a newer version", never applied,
  and re-emitted unchanged on the next save. User folders that fail validation put the
  whole file in read-only mode; the banner offers an explicit **Reset folders** (confirm)
  that writes an empty state. The page never overwrites an unreadable file silently.
- **Hosts: shallow validator only** (standalone `foldersState()`, native size and
  well-formed-JSON check): object, integer `version`, arrays and maps within the caps,
  hash regex, string lengths. The server must accept everything the page emits and
  reject oversize or malformed data; it does not duplicate the semantic rules, so
  there is no third copy to drift (contrast: the setup validator parity burden).
  The parity test asserts "server accepts every state the page serialises".
- **Stale references.** A member hash absent from the catalog is kept and shown as a
  ghost count ("3 missing"); Play folder skips it; it is never written back removed
  unless the user removes it.
- **Migration.** None required: `setups.json` is untouched and a missing `folders.json`
  is an empty state. "Folder from setup" is an explicit user action.

### 5.5 Persistence behaviour

`FolderStore` keeps at most one save in flight plus one coalesced pending save (the
same pattern as `pending` for setups). Mutations that the user made explicitly (create,
rename, delete, membership, save options) flush after 400 ms; `last` piggybacks on the
next flush; `ui` state flushes after 3 s of quiet and on panel close. A failed save
leaves the store dirty, shows the error in the status line, and retries only on the
next mutation or an explicit "Retry save" button. The browser reloads state on every
open when there are no unsaved edits. Two MPC-HC instances sharing one install use
last-writer-wins, like setups today.

### 5.6 Play statistics (Phase 3)

`stats` state file, `{"version":1,"plays":{"<sha256>":[count,lastPlayedMs]}}`, at most
20,000 entries, saved with a 60 s debounce and on panel close; failure is non-fatal
(session-only counters remain). A play is recorded by `PlayTracker` in
`mpc-folder-stats.ts` when a committed preset is replaced after at least 8 s of wall
time that began with `playing === true`. This is a heuristic for "recent"/"most played"
sorting, not an audit log. Session-only recency works from Phase 1 without any file.

## 6. Search (PROPOSED)

### 6.1 Scope and fields

Default scope is **the selected folder, recursive**; a toggle (`In: <folder> | Everywhere`,
persisted in `ui.scopeAll`) searches all presets. Plain terms match the **name** and the
**location path** (all occurrences' folder labels, so `tuggummi` returns a whole
artist). Fielded terms:

| Syntax | Meaning |
| --- | --- |
| `word`, `"two words"` | case-, diacritics-insensitive substring of name or path |
| `-word`, `!word`, `-field:value` | exclusion |
| `name:` `path:` `folder:` | name only / location path (`/` or `>` both accepted) |
| `pkg:` `package:` | package label or archive file name |
| `artist:` `source:` | source artist/repository/release, source group |
| `author:` `style:` `category:` `energy:` `busy:` `fidelity:` | taxonomy fields (only when a `TaxonMap` exists; otherwise an inline "no style data" hint) |
| `rating:4` `rating:>=3` `rating:3..5` `rating:unrated` (`stars:` alias) | numeric comparison; `unrated` = 0 |
| `size:>20k` `size:<2kb` `size:1k..8k` | file bytes, suffix `k`/`m` |
| `kind:avs\|nerv\|hud` | preset kind |
| `is:working\|broken\|rated\|unrated\|favorite\|available\|unavailable\|failed\|played\|partial` | status |
| `plays:>3` `played:<7d` | Phase 3 (stats) |
| `a\|b` inside one value | alternatives (`pkg:github\|local`) |

Terms are ANDed. An unknown `key:` is treated as plain text, so searching `re:mix` works.
A malformed clause (`rating:>>`) is reported inline ("ignored: ...") and never blanks the
list. The parser is total: it never throws.

### 6.2 Structures and cost

`buildRecords(catalog, tree, taxa?, stats?)` creates struct-of-arrays once per catalog
revision: `nameKey[]`, `pathKey[]`, `pkgKey[]` (normalised NFKD, accents stripped,
lower case), `rating: Uint8Array`, `bytes: Uint32Array`, `flags: Uint8Array` (not
working, unavailable, failed, kind bits), taxonomy columns, and integer **rank arrays**
`nameRank`, `pathRank`, `pkgRank` from one natural-order sort (digits zero-padded to 8 in
the sort key, so `Intro 2` sorts before `Intro 10` without `Intl.Collator` per
comparison). `updateRecord(rs, i, preset)` patches one row on rating or mark changes
(the manager finds changed rows by object identity against the previous catalog array).

MEASURED (linear scan, no index, three terms, results about 85 % of rows so worst
case): 3,409 rows 0.33 ms, 6,000 rows 0.65 ms, 12,000 rows 1.5 ms; building keys and
name rank 4.7, 10.9 and 17.6 ms; sorting the result by integer rank 0.4 to 1.2 ms.
**No inverted index, trigram or web worker is warranted.** The input is debounced at
80 ms and results are an `Int32Array` of catalog indices. Relevance (used only when a
text term exists and the sort is `relevance`): per text term 3 for a name prefix, 2 for a
word-start, 1 for a name substring, 0.5 for path only, summed.

### 6.3 Keyboard

`/` or `Ctrl+F` focuses the search box from anywhere in the browser; `Esc` in the box
clears it first, then returns focus to the list, then (host handler) closes the panel;
`Down` from the box moves to the first result; the result count and active scope are
announced in the `role="status"` line ("312 presets in tuggummi, sorted by name").
Typing never triggers a playback shortcut (the host already returns early while a panel
is open; the browser additionally stops propagation for keys it consumes).

## 7. Sorting (PROPOSED)

`SortKey = {key, dir}`; up to three keys (`Sort` select, direction toggle, `Then by`
select). Ties always fall back to `nameRank`, then catalog index, so order is total and
stable.

| Key | Source | Availability |
| --- | --- | --- |
| Relevance | 6.2 scoring | when a text term exists (default then) |
| Name | `display_name`, natural order | **EXISTS** |
| Highest rating | `rating` | **EXISTS** |
| Path | primary location labels, natural order | with `origins` or a hint; else name |
| Package | primary package label | with origins/sources; else path |
| File size | `bytes` | **EXISTS** |
| Recently played / Most played | `stats.json` | Phase 3; session-only recency earlier |
| Random | seeded permutation (`seed` shown as "Shuffle 4821" with a Reshuffle button) | **EXISTS** logic |
| Manual | list order of a manual user folder | user folders only |
| Style / Energy / Busyness / Author / Fidelity (partial last) | taxonomy | only with a `TaxonMap` |
| **Date modified** | none | **Not offered.** No mtime reaches the page. Optional Phase 3 (`modified` epoch-ms written into the catalog entry by the existing rate transaction: two lines in `AAAVSLibrary.h::Rate` and `standalone-library.mjs::rate`, then `LocalAvsPreset.modified` and the `rating-saved` handler) |

Default sort: Relevance with a query, otherwise the folder's saved `playback.sort`, else
Path then Name for virtual folders, Manual for manual folders, Name for smart folders.
The list-view sort is independent of the **playback** sort saved in a folder setup
(defaulted from it when a folder is opened, changeable in Playback options).

## 8. Play folder (PROPOSED)

### 8.1 Semantics

1. **Pool.** The selected folder's unique members (`recursive`, default on; off = direct
   members), ordered by the folder's playback sort. When a search or status filter is
   active the primary button becomes **Play N results** and the pool is exactly the
   displayed list in displayed order. Smart folders snapshot their membership at play
   time. `skipPartial` (default off) additionally drops taxonomy `partial` presets.
2. **Eligibility.** The transient order keeps every member that is `autoEligible`
   (unparseable presets are removed and counted). Not-working marks, session failures
   and the minimum rating are **not** baked into the order: `selectionPool()` already
   applies them dynamically, so clearing a mark or lowering the threshold takes effect
   live, and the rule "minimum rating constrains shuffle only" is unchanged. An empty
   eligible pool refuses to activate and leaves current playback untouched.
3. **Settings.** If the folder has a saved bundle and "Use folder options" is on
   (default), it is applied exactly as `activateSetup` applies a setup. With no bundle,
   the live settings stay as they are (Auto, shuffle, transition, timing unchanged) and
   the status line says so ("Auto is off: use Next/Previous").
4. **Start.** The first pool entry, or a random entry when shuffle is on, or the row the
   user pressed Shift+Enter on. With the song clock enabled the start is
   `clockPhase().index` like a setup.
5. **Active setup.** There is one `setupOrder`. Folder play **replaces** an active setup;
   activating a saved setup, "Use entire library" (`activate(null)`) or **Stop folder**
   replaces or clears it. Setup drafts are untouched. A folder and a setup never combine.
6. **Song clock (repeatable scene timing).** Follows the folder bundle's `timing`. The
   default for AVS folders is disabled (L8); NERV and HUD roots default to enabled at
   the current trusted tempo, mirroring the NERV scene-set template.
7. **Previous/Next, Auto, manual choice.** Identical to an active setup: `next` is
   `candidate()` over `selectionPool()`, `previous` is the sequential predecessor in the
   order, a manual pick uses `manualSelection`. (Making Previous history-based while
   shuffling is a possible later improvement to setups and folders alike; not part of
   this work.)
8. **Live edits.** Editing a user folder or a rating does not reorder an active play.
   The plan is a snapshot; the browser shows "Folder changed. Play again to apply" for a
   user folder edited while playing. Rating and mark changes affect eligibility
   immediately (existing behaviour).
9. **Last folder.** A successful play stores `last = {key, recursive}`; **Ctrl+F8**
   replays it, or opens the browser on the folder tree when there is none. Resume at
   launch is not automatic (optional Phase 3 setting).

### 8.2 Overlay

Bottom-left line while a folder is active:
`Folder: tuggummi (756) · 12 / 756 · <name> ★★★`, where the position is the current
preset's place in the eligible pool (no position while shuffling: `random`). Library and
setup states show `Library · 3409 · ...` and `Setup: <name> · ...`. The manager header
shows `Playing: Folder "tuggummi" · 756 presets · shuffle on [Stop folder]`, and the
tree marks the playing folder. The top-right timing line (BPM/FPS work) is untouched by
this design.

### 8.3 Host implementation (existing machinery, one new entry point)

`activateSetup` is split; nothing else about the selection machinery changes:

```ts
type PlaySource = { kind: 'library' } | { kind: 'setup'; label: string } | { kind: 'folder'; key: string; label: string; total: number };
function activateOrder(order: readonly number[] | null, config: { settings?: SetupSettings | null; timing?: SceneTiming | null; startAt?: number | null; source: PlaySource }): void
// activateSetup(setup): builds order via setupIndices, keeps its two throws, calls activateOrder(order, {settings: setup.settings, timing: setup.timing, source: {kind:'setup', label: setup.name}})
function playFolder(plan: FolderPlayPlan): { ok: true; eligible: number } | { ok: false; reason: string }
```

`playFolder` validates indices (integers in range, unique: O(n)), filters `!autoEligible`
(no throw), refuses an empty eligible pool, then runs the same body as
`activateSetup` from `setupOrder = order` onward. The **500 cap is not involved**: it is
enforced only in `parseSetups`, which this path never calls; the bound is
`catalog.length` (<= 50,000 by `MAX_CATALOG_ENTRIES`). `updateLabel()` reads `source`.

### 8.4 Required performance work for large pools (L3)

`selectionPool()` and `clockPhase()` become memoised on a revision key:
`(setupOrder identity, catalog identity, presets.shuffle, minimumRating, failedRevision)`
and `(position, clockRevision, poolRevision)` respectively. `failedRevision` is bumped
wherever `failed` mutates (`fail`, the `prepare` catch, `commit`). The cache lives in
`mpc-folder-play.ts` (`PoolCache`) and is exercised by tests; the host change is about
ten lines. Without it, the song clock on a 3,400-preset folder adds about 2 ms per
frame (MEASURED). Folder play with the clock off is unaffected.

### 8.5 Commands and shortcuts

| Command | Where | Notes |
| --- | --- | --- |
| **Play folder** button | tree/list toolbar | acts on the selected folder or shows "Play N results" |
| `Enter` on a tree row | tree | opens the folder (list) |
| `Ctrl+Enter` | tree or list | plays the folder / results |
| `Shift+Enter` on a list row | list | plays the folder starting at that preset |
| **Stop folder** | manager header | `stopFolder()` = `activate(null)` but keeps live settings |
| **Ctrl+F8** | global (page and native) | replay last folder, or open the browser on the tree |
| Standalone toolbar button "Play folder" (optional) | `standalone.html` | emits the same message as Ctrl+F8 |

Native wiring compared with F6/F7/F8 (nothing beyond this table is needed):

| Step | F6/F7/F8 today | `ID_AAAVS_PLAY_FOLDER` (Phase 2) |
| --- | --- | --- |
| ID | `resource.h` 31007-31009 | `#define ID_AAAVS_PLAY_FOLDER 31010` |
| Dispatch | `ON_COMMAND_RANGE(ID_AAAVS_PREVIOUS, ID_AAAVS_NOT_WORKING, ...)` and the UI-update range in `MainFrm.cpp` | extend both ranges to `ID_AAAVS_PLAY_FOLDER` |
| Accelerator | `AppSettings.cpp` row `{ID, VK, mods, ID}` | `{ ID_AAAVS_PLAY_FOLDER, VK_F8, FCONTROL, ID_AAAVS_PLAY_FOLDER }` (free today) |
| Menu and text | `mpc-hc.rc` `MENUITEM` and `STRINGTABLE` (UTF-16) | View menu "Play Folder", string "Visualizer: Play last preset folder" |
| Page to native | page `keydown` posts `rate-up` etc. | page `keydown` posts `play-folder` (Ctrl+F8) |
| Native to page | `Command()` posts `{"type":"rate",...}` after the `Ready()` gate | `Command()` posts `{"type":"play-folder"}` |
| Enable state | `OnUpdateAAAVSPreset` enables while `Ready()` | unchanged |
| Standalone | `StandaloneBridge.postMessage('rate-up')` emits `{type:'rate'}` | `case 'play-folder'` emits `{type:'play-folder'}` |

## 9. UI (PROPOSED)

### 9.1 Structure

The Preset Manager (mode 1) becomes the Preset Browser; Setup Builder (mode 2) keeps its
builder and timing controls in the detail column and gains the same tree and list on the
left. `mpc-management.ts` keeps `PresetManagement` and the Setup Builder code; the tree,
toolbar and virtual list live in the new `mpc-browser-view.ts`, which exposes a `detail`
slot the manager fills (preset detail, folder detail, builder). The manager's playback
controls are extracted once into `renderPlaybackControls(host, settings, timing, onDirty,
labelPrefix)` and used by both the Setup Builder (`labelPrefix` `Setup`, so the existing
aria-labels are unchanged) and the folder Playback options (`Folder`), so new timing
options appear in both automatically.

### 9.2 Wireframes (ASCII; `*` is a star)

Full screen or width >= 900 px, three panes:

```
+-------------------------------------------------------------------------------------------+
| Preset Browser                            [Setup Builder . Ctrl+F7] [Close . Esc]         |
| Playing: Folder "tuggummi" . 756 presets . shuffle on                    [Stop folder]    |
| [ Search presets... (/)          ] In:[tuggummi v] Sort:[Name v][^] Then:[- v]            |
| Status:[All v]  Show:[all ratings v]  Shuffle minimum:[All ratings v]                     |
+--------------------+------------------------------------------+---------------------------+
| FOLDERS            | AVS > By source > Visbot > tuggummi  756 | DETAILS                   |
| v AVS        3,409 | +--------------------------------------+ | Tuggummi - 01 - Intro     |
|  v By source       | |*** Tuggummi - Breaking Myself   12 K | | *** . 12 KB . AVS         |
|   v Visbot   3,010 | |    ...tuggummi/SINKKUJA              | | Location: AVS > By source |
|    > acid       31 | |--  Tuggummi - 01 - Intro  . playing  | |  > Visbot > tuggummi      |
|    v tuggummi  756 | |    ...tuggummi/allatuggummi          | | Also in 2 other folders   |
|     > allat... 751 | |**  Tuggummi - ZiG n ZaG          9 K | | [Load preset]             |
|   > GitHub     395 | |     ... (about 30 DOM rows;          | | [1*][2*][3*][4*][5*]      |
|   > Local      124 | |     the rest are virtual)            | | [Mark not working]        |
|  > By style        | +--------------------------------------+ | [Add to setup]            |
|  > By rating       | 756 presets . 12 selected                | [Add to folder v]         |
| > NERV          16 | [> Play folder][x] subfolders [Play 12]  |                           |
| > HUD packs    412 |                                          | FOLDER OPTIONS  v         |
| -- Smart --        |                                          | [x] Use folder options    |
|   Favorites      8 |                                          | Shuffle, transition, timing|
|   Unrated    3,401 |                                          | [Save current] [Clear]    |
| -- My folders --   |                                          |                           |
|   > Late night  24 |                                          |                           |
|   + New folder     |                                          |                           |
+--------------------+------------------------------------------+---------------------------+
| status line (role=status)                       Keyboard shortcuts v                      |
+-------------------------------------------------------------------------------------------+
```

Width 481-899 px: two panes (tree, list); the detail pane moves under the list (as
today). Width <= 480 px (the embedded artwork window): single column with drill-down.

```
+--------------------------------+     +--------------------------------+
| Preset Browser  [Setups] [X]   |     | Folders                  [X]   |
| Playing: tuggummi . [Stop]     |     | v AVS                    3,409 |
| [ Search...             ] [...] |     |   v By source                  |
| < Folders | ...Visbot>tuggummi |     |    v Visbot            3,010   |
+--------------------------------+     |      > acid                31  |
| *** Tuggummi - Breaking..  12K |     |      > tuggummi           756  |
|     ...tuggummi/SINKKUJA       |     | > NERV                      16 |
| --  Tuggummi - 01 - Intro      |     | > HUD packs                412 |
|     ...tuggummi/allatuggummi   |     | -- Smart --                    |
| **  Tuggummi - ZiG n ZaG   9K  |     | -- My folders --               |
| ... (virtual)                  |     |                                |
+--------------------------------+     | Enter opens, Ctrl+Enter plays  |
| [> Play folder]  [Details v]   |     +--------------------------------+
+--------------------------------+
```

`[...]` opens a sheet with Sort, Then by, Status, Show, Shuffle minimum. `Details v`
expands the detail pane as a bottom sheet over the list. `< Folders` returns to the tree;
choosing a folder returns to the list. The layout switches with the same media-query
breakpoints the current CSS uses (480 and 600 px), so the behaviour is identical in both
hosts; the styling reuses the existing colours (`#202020` panel, `#303030` controls,
`#606060` borders, `#36b4dc` focus/pressed) and is injected as a `<style>` element by the
view (L5), so `mpc.html` and `standalone.html` need no CSS edit.

### 9.3 Interaction and accessibility

- **Tree:** `role="tree"`, rows `role="treeitem"` with `aria-level`, `aria-expanded`,
  `aria-selected`; one tab stop (roving `tabindex`). Keys: Up/Down, Right expand/enter,
  Left collapse/parent, Home/End, `*` expand siblings, `Enter` open, `Ctrl+Enter` play,
  `F2` rename and `Delete` delete (user folders; delete asks to confirm), context actions
  also as buttons in the folder detail (no pointer-only affordance).
- **List:** `role="listbox"` `aria-multiselectable`, rows `role="option"` with
  `aria-posinset`/`aria-setsize`, `aria-activedescendant` on the container, virtual rows
  at a fixed height (36 px wide, 52 px narrow with the path line). Keys: Up/Down,
  PgUp/PgDn, Home/End, `Enter` load, `Shift+Enter` play from here, `Space` toggle
  selection, `Shift+Arrows` range, `Ctrl+A` select shown, digits `1`-`5` rate the focused
  row, `M` toggles not working, `.` reveals the playing preset (tree + scroll).
- Selecting rows enables **Add to setup** (bounded by 500, reports "Added 500 of 751"),
  **Add to folder** (a menu of user manual folders plus "New folder...") and, inside a
  manual folder, **Remove from folder** and Move up/down when sorted by Manual.
- Focus and announcements: opening focuses the tree's current row; every list change
  updates one `role="status"` line; no color-only states (rating, playing and
  not-working are text); the list row text stays `"★★★  Name · not working · playing"`
  as a single button/option string, with the location path as a separate child element,
  so the existing DOM tests keep passing.
- **Rendering:** persistent skeleton created once; `refresh()` only patches changed
  rows, the header source line and counts (a `requestAnimationFrame`-coalesced patch).
  `visibleWindow(scrollTop, viewport, rowHeight, count, overscan = 6, fallbackRows = 60)`
  returns the DOM slice; when no layout is measurable (fake DOM, hidden panel) it renders
  the first 60 rows, which keeps the current CPU DOM test valid unchanged.

## 10. Protocol additions and back-compat (PROPOSED)

| Direction | Message | Purpose | Back-compat |
| --- | --- | --- | --- |
| page to host | `library:{"op":"load-state","name":"folders"\|"stats"}` | read a private state file | old native/standalone: `library-error` `operation:"load-state"` (`Unknown library request`); page treats persistence as unavailable and stays session-only; the host page **does not announce** this particular error at startup |
| page to host | `library:{"op":"save-state","name":...,"data":{...}}` | write it | same |
| host to page | `{"type":"state-loaded","name":...,"data":object\|null}` | | ignored by old pages (unknown type) |
| host to page | `{"type":"state-saved","name":...}` | | ignored by old pages |
| page to native | `play-folder` (string) | Ctrl+F8 pressed in the page | old native: the string is ignored (no handler) and the page acts only on the native echo, so an old executable simply has no Ctrl+F8 (the browser button still works) |
| native to page | `{"type":"play-folder"}` | Ctrl+F8 or menu | ignored by old pages |
| catalog JSON | optional entry fields `folder`; existing `occurrences` | folder data | absent = "Unsorted" / flat |
| page internal | `Actions` additions (section 11.3) | | all optional; the existing test fixture and the mirror keep working |

`setups.json`, `settings.json`, `setups-loaded`, `setups-saved`, `settings` and every
existing message are unchanged. No new native-to-page message carries preset data.

Native C++ sketch (in `AAAVSLibrary.h`, so `tools/check-aaavs-library.cpp` can test it
without a WebView; `AAAVSView.cpp` only dispatches):

```cpp
inline std::string LoadState(const fs::path& root, const std::string& name) {
    if (name != "folders" && name != "stats") throw std::runtime_error("Unknown state file");
    const auto path = root / Wide(name + ".json"); NoLinks(path);
    std::string text = fs::exists(path) ? Read(path) : "null";
    rapidjson::Document doc; doc.Parse(text.c_str());
    if (doc.HasParseError()) throw std::runtime_error("Saved state is corrupt");
    return "{\"type\":\"state-loaded\",\"name\":\"" + name + "\",\"data\":" + Json(doc) + "}";
}
inline std::string SaveState(const fs::path& root, const std::string& name, const rapidjson::Value& data) {
    if ((name != "folders" && name != "stats") || !data.IsObject()) throw std::runtime_error("Invalid state request");
    const auto text = Json(data); if (text.size() > 3670016) throw std::runtime_error("State is too large");
    AtomicWrite(root / Wide(name + ".json"), text);
    return "{\"type\":\"state-saved\",\"name\":\"" + name + "\"}";
}
```

Standalone: `case 'load-state'` returns `jsonFile(join(privateRoot, name + '.json'), null)` through the
shallow validator; `case 'save-state'` validates and calls `atomicJson`. Both go through
the existing queue, locks, `noLinks` and size limits.

## 11. Modules, signatures and shared edits

### 11.1 New modules (owned by this stream; ESM, no dependencies)

`visualizer/src/mpc-folders.ts` (pure tree):

```ts
export type NodeKind = 'root'|'section'|'group'|'artist'|'package'|'dir'|'bucket'|'platform'|'facet'|'smart'|'user';
export interface FolderNode { readonly id: number; readonly key: string; readonly label: string; readonly kind: NodeKind; readonly parent: number; readonly children: number[]; direct: Int32Array; members: Int32Array | null }
export interface FolderTree { readonly nodes: FolderNode[]; readonly roots: number[]; readonly byKey: Map<string, number>; readonly primary: Int32Array; readonly locations: readonly (readonly number[])[]; revision: number }
export const BUCKET_ABOVE = 60, FAVORITE_MINIMUM = 4;
export interface TreeInputs { sources?: SourceMap; taxa?: TaxonMap | null; user?: readonly UserFolder[] }
export function buildFolderTree(catalog: readonly LocalAvsPreset[], inputs?: TreeInputs): FolderTree;
export function withUserFolders(tree: FolderTree, user: readonly UserFolder[], hashIndex: ReadonlyMap<string, number>): FolderTree;
export function folderMembers(tree: FolderTree, id: number, rs: RecordSet): Int32Array;          // recursive, unique, ascending
export function directMembers(tree: FolderTree, id: number, rs: RecordSet): Int32Array;
export interface TreeRow { id: number; key: string; depth: number; label: string; count: number; expanded: boolean | null; playing: boolean }
export function treeRows(tree: FolderTree, expanded: ReadonlySet<string>, playingKey: string | null, rs: RecordSet): TreeRow[];   // collapsed chains merged
export function locate(tree: FolderTree, index: number): { primary: number; others: number[] };
export function pathLabels(tree: FolderTree, id: number): string[];
export function hudPlatform(kitId: string): string;
```

`visualizer/src/mpc-folder-query.ts` (pure search, sort, window):

```ts
export interface RecordSet { count: number; nameKey: string[]; pathKey: string[]; pkgKey: string[]; rating: Uint8Array; bytes: Uint32Array; flags: Uint8Array;
  nameRank: Int32Array; pathRank: Int32Array; pkgRank: Int32Array; plays: Uint16Array; lastPlayed: Float64Array; taxon: (Int8Array | null) }
export const FLAG = { notWorking: 1, unavailable: 2, nerv: 4, hud: 8, failed: 16, partial: 32 } as const;
export function buildRecords(catalog: readonly LocalAvsPreset[], tree: FolderTree, taxa?: TaxonMap | null, stats?: PlayStats | null, failed?: ReadonlySet<number>): RecordSet;
export function updateRecord(rs: RecordSet, index: number, preset: LocalAvsPreset): void;
export interface Query { readonly raw: string; readonly text: readonly string[]; readonly clauses: readonly Clause[]; readonly notes: readonly string[] }
export function parseQuery(text: string): Query;                                   // total, never throws
export function runQuery(rs: RecordSet, q: Query, universe: Int32Array | null): { ids: Int32Array; score: Float32Array | null };
export type SortField = 'relevance'|'name'|'rating'|'path'|'package'|'size'|'recent'|'plays'|'random'|'manual'|'style'|'energy'|'busyness'|'author'|'fidelity';
export interface SortKey { key: SortField; dir: 'asc' | 'desc' }
export function sortIndices(rs: RecordSet, ids: Int32Array, spec: readonly SortKey[], ctx: { seed: number; score?: Float32Array | null; manual?: ReadonlyMap<number, number> }): Int32Array;
export function visibleWindow(scrollTop: number, viewport: number, rowHeight: number, count: number, overscan?: number, fallbackRows?: number): { start: number; end: number; offset: number };
```

`visualizer/src/mpc-folder-store.ts` (state, validation, save queue):

```ts
export const FOLDER_LIMITS: Readonly<{ folders: 200; depth: 4; members: 5000; totalMembers: 30000; name: 120; id: 100; query: 400; key: 400; playback: 300; expanded: 300; sort: 3; bytes: 3670016 }>;
export interface UserFolder { id: string; name: string; parent: string | null; kind: 'manual' | 'smart'; presets?: string[]; query?: string; scope?: string | null; sort?: SortKey[]; created: number }
export interface FolderPlayOptions { recursive: boolean; sort: SortKey[]; skipPartial?: boolean; settings?: SetupSettings; timing?: SceneTiming }
export interface FolderState { version: 1; rev: number; folders: UserFolder[]; playback: Record<string, FolderPlayOptions>; opaquePlayback: Record<string, unknown>; last: { key: string; recursive: boolean } | null; ui: FolderUi }
export function emptyFolderState(): FolderState;
export function parseFolderState(value: unknown): FolderState;                     // strict, throws Error(message)
export function serializeFolderState(state: FolderState): unknown;                 // includes opaquePlayback verbatim
export class FolderStore {
  constructor(send: (request: unknown) => void, timers?: { set(fn: () => void, ms: number): number; clear(id: number): void });
  readonly state: FolderState; status: 'idle' | 'loading' | 'ready' | 'unavailable' | 'readonly';
  load(): void; receive(type: string, payload: unknown, operation?: string): void;
  mutate(change: (s: FolderState) => void, immediate?: boolean): void; flush(): void; retry(): void; reset(): void;
}
```

`visualizer/src/mpc-folder-play.ts` (plan, no DOM):

```ts
export interface FolderPlayPlan { ok: true; key: string; label: string; order: number[]; total: number; skipped: { unavailable: number; missing: number; partial: number }; startAt: number | null; settings: SetupSettings | null; timing: SceneTiming | null }
export function planFolderPlay(tree: FolderTree, rs: RecordSet, catalog: readonly LocalAvsPreset[], request: { key: string; label: string; recursive: boolean; sort: readonly SortKey[]; results?: Int32Array | null; startAt?: number | null; saved?: FolderPlayOptions | null; useSaved: boolean; seed: number }): FolderPlayPlan | { ok: false; reason: string };
export class PoolCache { get(order: readonly number[], catalog: readonly LocalAvsPreset[], shuffle: boolean, minimumRating: number, failed: ReadonlySet<number>, revision: number): number[]; memoPhase<T>(key: string, compute: () => T): T }
```

`visualizer/src/mpc-folder-stats.ts` (Phase 3): `PlayTracker` (`commit(hash, playing, now)`, `flush(now)`), `PlayStats`, `parseStats`.
`visualizer/src/mpc-browser-view.ts`: DOM view (tree, toolbar, virtual list, detail slot) and the injected style string (`browserCss`).

### 11.2 Existing files: shared edits (small, additive)

| File | Edit | Why |
| --- | --- | --- |
| `visualizer/src/avs/local-collection.ts` | `origins`, `folder`, `fetchLocalAvsSources`, `parseLocalAvsSources` (3.1) | the data already fetched but discarded; hub file, additive, optional fields |
| `visualizer/src/mpc-setups.ts` | export `parseSettings(s)` (extract lines 11-14 of `parseSetups`; behaviour unchanged, `parseSetups` calls it) | folder bundles must share the settings validator so the timing/transition designs extend one place |
| `visualizer/src/mpc-management.ts` | extend `Actions` (11.3); delegate mode-1 list/detail to `mpc-browser-view.ts`; extract `renderPlaybackControls`; route `state-loaded`/`state-saved`/`library-error(load-state/save-state)` in `receive`; add `playLastFolder()` and `noteCommit()` | UI integration; keep every existing label and behaviour (2.4) |
| `visualizer/src/mpc-host.ts` | `activateOrder`/`playFolder`/`stopFolder`/`source()` (8.3); `updateLabel()` source prefix; `PoolCache` in `selectionPool`/`clockPhase` (8.4); message routing for `state-loaded`, `state-saved`, `play-folder`; `Ctrl+F8` in the keydown map; do not announce `load-state` failures; pass `sources`, `taxa`, `failedIndices` to the manager; call `management.noteCommit` from `commit()` | Play folder and large-pool cost |
| `visualizer/src/standalone-player.ts` | `case 'play-folder'` in `StandaloneBridge.postMessage`; optional toolbar button wiring | standalone parity |
| `visualizer/standalone.html` | optional `Play folder` button in the transport row | discoverability; no CSS edit needed |
| `visualizer/tools/standalone-library.mjs` | `load-state`/`save-state` cases, shallow `foldersState`/`statsState`, deny `folders|stats` in the legacy static deny regex | persistence |
| `src/mpc-hc/AAAVSLibrary.h` | `LoadState`/`SaveState` (section 10) | persistence and native test |
| `src/mpc-hc/AAAVSView.cpp` | dispatch `load-state`/`save-state`; handle `play-folder` string; `Command(ID_AAAVS_PLAY_FOLDER)` | Phase 2 |
| `src/mpc-hc/resource.h`, `MainFrm.cpp`, `AppSettings.cpp`, `mpc-hc.rc` | `ID_AAAVS_PLAY_FOLDER` 31010, range ends, accelerator, menu item, string (rc is UTF-16) | native command |
| `visualizer/package.json` | add the new checks to `check` (and to `check:player` those that stock also runs) | gates |
| `tools/aaavs-mirror.json` | `files` entries for each new `tools/check-*.mjs` (`visualizer/src` is a mirrored directory, so new sources need no entry) and for this document | stock receives them |
| `tools/check-release-package.py` | add `visualizer/avs presets/folders.json` and `stats.json` to the private-fixture list | keep user state out of public artifacts |
| `docs/PRESET-MANAGEMENT.md`, `docs/AAAVS-SHARED-DEVELOPMENT.md` | user-facing browser, folders, Ctrl+F8; feature-table row | after implementation |

### 11.3 `Actions` additions (all optional)

```ts
interface Actions { /* existing members unchanged */
  sources?(): Promise<SourceMap>;                       // fetchLocalAvsSources
  taxa?(): TaxonMap | null;                             // taxonomy design; null when absent
  failedIndices?(): ReadonlySet<number>;                // session failures, for smart:unavailable
  playFolder?(plan: FolderPlayPlan): { ok: true; eligible: number } | { ok: false; reason: string };
  stopFolder?(): void;
  source?(): PlaySource;                                // library | setup | folder, for header and tree marker
}
```

`PresetManagement` also gains `playLastFolder()` (host calls it on the `play-folder`
message) and `noteCommit(index, playing)` (feeds `PlayTracker`). With any of these
absent, the corresponding button is disabled with a reason; nothing throws.

## 12. Test plan (CPU only; no browser, GPU, native build or network)

New files follow the `visualizer/tools/check-*.mjs` idiom (esbuild bundle, `data:` import).
Each check runs against a **deterministic synthetic catalog generator**
(`syntheticCatalog(n, seed)` in a shared `visualizer/tools/fixtures-folders.mjs`): 4,000
AVS presets over 6 source groups and 90 packages, 8 % in two or three packages, some
under `_nested/<hex>`, root-level files, entries with no occurrences, accented and
duplicate names, `Intro 2`/`Intro 10` families, plus 16 NERV and 400 HUD entries with
`folder` hints (one platform with 150 kits for buckets) and ratings/marks scattered.

| Check | Assertions |
| --- | --- |
| `check-mpc-folders.mjs` | AVS root count equals unique AVS entries; every AVS preset belongs to at least one leaf; multi-package presets appear in each folder and are counted once at every ancestor (union equals brute force); primary-location rule (each tie-break); `_nested` stripping; wrapper-directory packages vs root-file packages; chain collapse rows and their keys; buckets appear only above 60 children and 3 groups; keys unique and identical across two builds and across a shuffled catalog order; no key contains a staging path; smart folders equal brute-force predicates; sibling roots NERV/HUD hidden when empty; user folder attach; taxonomy facets present/absent; performance guard (build under 250 ms for 6,000 entries, generous budget) |
| `check-mpc-folder-query.mjs` | parser cases (quotes, negation, `|` alternatives, ranges, `unrated`, unknown key as text, malformed clause noted, empty input) ; a seeded property test compares `runQuery` with a naive oracle over 300 random queries; natural sort (`Intro 2` < `Intro 10`), diacritics, stable ties, multi-key, `random` deterministic per seed and different across seeds, relevance ordering, `manual` order; `updateRecord` after rating/mark; `visibleWindow` edges (0 rows, overscan, viewport larger than list, unmeasured fallback = 60); timing budget for 6,000 rows (search + sort under 40 ms) |
| `check-mpc-folder-store.mjs` | round trip; each cap accepted at N and rejected at N+1 (folders, members, total members, name, query, key, playback, expanded, sort); cycles, depth 5, duplicate ids, bad hashes, bad parent; `version 2` gives read-only; an invalid playback entry becomes `opaquePlayback` and survives serialise; bundle settings accepted iff `parseSetups` accepts the same settings (parity); save queue with fake timers: coalescing, one in flight, failure keeps dirty, `retry`, `reset`; `Unknown library request` on `load-state` yields `unavailable` and session-only editing |
| `check-mpc-folder-play.mjs` | recursive vs direct; playback sort; unparseable removed and counted; missing hashes counted; empty result refuses; `startAt`; results mode equals list order; **4,000-member order accepted (no 500 cap)** and steps through `stepSetup`; `skipPartial`; `PoolCache` hit/miss on every key component and phase memo; smart folder snapshot |
| `check-mpc-selection.mjs` (extend) | using the existing host harness: `actions.playFolder` loads the first eligible member, `next` follows `selectionPool`, a mark removes a member live, `minimumRating` affects only shuffle, `activate(null)` clears, source label appears in `#preset`, `play-folder` message with no last folder opens the manager (`panel(1)`), a 600-preset folder activates (cap check), `load-state` failure produces no announcement |
| `check-mpc-management.mjs` (extend) | existing assertions unchanged; add: tree rows for a small catalog, folder select filters the list, search box filters without rebuilding the input (same element instance), sort select options, Play folder button calls `playFolder` once with the expected order, disabled reasons when actions are missing, keyboard model functions (`treeKeyAction`, `listKeyAction` are pure and tested without DOM) |
| `check-standalone-library.mjs` (extend) | `load-state` of a missing file returns `data:null`; save/load round trip for `folders` and `stats`; unknown name, oversize (3.5 MiB + 1) and non-object rejected; corrupt file rejected on load; `.aaavs-private` static 404 for the new files; junction/symlink refusal via `noLinks`; parity: every state produced by `serializeFolderState` for the synthetic fixtures is accepted; concurrent saves serialised; the existing `setups.json` cases untouched |
| `check-standalone-player.mjs` (extend) | bridge `play-folder` emits `{type:'play-folder'}`; `state-loaded` passthrough |
| `check-mpc-catalog.mjs` (extend) | when the private collection is present: `origins` parsed for all 3,409 entries, AVS root equals 3,409, every occurrence path free of staging segments; skipped cleanly when absent |
| `tools/check-aaavs-library.cpp` (extend) | `LoadState`/`SaveState`: missing file `null`, round trip, name whitelist, oversize, corrupt JSON, link refusal. **Compiled and run only by the native build process; not claimed here.** |
| `check-release-package.py` (extend) | the private fixtures include `folders.json` and `stats.json` and must not appear in the archive |

Golden hashes and the AVS corpus gate are not involved and must not be re-recorded.
Acceptance that remains **unverified until GPU/app use is allowed:** real WebView2
focus/keyboard behaviour, scroll performance with real DOM, 480 px layout, the native
menu and accelerator, and the audible/visual result of switching within a large folder.

## 13. Phasing, risks, questions

### 13.1 Phases

1. **Browser (no native change).** Origins and sources parsing, tree, smart folders
   (without recent/most played), search, sort, virtual list, tree/list UI, session-only
   Play folder with `activateOrder`, overlay source line, pool cache, Ctrl+F8 in the page,
   standalone `play-folder` message. Ships first: it delivers the master folder, search,
   sorting and Play folder.
2. **Persistence and native.** `folders.json` ops (C++ and standalone), user folders,
   folder setups (playback options), last folder, `ID_AAAVS_PLAY_FOLDER`, menu item,
   release/mirror plumbing.
3. **Statistics and polish.** `stats.json`, recent/most played, `modified`, bulk actions,
   resume-at-launch setting, Save folder as setup / Folder from setup.
4. **Optional.** Additional facets from the taxonomy design as they land (no code
   change needed beyond the provider).

### 13.2 Risks

- **Coordination:** `mpc-management.ts`, `mpc-host.ts` and `mpc-setups.ts` are edited by
  the timing and transition designs too; keep this stream's edits mechanical and merge
  `renderPlaybackControls` and `parseSettings` first.
- **Memory:** `origins` adds about 1.1 MB of strings and one Int32Array per node; both
  are small against the existing 3.4 MB of parsed JSON.
- **Large-pool clock cost** if the pool cache is skipped (L3).
- **AVS boundary latency** with the song clock (L8) is a limitation, not fixed here.
- **Downgrade:** older builds ignore `folders.json`; older `parseSetups` rejects setups
  written with newer transition indices regardless (timing design).
- **Heuristic labels:** taxonomy author/energy are unvalidated; the browser shows them
  as labels and never as ratings, and folders remain editable by the user.
- **Two installs:** native and stock keep separate private files; mirroring source never
  copies `folders.json`.
- **Not verified:** everything visual or interactive; see section 12.

### 13.3 Owner questions (defaults given)

- **Q1.** Favorites = 4+ stars, no separate favourite flag. Default: yes.
- **Q2.** Store user folders and folder options in a new `folders.json` rather than on
  `setups.json` entries. Default: yes (section 5.2).
- **Q3.** Ctrl+F8 for "Play folder / replay last folder". Default: yes (unused today).
- **Q4.** Folder play replaces an active setup; they never combine. Default: yes.

### 13.4 Non-goals

No preset editing, no cloud sync of folders, no automatic tagging at play time, no
change to golden AVS behaviour, no reading of any private path, media or personal data
into a public artifact, and no claim that the wireframes were rendered or tested.
