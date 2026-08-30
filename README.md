# PRTF-edit

[![Visual Studio Marketplace Version](https://vsmarketplacebadges.dev/version/ChristianLarsen.prtf-edit.svg)](https://marketplace.visualstudio.com/items?itemName=ChristianLarsen.prtf-edit)
[![Installs](https://vsmarketplacebadges.dev/installs/ChristianLarsen.prtf-edit.svg)](https://marketplace.visualstudio.com/items?itemName=ChristianLarsen.prtf-edit)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE.md)

**PRTF-edit** brings a live structure view, a drag-and-drop print-layout preview, and guided DDS keyword editing to IBM i **printer files** — right inside VS Code. No more counting columns by hand, no more round-trips through STRRLU on a 5250 session, no more guessing how a `SKIPB`, an indicator condition, or an `EDTCDE` will actually print until you compile.

PRTF-edit doesn't replace your compiler — it closes the gap between writing DDS and seeing the report it produces, so what you preview lines up with what actually prints.

---

## ✨ Features

### Definition tree
- A dedicated **PRTF Structure** view in the Activity Bar lists the file itself, every record format, field, and constant in the open source, grouped and kept in sync automatically as you type.
- The **File** node shows the source member's own name and its file-level attributes.
- Click any item to jump straight to its line in the source.
- Records, fields, and constants each show a short summary right in the tree (position, indicators, ...).
- Right-click menus let you create, rename, copy, and delete records, fields, and constants without hand-editing the source (see **Editing from the tree** below).

### Page-layout preview
- Click the preview icon on a record to open a print-style simulation of its layout, rendered on a character grid at the page size you choose (rows × columns, default 66×132).
- Fields show as `O` or `6` placeholders (the familiar SDA/DFU convention) — hover one for its name and description. A numeric field with an edit code (`EDTCDE`) is shown at its worst-case edited width (commas, sign), not just its raw length.
- `COLOR`, `HIGHLIGHT`, and `UNDERLINE` render visually, at both record and field level.
- Drag a field or constant anywhere on the page to reposition it — the preview understands both records positioned with an explicit Line/Position and "flow" records positioned via `SKIPB`/`SPACEB`/`SPACEA`/`SKIPA`, adjusting whichever applies, including a file-level `SKIPB`/`SKIPA` cascading into every record the way real DDS applies it.
- **"+ Field" / "+ Constant"**: click the button, then click a spot on the page to place a new one there. A long constant automatically splits across DDS's own continuation convention.
- Select a field or constant on the page to edit it right there: **"🗑 Delete"** removes it entirely, **"🎨 Attributes"** sets or clears `TEXT`/`COLOR`/`HIGHLIGHT`/`UNDERLINE`/`EDTCDE`/`FONT`/`CHRID` from a simple picker, **"↕️ Spacing"** sets or clears its own `SKIPB`/`SPACEB`/`SPACEA`/`SKIPA` — no need to open the tree or remember DDS keyword syntax. Clicking empty space clears the selection.
- Right-clicking a field or constant also opens the spacing editor directly, with the option to convert an explicit-Line record to flow positioning in one step.
- **"Overlay"**: show another record dimmed behind the one you're editing, to check alignment between them — e.g. a header against the detail line printed below it. A **"🔁 Repeat"** toggle tiles the overlay down the whole page, so it stays visible even after a totals record's own `SKIPB` pushes it far down.
- **"Compose sequence"**: preview several record formats together — each with its own repeat count — the way they'd actually print one after another (a header, several detail rows, a total line), with automatic page breaks once the content passes your configured page length, and optional repeating "standing" headers on every new page.
- **"Indicators"**: simulate which indicators are on or off, to see exactly which fields, constants, and keywords would print — including how a conditioned `SKIPB`/`SPACEB`/`SPACEA`/`SKIPA` shifts everything printed after it, and indicators used only on a record-, or file-level keyword with no field of its own. Only shown when the record you're viewing actually uses indicators.
- **Spacing at a glance**: a field or constant with its own `SKIPB`/`SPACEB`/`SPACEA`/`SKIPA` shows a small "S" marker, even before you select it. Select it and its keyword(s) appear as toggle buttons right under Indicators — lit blue when their own indicator condition is currently satisfied — click one to change its value directly. The record and the file get the same treatment: an "S" pinned to the page's corner for the record's own spacing, and a "📄 S" in the toolbar for the file's.
- **"📏 Ruler"** for row/column numbers alongside the page, **"🗖 Focus"** to hide the source editor and concentrate on the preview.

### Editing from the tree
Right-click any record, field, or constant in the Definition tree:
- **File** — edit Spacing (`SKIPB`/`SKIPA`, the only two spacing keywords valid at file level), applied before/after every record format the way real DDS does.
- **Records** — New, Rename, Copy, Delete, edit Attributes (`HIGHLIGHT`/`ENDPAGE`/`FONT`), edit Spacing (`SKIPB`/`SPACEB`/`SPACEA`/`SKIPA`).
- **Fields** — Rename, Copy, Delete, edit Attributes, edit Indicators.
- **Constants** — Edit Text (its own literal text), Fill to Width of... (pad it with spaces to match another field's or constant's printed width, anywhere in the file — handy for lining up a header label with the field printed below it), Copy, Delete, edit Attributes, edit Indicators.
- **Attributes**: for a field/constant, `TEXT`, `COLOR`, `HIGHLIGHT`, `UNDERLINE`, `FONT`, and — for numeric fields and `PAGNBR` — `EDTCDE`, plus `CHRID` for non-numeric fields, the same simple picker as the preview's own "🎨 Attributes" button; for a record, `HIGHLIGHT`, `ENDPAGE`, and `FONT`, the keywords the preview understands at record level. A graphic `FONT` name and `CHRID` can't apply to the same field per DDS — setting one while the other is already in effect (directly, or inherited from the record's own `FONT`) is blocked with an explanation, instead of silently writing a combination DDS would just ignore.
- **Spacing** (records and file): the same `SKIPB`/`SPACEB`/`SPACEA`/`SKIPA` editor a field/constant already gets from the preview, for the record format or the whole file.
- **Indicators**: condition a field, constant, or keyword — including a record's own attribute — on up to 9 ANDed indicators, or add an OR'd alternative — DDS's own continuation-line rules for indicators are handled for you automatically.
- Copying a field or constant that carries its own `SKIPB`/`SPACEB`/`SPACEA`/`SKIPA` asks whether to bring that spacing along, since it describes where the item sits *relative to whatever's before it*, not a property of the item itself.

### Diagnostics
- The Problems panel flags a record format that mixes an explicit Line entry with `SPACEA`/`SPACEB`/`SKIPA`/`SKIPB` — DDS doesn't allow combining the two positioning styles in the same record, and this is caught before you ever try to compile it.

---

## 🚀 How to Use

1. Open a DDS printer file source (language id `dds.prtf`) in VS Code.
2. Click the **PRTF Structure** icon in the Activity Bar.
3. The **Definition** view appears automatically, showing the file, its records, fields, and constants.
4. Click any item to jump to it in the source, or use the preview icon on a record to open its **Page-Layout Preview**.

---

## ⚙️ Requirements

- Visual Studio Code **v1.75** or higher.
- Recommended: the [Code for IBM i](https://marketplace.visualstudio.com/items?itemName=HalcyonTechLtd.code-for-ibmi) extension, for source member access and the `dds.prtf` language id.

---

## 🐞 Known Issues

This extension is under active development — some DDS keywords aren't supported yet (see **To Do** below). Please [open an issue](https://github.com/christianlarsen/prtf-edit/issues) if something isn't working as expected!

---

## 📝 To Do

- Wider keyword coverage — most of what's left is the large AFPDS-only graphics/resource surface (`AFPRSC`, `BOX`, `LINE`, `GDF`, `OVERLAY`, `PAGSEG`, `POSITION`, barcodes, DBCS), which is out of scope for now.
- Remaining printer-control keywords not yet editable from the tree: `PRTQLTY`, `LPI`, `CPI`, `DUPLEX`, `DRAWER`, `OUTBIN`, `CDEFNT`, `CHRSIZ`, `DFNCHR`, `FNTCHRSET`, `FONTNAME`, `CCSID`, and a handful of others.
- Persisting STRRLU-style "compilation data" (`DEVTYPE`, `PAGESIZE`, lines/characters per inch, overflow line, ...) directly in the source, the way STRRLU itself does — RDi doesn't offer this either, so it'd be a genuine gap this extension could close.
- Bug fixes as they turn up.
- Many new features to come!

---

## 📦 Version History
See the full changelog [here](./CHANGELOG.md).

### Latest
**0.2.2** - 2026-08-30
- Clicking a record's own name in the "Definition" tree no longer forces it open — selecting it just selects it now; the disclosure arrow (or "Expand All") is what expands. Selecting a field or constant from the preview still opens the tree down to it, as before.
- The preview's page size now starts from the file's own `PAGESIZE` keyword when declared, or auto-fits every field/constant in the file, instead of always starting at a fixed 66x132 that could clip wider (e.g. landscape) reports.
- Fixed a constant whose Position lands alone on its own line, with keywords like `SPACEB`/`UNDERLINE`/`HIGHLIGHT` coded before its literal text (a shape RLU itself produces) — the first keyword no longer shows up as a bogus extra constant in the tree and preview.

---

## ⭐ Enjoying PRTF-edit?

If it's saving you trips to SEU or STRRLU, please consider [leaving a rating on the Marketplace](https://marketplace.visualstudio.com/items?itemName=ChristianLarsen.prtf-edit&ssr=false#review-details) — it takes 10 seconds and is the single biggest thing that helps other IBM i developers find it.

💬 **Feedback is welcome!** Please leave a comment, [open an issue](https://github.com/christianlarsen/prtf-edit/issues), and enjoy using PRTF-edit.
