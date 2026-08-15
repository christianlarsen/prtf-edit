# Change Log

## [0.0.1] - Unreleased

- Initial project skeleton: activation on `dds.prtf` documents, empty "Definition" tree view placeholder.
- Parser and model (`prtf-edit.parser`/`prtf-edit.model`): fixed-column tokenizer for record/field/
  constant lines, indicator AND/OR-group resolution, keyword (attribute) extraction with
  continuation-line support, REFFLD reference-target parsing, and Line/Position resolution
  (explicit or DDS-relative "blank row"/"+n" positioning). Not yet wired to the tree view or preview.
  Validated against a real-world PRTF example covering multiple records, EDTCDE, and SPACEA/SPACEB/
  SKIPA/SKIPB at both record and field level.
- "Definition" tree view wired to the parser: Records > (Attributes, Fields and Constants) >
  (Indicators, Attributes), refreshing on every source edit; clicking a node navigates the source
  editor to its line.
- Read-only page-layout preview (`prtf-edit.preview-record`, inline icon on a record's tree row):
  renders one record's fields/constants at their resolved (row, col) on a character grid, with
  page rows/cols editable in the preview's own toolbar (not derived from DDS — see README).
  Auto-refreshes on source edits. Fields render as a run of `O` (character/date/time) or `6`
  (numeric) — the field name shows as a hover tooltip instead of being spelled out, matching the
  SDA/DFU placeholder convention. The page itself renders white background/black text regardless
  of the editor's theme, like an actual printout, while the toolbar stays plainly styled around it.
- Preview ↔ source bidirectional selection: clicking a field or constant in the preview jumps the
  source editor to its line; moving the cursor in the source switches the preview to whichever
  record it's in and highlights the specific field/constant, without a full panel reload when it's
  still within the record already shown.
- Fixed: clicking inside the preview (or anything else moving focus off a text editor, e.g. the
  terminal) emptied the "Definition" tree, because `vscode.window.activeTextEditor` reports
  `undefined` whenever a non-editor part of the UI has focus and the tree-tracking logic treated
  that the same as "the PRTF file was closed". Now it only clears tracking when the tracked
  document is actually closed (`onDidCloseTextDocument`), matching dspf-edit's own guard.
- Fixed: clicking a field/constant in the preview (or a tree node) could open a second, duplicate
  editor tab for the source instead of reusing the one already open, because `showTextDocument`
  was left to guess the target view column from "the active column" — ambiguous with focus on a
  webview. It now explicitly targets whichever column the source is already visible in.
- Clicking a field/constant in the preview now also reveals and selects it in the "Definition"
  tree (previously it only moved the source cursor). Tree nodes gained stable, data-derived ids
  and the provider implements `getParent()`, which `TreeView.reveal()` needs to walk up to an
  arbitrary node without it already being part of a rendered tree.
- Drag a field or constant in the preview to a new position (`prtf-edit.move-element`): rewrites
  only that line's Line/Position columns (39-44, same column arithmetic as dspf-edit's own
  change-position.ts) via a `WorkspaceEdit`, leaving name/type/length/keywords untouched. Rejects
  (rather than silently pads) source lines too short to contain a Line/Position zone. Clamped to
  the smaller of DDS's own 255 limit and the preview's configured page size. A short drag (under
  4px) is still treated as a click-to-navigate, not a move.
- Fixed: the drag felt jerky compared to dspf-edit's own screen preview. dspf-edit avoids the
  issue entirely by rendering to a canvas; porting that wasn't warranted for one feature, so
  instead the ghost now only writes a CSS transform (compositor-only, no layout recalculation)
  instead of `left`/`top`, and only when the snapped grid cell actually changes — not on every raw
  `mousemove` event, most of which land within the same cell as the last one.
- Reworked "add constant" to match dspf-edit's own preview UX exactly, since a later "add field"
  needs to reuse the identical mechanism: a toolbar "+ Constant" button arms a "placing" mode
  (cursor becomes a crosshair, button highlights) — the *next* click on the page places the
  constant there and disarms placing mode, rather than every click on empty space doing so. This
  also fixes a bug the plain "click empty space" approach caused: ending a drag over empty space
  fired a native `click` there too, incorrectly triggering "add constant" right after every move.
  Prompts for the literal text (rejecting, not silently truncating, text over the 34-character
  single-line limit — longer needs DDS's line-continuation convention, not supported yet), doubles
  embedded single quotes (DDS's own escaping convention), and appends the new line right after the
  record's current last line via a `WorkspaceEdit` insert.
- Fixed: dragging a field/constant could land it a character or so to the right of where it
  visually looked like it would drop. The pixel-to-grid-column math measured the text's starting
  x-coordinate from `.pf-line`'s own bounding box — but that div has `padding: 0 6px`, and
  `getBoundingClientRect()` returns the *outer* box edge, which sits before that padding, not
  where the text itself actually starts. Every computed column was off by that padding. Now
  measured directly from a probe element's own rendered position instead of assumed from the
  line's box, so it's correct regardless of whatever padding `.pf-line` has.
- Added a "+ Field" button reusing the same placing-mode mechanism as "+ Constant"
  (`prtf-edit.add-field`): prompts for a name (validated against DDS naming rules and duplicates
  within the record), a type (A/S/L/T/Z — the v1 keyword scope), and length/decimals where the
  type needs them (skipped for L/T/Z, whose length DDS derives from DATFMT/TIMFMT). Same insertion
  strategy as add-constant. Validated against a real example for all three length-shapes
  (plain-length, length+decimals, derived-length).
- Added a diagnostics pass (`prtf-edit.validation`) that mirrors a real CRTPRTF compile check,
  confirmed against an actual joblog: within one record format, an explicit Line (positions 39-41)
  on any field/constant and a SPACEA/SPACEB/SKIPA/SKIPB keyword at record or field level cannot
  coexist — CRTPRTF rejects the whole record format (CPD5238 "No valid record found in source"),
  flagging the offending space/skip keyword lines (CPD7826) and the line-numbered field/constant
  lines (CPD7860). Surfaces as VS Code diagnostics (Problems panel + editor squiggles) on every
  parse, so the conflict shows up before a round-trip through CRTPRTF instead of after.
- Added `samples/cabecera-report.prtf`: a hand-built, all-explicit-Line/Position record (no
  SPACE/SKIP conflict) with fields, constants, and several keywords (TEXT, UNDERLINE, EDTCDE,
  DATE, PAGNBR) — confirmed via STRRLU on a real IBM i to compile and design cleanly. Used as the
  basis for the three preview fixes below.
- Fixed: a bare system-keyword constant (`DATE`, `TIME`, `PAGNBR` — no quoted literal, coded
  directly in the Line/Position line same as a real DDS example) was parsed as if the keyword text
  itself were the constant's printed value, so the preview showed the raw source text
  (`DATE(*SYS *YY) EDTCDE(Y)`) instead of a placeholder. The parser now recognizes a constant's
  keyword-zone text as a literal only when it's actually quoted (`'text'` or `X'hex'`); otherwise
  it folds the keyword into the constant's own `attributes`, same as a separate keyword-only
  continuation line would. New shared model helpers (`isLiteralConstantValue`,
  `systemKeywordPlaceholder`) keep the parser and the preview's placeholder logic in agreement.
- The preview now renders the `UNDERLINE` keyword (field or constant) as actual underline, and a
  field's hover tooltip includes its `TEXT()` keyword description when present (e.g. "EMPRESA —
  Nombre de la empresa"), not just its name.
- The preview's numeric field placeholder now reflects `EDTCDE` editing at its *worst case* width
  (every digit significant, negative) instead of the field's raw unedited length — e.g. a 9,2
  field with `EDTCDE(J)` now shows `9,999,999.99-` (13 chars) instead of `666666666` (9 chars).
  Matches the convention IBM's own RLU design view uses (fill edited fields with 9s at their
  edited width) — confirmed against a real RLU screenshot for the sample file's `CANTIDAD` and
  `IMPORTE` fields. Covers the standard edit codes (1-4, A-D, J-Q); user-defined codes (5-9, via
  CRTEDTD) fall back to the plain placeholder since their editing can't be resolved without the
  actual object. `PAGNBR`'s placeholder changed from `0001` to `9999` for the same reason (also
  matches the manual's own "page count never grows past 9999").
- Added SPACE/SKIP flow-mode position resolution (`resolveFlowModePositions`, a new pass in
  `prtf-edit.parser`, run after attribute linking so it sees every field/constant's full keyword
  set including separate continuation lines): records with no explicit Line anywhere now get
  absolute rows too, simulating one pass down the page in source order (record-level SKIPB/SPACEB
  sets the start line; each item's own SKIPB/SPACEB/SPACEA/SKIPA move the "current line" around
  it). Previously these fields/constants just stayed unpositioned and invisible in the preview.
  New `PrtfField`/`PrtfConstant.positionSource` ('explicit' | 'flow') distinguishes a real Line
  entry from a flow-simulated one — needed so `prtf-edit.validation`'s Line-vs-SPACE/SKIP conflict
  check doesn't misfire on legitimate flow-mode records (which necessarily use the very keywords
  that check looks for). The preview disables dragging for flow-positioned items (no Line/Position
  zone to rewrite) but keeps click-to-navigate. Validated against a repeating-detail-row record
  (record-level SPACEA(1), several fields chained by "+n" on one row) and a two-row record (a
  field-level SKIPB forcing a mid-record line change), plus a full regression pass confirming
  explicit-mode records and the existing Line/SPACE-SKIP conflict detection are unaffected.
- Added a "Compose sequence" toggle to the preview toolbar (`prtf-edit.record-preview-panel`'s
  `collectComposedPageItems`, backed by a new exported `simulateRecordFlow` in the parser):
  combine several record formats, each with its own repeat count, onto one page instead of
  previewing a single one — e.g. a header once, a detail row three times, a total once. A
  flow-mode entry is re-simulated fresh per repeat with a running "current line" carried across
  the whole sequence (including, for the first time, a record's own *trailing* SPACEA/SKIPA —
  previously skipped since a record previewed alone has no "next" to feed it); an explicit-mode
  entry always renders at its own fixed absolute rows, and hands off the running line at one past
  its highest used row so a following flow-mode entry starts below it without needing its own
  bridging SKIPB. Dragging and "+ Constant"/"+ Field" are disabled while composing — a rewritten
  line wouldn't map cleanly onto one of several repeated occurrences of the same field. Added
  `samples/informe-completo.prtf` (CABECERA + DETALLE + TOTAL in one document) to exercise it —
  composing CABECERA×1 + DETALLE×3 + TOTAL×1 renders header, three clean advancing detail rows,
  and the total with no overlap, validated end-to-end via a Node script against the compiled
  output.
- Fixed: a flow-positioned field/constant (SPACEB/SPACEA/SKIPB/SKIPA — no explicit Line) couldn't
  be dragged at all in the preview, even sideways. Its Position (columns 42-44) is a real,
  independent value regardless of how the row was resolved, so there's no reason horizontal
  dragging shouldn't work — only the row genuinely has nowhere to be written (no Line entry
  exists, and adding one would silently convert it to explicit mode and conflict with the
  record's own SPACE/SKIP keywords). Dragging one of these now moves it sideways only — the row
  snaps back to where it already was — via a new `buildRepositionedColumnOnly` (rewrites Position,
  leaves the blank Line zone untouched) alongside the existing full row+column move. Composing a
  sequence still disables dragging entirely (unrelated reason — a rewritten line wouldn't map
  onto one of several repeated occurrences).
- Added an "Overlay" control to the preview toolbar, mirroring dspf-edit's own overlay feature:
  pick a second record to show dimmed behind the one you're previewing, as a read-only reference
  while you drag or place fields/constants in the active record — e.g. checking a detail row
  doesn't collide with the header above it. The overlaid record's items get no `data-line`
  attribute at all (rather than merely a CSS style), so every click/drag handler — which all key
  off that attribute — ignores them outright; they're listed first in the combined item array so
  the active record's own content always wins ownership of a shared cell. Not offered while
  composing a sequence (a different, already-combined view). Switching which record is being
  previewed clears the overlay selection, avoiding a stale pointer at what's now the active
  record.
- Fixed: the overlay showed the two records independently — each positioned as if previewed
  alone, so a flow-mode detail row and its header both started around row 1 and landed stacked on
  top of each other instead of showing how they'd actually look combined. Overlay now chains the
  active record right after the overlaid one, via the same positioning logic "Compose sequence"
  uses for two entries in a row (refactored the shared per-record chaining into a new
  `positionRecordEntry`, used by both `collectComposedPageItems` and the new
  `collectPageItemsWithOverlay`) — e.g. previewing a detail row with its header overlaid now shows
  the detail row starting right below the header's own content, not on top of it. Only the
  overlay's items are still non-interactive; the active record keeps its normal drag/click
  behavior. An explicit-mode active record is unaffected either way, same as before — its Line/
  Position is absolute regardless of what's overlaid behind it.
- Fixed: the overlay always chained the *active* record after the overlaid one, so which record
  came first on the page depended on which one you happened to be editing — previewing CABECERA
  with DETALLE overlaid showed DETALLE restarting at line 1 instead of below CABECERA, even though
  previewing it the other way around (DETALLE active, CABECERA overlaid) correctly showed the same
  two records lined up properly. `collectPageItemsWithOverlay` now orders the two by which record
  is declared earlier in the DDS source, regardless of which one is active — so both directions of
  previewing the same pair render identically. Ownership of a shared cell still always goes to the
  active record's items (appended last regardless of chaining order), so dragging is never
  shadowed by the read-only overlay layer.
- Added page-break / overflow handling to "Compose sequence" (`prtf-edit.record-preview-panel`):
  a new "Overflow" toolbar field (visible only while composing, defaulting to Rows — OVRFLW/page
  length) rolls composed content onto a fresh page once it would go past that line, rendered as a
  separate labeled sheet below the first ("Page 2", "Page 3", ...) instead of silently clipping at
  the bottom of the one page like before. Implemented by treating a DDS Line number as genuinely
  page-relative (1 to the overflow/page length, not a total that keeps growing across pages) and
  wrapping `collectComposedPageItems`'s running "current line" accordingly — a real reflection of
  how DDS positioning works, not just a display trick. A single record instance's own content is
  never split across two pages: if positioning it where the page currently stands would overflow,
  and the page isn't already empty, the whole instance restarts fresh at the top of the next one
  instead (an explicit-mode record's own fixed absolute row still renders exactly as coded, just
  on whichever page that roll-over lands it on). Added support for the `ENDPAGE` keyword — an
  unconditional page eject right after the record it's on prints, regardless of the Overflow
  threshold. `PageItem` gained a `page` number (defaulting to 1, so single-record and overlay
  preview — neither of which paginate — render exactly as before). Validated: a composed sequence
  overflowing mid-run rolls cleanly onto page 2 continuing from line 1 there; an explicit-mode
  total whose fixed row falls past the overflow line correctly lands on the next page instead of
  being clipped; three repeats of a record carrying `ENDPAGE` each land on their own page
  regardless of a generous overflow threshold.
- Added long-constant support to "+ Constant" (`prtf-edit.add-constant`): text that doesn't fit
  in one line's 36-column keyword zone (columns 45-80) now splits across DDS's own
  keyword-continuation convention (a trailing '-') instead of being rejected outright. New
  `buildConstantLines` (replacing the old single-line `buildConstantLine`) mirrors exactly what
  the parser's own `extractMultiLineConstant` already reads back, so an added long constant
  round-trips correctly; only the first line carries the Line/Position entry, every continuation
  line is a bare keyword-only line (form-type `A` in column 6, same as any other multi-line DDS
  attribute in this codebase). Caught and fixed a bug during validation: continuation lines were
  initially built with column 6 left blank instead of `A`, harmless to this project's own lenient
  parser (which doesn't check it) but not a real DDS line. Validated: a short constant renders
  identically to before (single line, no dash); text just over/under the 36-character boundary;
  a genuinely long constant with an embedded quote spanning 5 lines; a 120-character constant
  spanning 4 — all round-trip through the parser to the exact original text, row, and column.
- Rendered `COLOR` and `HIGHLIGHT` in the preview, alongside the existing `UNDERLINE`. `COLOR`'s
  named-color form (BLK/BLU/BRN/GRN/PNK/RED/TRQ/YLW) maps to a legible CSS color — YLW renders as
  a darker gold rather than pure yellow, since real yellow ink is about as hard to read on white
  paper and an unreadable preview isn't useful; the RGB/CMYK/CIELAB/Highlight color models are
  device-calibrated numeric values with no simple mapping, so those fall back to the default
  color, the same scope boundary already drawn around EDTCDE's user-defined edit codes. `HIGHLIGHT`
  renders bold, and — unlike `UNDERLINE`/`COLOR`, which are field-only — is honored at both record
  and field level (a record-level `HIGHLIGHT` applies to every field in that record, per the DDS
  reference), so `buildFieldPageItem`/`buildConstantPageItem` now take the owning record's
  attributes as well as the item's own. Validated against a record combining record-level
  `HIGHLIGHT` with a field-level `COLOR(RED)`, a field with neither of its own (inheriting bold
  from the record only), and a constant with its own `COLOR(BLU)` and `HIGHLIGHT` — all three
  resolved bold/color correctly.
- Added a "repeat per page" checkbox to each "Compose sequence" row: once that entry's own turn
  in the sequence has been positioned, every *later* page break (from overflow or `ENDPAGE`,
  triggered by anything else in the sequence) re-renders that record's content at the top of the
  new page first, before whatever caused the break continues — the standard "page header repeats
  automatically" pattern, without needing a manual entry per page. Registered as a "standing
  header" only after its own first occurrence (so it doesn't also trigger on its own placement),
  tracked in `collectComposedPageItems` and applied via a new `startNewPage()` helper shared by
  both the overflow and `ENDPAGE` roll-over paths, so the two stay in sync automatically. Validated
  against a header marked to repeat with ten detail-row repeats forcing two pages: the header's
  own field appears once per page, right above the continuing detail rows on each.
- Housekeeping pass: removed a whole parallel data mirror (`records`, `fieldsPerRecords`,
  `attributesFileLevel` global arrays, the `FieldInfo`/`ConstantInfo`/`AttributeWithIndicators`/
  `FieldsPerRecord` types, and the parser functions that only existed to populate them —
  `linkFieldsAndConstantsToRecords`, `addFieldToRecord`, `addConstantToRecord`,
  `processFileAttributes`, `syncRecordAttributes`) that dated back to mirroring dspf-edit's
  original structure but nothing in prtf-edit — the tree, the preview, the commands — ever
  actually read; the flat `PrtfElement[]` array from `parseDocument` turned out to be all any of
  them needed. Also removed `currentPrtfElements` (assigned, never read) and the unused `PrtfGroup`
  model type/union member it was the only producer of, and `ExtensionState.lastPrtfEditor` (written
  on every editor change, never read anywhere). `assignRecordEndIndices` keeps only the half of it
  that's actually live (`PrtfRecord.endIndex`, used by "+ Constant"/"+ Field" to find where to
  insert). Confirmed via full-project grep that nothing referenced any of it, and the entire
  regression suite (17 scripts) still passes unchanged. Also refreshed README.md's "Status" line
  and two "Key findings" entries, which had been left describing the project as it stood before
  Fase 3 (before the preview existed at all) and before Fase 6c respectively.
- Reorganized the preview toolbar into stacked rows, mirroring dspf-edit's own preview layout:
  an info/Focus row, a "what am I looking at" selectors row (Compose sequence, Record, Overlay),
  an actions row (Rows/Cols/Overflow, "+ Constant"/"+ Field"), and the sequence editor row (shown
  only while composing) — instead of one wide flex row that wrapped unpredictably as controls were
  added over several iterations. Added a "Focus" button, ported directly from dspf-edit's own
  implementation: maximizes the preview's editor group (`workbench.action.toggleMaximizeEditorGroup`)
  so it fills the editing area, hiding the DDS source editor beside it — the Definition tree isn't
  part of the editor grid, so it stays visible — and toggles to "Show code" to bring the split view
  back. (dspf-edit doesn't have a separate "View Source" button; Focus/Show code, the same button
  in its two states, is that mechanism.) Unlike dspf-edit — which sets the webview's HTML once and
  pushes all later updates via postMessage — this preview rebuilds its HTML on every render, so the
  focus state is threaded into the template itself (not just handled via postMessage) to survive
  an unrelated re-render (e.g. a source edit) without the button relabeling itself back to "Focus"
  while the editor group is still actually maximized.
- Simplified the preview toolbar per feedback: row 1 now holds only the "Focus" button (dropped
  the record name/page size info text); the standalone "Record" selector is gone entirely — the
  previewed record now follows the source cursor or a Definition tree selection, same as
  dspf-edit's own preview (which has no such selector either). "Compose sequence" still lets you
  pick specific records, via each sequence row's own select (now built from a small
  server-injected record-name list instead of cloning the removed selector's options). Reordered
  the remaining rows so Record-adjacent selectors (Overlay, Compose sequence — Compose last within
  its row) sit at the bottom, below the actions row, so turning "Compose sequence" on only adds
  content below everything else instead of shifting rows above it.
- Fixed: turning "Focus" on (maximizing the preview's editor group, hiding the DDS source editor)
  and then clicking a Definition tree node brought the source editor back — because tree-click
  navigation went through `vscode.window.showTextDocument`, which surfaces whatever view column
  it's asked to show, undoing the maximize just to move the cursor. Ported the fix from dspf-edit
  verbatim: a new `RecordPreviewPanel.revealInSourceEditor` (mirroring dspf-edit's own
  `revealInSourceEditor`) checks `isFocusModeActive()` first and, when it's on, updates the tracked
  source editor object's `.selection`/`.revealRange()` directly instead of calling
  `showTextDocument` — so the cursor moves without surfacing the hidden group. Needed
  `ExtensionState.lastPrtfEditor` back (the tracked-editor field removed as dead code in the
  housekeeping pass two entries up) — this time actually wired to a real consumer, matching
  dspf-edit's own `lastDdsEditor`. `prtf-edit.navigation.ts`'s `revealLine` (used by the tree
  view's own click handler) is now a thin wrapper delegating to this same method, so both
  navigation paths behave identically; the preview panel's own click-to-navigate calls it directly
  (dropped its `revealLine` import — the two modules now depend on each other only inside function
  bodies, which is fine for a same-process VS Code extension, and confirmed to resolve correctly
  by requiring both compiled modules directly).
- Removed the "Help" collapsible from the preview — decided it wasn't earning its keep.
- Added a "📏 Ruler" toggle to the preview toolbar, in the spirit of dspf-edit's own "Grid" button
  but showing row numbers and a column ruler (the column number every 5 columns) instead of a dot
  grid — so a field's Line/Position can be read straight off the page. New `buildColumnRuler(cols)`
  builds the ruler text; the row-number gutter is built alongside it in `getHtml`. Both render as
  siblings of `.page` in a small CSS grid (auto-collapsing to just `.page` when the toggle is off),
  never injected into `.page` itself — toggling them can't touch the drag/measure column math,
  which reads `.pf-line`'s own layout and already had to be hard-won correct once. Verified this
  holds even with the ruler on: `measure()` re-derives `padLeft`/`padTop` fresh from a live probe
  relative to `#page`'s current bounding box on every drag, rather than assuming a fixed offset, so
  it self-corrects for the wider/taller `#page` box the ruler adds. Tracked server-side (like
  "Focus") only so the toggle survives a re-render; the toggle itself is pure CSS, no
  recomputation needed. Validated the ruler text's alignment (e.g. "10" ends exactly at column 10)
  and the generated markup's tag balance against a real grid.
