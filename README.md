# Printer File DDS edit

VS Code extension to create and modify DDS **printer files** (PRTF) on IBM i — sibling project to
[dspf-edit](https://github.com/christianlarsen/dspf-edit) (display files), reusing its architecture
and, where it makes sense, its patterns and code.

Status: parses PRTF source into records/fields/constants and shows them in a live "Definition" tree
view (click a node to jump to its source line). No preview yet — that's Fase 3.

## Why a separate project instead of extending dspf-edit

DSPF is an interactive, absolute-position screen (row/col given directly, input fields, function
keys, windows, subfiles). PRTF is a page-based, non-interactive stream: vertical position is
usually *relative* (SPACEA/SPACEB/SKIPA/SKIPB advance a line cursor), there's page size/overflow
instead of a fixed screen, and no windows/subfiles/colors. The preview — the core of dspf-edit — has
to simulate a layout engine instead of just painting a fixed grid, so it's a different problem
underneath a similar shell. Starting as its own repo avoids forcing that divergence into dspf-edit's
codebase; genuinely-reusable pieces (IBM i connection glue, DDS fixed-column tokenizer basics) get
copied over and adapted rather than shared via a package, unless/until duplication actually becomes
painful.

## Roadmap

- [x] Fase 0 — Scaffold: repo, activation on `dds.prtf`, empty tree view.
- [x] Fase 0b — Spec confirmed against the official "DDS for printer files" reference (IBM i 7.2).
      See "Confirmed column layout" and "Key findings" below.
- [x] Fase 1 — Parser + model: fixed-column tokenizer, record/field/constant tree, line/position
      resolution. Validated against a real-world PRTF example (see `CHANGELOG.md`). SPACE/SKIP flow
      mode isn't normalized to absolute coordinates yet — deferred to Fase 3, since real-world PRTF
      source overwhelmingly uses explicit Line/Position (same style as DSPF).
- [x] Fase 2 — Definition tree view wired to the real parser: Records > (Attributes, Fields and
      Constants) > (Indicators, Attributes), click-to-navigate to the source line.
- [x] Fase 3 — Preview, read-only: one page, one record, via the record's inline preview icon in
      the tree. Page rows/cols are set in the preview's own toolbar (decided against a CPI/LPI
      control — Line/Position are already character/line units in the base line/position mode this
      preview renders, so CPI/LPI don't affect the grid; they'd only matter for the *AFPDS-only
      inch-based `POSITION` keyword, out of v1 scope). Fields render as O (character/date/time) or
      6 (numeric), the SDA/DFU placeholder convention — hover a field for its name. The page itself
      is white/black regardless of editor theme, like an actual printout. Auto-refreshes on edits.
- [x] Fase 4 — Preview, interactive: click a field/constant in the preview to navigate to its
      source line and select it in the "Definition" tree; moving the cursor in the source switches
      the preview to that record and highlights the field/constant it's on.
- [x] Fase 5 — Preview, editing: drag a field/constant in the preview to reposition it, rewriting
      only its Line/Position columns (39-44) — name, type, length and keywords are left untouched.
      A toolbar "+ Constant" button arms a placing mode (crosshair cursor); the next click on the
      page adds a new constant there (prompts for the text, splitting it across DDS's own
      keyword-continuation convention — a trailing '-' — when it doesn't fit one line's 36-column
      keyword zone) — same click-to-place mechanism dspf-edit's own preview uses. A "+ Field" button reuses the identical mechanism, chaining
      prompts for name (validated, no duplicates), type (A/S/L/T/Z — the v1 keyword scope), and
      length/decimals where applicable (blank/derived for L/T/Z, per DATFMT/TIMFMT defaults).
      Diagnostics (Problems panel): flags a record format that mixes explicit Line numbers with a
      SPACEA/SPACEB/SKIPA/SKIPB keyword at record or field level — confirmed against a real
      CRTPRTF joblog to be a hard compile error (CPD5238/CPD7826/CPD7860), not just bad style.
- [x] Fase 6a — SPACE/SKIP flow-mode positioning: records with no explicit Line anywhere (only
      SPACEB/SPACEA/SKIPB/SKIPA) are now normalized to absolute rows too, not just explicit-Line
      records. Simulates one pass down the page in source order — a record-level SKIPB/SPACEB sets
      the starting line, each field/constant's own SKIPB/SPACEB (before) and SPACEA/SKIPA (after)
      advance the "current line" around it, and anything with neither just continues on the
      current line (the common case: several fields on one repeating detail row, chained by
      `+n` position, advancing together via a single record-level SPACEA). Dragging is disabled
      for these items in the preview (there's no Line/Position zone to rewrite) — click-to-navigate
      still works.
- [x] Fase 6b — Multi-record composition: a "Compose sequence" toggle in the preview toolbar lets
      you combine several record formats — each with its own repeat count (e.g. CABECERA once,
      DETALLE three times, TOTAL once) — onto a single page, in order. A flow-mode entry is
      re-simulated per repeat, chaining the running "current line" (including its own trailing
      SPACEA/SKIPA) across the whole sequence; an explicit-mode entry renders at its own fixed
      rows every time, and advances the running line to just past its highest row for whatever
      follows (a preview convenience — real DDS has no such automatic hand-off, so a genuine
      overlap between two flow-mode entries that don't coordinate their own keywords still shows
      as one). Editing (drag, "+ Constant"/"+ Field") is unavailable while composing.
      Also added an "Overlay" control (mirrors dspf-edit's own): show a second record dimmed and
      read-only behind the one you're editing, chained in the same page-order logic as "Compose
      sequence" regardless of which of the two is active, so dragging in the active record can be
      checked against the other without switching views.
- [x] Fase 6c — Page-break / overflow: a "Overflow" toolbar field (shown only while composing —
      OVRFLW/page length) rolls composed content onto a new page, rendered as a separate sheet
      below the first, once it would go past that line — a Line number is inherently page-relative
      in real DDS (1 to PAGESIZE), not a total that keeps growing, so this genuinely models
      pagination rather than just improving the display. A single record instance is never split
      across two pages — if it would overflow the current one, it restarts fresh at the top of the
      next. The `ENDPAGE` keyword forces that same roll-over unconditionally, right after the
      record it's on prints, regardless of the Overflow threshold.

## Confirmed column layout (positions 1-80)

Identical to DSPF for positions 1-44 except where noted — same tokenizer applies:

| Positions | Meaning | PRTF-specific notes |
|---|---|---|
| 1-5 | Sequence number | |
| 6 | Form type | |
| 7-16 | Condition (indicators) | same AND/OR/NOT rules as DSPF |
| 17 | Name type | `R` = record format, blank = field |
| 18 | Reserved | |
| 19-28 | Name | blank = constant (or `*NONE` when POSITION keyword used) |
| 29 | Reference | `R` copies attributes from a REFFLD/REF-named field |
| 30-34 | Length | blank for L/T/Z types (length comes from DATFMT/TIMFMT) |
| 35 | Data type | `S A F L T Z` (+ `O`/`G` for DBCS/UTF-16) — **no packed/binary**: referenced packed/binary fields are converted to zoned (S) |
| 36-37 | Decimal positions | |
| 38 | Usage | **`O`/blank (output-only) or `P` (program-to-system) only** — no `I`/`B`/`H` like DSPF, since PRTF has no input |
| 39-41 | Line | absolute row on the page |
| 42-44 | Position | absolute column; blank + `+n` = n spaces after the previous field's end |
| 45-80 | Keywords | |

## Key findings from the spec review

1. **Two mutually exclusive layout modes per record format.** Either every field on the record
   gets an explicit Line (39-41), or none do and layout flows via SKIPB/SPACEB/SKIPA/SPACEA plus
   source order — mixing the two within one record format is invalid. In practice most real-world
   PRTF source (see example below) uses the absolute-line style almost identically to DSPF, so the
   parser/preview can treat that as the common case and treat SPACE/SKIP-driven flow as a
   normalization pass that resolves to the same absolute (line, col) model before rendering.
2. **Page size is not in the DDS source.** Unlike DSPF's `DSPSIZ` keyword, there is no PRTF DDS
   keyword for page length/width — those come from the `PAGESIZE` parameter on the `CRTPRTF` /
   `CHGPRTF` / `OVRPRTF` commands (same for `OVRFLW`, and the default CPI/LPI/FONT). DDS-level `CPI`
   and `LPI` keywords can *override* the file-level default per record, but there's no default in
   the source itself. **Open question for Fase 3**: default to common values (e.g. 66 lines ×
   132/198 chars), let the user set page size/CPI/LPI in the preview toolbar, and/or query the
   actual `CRTPRTF` attributes via SQL (`QSYS2`) when connected — needs a decision before building
   the preview.
3. **v1 keyword scope** (SCS/base — excludes the large *AFPDS-only graphics surface: AFPRSC, BOX,
   LINE, GDF, OVERLAY, PAGSEG, POSITION, barcodes, fonts/CDEFNT/FNTCHRSET, color, DBCS): `SKIPB`,
   `SKIPA`, `SPACEB`, `SPACEA`, `EDTCDE`, `EDTWRD`, `DATE`, `TIME`, `PAGNBR`, `DFT`, `REF`,
   `REFFLD`, `DLTEDT`, `TEXT`, indicators. `PRTQLTY`/`LPI`/`CPI`/`DUPLEX`/`DRAWER`/`OUTBIN` are
   cheap to support alongside since they're simple value keywords with no layout impact.
4. **Position 38 `P` (program-to-system) fields never print** — they only pass values into other
   keywords' parameters at runtime (e.g. `AFPRSC`'s resource-name, `BARCODE`'s PDF417 macro data).
   The model needs a flag for this so the preview knows to skip rendering them.

## Development

```bash
npm install
npm run watch   # or F5 in VS Code to launch the Extension Development Host
```

Requires the [Code for IBM i](https://marketplace.visualstudio.com/items?itemName=HalcyonTechLtd.code-for-ibmi)
extension for source member access and the `dds.prtf` language id.
