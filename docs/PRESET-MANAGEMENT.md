# Preset ratings and setups

The View menu includes **Preset Manager** (Ctrl+F6) and **Setup Builder** (Ctrl+F7). These defaults do not replace existing MPC-HC bindings. Visualizer commands, including ratings and **Mark preset not working (F8)**, are registered in **Options > Player > Keys**, alongside the player's existing commands. The management view also includes a shortcut reference. Escape closes the view; typing in its fields does not trigger playback shortcuts.

**F7** raises the currently displayed preset's rating; **F6** lowers it. Ratings are clamped to 1–5 stars; an unrated preset starts at one star. The manager's star buttons rate the selected row, which may differ from the playing preset. Repeated shortcut requests are queued and acknowledged after saving.

A rated preset receives a suffix such as `Original name [3 stars].avs`. The content hash prefix, AVS bytes, and bitmap identity remain unchanged. The application explicitly updates the file's last-write timestamp so Explorer's **Date modified** changes, and atomically updates the catalog's path and rating. Failed catalog saves roll back the rename and timestamp. Existing target files are never overwritten. Linked paths outside the installed collection are rejected. Errors are shown in the interface.

The manager provides search, list minimum-rating filtering, working-status filtering, name/rating sorting, paging, and direct loading. It uses the installed preset collection beside the executable. Ratings are not written to a separate source checkout. The list's **Show N+ stars** control changes only the rows displayed; it is separate from the playback filter below.

## Mark a preset as not working

Press **F8** to mark the currently displayed preset. Repeated F8 presses leave it marked; they do not toggle it back. The manager's **Mark not working** button applies to its selected row, which can differ from the displayed preset. Marked entries show **not working** in the list and are excluded from automatic and random selection, including setup and song-clock selection.

This saves a `notWorking` flag in the installed `visualizer/avs presets/catalog/presets.json`. It does not rename or delete the preset, change its star rating, alter its bytes, or change the preset file's Date modified. Catalog writes are atomic, and the interface reports save failures.

To retest a marked preset, select it in Preset Manager and choose **Load preset**. The mark alone does not block an explicit load; an entry already known to be unparseable remains unavailable. After confirming it works, choose **Clear not-working mark** to return it to eligible selection. The **Marked not working** status filter helps find these entries. Marking is a persistent user decision; session-only load/render failures are tracked separately.

## Limit shuffle by rating

Set **Shuffle minimum rating** in Preset Manager or **View > Visualizer > Visualizer options**. Choices are **All ratings**, **1+**, **2+**, **3+**, **4+**, and **5 stars**. All includes unrated presets. A minimum of 3 includes 3-, 4-, and 5-star presets; 5 admits only 5-star presets.

The threshold applies when **Shuffle is enabled**: manual random Next, adaptive Auto, shuffled setups, and seeded song-clock selection all use the same eligible pool. Sequential browsing and explicit **Load preset** do not require the minimum rating. Not-working marks remain excluded from automatic selection independently of the threshold.

The active threshold persists in the player's preferences and is saved with setup settings. Older setups without a threshold use All. A setup's saved threshold takes effect when that setup is activated. The manager's global playback selector changes the active preference; the builder's setup selector edits the draft until activation.

If no presets qualify, the player reports **no eligible presets** and holds the current display; it never silently selects a lower-rated or marked preset. Lower the threshold, rate another preset, clear a mark, or disable shuffle. An eligible pool containing only the current preset cannot provide another random choice. Changing eligibility cancels prepared choices that no longer qualify; timed scene choices outside the new pool are discarded.

## Setups

A setup is a saved ordered preset list plus shuffle, minimum shuffle rating, Auto phrase length, transition style/duration, and manual/automatic transition preferences. Song-clock setups also save BPM, offset, bars per scene, and shuffle seed. It is not an editor for the effects inside an AVS preset.

1. Open Setup Builder and choose **New setup**.
2. Select presets on the left and use **Add to setup**.
3. Reorder with the arrow buttons, remove unwanted entries, and set playback/transition options.
4. **Save setup** persists it; **Activate setup** applies it to this session. Unsaved drafts can be activated without overwriting a saved setup.
5. **Use entire library** clears the active preset-list restriction. Saved setups remain available on the next launch; select and activate one to use it again.

Setups use content hashes rather than filenames, so ratings and renames do not break them. A missing or unavailable preset blocks activation with an explanation. Deleting a saved setup does not delete preset files. Automatic preset changes wait while a management view is open.

Saved setup data lives in `visualizer/avs presets/setups.json` relative to the executable. The staging script preserves an existing installed catalog and preset bank, including filename ratings and not-working marks; rebuilding updates application code and dependencies without restoring old names or clearing marks. Deliberately replacing a preset collection is a separate operation.

## Validation

- Native filesystem fixture: repeated ratings, actual renames, timestamp changes, unchanged AVS bytes, atomic-write rollback, rejected traversal/unknown identities, and reversible not-working flags that preserve rating, filename, and preset timestamp.
- CPU DOM/model fixtures: rating/status/load controls, separate list/playback filters, setup composition/save acknowledgement/reload/activation, malformed settings, backward-compatible thresholds, persistence errors, and panel closing.
- Host and selection fixtures: committed-preset shortcut routing, queued writes, every rating threshold, empty and singleton pools, manual/automatic/setup filtering, timed shuffle, direct retesting, and pending-selection cancellation.
- Existing audio, clock, navigation, safety and lifecycle regressions remain required.

No player, browser, or GPU was launched during implementation. Native compilation and CPU checks do not establish visual, focus, DPI, or live shortcut acceptance in WebView2.
