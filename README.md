# PRTF-edit

**PRTF-edit** is a Visual Studio Code extension that helps IBM i developers when creating or modifying DDS source files for **printer files**.

The extension provides a **navigable schema view** of the DDS source file that is automatically updated whenever the source changes, plus a page-layout preview that simulates how the record formats will actually print.

---

## ✨ Features

- **Schema navigation**
  - "Definition" tree view: Records > (Attributes, Fields, Constants) > (Indicators, Attributes).
  - Click on schema elements to jump directly to their location in the source.
  - Auto-refreshes on every source edit.

- **Page-Layout Preview**
  - Visual, print-style preview of a record's fields and constants, rendered on a character grid — page size (rows/cols) editable in the toolbar (default 66×132).
  - Fields render as `O` (character/date/time) or `6` (numeric) placeholders, the SDA/DFU convention — hover a field for its name and `TEXT()` description.
  - The page renders white background/black text regardless of editor theme, like an actual printout.
  - Drag fields/constants to reposition them directly on the preview (rewrites only the Line/Position columns, leaving name/type/length/keywords untouched).
  - "+ Field" / "+ Constant" buttons: click, then click a point on the page to place a new field/constant there. Long constants automatically split across DDS's own keyword-continuation convention.
  - "🗑 Delete": removes a selected field/constant's entire source block.
  - Right-click "Edit spacing": set or clear a field/constant's own `SKIPB`/`SPACEB`/`SKIPA`/`SPACEA` directly, with an option to convert the whole record to `SKIPB`-based positioning at once.
  - **Flow-mode support**: records positioned via `SPACEB`/`SPACEA`/`SKIPB`/`SKIPA` (no explicit Line) are normalized to absolute rows by simulating the page flow. Flow-positioned items can be dragged both vertically and horizontally, including reordering past a preceding item when a drag needs to move it earlier than its own spacing allows.
  - "Overlay": show a second record dimmed behind the one being edited, to see how they compose.
  - "Compose sequence": combine several record formats — each with its own repeat count — onto a single simulated page, in order (e.g. a header once, a detail row several times, a total once). Supports "repeat per page" for header-style entries.
  - Page-break / overflow: an "Overflow" toolbar field rolls composed content onto additional simulated pages once it exceeds the page length, honoring the `ENDPAGE` keyword.
  - Renders `UNDERLINE`, `COLOR` (named-color form), and `HIGHLIGHT` (record- and field-level); numeric fields render at their `EDTCDE`-edited worst-case width, matching IBM's own RLU design-view convention.
  - "📏 Ruler" toggle: row numbers and a column ruler alongside the page.
  - "Focus" button: maximizes the preview and hides the source editor (the Definition tree stays visible).
  - Stays in sync with the schema tree and source cursor in both directions.

- **Diagnostics**
  - Problems panel: flags a record format that mixes an explicit Line with a `SPACEA`/`SPACEB`/`SKIPA`/`SKIPB` keyword — confirmed against a real `CRTPRTF` joblog to be a hard compile error (CPD5238/CPD7826/CPD7860), not just bad style.

---

## 🚀 How to Use

1. Open a DDS printer file source (`dds.prtf`) in VS Code.
2. Click the **PRTF Structure** icon in the Activity Bar.
3. The **Definition** view appears automatically, showing your records, fields, and constants.
4. Use **left-click** to navigate to a source line, or the inline preview icon on a record to open the **Page-Layout Preview**.

---

## ⚙️ Requirements

- Visual Studio Code **v1.75** or higher.
- Recommended: the [Code for IBM i](https://marketplace.visualstudio.com/items?itemName=HalcyonTechLtd.code-for-ibmi) extension, for source member access and the `dds.prtf` language id.

---

## 🐞 Known Issues

This extension is currently in **preview**.
Some features may not work as expected. Please leave an issue if something is not working fine!

---

## 📝 To Do

- Bug fixes.
- Wider keyword coverage: the large *AFPDS-only graphics surface (`AFPRSC`, `BOX`, `LINE`, `GDF`, `OVERLAY`, `PAGSEG`, `POSITION`, barcodes, fonts, DBCS) is out of v1 scope.
- `PRTQLTY`/`LPI`/`CPI`/`DUPLEX`/`DRAWER`/`OUTBIN` support.
- Many new features to come!

---

## 📦 Version History
See the full changelog [here](./CHANGELOG.md).

### Latest
**0.0.1** - 2026-08-17
- First release.

---

💬 **Feedback is welcome!** Please leave a comment, open an issue, and enjoy using PRTF-edit.
