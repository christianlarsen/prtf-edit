/*
	Christian Larsen, 2026
	"PRTF structure"
	prtf-edit.record-preview-panel.ts
*/

import * as vscode from 'vscode';
import { PrtfElement, PrtfField, PrtfConstant, PrtfRecord, PrtfFile, PrtfAttribute, PrtfIndicator, systemKeywordPlaceholder, findTextKeyword, groupIndicatorsByCondition } from '../prtf-edit.model/prtf-edit.model';
import { simulateRecordFlow } from '../prtf-edit.parser/prtf-edit.parser';
import { ExtensionState } from '../prtf-edit.states/state';
import { revealInTree } from '../prtf-edit.providers/prtf-edit.providers';
import { moveElement } from '../prtf-edit.commands/prtf-edit.move-element';
import { addConstantAt } from '../prtf-edit.commands/prtf-edit.add-constant';
import { addFieldAt } from '../prtf-edit.commands/prtf-edit.add-field';
import { editSpacing, editRecordSpacing, editFileSpacing, keywordPattern, SPACING_KEYWORDS, FILE_SPACING_KEYWORDS } from '../prtf-edit.commands/prtf-edit.edit-spacing';
import { deleteElement } from '../prtf-edit.commands/prtf-edit.delete-element';
import { editAttributes } from '../prtf-edit.commands/prtf-edit.edit-attributes';

/** Default page size (66 lines is the traditional 11" @ 6 LPI page; 132 columns is 10 CPI on
 * standard wide computer paper — both just starting points, editable in the toolbar). */
const DEFAULT_ROWS = 66;
const DEFAULT_COLS = 132;

interface PageItem {
	row: number;
	col: number;
	text: string;
	/** Source line to navigate to / highlight from — a field's own line, or a constant's first
	 * line (its literal text may continue across several). */
	lineIndex: number;
	/** Shown as a hover tooltip over this item's cells: a field's name (plus its TEXT() keyword
	 * description, if any), or a constant's TEXT() description alone (its own text already says
	 * what it prints, so it only gets a tooltip when there's documentation to add). */
	title?: string;
	/** True when the field/constant carries the UNDERLINE keyword — rendered with underline in
	 * the preview so keyword-driven appearance isn't invisible next to the plain O/6 placeholders. */
	underline?: boolean;
	/** True when this item's row came from simulating SPACEB/SPACEA/SKIPB/SKIPA flow rather than
	 * an actual Line entry (positionSource === 'flow') — there's no Line entry in the source to
	 * rewrite, so dragging it only moves its Position (column); the row snaps back to where it
	 * already was. */
	flowPositioned?: boolean;
	/** True when the field/constant carries the HIGHLIGHT keyword (or its owning record does —
	 * HIGHLIGHT is valid at either level, and applies to every field in the record when set at the
	 * record level) — rendered bold. */
	bold?: boolean;
	/** CSS color from a field's COLOR(color-name) keyword — the named-color form only; the RGB/
	 * CMYK/CIELAB/Highlight color models are device-calibrated values with no simple mapping, so
	 * those render in the default color (see getColor). */
	color?: string;
	/** True for an item from the overlaid (background) record, not the one being previewed —
	 * dimmed and non-interactive, a read-only reference layer to check against while editing the
	 * active record (mirrors dspf-edit's own Overlay control). */
	overlay?: boolean;
	/** 1-based page number, for a composed sequence long enough to spill past the configured
	 * overflow/page length (see collectComposedPageItems) — `row` is relative to this page, not a
	 * running total across pages. Undefined (treated as page 1) outside composition, where
	 * pagination doesn't apply. */
	page?: number;
	/** This item's own SKIPB/SPACEB/SPACEA/SKIPA keyword(s), if any — rendered as small toggle-style
	 * buttons (same look as the Indicators row) once the item is selected; `active` reflects whether
	 * that particular keyword's own indicator condition (if it has one) is currently satisfied under
	 * live simulation, same as any other conditioned keyword. Clicking one reopens editSpacing preset
	 * to that keyword instead of asking which one via right-click's QuickPick. */
	spacing?: { keyword: string; value: number; active: boolean }[];
	/** At-a-glance corner markers so an item's indicators/spacing/attributes don't stay invisible
	 * until it's clicked: 'I' when the item itself (or any of its own attribute lines, including a
	 * conditioned spacing keyword) carries an indicator condition; 'S' when it has any of its own
	 * SKIPB/SPACEB/SPACEA/SKIPA (mirrors `spacing` above); 'A' when it has any of its own TEXT/
	 * COLOR/HIGHLIGHT/UNDERLINE/EDTCDE — the keywords the "🎨 Attributes" command edits. Presence
	 * only, not live indicator state (that distinction is what the spacing row's own on/off already
	 * shows once selected). */
	flags?: { indicators: boolean; spacing: boolean; attributes: boolean };
};

/** Reads whichever of the four spacing keywords are actually set on an item, for the preview's own
 * spacing row — same keywords editSpacing itself edits. Unlike readKeywordValue, this also reports
 * whether each one is currently indicator-active (true when the keyword carries no indicator
 * condition of its own), so the client can render it lit/unlit exactly like the Indicators row. */
function readSpacingEntries(attributes: PrtfAttribute[] | undefined, keywords: readonly string[], activeIndicators: Set<number>): { keyword: string; value: number; active: boolean }[] {
	const result: { keyword: string; value: number; active: boolean }[] = [];
	for (const keyword of keywords) {
		const attr = (attributes ?? []).find(a => keywordPattern(keyword).test(a.value));
		const match = attr?.value.match(keywordPattern(keyword));
		if (!attr || !match) {continue;};
		result.push({ keyword, value: Number(match[1]), active: isItemDisplayed(attr.indicators, activeIndicators) });
	};
	return result;
};

function itemSpacing(attributes: PrtfAttribute[] | undefined, activeIndicators: Set<number>): { keyword: string; value: number; active: boolean }[] {
	return readSpacingEntries(attributes, SPACING_KEYWORDS, activeIndicators);
};

/** See PageItem.flags. `ownIndicators` is the field/constant's own visibility condition (undefined
 * for a constant, which — unlike a field — can only be conditioned per-keyword, never as a whole). */
function itemFlags(ownIndicators: PrtfIndicator[] | undefined, attributes: PrtfAttribute[] | undefined, spacing: { keyword: string }[]): { indicators: boolean; spacing: boolean; attributes: boolean } {
	return {
		indicators: (ownIndicators?.length ?? 0) > 0 || (attributes ?? []).some(attr => (attr.indicators?.length ?? 0) > 0),
		spacing: spacing.length > 0,
		attributes: findTextKeyword(attributes) !== undefined
			|| getColor(attributes) !== undefined
			|| hasUnderline(attributes)
			|| hasHighlight(attributes, undefined)
			|| parseEdtcde(attributes) !== undefined
	};
};

/**
 * Whether a field/constant/keyword's own indicator conditioning (AND groups, OR'd alternatives —
 * see groupIndicatorsByCondition) is satisfied under `activeIndicators` — the set of indicator
 * numbers currently simulated "on" ("Indicators" toolbar toggle). An empty set (simulation off, or
 * an overlaid/background layer, which never reacts to the live toggle) produces a deterministic
 * resting state: unconditioned and explicitly-negated ("NOT") items show, plain positive
 * conditions don't — mathematically identical to dspf-edit's own "treat every indicator as off"
 * rule (`activeIndicators.has(n) === active` reduces to `!active` when the set is empty), so one
 * parameter covers both "not simulating" and "simulating with nothing turned on" without needing a
 * separate boolean.
 */
function isItemDisplayed(indicators: PrtfIndicator[] | undefined, activeIndicators: Set<number>): boolean {
	if (!indicators || indicators.length === 0) {return true;};
	const satisfies = (ind: PrtfIndicator) => activeIndicators.has(ind.number) === ind.active;
	return groupIndicatorsByCondition(indicators).some(group => group.every(satisfies));
};

/**
 * Every indicator number referenced anywhere across the given records — each field/constant's own
 * `indicators`, plus every one of its attributes' own (a keyword can be conditioned independently
 * of the item it's on), plus each record's own record-level attributes (e.g. a record-level
 * SKIPB/SPACEB/SPACEA/SKIPA/HIGHLIGHT conditioned on an indicator, with no field/constant of its
 * own to hang off of) — sorted, for the "Indicators" toolbar's per-number toggle buttons.
 * `PrtfRecord` itself has no `indicators` field (unlike DSPF), but its `attributes` entries each
 * carry their own, same as a field/constant's.
 */
function collectIndicatorNumbers(elements: PrtfElement[], recordNames: string[]): number[] {
	const numbers = new Set<number>();
	const addAll = (indicators: PrtfIndicator[] | undefined) => {
		for (const ind of indicators ?? []) {numbers.add(ind.number);};
	};
	for (const el of elements) {
		if ((el.kind === 'field' || el.kind === 'constant') && recordNames.includes(el.recordname)) {
			addAll(el.indicators);
			for (const attr of el.attributes ?? []) {addAll(attr.indicators);};
		};
		if (el.kind === 'record' && recordNames.includes(el.name)) {
			for (const attr of el.attributes ?? []) {addAll(attr.indicators);};
		};
		// File-level SKIPB/SKIPA applies to every record (see positionRecordEntry) — not scoped to
		// recordNames the way a record's own attributes are, so a conditioned one always needs its
		// indicator listed here, regardless of which record is currently being previewed.
		if (el.kind === 'file') {
			for (const attr of el.attributes ?? []) {addAll(attr.indicators);};
		};
	};
	return [...numbers].sort((a, b) => a - b);
};

/**
 * Placeholder character for a field, following the SDA/DFU convention: numeric fields print as a
 * run of '6's, everything else (character, date/time/timestamp) as a run of 'O's (for
 * "output-capable"). Real print data is only known at run time, so this is a stand-in for "a
 * field goes here" — the actual field name is available on hover instead.
 */
function fieldPlaceholderChar(type: string | undefined): string {
	return type === 'S' || type === 'F' ? '6' : 'O';
};

/**
 * Width/shape effect of the IBM i-supplied numeric edit codes (1-4, A-D, J-Q — see "IBM i edit
 * codes in printer files" in the DDS reference) needed to approximate a field's *edited* printed
 * form: whether digit groups get comma separators, and whether/how a sign prints. Decimal point
 * placement and comma grouping don't vary among these standard codes for a non-zero value — only
 * whether they show at all, and how a negative sign is shown, do.
 */
export interface EditCodeInfo {
	commas: boolean;
	sign: 'none' | 'suffixMinus' | 'suffixCr' | 'prefixMinus';
};

export const EDIT_CODES: Record<string, EditCodeInfo> = {
	'1': { commas: true, sign: 'none' }, '2': { commas: true, sign: 'none' },
	'3': { commas: false, sign: 'none' }, '4': { commas: false, sign: 'none' },
	'A': { commas: true, sign: 'suffixCr' }, 'B': { commas: true, sign: 'suffixCr' },
	'C': { commas: false, sign: 'suffixCr' }, 'D': { commas: false, sign: 'suffixCr' },
	'J': { commas: true, sign: 'suffixMinus' }, 'K': { commas: true, sign: 'suffixMinus' },
	'L': { commas: false, sign: 'suffixMinus' }, 'M': { commas: false, sign: 'suffixMinus' },
	'N': { commas: true, sign: 'prefixMinus' }, 'O': { commas: true, sign: 'prefixMinus' },
	'P': { commas: false, sign: 'prefixMinus' }, 'Q': { commas: false, sign: 'prefixMinus' },
};

/** Groups a run of `digitCount` 9s with commas every 3 digits from the right (e.g. 7 -> "9,999,999"). */
function groupDigits(digitCount: number): string {
	if (digitCount <= 0) {return '';};
	const firstGroupLen = ((digitCount - 1) % 3) + 1;
	const groups = ['9'.repeat(firstGroupLen)];
	for (let remaining = digitCount - firstGroupLen; remaining > 0; remaining -= 3) {
		groups.push('999');
	};
	return groups.join(',');
};

/**
 * Parses EDTCDE(edit-code [* | floating-currency-symbol]) — the edit code itself, and its
 * optional second parameter, which is either '*' (asterisk-fill — doesn't affect width) or a
 * literal currency symbol (does).
 */
export function parseEdtcde(attributes: PrtfAttribute[] | undefined): { code: string; currency?: string } | undefined {
	for (const attr of attributes ?? []) {
		const match = attr.value.match(/EDTCDE\(\s*([1-4A-DJ-Q])\s*(?:(\*)|([^\s)]+))?\s*\)/i);
		if (match) {return { code: match[1].toUpperCase(), currency: match[3] };};
	};
	return undefined;
};

/**
 * Approximates a numeric field's *edited* printed form at its worst case (every digit
 * significant, and negative — so any sign the edit code would show is included) — the same
 * "fill with 9s at the edited width" convention RLU's own design view uses, rather than the raw
 * O/6 placeholder. Real width can only be smaller than this at run time (zero-suppression,
 * positive values), never larger, so this is the right shape to check for overlap against.
 * Returns undefined when there's no EDTCDE, or it's a user-defined code (5-9) whose editing comes
 * from a CRTEDTD object we have no way to resolve here — those fall back to the plain placeholder.
 * Also reused by fill-constant.ts, unconditionally on the field's own attributes (not gated by any
 * live indicator-simulation state — a "reference width" lookup sizes for the widest an
 * EDTCDE-conditioned field could ever print, the same conservative reasoning as everywhere else
 * this function is used).
 * @param activeAttributes - The field's own attributes, already filtered down to whichever are
 *   currently indicator-active (see isItemDisplayed) — so a conditionally-applied EDTCDE is only
 *   honored when its own condition is currently met.
 */
export function editedNumericPlaceholder(field: PrtfField, activeAttributes: PrtfAttribute[]): string | undefined {
	const edtcde = parseEdtcde(activeAttributes);
	if (!edtcde) {return undefined;};
	const info = EDIT_CODES[edtcde.code];
	if (!info) {return undefined;};

	const length = field.length ?? 0;
	const decimals = field.decimals ?? 0;
	const integerDigits = Math.max(length - decimals, 0);

	const integerPart = info.commas ? groupDigits(integerDigits) : '9'.repeat(integerDigits);
	const decimalPart = decimals > 0 ? '.' + '9'.repeat(decimals) : '';
	const currencyPart = edtcde.currency ?? '';
	const prefixSign = info.sign === 'prefixMinus' ? '-' : '';
	const suffixSign = info.sign === 'suffixCr' ? 'CR' : info.sign === 'suffixMinus' ? '-' : '';

	return `${prefixSign}${currencyPart}${integerPart}${decimalPart}${suffixSign}`;
};

function fieldPlaceholderText(field: PrtfField, activeAttributes: PrtfAttribute[]): string {
	const edited = editedNumericPlaceholder(field, activeAttributes);
	if (edited) {return edited;};
	const len = Math.max(field.length ?? 0, 0);
	return fieldPlaceholderChar(field.type).repeat(len);
};

/** Strips a quoted constant literal's surrounding quotes — mirrors the parser's own stripping. */
function stripQuotes(rawName: string): string {
	return rawName.length >= 2 && rawName.startsWith("'") && rawName.endsWith("'")
		? rawName.slice(1, -1)
		: rawName;
};

/**
 * PAGNBR's own edited-width placeholder, mirroring editedNumericPlaceholder's "fill with 9s at the
 * edited width" approach for a field — but against a fixed 4-digit unsigned counter (the '9999'
 * baseline systemKeywordPlaceholder already uses for a plain PAGNBR) rather than a field's own
 * length/decimals, since a page number carries neither. Sign display (CR/-/leading-minus) is
 * skipped regardless of which edit code is chosen — a page number is never negative, so it doesn't
 * apply here the way it does for a genuinely signed numeric field. Returns undefined when there's
 * no EDTCDE on this constant, or it's a user-defined code (5-9) this extension can't resolve (same
 * scope boundary as editedNumericPlaceholder).
 */
function editedPagnbrPlaceholder(activeAttributes: PrtfAttribute[]): string | undefined {
	const edtcde = parseEdtcde(activeAttributes);
	if (!edtcde) {return undefined;};
	const info = EDIT_CODES[edtcde.code];
	if (!info) {return undefined;};
	const currencyPart = edtcde.currency ?? '';
	return `${currencyPart}${info.commas ? groupDigits(4) : '9'.repeat(4)}`;
};

/**
 * Placeholder text for a constant. A bare DATE/TIME/PAGNBR keyword (no quoted literal — see
 * "Constant fields in printer files" in the DDS reference) prints a system-supplied value at run
 * time; approximate that with a representative pattern instead of showing nothing. PAGNBR's own
 * EDTCDE (if any — the only one of the three DDS lets you edit this way) further shapes that
 * pattern's width, same "worst case" convention as a numeric field's own edited placeholder.
 * @param activeAttributes - The constant's own attributes, already filtered to whichever are
 *   currently indicator-active — see editedNumericPlaceholder's own doc comment.
 */
function constantPlaceholderText(constant: PrtfConstant, activeAttributes: PrtfAttribute[]): string {
	for (const attr of activeAttributes) {
		const placeholder = systemKeywordPlaceholder(attr.value);
		if (placeholder) {
			const isPagnbr = /^PAGNBR\b/i.test(attr.value.trim());
			return (isPagnbr && editedPagnbrPlaceholder(activeAttributes)) || placeholder;
		};
	};
	return stripQuotes(constant.name);
};

/** True when the field/constant's own attributes carry the (parameter-less) UNDERLINE keyword. */
function hasUnderline(attributes: PrtfAttribute[] | undefined): boolean {
	return (attributes ?? []).some(attr => /\bUNDERLINE\b/i.test(attr.value));
};

/** True when the record-level attributes carry ENDPAGE — an unconditional page eject right after
 * that record prints, regardless of the overflow/page-length threshold (see "ENDPAGE (End Page)
 * keyword in printer files" in the DDS reference). */
function hasEndPage(attributes: PrtfAttribute[] | undefined): boolean {
	return (attributes ?? []).some(attr => /\bENDPAGE\b/i.test(attr.value));
};

/**
 * Maps COLOR's named-color parameter (see "COLOR (Color) keyword in printer files" in the DDS
 * reference) to a legible CSS color for the preview. YLW renders as a darker gold rather than
 * pure yellow — real yellow ink is barely legible on white paper too, and an unreadable preview
 * isn't a useful one. The RGB/CMYK/CIELAB/Highlight color models are device-calibrated numeric
 * values with no simple mapping, so a field using one of those just renders in the default color,
 * same scope boundary as EDTCDE's user-defined edit codes (5-9).
 */
export const COLOR_NAMES: Record<string, string> = {
	BLK: '#000000', BLU: '#0000ee', BRN: '#8b4513', GRN: '#008000',
	PNK: '#ff69b4', RED: '#e00000', TRQ: '#00a0a0', YLW: '#b8960c',
};

function getColor(attributes: PrtfAttribute[] | undefined): string | undefined {
	for (const attr of attributes ?? []) {
		const match = attr.value.match(/\bCOLOR\(\s*([A-Z]{3})\s*\)/i);
		if (match) {return COLOR_NAMES[match[1].toUpperCase()];};
	};
	return undefined;
};

/**
 * True when the field/constant carries HIGHLIGHT, or its owning record does — HIGHLIGHT is a
 * record- or field-level keyword only (per IBM's DDS reference for printer files; not valid at
 * file level, unlike some other appearance keywords), and a record-level one applies to every
 * field in that record.
 */
function hasHighlight(itemAttributes: PrtfAttribute[] | undefined, recordAttributes: PrtfAttribute[] | undefined): boolean {
	const carries = (attrs: PrtfAttribute[] | undefined) => (attrs ?? []).some(attr => /\bHIGHLIGHT\b/i.test(attr.value));
	return carries(itemAttributes) || carries(recordAttributes);
};

/**
 * Builds a one-line column ruler: the 1-based column number, right-aligned so its last digit
 * lands exactly on that column, every 5 columns — blank everywhere else. Used by the "Ruler"
 * toggle, alongside a matching row-number gutter, so a field/constant's Line/Position can be read
 * straight off the page without hovering it (part of what the "+ Constant"/"+ Field" placing
 * mode and drag already report via the cursor, but useful to see at a glance too).
 */
export function buildColumnRuler(cols: number): string {
	const chars = new Array(cols).fill(' ');
	for (let col = 5; col <= cols; col += 5) {
		const label = String(col);
		const start = col - label.length;
		for (let i = 0; i < label.length; i++) {
			if (start + i >= 0) {chars[start + i] = label[i];};
		};
	};
	return chars.join('');
};

/**
 * Builds the page's character grid: a `rows`-length array of `cols`-wide strings, with each
 * item's text written starting at its (row, col) — 1-based, as coded in DDS — clipped at the page
 * boundary rather than wrapping, so the preview honestly shows what does and doesn't fit at the
 * configured page size.
 */
export function buildPageGrid(rows: number, cols: number, items: PageItem[]): string[] {
	const grid: string[][] = Array.from({ length: rows }, () => Array(cols).fill(' '));

	for (const item of items) {
		const r = item.row - 1;
		if (r < 0 || r >= rows) {continue;}
		for (let i = 0; i < item.text.length; i++) {
			const c = item.col - 1 + i;
			if (c < 0 || c >= cols) {continue;}
			grid[r][c] = item.text[i];
		};
	};

	return grid.map(line => line.join(''));
};

/**
 * Parallel grid to buildPageGrid's, holding the index (into `items`) of whichever item owns each
 * cell (undefined where no item covers it) — used to attribute hover titles and click-to-navigate
 * to the right item without re-deriving it from the plain char grid.
 */
export function buildOwnerGrid(rows: number, cols: number, items: PageItem[]): (number | undefined)[][] {
	const grid: (number | undefined)[][] = Array.from({ length: rows }, () => Array(cols).fill(undefined));

	items.forEach((item, index) => {
		const r = item.row - 1;
		if (r < 0 || r >= rows) {return;}
		for (let i = 0; i < item.text.length; i++) {
			const c = item.col - 1 + i;
			if (c < 0 || c >= cols) {continue;}
			grid[r][c] = index;
		};
	});

	return grid;
};

/** Builds one field's PageItem — shared by the single-record and composed-sequence collectors.
 * `rowOverride`/`forceFlowFlag` let a composed render supply a row from its own running
 * simulation instead of the field's own (isolated-record) resolved `row`. `activeIndicators`
 * (empty when indicator simulation is off, or for an overlaid/background layer) filters the
 * field's own attributes down to whichever are currently indicator-active before deriving
 * TEXT/UNDERLINE/COLOR/HIGHLIGHT/EDTCDE from them — a conditionally-applied keyword is gated
 * independently of the field's own visibility (already decided by the caller before this is
 * called at all). */
function buildFieldPageItem(field: PrtfField, rowOverride: number | undefined, forceFlowFlag: boolean | undefined, recordAttributes: PrtfAttribute[] | undefined, activeIndicators: Set<number>): PageItem | undefined {
	const row = rowOverride ?? field.row;
	if (row === undefined || field.column === undefined) {return undefined;};

	const activeAttributes = (field.attributes ?? []).filter(attr => isItemDisplayed(attr.indicators, activeIndicators));
	const textDescription = findTextKeyword(activeAttributes);
	const flowPositioned = forceFlowFlag ?? (field.positionSource === 'flow');
	const title = [
		textDescription ? `${field.name} — ${textDescription}` : field.name,
		flowPositioned ? '(flow-positioned; drag adjusts SPACEB)' : '',
		'— right-click to edit SKIPB/SPACEB/SPACEA/SKIPA'
	].filter(Boolean).join(' ');
	const spacing = itemSpacing(field.attributes, activeIndicators);
	return {
		row, col: field.column, text: fieldPlaceholderText(field, activeAttributes), title, lineIndex: field.lineIndex,
		underline: hasUnderline(activeAttributes), flowPositioned,
		bold: hasHighlight(activeAttributes, recordAttributes), color: getColor(activeAttributes),
		spacing, flags: itemFlags(field.indicators, field.attributes, spacing)
	};
};

/** Builds one constant's PageItem — see buildFieldPageItem. */
function buildConstantPageItem(constant: PrtfConstant, rowOverride: number | undefined, forceFlowFlag: boolean | undefined, recordAttributes: PrtfAttribute[] | undefined, activeIndicators: Set<number>): PageItem {
	const row = rowOverride ?? constant.row;
	const activeAttributes = (constant.attributes ?? []).filter(attr => isItemDisplayed(attr.indicators, activeIndicators));
	const flowPositioned = forceFlowFlag ?? (constant.positionSource === 'flow');
	const title = [
		findTextKeyword(activeAttributes),
		flowPositioned ? '(flow-positioned; drag adjusts SPACEB)' : '',
		'— right-click to edit SKIPB/SPACEB/SPACEA/SKIPA'
	].filter(Boolean).join(' ');
	const spacing = itemSpacing(constant.attributes, activeIndicators);
	return {
		row, col: constant.column, text: constantPlaceholderText(constant, activeAttributes), title, lineIndex: constant.lineIndex,
		underline: hasUnderline(activeAttributes), flowPositioned,
		bold: hasHighlight(activeAttributes, recordAttributes), color: getColor(activeAttributes),
		spacing, flags: itemFlags(undefined, constant.attributes, spacing)
	};
};

/**
 * Collects the visible (row, col, text) items for one record: fields and constants with a
 * resolved absolute position, skipping program-to-system fields (usage `P` — they never print)
 * and anything indicator-conditioned off under `activeIndicators` (see isItemDisplayed).
 * Delegates to positionRecordEntry (below) rather than reading each item's own pre-resolved
 * `row`/`column` directly — a flow-mode record needs a *fresh* SPACEB/SPACEA/SKIPB/SKIPA
 * simulation to reflect the current simulated indicator state (a conditioned spacing keyword
 * shouldn't contribute when its own condition isn't met), not the static resolution
 * resolveFlowModePositions computed once at parse time assuming everything unconditionally
 * applies.
 */
export function collectPageItems(elements: PrtfElement[], recordName: string, activeIndicators: Set<number> = new Set()): PageItem[] {
	const record = elements.find((el): el is PrtfRecord => el.kind === 'record' && el.name === recordName);
	if (!record) {return [];};
	return positionRecordEntry(elements, record, 0, false, activeIndicators).items;
};

/** One entry in a composed multi-record sequence: a record format, repeated `repeat` times. */
export interface SequenceEntry {
	recordName: string;
	repeat: number;
	/** Re-render this record's content at the top of every subsequent page created while
	 * composing (via overflow or ENDPAGE) — the common "page header repeats automatically" report
	 * pattern, without needing a manual entry per page. */
	repeatOnPageBreak?: boolean;
};

/**
 * Positions one record format's worth of items starting at `startLine`, and reports the "current
 * line" handed off to whatever comes next — the shared logic behind both collectComposedPageItems
 * (a whole sequence) and collectPageItemsWithOverlay (just two: the overlay, then the active
 * record), so the two stay in exact agreement about how records chain onto one page.
 *
 * A flow-mode record format (no explicit Line anywhere) is re-simulated fresh via
 * simulateRecordFlow, including its own trailing SPACEA/SKIPA — which resolveFlowModePositions
 * deliberately skips for a record previewed in isolation, since there's nothing "next" to feed
 * there.
 *
 * An explicit-mode record format renders at its own fixed absolute rows regardless of where it
 * sits in the chain — real DDS Line/Position is genuinely absolute, and (per
 * prtf-edit.validation.ts) an explicit-mode record can't carry a record-level SPACEA/SKIPA to
 * begin with, so there's no real DDS "current line" contribution to take from it. Real DDS would
 * happily let whatever comes next overlap it if that next record's own keywords don't account for
 * its height (a genuine report-design pitfall). This positioning, though, advances the handed-off
 * line to just past the highest row the explicit-mode record actually used — a convenience for the
 * common header/detail/total layout, which would otherwise need every following flow-mode entry to
 * hand-code a matching SKIPB. A following flow-mode entry's own SKIPB/SPACEB, if it has one, still
 * takes precedence over this default (see simulateRecordFlow) — this only supplies a starting
 * point when the entry doesn't specify one itself.
 * @param elements - The full parsed document
 * @param record - The record format to position
 * @param startLine - The "current line" coming in from whatever was positioned before it
 * @param tagOverlay - True to mark every resulting item PageItem.overlay (dimmed, non-interactive)
 * @param activeIndicators - Currently-simulated-on indicator numbers (empty = simulation off, or
 *   an overlaid/background layer — see isItemDisplayed). Items conditioned off are excluded
 *   *before* flow simulation runs, not just from the rendered result — a hidden field/constant's
 *   own SKIPB/SPACEB/SPACEA/SKIPA shouldn't contribute to the running line either, matching real
 *   DDS (a conditioned-off element's whole line, spacing included, doesn't execute). What remains
 *   is passed to simulateRecordFlow with a per-*attribute* gate too, so a keyword conditioned
 *   more narrowly than its own (already-visible) item — e.g. a SPACEA on its own separately
 *   conditioned continuation line — is still resolved correctly on its own terms.
 */
function positionRecordEntry(
	elements: PrtfElement[],
	record: PrtfRecord,
	startLine: number,
	tagOverlay: boolean,
	activeIndicators: Set<number>
): { items: PageItem[]; endLine: number } {
	const recordItems = elements
		.filter((el): el is PrtfField | PrtfConstant => (el.kind === 'field' || el.kind === 'constant') && el.recordname === record.name)
		.filter(el => isItemDisplayed(el.indicators, activeIndicators))
		.sort((a, b) => a.lineIndex - b.lineIndex);
	if (recordItems.length === 0) {return { items: [], endLine: startLine };};

	const items: PageItem[] = [];
	let currentLine = startLine;
	const tag = (item: PageItem): PageItem => tagOverlay ? { ...item, overlay: true } : item;
	const isAttributeActive = (attr: PrtfAttribute) => isItemDisplayed(attr.indicators, activeIndicators);

	if (recordItems.every(item => item.positionSource !== 'explicit')) {
		// A file-level SKIPB/SKIPA (the only two spacing keywords valid at that level) applies
		// before/after *every* record format in the file, per IBM's DDS reference — not a one-time
		// page-boundary event — so it belongs here, at the same layer as the record's own.
		const fileAttributes = elements.find((el): el is PrtfFile => el.kind === 'file')?.attributes;
		const { rows, endLine } = simulateRecordFlow(record, recordItems, startLine, isAttributeActive, fileAttributes);
		for (const item of recordItems) {
			const row = rows.get(item.lineIndex);
			if (row === undefined) {continue;};
			if (item.kind === 'field') {
				if (item.programToSystem) {continue;};
				const built = buildFieldPageItem(item, row, true, record.attributes, activeIndicators);
				if (built) {items.push(tag(built));};
			} else {
				items.push(tag(buildConstantPageItem(item, row, true, record.attributes, activeIndicators)));
			};
		};
		currentLine = endLine;
	} else {
		for (const item of recordItems) {
			if (item.kind === 'field') {
				if (item.programToSystem) {continue;};
				const built = buildFieldPageItem(item, undefined, undefined, record.attributes, activeIndicators);
				if (built) {
					items.push(tag(built));
					// +1: the default handoff is the line *after* the highest one this record
					// used, not that same line again.
					currentLine = Math.max(currentLine, built.row + 1);
				};
			} else {
				const built = buildConstantPageItem(item, undefined, undefined, record.attributes, activeIndicators);
				items.push(tag(built));
				currentLine = Math.max(currentLine, built.row + 1);
			};
		};
	};

	return { items, endLine: currentLine };
};

/**
 * Composes several record formats (and repeats of the same one — e.g. a header, several detail
 * rows, a total) onto one or more pages, in the given order, chaining each entry's "current line"
 * (via positionRecordEntry) into the next — and, when that line would exceed `overflowLine` (the
 * configured page length — a DDS Line number is inherently page-relative, 1 to PAGESIZE, not a
 * number that keeps growing across pages, so this genuinely models it, not just a display
 * convenience), rolling the next instance onto a fresh page instead. An `ENDPAGE` record forces
 * that same roll-over unconditionally, right after it prints, regardless of the threshold.
 *
 * A single record instance's own content is never split across two pages — if positioning it
 * where the page currently stands would overflow, and the page isn't already empty, the whole
 * instance restarts fresh at the top of the next page instead. (If it's still too tall to fit on
 * an empty page, it prints anyway, spilling past the configured boundary — a real design issue in
 * that case, not something to silently paper over.)
 *
 * An entry with `repeatOnPageBreak` becomes a "standing header": once its own turn in the
 * sequence has been positioned, every *later* page break (from overflow or ENDPAGE, triggered by
 * anything in the rest of the sequence) re-renders its content at the top of the new page first,
 * before whatever caused the break continues — the common "page header repeats automatically"
 * pattern, without a manual sequence entry per page.
 * @param elements - The full parsed document
 * @param sequence - The ordered, repeat-counted record formats to compose
 * @param overflowLine - The page length (OVRFLW/PAGESIZE) to roll over at
 * @param activeIndicators - Currently-simulated-on indicator numbers — see positionRecordEntry.
 */
export function collectComposedPageItems(elements: PrtfElement[], sequence: SequenceEntry[], overflowLine: number, activeIndicators: Set<number> = new Set()): PageItem[] {
	const items: PageItem[] = [];
	const records = elements.filter((el): el is PrtfRecord => el.kind === 'record');
	const pageLength = Math.max(1, Math.floor(overflowLine) || 1);
	let currentLine = 0;
	let currentPage = 1;
	const standingHeaders: PrtfRecord[] = [];

	const startNewPage = (): void => {
		currentPage += 1;
		currentLine = 0;
		for (const header of standingHeaders) {
			const result = positionRecordEntry(elements, header, currentLine, false, activeIndicators);
			for (const item of result.items) {items.push({ ...item, page: currentPage });};
			currentLine = result.endLine;
		};
	};

	for (const entry of sequence) {
		const record = records.find(r => r.name === entry.recordName);
		if (!record) {continue;};

		const repeatCount = Math.max(1, Math.floor(entry.repeat) || 1);
		for (let i = 0; i < repeatCount; i++) {
			let result = positionRecordEntry(elements, record, currentLine, false, activeIndicators);
			const highestRow = Math.max(currentLine, result.endLine - 1, ...result.items.map(it => it.row));

			if (highestRow > pageLength && currentLine > 0) {
				// Would overflow the current (non-empty) page — start this instance fresh at the
				// top of a new one instead of letting it spill across the page boundary.
				startNewPage();
				result = positionRecordEntry(elements, record, currentLine, false, activeIndicators);
			};

			for (const item of result.items) {items.push({ ...item, page: currentPage });};
			currentLine = result.endLine;

			if (hasEndPage(record.attributes)) {startNewPage();};
		};

		// Registered only after this entry's own occurrence is positioned — that occurrence
		// already covers "the header prints where it's declared in the sequence"; only *later*
		// page breaks should trigger the automatic repeat.
		if (entry.repeatOnPageBreak && !standingHeaders.includes(record)) {
			standingHeaders.push(record);
		};
	};

	return items;
};

/**
 * Positions the active and overlaid records the way they'd actually print together — via the
 * same chaining positionRecordEntry uses for a composed sequence — so switching which one you're
 * editing doesn't change how they line up. Whichever record is declared *earlier* in the DDS
 * source is chained first regardless of which one is "active": previewing CABECERA with DETALLE
 * overlaid still shows DETALLE below CABECERA's content, exactly as previewing DETALLE with
 * CABECERA overlaid does — not DETALLE restarting at line 1 just because it's the one playing
 * overlay this time. Ownership of a shared cell, though, always goes to the active record's items
 * — they're appended last regardless of which record was positioned first, so dragging is never
 * shadowed by the read-only overlay layer.
 *
 * The overlaid (background) record always renders at the indicator resting state — an empty
 * `activeIndicators` set — never the live simulated one, regardless of what `activeIndicators`
 * itself is; only the active record reacts to the "Indicators" toggle. Mirrors dspf-edit's own
 * overlay behavior.
 * @param activeIndicators - Currently-simulated-on indicator numbers, applied to the *active*
 *   record only.
 */
export function collectPageItemsWithOverlay(
	elements: PrtfElement[],
	recordName: string,
	overlayRecordName: string,
	activeIndicators: Set<number> = new Set(),
	repeatOverlay: boolean = false,
	pageRows: number = DEFAULT_ROWS
): PageItem[] {
	const records = elements.filter((el): el is PrtfRecord => el.kind === 'record');
	const activeRecord = records.find(r => r.name === recordName);
	if (!activeRecord) {return [];};

	const overlayRecord = records.find(r => r.name === overlayRecordName);
	if (!overlayRecord) {return positionRecordEntry(elements, activeRecord, 0, false, activeIndicators).items;};

	const activeIsFirst = activeRecord.lineIndex <= overlayRecord.lineIndex;
	const firstRecord = activeIsFirst ? activeRecord : overlayRecord;
	const secondRecord = activeIsFirst ? overlayRecord : activeRecord;
	const restingIndicators = new Set<number>();
	const firstIndicators = activeIsFirst ? activeIndicators : restingIndicators;
	const secondIndicators = activeIsFirst ? restingIndicators : activeIndicators;

	const firstResult = positionRecordEntry(elements, firstRecord, 0, !activeIsFirst, firstIndicators);
	const secondResult = positionRecordEntry(elements, secondRecord, firstResult.endLine, activeIsFirst, secondIndicators);

	const activeItems = activeIsFirst ? firstResult.items : secondResult.items;

	let overlayItems: PageItem[];
	if (repeatOverlay) {
		// Independent of the active record's own (possibly SKIPB/SPACEB-pushed-way-down) position:
		// tile read-only copies of the overlay record back-to-back from the top of the page, using
		// its own natural flow height as the step, all the way to the bottom — a uniform column
		// reference that's always nearby no matter where the active record ends up, rather than one
		// occurrence chained relative to it (which was confusing: it effectively started wherever
		// the active record's own content began/ended, not at a predictable spot).
		overlayItems = [];
		let tileStart = 0;
		let previousStart = -1;
		while (tileStart < pageRows && tileStart !== previousStart) {
			previousStart = tileStart;
			const tile = positionRecordEntry(elements, overlayRecord, tileStart, true, restingIndicators);
			if (tile.items.length === 0 || tile.endLine <= tileStart) {break;};
			overlayItems = [...overlayItems, ...tile.items];
			tileStart = tile.endLine;
		};
	} else {
		overlayItems = activeIsFirst ? secondResult.items : firstResult.items;
	};

	return [...overlayItems, ...activeItems];
};

/**
 * Finds which record (and, if precise enough, which field/constant line) a source line belongs
 * to — used to keep the preview following the cursor as it moves through the source.
 * @param elements - The document's parsed structure
 * @param lineIndex - Zero-based source line to locate
 */
export function findElementAtLine(elements: PrtfElement[], lineIndex: number): { recordName: string; targetLineIndex?: number } | undefined {
	for (const el of elements) {
		if (el.kind === 'field' && el.lineIndex === lineIndex) {
			return { recordName: el.recordname, targetLineIndex: el.lineIndex };
		};
	};
	for (const el of elements) {
		if (el.kind === 'constant' && lineIndex >= el.lineIndex && lineIndex <= el.lastLineIndex) {
			return { recordName: el.recordname, targetLineIndex: el.lineIndex };
		};
	};
	for (const el of elements) {
		if (el.kind === 'record' && el.endIndex !== undefined && lineIndex >= el.lineIndex && lineIndex <= el.endIndex) {
			return { recordName: el.name };
		};
	};
	return undefined;
};

function escapeHtml(text: string): string {
	return text
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;');
};

/** Renders one grid row as HTML, wrapping each run of cells owned by the same item in a single
 * <span data-line="..." title="...">, so it's individually hoverable/clickable/highlightable. An
 * overlay item (see PageItem.overlay) gets no `data-line` at all — it's a read-only reference
 * layer, dimmed via CSS and inert to every click/drag handler, which all key off that attribute. */
function renderLineHtml(charLine: string, ownerLine: (number | undefined)[], items: PageItem[]): string {
	let html = '';
	let i = 0;
	while (i < charLine.length) {
		const owner = ownerLine[i];
		let j = i + 1;
		while (j < charLine.length && ownerLine[j] === owner) {j++;}
		const segment = escapeHtml(charLine.slice(i, j));
		if (owner !== undefined) {
			const item = items[owner];
			const titleAttr = item.title ? ` title="${escapeHtml(item.title)}"` : '';
			const flowAttr = item.flowPositioned ? ' data-flow="1"' : '';
			const lineAttr = item.overlay ? '' : ` data-line="${item.lineIndex}"`;
			const spacingAttr = (!item.overlay && item.spacing && item.spacing.length > 0)
				? ` data-spacing="${escapeHtml(JSON.stringify(item.spacing)).replace(/"/g, '&quot;')}"`
				: '';
			// Trying just 'S' (spacing) for now — indicators/attributes still computed in
			// item.flags, ready to add back to this join() if the corner marker earns its keep.
			const flagsLabel = item.overlay ? '' : [
				item.flags?.spacing ? 'S' : ''
			].join('');
			const flagsAttr = flagsLabel ? ` data-flags="${flagsLabel}"` : '';
			const styleAttr = item.color ? ` style="color:${item.color}"` : '';
			const cssClass = [
				'pf-item',
				item.underline ? 'pf-underline' : '',
				item.bold ? 'pf-bold' : '',
				item.overlay ? 'pf-overlay' : ''
			].filter(Boolean).join(' ');
			html += `<span class="${cssClass}"${lineAttr}${flowAttr}${spacingAttr}${flagsAttr}${titleAttr}${styleAttr}>${segment}</span>`;
		} else {
			html += segment;
		};
		i = j;
	};
	return html || '&nbsp;';
};

export class RecordPreviewPanel {
	public static current: RecordPreviewPanel | undefined;

	private readonly panel: vscode.WebviewPanel;
	private elements: PrtfElement[] = [];
	private recordName: string;
	private rows = DEFAULT_ROWS;
	private cols = DEFAULT_COLS;
	/** OVRFLW/page-length threshold for "Compose sequence" pagination (see
	 * collectComposedPageItems) — defaults to `rows`, the common case where overflow falls at the
	 * physical bottom of the page. Not applied outside composition. */
	private overflowLine = DEFAULT_ROWS;
	private highlightLineIndex: number | undefined;
	/** Non-empty when composing several record formats onto one page (see collectComposedPageItems)
	 * instead of previewing a single one — set via the toolbar's sequence editor. */
	private sequence: SequenceEntry[] = [];
	/** A second record shown dimmed behind the active one, as a read-only reference layer while
	 * dragging/editing — e.g. checking a detail row doesn't collide with the header above it.
	 * Mirrors dspf-edit's own Overlay control. Not offered while composing a sequence. Reset
	 * (not persisted) whenever the active record changes — createOrShow/syncToLine — so a
	 * stale overlay target from whatever record was active before doesn't silently keep applying
	 * to the new one; same reasoning as activeIndicators' own reset. */
	private overlayRecordName: string | undefined;
	/** When true, tiles additional read-only copies of the overlay record further down the page
	 * (stacked using its own natural SPACEB/SKIPB/SPACEA/SKIPA height), so a reference copy stays
	 * visible even once the active record's own SKIPB/SPACEB has pushed it far down. No effect when
	 * overlayRecordName is unset. Not reset on record switch — like showRuler, it's a display
	 * preference, harmless while there's no overlay target to apply it to. */
	private overlayRepeat = false;
	/** Tracks the "Focus" toggle purely to relabel the button on the next render — the real state
	 * lives in VS Code's own maximized-editor-group flag (see toggleFocusMode), which this only
	 * reflects for toggles made through this button. */
	private focusModeActive = false;
	/** Tracked so a later full re-render (e.g. from a source edit) doesn't silently turn the ruler
	 * back off — toggling it doesn't otherwise need a re-render at all, since it's pure CSS. */
	private showRuler = false;
	/** "Indicators" toggle — a panel-wide preference like showRuler, persisting across switching
	 * which record is previewed. */
	private indicatorsEnabled = false;
	/** Which indicator numbers are currently simulated "on". Reset (not persisted) whenever the
	 * set of relevant records changes — switching which record is previewed, or editing the
	 * "Compose sequence" list — since the available/meaningful numbers differ per record; survives
	 * a same-record re-render (e.g. a source edit), same as dspf-edit's own behavior. */
	private activeIndicators: Set<number> = new Set();
	private disposables: vscode.Disposable[] = [];

	public static createOrShow(recordName: string, elements: PrtfElement[]): void {
		if (RecordPreviewPanel.current) {
			if (RecordPreviewPanel.current.recordName !== recordName) {
				RecordPreviewPanel.current.activeIndicators = new Set();
				// The overlay picker's own options already exclude whichever record is active
				// (see getHtml's overlayOptions), but the *stored* selection itself was never
				// actually cleared on a record switch, despite the intent — a stale overlay target
				// (from whatever record was active before) silently kept applying to the new one.
				RecordPreviewPanel.current.overlayRecordName = undefined;
			};
			RecordPreviewPanel.current.recordName = recordName;
			RecordPreviewPanel.current.elements = elements;
			RecordPreviewPanel.current.panel.reveal(vscode.ViewColumn.Beside);
			RecordPreviewPanel.current.render();
			return;
		};

		const panel = vscode.window.createWebviewPanel(
			'prtfRecordPreview',
			'PRTF Preview',
			vscode.ViewColumn.Beside,
			{ enableScripts: true, retainContextWhenHidden: true }
		);

		RecordPreviewPanel.current = new RecordPreviewPanel(panel, recordName, elements);
	};

	/**
	 * Whether the open preview panel currently has its "focus mode" on (source editor's group
	 * maximized away). revealInSourceEditor uses this to avoid undoing the maximize just to move
	 * the cursor.
	 */
	public static isFocusModeActive(): boolean {
		return RecordPreviewPanel.current?.focusModeActive ?? false;
	};

	/**
	 * Moves the source editor's cursor/selection to `lineIndex` and reveals it — shared by the
	 * tree view's click-to-navigate (via prtf-edit.navigation.ts's revealLine) and the preview
	 * panel's own click-to-navigate, so both land in the editor the same way. When focus mode is
	 * on, this deliberately skips `vscode.window.showTextDocument` (which would surface the source
	 * editor's hidden group and undo the maximize) and updates the tracked editor object directly
	 * instead, so the source is at the right spot whenever focus mode gets turned off. Otherwise
	 * behaves as a normal "reveal without stealing focus" jump.
	 * @param lineIndex - Zero-based line index to navigate to
	 */
	public static async revealInSourceEditor(lineIndex: number): Promise<void> {
		const document = ExtensionState.lastPrtfDocument;
		if (!document) {return;}

		const line = Math.max(0, Math.min(lineIndex, document.lineCount - 1));
		const position = new vscode.Position(line, 0);

		if (RecordPreviewPanel.isFocusModeActive() && ExtensionState.lastPrtfEditor) {
			const editor = ExtensionState.lastPrtfEditor;
			editor.selection = new vscode.Selection(position, position);
			editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
			return;
		};

		// Reuse whichever view column the source is already visible in, rather than letting
		// showTextDocument guess from "the active column" — with focus on a webview (the preview
		// panel, the tree view), that guess can resolve to the webview's own column and open a
		// second, unwanted copy of the source there instead of reusing the existing one.
		const visibleEditor = vscode.window.visibleTextEditors.find(e => e.document === document);
		const viewColumn = visibleEditor?.viewColumn ?? vscode.ViewColumn.One;

		const editor = await vscode.window.showTextDocument(document, { viewColumn, preserveFocus: true, preview: false });
		editor.selection = new vscode.Selection(position, position);
		editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
	};

	/** Re-renders the currently open preview with freshly parsed elements (e.g. after a source
	 * edit), if a panel is open — a no-op otherwise. */
	public static refreshIfOpen(elements: PrtfElement[]): void {
		if (!RecordPreviewPanel.current) {return;}
		RecordPreviewPanel.current.elements = elements;
		RecordPreviewPanel.current.render();
	};

	/**
	 * Points the preview (when open) at whatever's on `lineIndex` — called when a tree node is
	 * selected, *not* on every source cursor move (the preview deliberately doesn't follow the
	 * cursor around as you edit/scroll — only an explicit tree click or a click inside the preview
	 * itself changes what it shows, matching dspf-edit's own preview). Switches the previewed
	 * record (re-rendering) when `lineIndex` lands in a different one than what's currently shown,
	 * or just moves the highlight (no re-render — avoids flicker/losing scroll position) when it's
	 * still within the currently shown record.
	 */
	public static syncToLine(elements: PrtfElement[], lineIndex: number): void {
		const panel = RecordPreviewPanel.current;
		if (!panel) {return;}

		const target = findElementAtLine(elements, lineIndex);
		if (!target) {return;}

		if (target.recordName !== panel.recordName) {
			panel.recordName = target.recordName;
			panel.elements = elements;
			panel.highlightLineIndex = target.targetLineIndex;
			panel.activeIndicators = new Set();
			panel.overlayRecordName = undefined;
			panel.render();
		} else {
			panel.highlightLineIndex = target.targetLineIndex;
			panel.panel.webview.postMessage({ type: 'highlightLine', lineIndex: target.targetLineIndex ?? null });
		};
	};

	private constructor(panel: vscode.WebviewPanel, recordName: string, elements: PrtfElement[]) {
		this.panel = panel;
		this.recordName = recordName;
		this.elements = elements;

		this.panel.webview.onDidReceiveMessage(message => this.onDidReceiveMessage(message), null, this.disposables);
		this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

		this.render();
	};

	private async onDidReceiveMessage(message: any): Promise<void> {
		switch (message.type) {
			case 'toggleFocusMode':
				await this.toggleFocusMode();
				break;
			case 'toggleRuler':
				this.showRuler = !this.showRuler;
				this.panel.webview.postMessage({ type: 'rulerChanged', active: this.showRuler });
				break;
			case 'setPageSize':
				this.rows = clampPageSize(message.rows, DEFAULT_ROWS);
				this.cols = clampPageSize(message.cols, DEFAULT_COLS);
				this.overflowLine = clampPageSize(message.overflow, this.rows);
				this.render();
				break;
			case 'setSequence':
				this.sequence = Array.isArray(message.items)
					? message.items
						.filter((it: any) => typeof it?.recordName === 'string' && it.recordName)
						.map((it: any) => ({
							recordName: it.recordName,
							repeat: Math.max(1, Math.floor(Number(it.repeat)) || 1),
							repeatOnPageBreak: Boolean(it.repeatOnPageBreak)
						}))
					: [];
				// The composed sequence's own records determine which indicator numbers are even
				// meaningful — same reasoning as resetting on a plain record switch.
				this.activeIndicators = new Set();
				this.render();
				break;
			case 'setOverlay':
				this.overlayRecordName = typeof message.recordName === 'string' && message.recordName ? message.recordName : undefined;
				this.render();
				break;
			case 'setOverlayRepeat':
				this.overlayRepeat = Boolean(message.enabled);
				this.render();
				break;
			case 'setIndicatorsEnabled':
				this.indicatorsEnabled = Boolean(message.enabled);
				this.render();
				break;
			case 'toggleIndicator':
				if (typeof message.number === 'number') {
					if (this.activeIndicators.has(message.number)) {
						this.activeIndicators.delete(message.number);
					} else {
						this.activeIndicators.add(message.number);
					};
					this.render();
				};
				break;
			case 'gotoLine':
				if (typeof message.lineIndex === 'number') {
					await RecordPreviewPanel.revealInSourceEditor(message.lineIndex);
					const target = findElementAtLine(this.elements, message.lineIndex);
					revealInTree(target?.recordName ?? this.recordName, message.lineIndex);
					// Drives the preview's own selection square directly, rather than relying on
					// the source cursor move above to loop back through a selection-change
					// listener — the preview no longer follows the cursor at all (only an explicit
					// tree click or a click inside the preview itself changes what's selected).
					this.highlightLineIndex = target?.targetLineIndex ?? message.lineIndex;
					this.panel.webview.postMessage({ type: 'highlightLine', lineIndex: this.highlightLineIndex ?? null });
				};
				break;
			case 'deselect':
				// Clicking blank space on the page (not on any field/constant) clears the selection,
				// same as dspf-edit — the client already removed the highlight class itself; this just
				// keeps the server's own idea of the selection (used by deleteItem/editAttributes, and
				// preserved across re-renders) in sync with it.
				this.highlightLineIndex = undefined;
				break;
			case 'moveItem':
				if (this.sequence.length === 0 && typeof message.lineIndex === 'number' && typeof message.newRow === 'number' && typeof message.newCol === 'number') {
					// Gate flow-mode baseline math by the same live indicator-simulation state the
					// page is currently rendered with (see resolveFlowModeMove's own doc comment) —
					// otherwise a preceding item's indicator-conditioned SPACEB/SPACEA/SKIPB/SKIPA
					// would silently disagree with the row the user is actually dragging within.
					const liveIndicators = this.indicatorsEnabled ? this.activeIndicators : new Set<number>();
					const isAttributeActive = (attr: PrtfAttribute) => isItemDisplayed(attr.indicators, liveIndicators);
					moveElement(message.lineIndex, message.newRow, message.newCol, this.rows, this.cols, Boolean(message.flow), isAttributeActive);
				};
				break;
			case 'editSpacing':
				if (this.sequence.length === 0) {
					// Right-click always sends an explicit lineIndex (whatever's under the cursor,
					// regardless of prior selection); the toolbar's own "↕️ Spacing" button doesn't —
					// same convention as deleteItem/editAttributes — so it falls back to whatever's
					// currently selected.
					const spacingLineIndex = typeof message.lineIndex === 'number' ? message.lineIndex : this.highlightLineIndex;
					if (typeof spacingLineIndex === 'number') {
						editSpacing(spacingLineIndex, typeof message.keyword === 'string' ? message.keyword : undefined);
					};
				};
				break;
			case 'editRecordSpacing':
				if (this.sequence.length === 0) {
					const record = this.elements.find((el): el is PrtfRecord => el.kind === 'record' && el.name === this.recordName);
					if (record) {await editRecordSpacing(record);};
				};
				break;
			case 'editFileSpacing':
				if (this.sequence.length === 0) {
					const file = this.elements.find((el): el is PrtfFile => el.kind === 'file');
					if (file) {await editFileSpacing(file);};
				};
				break;
			case 'deleteItem':
				if (this.sequence.length === 0 && this.highlightLineIndex !== undefined) {
					await deleteElement(this.highlightLineIndex);
					this.highlightLineIndex = undefined;
				};
				break;
			case 'editAttributes':
				if (this.sequence.length === 0 && this.highlightLineIndex !== undefined) {
					await editAttributes(this.highlightLineIndex);
				};
				break;
			case 'addConstantAt':
				if (this.sequence.length === 0 && typeof message.row === 'number' && typeof message.col === 'number') {
					addConstantAt(this.recordName, message.row, message.col, this.rows, this.cols);
				};
				break;
			case 'addFieldAt':
				if (this.sequence.length === 0 && typeof message.row === 'number' && typeof message.col === 'number') {
					addFieldAt(this.recordName, message.row, message.col, this.rows, this.cols);
				};
				break;
		};
	};

	/**
	 * Toggles "focus mode", mirroring dspf-edit's own preview: maximizes the preview's editor
	 * group so it fills the editing area, hiding the DDS source editor beside it. The Side Bar
	 * (Definition tree) isn't part of the editor grid, so it stays visible throughout. Uses VS
	 * Code's own maximize-group state rather than tracking layout ourselves — this only reflects
	 * toggles made through this button, and only updates the button label, not a full re-render
	 * (the grid itself doesn't change), so a manual un-maximize elsewhere wouldn't relabel it.
	 */
	private async toggleFocusMode(): Promise<void> {
		this.panel.reveal(undefined, false);
		await vscode.commands.executeCommand('workbench.action.toggleMaximizeEditorGroup');
		this.focusModeActive = !this.focusModeActive;
		this.panel.webview.postMessage({ type: 'focusModeChanged', active: this.focusModeActive });
	};

	private render(): void {
		const records = this.elements.filter((e): e is PrtfRecord => e.kind === 'record');
		if (!records.some(r => r.name === this.recordName) && records.length > 0) {
			this.recordName = records[0].name;
		};

		const composing = this.sequence.length > 0;
		const liveIndicators = this.indicatorsEnabled ? this.activeIndicators : new Set<number>();
		// positionRecordEntry lists the overlay's items first — buildPageGrid/buildOwnerGrid
		// resolve a shared cell to whichever item comes *last* in the array, so the active
		// record's own content (and its interactivity) always wins where the two overlap.
		const items = composing
			? collectComposedPageItems(this.elements, this.sequence, this.overflowLine, liveIndicators)
			: this.overlayRecordName
				? collectPageItemsWithOverlay(this.elements, this.recordName, this.overlayRecordName, liveIndicators, this.overlayRepeat, this.rows)
				: collectPageItems(this.elements, this.recordName, liveIndicators);

		this.panel.title = composing ? 'Preview: (composed)' : `Preview: ${this.recordName || '(no records)'}`;
		this.panel.webview.html = this.getHtml(records, items);
	};

	private getHtml(records: PrtfRecord[], items: PageItem[]): string {
		const composing = this.sequence.length > 0;
		const liveIndicators = this.indicatorsEnabled ? this.activeIndicators : new Set<number>();

		// Record- and file-level spacing badges (see field/constant's own corner 'S' marker) — shown
		// only outside composition, where "the current record"/"the file" are still single,
		// unambiguous things a click can act on (editRecordSpacing/editFileSpacing each take one
		// specific record/file, not a composed chain of them).
		const currentRecord = !composing ? records.find(r => r.name === this.recordName) : undefined;
		const recordSpacingEntries = currentRecord ? readSpacingEntries(currentRecord.attributes, SPACING_KEYWORDS, liveIndicators) : [];
		const fileElement = !composing ? this.elements.find((el): el is PrtfFile => el.kind === 'file') : undefined;
		const fileSpacingEntries = fileElement ? readSpacingEntries(fileElement.attributes, FILE_SPACING_KEYWORDS, liveIndicators) : [];
		const spacingTitle = (label: string, entries: { keyword: string; value: number; active: boolean }[]) =>
			`${label} spacing: ` + entries.map(e => `${e.keyword}(${e.value})${e.active ? '' : ' — not active'}`).join(', ') + ' — click to change';
		// Same on/off convention as the selected item's own spacing row: blue while at least one of
		// this scope's keywords is currently in effect (unconditioned ones always count), white once
		// every one of them is conditioned off under the live indicator simulation.
		const anySpacingActive = (entries: { active: boolean }[]) => entries.some(e => e.active);

		// Record names for the "Compose sequence" rows' own selects (built client-side — see
		// makeSequenceRow) — there's no standalone "which record" selector in the toolbar itself;
		// the previewed record follows the source cursor / tree selection instead, same as
		// dspf-edit's own preview.
		const recordNamesJson = JSON.stringify(records.map(r => r.name));

		const overlayOptions = [`<option value="">(none)</option>`]
			.concat(records
				.filter(r => r.name !== this.recordName)
				.map(r => `<option value="${escapeHtml(r.name)}" ${r.name === this.overlayRecordName ? 'selected' : ''}>${escapeHtml(r.name)}</option>`))
			.join('');

		// "Indicators" toggle: which record(s) to scan for available indicator numbers — just the
		// one being previewed normally, or every record named in the composed sequence while
		// composing (several may be shown at once there).
		const indicatorRecordNames = this.sequence.length > 0
			? [...new Set(this.sequence.map(entry => entry.recordName).filter(Boolean))]
			: [this.recordName].filter(Boolean);
		const availableIndicatorNumbers = collectIndicatorNumbers(this.elements, indicatorRecordNames);
		const hasIndicators = availableIndicatorNumbers.length > 0;
		if (!hasIndicators && this.indicatorsEnabled) {
			// Nothing left to simulate (e.g. the last indicator-conditioned keyword in this record
			// was just dragged/edited away) — the "Indicators" control itself is about to stop being
			// rendered at all, so its state shouldn't linger checked for whenever one reappears.
			this.indicatorsEnabled = false;
			this.activeIndicators = new Set();
		};
		const indicatorButtonsHtml = this.indicatorsEnabled
			? availableIndicatorNumbers.map(n =>
				`<button type="button" class="indicator-btn${this.activeIndicators.has(n) ? ' active' : ''}" data-indicator="${n}">${n}</button>`
			).join('')
			: '';

		// Ruler ("📏 Ruler" toggle): a column-number header (every 5 columns) and a row-number
		// gutter, both outside `.page` itself (a sibling in the same CSS grid) so toggling them
		// never touches `.page`'s own markup/padding — and with it, never risks the drag/measure
		// column math that already had to be hard-won correct once (see measure() below).
		const rulerLineHtml = escapeHtml(buildColumnRuler(this.cols));
		const gutterDigits = String(this.rows).length;
		const gutterCellsHtml = Array.from({ length: this.rows }, (_, i) =>
			`<div class="pf-gutter-cell">${String(i + 1).padStart(gutterDigits, ' ')}</div>`
		).join('');

		// One or more stacked "sheets" — more than one only once composed content has actually
		// rolled past the overflow/page-length threshold (see collectComposedPageItems); outside
		// composition, items carry no `.page` at all, so this is always exactly one, unlabeled,
		// identical to the single-page rendering before pagination existed.
		const pageNumbers = [...new Set(items.map(it => it.page ?? 1))].sort((a, b) => a - b);
		const showPageLabels = pageNumbers.length > 1;
		const pagesHtml = (pageNumbers.length ? pageNumbers : [1]).map(pageNum => {
			const pageItems = items.filter(it => (it.page ?? 1) === pageNum);
			const gridLines = buildPageGrid(this.rows, this.cols, pageItems);
			const ownerGrid = buildOwnerGrid(this.rows, this.cols, pageItems);
			const rowsHtml = gridLines
				.map((line, i) => `<div class="pf-line">${renderLineHtml(line, ownerGrid[i], pageItems)}</div>`)
				.join('');
			const label = showPageLabels ? `<div class="pf-page-label">Page ${pageNum}</div>` : '';
			const recordBadge = (pageNum === (pageNumbers[0] ?? 1) && recordSpacingEntries.length > 0)
				? `<button type="button" id="recordSpacingBtn" class="spacing-item-btn pf-record-spacing-badge${anySpacingActive(recordSpacingEntries) ? ' active' : ''}" title="${escapeHtml(spacingTitle('Record', recordSpacingEntries))}">S</button>`
				: '';
			return `<div class="pf-page-group">${label}<div class="pf-page-grid">` +
				`<div class="pf-ruler-corner"></div>` +
				`<div class="pf-ruler-line">${rulerLineHtml}</div>` +
				`<div class="pf-gutter">${gutterCellsHtml}</div>` +
				`<div class="page">${recordBadge}${rowsHtml}</div>` +
				`</div></div>`;
		}).join('');

		return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<style>
	* {
		box-sizing: border-box;
	}
	body {
		font-family: sans-serif;
		background: #ffffff;
		color: #000000;
		padding: 0;
		margin: 0;
	}
	/* One sticky band (like dspf-edit's own toolbar) containing several stacked rows — grouped by
	   purpose the same way: an info/Focus row, a "what am I looking at" selectors row, an actions
	   row, and (only while composing) the sequence editor row. */
	#toolbarContainer {
		position: sticky;
		top: 0;
		background: #f3f3f3;
		border-bottom: 1px solid #ccc;
		padding: 8px 12px;
		z-index: 10;
	}
	.toolbar-row {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		column-gap: 12px;
		row-gap: 6px;
		font-size: 12px;
	}
	.toolbar-row:not(:last-child) {
		margin-bottom: 6px;
	}
	.toolbar-row label {
		display: flex;
		align-items: center;
		gap: 4px;
		font-size: 12px;
		color: #000000;
	}
	#sizeLabel {
		font-weight: 600;
		color: #000000;
	}
	.toolbar-row select, .toolbar-row input {
		background: #ffffff;
		color: #000000;
		border: 1px solid #999;
		border-radius: 2px;
		padding: 2px 4px;
	}
	.toolbar-row input[type=number] {
		width: 4em;
	}
	.toolbar-row button {
		background: #ffffff;
		color: #000000;
		border: 1px solid #999;
		border-radius: 2px;
		padding: 3px 8px;
		font-size: 12px;
		cursor: pointer;
	}
	.toolbar-row button.active {
		background: #337aff;
		color: #ffffff;
		border-color: #337aff;
	}
	/* Without this, a disabled button (e.g. "🗑 Delete"/"🎨 Attributes" before anything's selected)
	   looks identical to an enabled one — the explicit background/color above overrides the
	   browser's own default disabled dimming, so it needs to be restated here instead. */
	.toolbar-row button:disabled {
		background: #f3f3f3;
		color: #999999;
		border-color: #ddd;
		cursor: not-allowed;
		opacity: 0.6;
	}
	/* "Indicators" toggle's per-number buttons, on their own row (5) — tighter than a regular
	   toolbar button since there can be many (one per indicator actually referenced in the
	   record). Styled like an LED, dspf-edit's own convention: dimmed/off by default, lit green
	   once toggled on, rather than reusing the plain blue .active look every other toolbar
	   toggle button has. */
	.indicator-btn {
		padding: 1px 6px;
		min-width: 1.6em;
		text-align: center;
		background: #eeeeee;
		color: #aaaaaa;
		border: 1px solid #cccccc;
	}
	.indicator-btn.active {
		background: #22c55e;
		color: #000000;
		border-color: #22c55e;
	}
	#sequenceBar {
		display: none;
	}
	#sequenceBar.visible {
		display: flex;
	}
	.seq-row {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		font-size: 12px;
		background: #ffffff;
		border: 1px solid #999;
		border-radius: 2px;
		padding: 2px 4px;
	}
	.seq-row input[type=number] {
		width: 3.5em;
		background: #ffffff;
		color: #000000;
		border: 1px solid #999;
	}
	.seq-row select {
		background: #ffffff;
		color: #000000;
		border: 1px solid #999;
	}
	.seq-row button {
		background: #ffffff;
		color: #000000;
		border: 1px solid #999;
		border-radius: 2px;
		cursor: pointer;
		padding: 0 4px;
	}
	.seq-row label {
		display: inline-flex;
		align-items: center;
		gap: 2px;
		white-space: nowrap;
	}
	.page-wrapper {
		padding: 16px;
		overflow: auto;
	}
	.page {
		position: relative;
		display: inline-block;
		background: #ffffff;
		color: #000000;
		border: 1px solid #999;
		box-shadow: 0 1px 4px rgba(0, 0, 0, 0.25);
		font-family: 'Courier New', monospace;
		font-size: 13px;
		white-space: pre;
		line-height: 1.35;
		padding: 4px 0;
	}
	.pf-page-group {
		margin-bottom: 24px;
	}
	.pf-page-label {
		font-family: sans-serif;
		font-size: 11px;
		font-weight: bold;
		color: #666;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		margin-bottom: 4px;
	}
	/* "Ruler" toggle: a column-number header and row-number gutter, laid out as siblings of
	   .page in a small grid rather than injected into it — .page's own markup/padding never
	   changes, so the drag/measure column math (which reads .pf-line's own layout) is never at
	   risk from toggling this on or off. */
	.pf-page-grid {
		display: grid;
		grid-template-columns: max-content max-content;
	}
	.pf-ruler-corner, .pf-ruler-line, .pf-gutter {
		display: none;
	}
	.pf-ruler-line {
		font-family: 'Courier New', monospace;
		font-size: 13px;
		white-space: pre;
		padding: 0 6px;
		color: #888;
	}
	.pf-gutter {
		flex-direction: column;
		font-family: 'Courier New', monospace;
		font-size: 13px;
		line-height: 1.35;
		white-space: pre;
		padding: 4px 6px 4px 0;
		text-align: right;
		color: #888;
		background: #f7f7f7;
	}
	#page.pf-ruler-on .pf-ruler-corner,
	#page.pf-ruler-on .pf-ruler-line {
		display: block;
	}
	#page.pf-ruler-on .pf-gutter {
		display: flex;
	}
	.pf-line {
		padding: 0 6px;
	}
	.pf-item {
		position: relative;
		cursor: pointer;
	}
	/* At-a-glance corner marker (see PageItem.flags) — tucked inside the item's own box (not
	   hanging below it, which would collide with the line underneath given how tightly report
	   lines are packed) so it never needs its own row. Letters, not a filled badge, so it doesn't
	   obscure the O/6 placeholder text it sits on top of. */
	.pf-item[data-flags]::after {
		content: attr(data-flags);
		position: absolute;
		right: 0;
		bottom: 0;
		font-family: sans-serif;
		font-size: 9px;
		font-weight: bold;
		line-height: 1;
		letter-spacing: 0.5px;
		color: #337aff;
		pointer-events: none;
	}
	.pf-underline {
		text-decoration: underline;
	}
	.pf-bold {
		font-weight: bold;
	}
	.pf-overlay {
		/* Distinct on three independent cues (color, dimness, slant), not opacity alone — a plain
		   (non-bold) active item at full black is otherwise close enough to a dimmed overlay item
		   to be mistaken for one, while a bold active item's extra weight already stood apart. An
		   inline COLOR-keyword style on the item itself still overrides the color set here (higher
		   specificity), but the italic + opacity cues still apply regardless. */
		color: #999999;
		opacity: 0.6;
		font-style: italic;
		cursor: default;
		pointer-events: none;
	}
	.pf-item:hover {
		background: #cce4ff;
	}
	/* A border around the selected field/constant, like dspf-edit's own preview selection — not a
	   filled background, which would obscure the O/6 placeholder text underneath it. outline
	   rather than border: it overlays without adding to the element's box, so it can't shift
	   neighboring characters out of their monospace grid cells. */
	.pf-item.pf-highlight {
		outline: 2px solid #337aff;
		outline-offset: -1px;
	}
	.pf-ghost {
		position: fixed;
		background: rgba(51, 122, 255, 0.25);
		border: 1px dashed #337aff;
		pointer-events: none;
		z-index: 1000;
		will-change: transform;
	}
	/* Spacing toggle-look buttons — the selected item's own SKIPB/SPACEB/SPACEA/SKIPA (on their own
	   row right under Indicators), plus the record/file-level badges below, which live outside any
	   .toolbar-row (one pinned to the page corner, the other still in a toolbar row but styled the
	   same way regardless) — self-contained rather than relying on .toolbar-row button/button.active,
	   so the same look works in both places. Lit blue via .active — for the selected item's own row
	   that means "this keyword's indicator condition is currently satisfied"; for the record/file
	   badges (always .active when shown at all) it just means "this scope has spacing set". */
	.spacing-item-btn {
		padding: 1px 6px;
		font-family: 'Courier New', monospace;
		font-size: 12px;
		background: #ffffff;
		color: #000000;
		border: 1px solid #999;
		border-radius: 2px;
		cursor: pointer;
	}
	.spacing-item-btn.active {
		background: #337aff;
		color: #ffffff;
		border-color: #337aff;
	}
	/* The current record's own spacing badge, pinned to its page's top-left corner — same 'S'
	   language as a field/constant's own corner marker, just at page scale and clickable (a record
	   isn't one grid cell, so it has no natural in-page spot the way a field/constant does). */
	.pf-record-spacing-badge {
		position: absolute;
		top: -9px;
		left: -1px;
		z-index: 10;
	}
</style>
</head>
<body>
	<div id="toolbarContainer">
		<div id="toolbarRow1" class="toolbar-row">
			<button id="focusModeBtn" title="Hide the source code editor to focus on the preview (tree view stays visible)">${this.focusModeActive ? '🗗 Show code' : '🗖 Focus'}</button>
			${fileSpacingEntries.length > 0 ? `<button type="button" id="fileSpacingBtn" class="spacing-item-btn${anySpacingActive(fileSpacingEntries) ? ' active' : ''}" title="${escapeHtml(spacingTitle('File', fileSpacingEntries))}">📄 S</button>` : ''}
		</div>
		<div id="toolbarRow2" class="toolbar-row">
			<span id="sizeLabel">Size:</span>
			<label>Rows
				<input id="rows" type="number" min="1" max="255" value="${this.rows}">
			</label>
			<label>Cols
				<input id="cols" type="number" min="1" max="255" value="${this.cols}">
			</label>
			<label id="overflowLabel" title="OVRFLW/page length — when composed content would go past this line, it rolls onto a new page instead">Overflow
				<input id="overflow" type="number" min="1" max="255" value="${this.overflowLine}">
			</label>
			<label id="overlayLabel" title="Show another record dimmed behind this one, as a read-only reference — e.g. to check a detail row doesn't collide with the header above it">Overlay
				<select id="overlaySelect">${overlayOptions}</select>
				<label title="Keep tiling read-only copies of the overlay further down the page, so a reference copy stays visible even after SKIPB/SPACEB has pushed this record's own content far down">
					<input type="checkbox" id="overlayRepeatToggle" ${this.overlayRepeat ? 'checked' : ''} ${this.overlayRecordName ? '' : 'disabled'}> 🔁 Repeat
				</label>
			</label>
		</div>
		<div id="toolbarRow3" class="toolbar-row">
			<button id="addFieldBtn" title="Click, then click a point on the page to place a new field there">+ Field</button>
			<button id="addConstantBtn" title="Click, then click a point on the page to place a new constant there">+ Constant</button>
			<button id="rulerBtn" class="${this.showRuler ? 'active' : ''}" title="Show row numbers and a column ruler (every 5 columns) alongside the page">📏 Ruler</button>
			<button id="deleteItemBtn" ${this.highlightLineIndex === undefined ? 'disabled' : ''} title="Click a field/constant on the page first, then this to delete it entirely">🗑 Delete</button>
			<button id="attributesBtn" ${this.highlightLineIndex === undefined ? 'disabled' : ''} title="Click a field/constant on the page first, then this to set TEXT/COLOR/HIGHLIGHT/UNDERLINE/EDTCDE">🎨 Attributes</button>
			<button id="spacingBtn" ${this.highlightLineIndex === undefined ? 'disabled' : ''} title="Click a field/constant on the page first, then this to set/clear its SKIPB/SPACEB/SPACEA/SKIPA">↕️ Spacing</button>
		</div>
		<div id="toolbarRow4" class="toolbar-row">
			${hasIndicators ? `<label id="indicatorsLabel" title="Simulate which indicators are on, to preview conditional fields/constants/keywords — including a conditioned SKIPB/SPACEB/SPACEA/SKIPA, which shifts everything printed after it">
				<input type="checkbox" id="indicatorsToggle" ${this.indicatorsEnabled ? 'checked' : ''}> Indicators
			</label>` : ''}
			<label><input type="checkbox" id="composeToggle" ${this.sequence.length > 0 ? 'checked' : ''}> Compose sequence</label>
		</div>
		${this.indicatorsEnabled ? `<div id="toolbarRow5" class="toolbar-row">
			<span id="indicatorList">${indicatorButtonsHtml}</span>
		</div>` : ''}
		<div id="toolbarRowSpacing" class="toolbar-row" style="display:none">
			<span id="spacingList"></span>
		</div>
		<div id="sequenceBar" class="toolbar-row">
			<span id="sequenceRows"></span>
			<button id="addSequenceRowBtn" title="Add another record format to the composed sequence">+ Row</button>
		</div>
	</div>
	<div class="page-wrapper">
		<div id="page" class="${this.showRuler ? 'pf-ruler-on' : ''}">${pagesHtml}</div>
	</div>
	<script>
		const vscode = acquireVsCodeApi();
		document.getElementById('focusModeBtn').addEventListener('click', () => {
			vscode.postMessage({ type: 'toggleFocusMode' });
		});
		document.getElementById('rulerBtn').addEventListener('click', () => {
			vscode.postMessage({ type: 'toggleRuler' });
		});
		document.getElementById('overlayRepeatToggle').addEventListener('change', e => {
			vscode.postMessage({ type: 'setOverlayRepeat', enabled: e.target.checked });
		});
		document.getElementById('overlaySelect').addEventListener('change', e => {
			vscode.postMessage({ type: 'setOverlay', recordName: e.target.value || null });
			document.getElementById('overlayRepeatToggle').disabled = !e.target.value;
		});
		// Only rendered at all once there's at least one indicator to simulate in the current record.
		document.getElementById('indicatorsToggle')?.addEventListener('change', e => {
			vscode.postMessage({ type: 'setIndicatorsEnabled', enabled: e.target.checked });
		});
		document.querySelectorAll('.indicator-btn').forEach(btn => {
			btn.addEventListener('click', () => {
				vscode.postMessage({ type: 'toggleIndicator', number: Number(btn.dataset.indicator) });
			});
		});
		function postPageSize() {
			vscode.postMessage({
				type: 'setPageSize',
				rows: Number(document.getElementById('rows').value),
				cols: Number(document.getElementById('cols').value),
				overflow: Number(document.getElementById('overflow').value)
			});
		};
		document.getElementById('rows').addEventListener('change', postPageSize);
		document.getElementById('cols').addEventListener('change', postPageSize);
		document.getElementById('overflow').addEventListener('change', postPageSize);

		const addConstantBtn = document.getElementById('addConstantBtn');
		const addFieldBtn = document.getElementById('addFieldBtn');
		const deleteItemBtn = document.getElementById('deleteItemBtn');
		const attributesBtn = document.getElementById('attributesBtn');
		const spacingBtn = document.getElementById('spacingBtn');
		let currentHighlightLine = ${JSON.stringify(this.highlightLineIndex ?? null)};
		function refreshSelectionButtonsState() {
			const disabled = composeToggle.checked || currentHighlightLine === null || currentHighlightLine === undefined;
			deleteItemBtn.disabled = disabled;
			attributesBtn.disabled = disabled;
			spacingBtn.disabled = disabled;
		};
		deleteItemBtn.addEventListener('click', () => vscode.postMessage({ type: 'deleteItem' }));
		attributesBtn.addEventListener('click', () => vscode.postMessage({ type: 'editAttributes' }));
		spacingBtn.addEventListener('click', () => vscode.postMessage({ type: 'editSpacing' }));
		document.getElementById('recordSpacingBtn')?.addEventListener('click', () => vscode.postMessage({ type: 'editRecordSpacing' }));
		document.getElementById('fileSpacingBtn')?.addEventListener('click', () => vscode.postMessage({ type: 'editFileSpacing' }));

		// "Compose sequence": combine several record formats (each with a repeat count) onto one
		// page instead of previewing a single one — see collectComposedPageItems.
		const composeToggle = document.getElementById('composeToggle');
		const overlayLabel = document.getElementById('overlayLabel');
		const overflowLabel = document.getElementById('overflowLabel');
		const sequenceBar = document.getElementById('sequenceBar');
		const sequenceRows = document.getElementById('sequenceRows');
		const addSequenceRowBtn = document.getElementById('addSequenceRowBtn');
		const recordNames = ${recordNamesJson};
		const initialSequence = ${JSON.stringify(this.sequence)};

		function makeSequenceRow(recordName, repeat, repeatOnPageBreak) {
			const row = document.createElement('span');
			row.className = 'seq-row';
			const select = document.createElement('select');
			recordNames.forEach(name => {
				const option = document.createElement('option');
				option.value = name;
				option.textContent = name;
				select.appendChild(option);
			});
			if (recordName) select.value = recordName;
			const timesLabel = document.createTextNode(' × ');
			const repeatInput = document.createElement('input');
			repeatInput.type = 'number';
			repeatInput.min = '1';
			repeatInput.value = String(repeat || 1);
			const headerLabel = document.createElement('label');
			headerLabel.title = 'Repeat this record\\'s content at the top of every later page (e.g. a page header)';
			const headerCheckbox = document.createElement('input');
			headerCheckbox.type = 'checkbox';
			headerCheckbox.checked = Boolean(repeatOnPageBreak);
			headerLabel.appendChild(headerCheckbox);
			headerLabel.appendChild(document.createTextNode(' repeat per page'));
			const removeBtn = document.createElement('button');
			removeBtn.type = 'button';
			removeBtn.textContent = '\\u00d7';
			removeBtn.title = 'Remove this row';
			row.appendChild(select);
			row.appendChild(timesLabel);
			row.appendChild(repeatInput);
			row.appendChild(headerLabel);
			row.appendChild(removeBtn);
			select.addEventListener('change', postSequence);
			repeatInput.addEventListener('change', postSequence);
			headerCheckbox.addEventListener('change', postSequence);
			removeBtn.addEventListener('click', () => { row.remove(); postSequence(); });
			return row;
		};

		function postSequence() {
			const items = Array.from(sequenceRows.querySelectorAll('.seq-row')).map(row => ({
				recordName: row.querySelector('select').value,
				repeat: Number(row.querySelector('input[type=number]').value) || 1,
				repeatOnPageBreak: row.querySelector('input[type=checkbox]').checked
			}));
			vscode.postMessage({ type: 'setSequence', items });
		};

		addSequenceRowBtn.addEventListener('click', () => {
			sequenceRows.appendChild(makeSequenceRow('', 1, false));
			postSequence();
		});

		function setComposeMode(active) {
			overlayLabel.style.display = active ? 'none' : '';
			// Overflow/page length only means anything once several record instances are chained
			// onto a page — the reverse of overlayLabel, which only makes sense outside composition.
			overflowLabel.style.display = active ? '' : 'none';
			sequenceBar.classList.toggle('visible', active);
			addConstantBtn.disabled = active;
			addFieldBtn.disabled = active;
			refreshSelectionButtonsState();
		};

		composeToggle.addEventListener('change', () => {
			setComposeMode(composeToggle.checked);
			if (!composeToggle.checked) {
				vscode.postMessage({ type: 'setSequence', items: [] });
			} else {
				postSequence();
			};
		});

		if (initialSequence.length > 0) {
			initialSequence.forEach(it => sequenceRows.appendChild(makeSequenceRow(it.recordName, it.repeat, it.repeatOnPageBreak)));
		} else {
			sequenceRows.appendChild(makeSequenceRow('', 1, false));
		};
		setComposeMode(composeToggle.checked);

		const page = document.getElementById('page');
		const PAGE_ROWS = ${this.rows};
		const PAGE_COLS = ${this.cols};
		let dragState = null;

		function measure() {
			const firstLine = page.querySelector('.pf-line');
			const pageRect = page.getBoundingClientRect();
			const lineRect = firstLine.getBoundingClientRect();
			const probe = document.createElement('span');
			probe.style.visibility = 'hidden';
			probe.textContent = 'M'.repeat(50);
			// Prepended, not appended: lineRect.left is the .pf-line box's own edge, which sits
			// *before* its left padding — using that as padLeft under-measured the real text-start
			// x by exactly that padding, systematically shifting every computed column to the
			// right of where the mouse actually was. Measuring the probe's own rendered position
			// (with nothing ahead of it in the line) gives the true text-start x regardless of
			// whatever padding/border .pf-line has, without having to know or hardcode it.
			firstLine.insertBefore(probe, firstLine.firstChild);
			const probeRect = probe.getBoundingClientRect();
			const charWidth = probeRect.width / 50;
			const padLeft = probeRect.left - pageRect.left;
			probe.remove();
			return {
				pageRect,
				rowHeight: lineRect.height,
				charWidth,
				padLeft,
				padTop: lineRect.top - pageRect.top
			};
		};

		function cellFromEvent(e, dragState) {
			const metrics = dragState.metrics;
			// Subtract the grab offset (where within the item you actually clicked) before mapping
			// to a cell, so the item's start lands the same distance from the cursor throughout the
			// drag as it was at mousedown — otherwise the item jumps to put its first character
			// under the cursor the instant you move it.
			const adjX = e.clientX - dragState.grabOffsetX;
			const adjY = e.clientY - dragState.grabOffsetY;
			const col = Math.round((adjX - metrics.pageRect.left - metrics.padLeft) / metrics.charWidth) + 1;
			const row = Math.floor((adjY - metrics.pageRect.top - metrics.padTop) / metrics.rowHeight) + 1;
			return {
				row: Math.max(1, Math.min(PAGE_ROWS, row)),
				col: Math.max(1, Math.min(PAGE_COLS, col))
			};
		};

		// "Placing" mode: click a toolbar button, then click a point on the page to add a new item
		// there — same interaction dspf-edit uses for its own preview. Only one kind can be armed
		// at a time; the active button toggles off on a second click, and armed one disarms the
		// other.
		let placingKind = null;

		function setPlacingKind(kind) {
			placingKind = kind;
			addConstantBtn.classList.toggle('active', placingKind === 'constant');
			addFieldBtn.classList.toggle('active', placingKind === 'field');
			page.style.cursor = placingKind ? 'crosshair' : '';
			page.title = placingKind ? ('Click a point on the page to place the new ' + placingKind) : '';
		};

		addConstantBtn.addEventListener('click', () => {
			setPlacingKind(placingKind === 'constant' ? null : 'constant');
		});
		addFieldBtn.addEventListener('click', () => {
			setPlacingKind(placingKind === 'field' ? null : 'field');
		});

		page.addEventListener('mousedown', e => {
			if (e.button !== 0) return; // Left-click only — right-click opens the spacing menu instead.
			if (placingKind) {
				const metrics = measure();
				const col = Math.round((e.clientX - metrics.pageRect.left - metrics.padLeft) / metrics.charWidth) + 1;
				const row = Math.floor((e.clientY - metrics.pageRect.top - metrics.padTop) / metrics.rowHeight) + 1;
				if (row >= 1 && row <= PAGE_ROWS && col >= 1 && col <= PAGE_COLS) {
					vscode.postMessage({ type: placingKind === 'field' ? 'addFieldAt' : 'addConstantAt', row, col });
				};
				setPlacingKind(null);
				e.preventDefault();
				return;
			};
			const el = e.target.closest('[data-line]');
			if (!el) {
				// Clicked blank space on the page — deselect whatever was highlighted, same as
				// dspf-edit's own preview.
				applyHighlight(null);
				vscode.postMessage({ type: 'deselect' });
				return;
			};
			const rect = el.getBoundingClientRect();
			const metrics = measure();
			dragState = {
				lineIndex: Number(el.dataset.line),
				startX: e.clientX,
				startY: e.clientY,
				moved: false,
				// Nothing is draggable at all while composing a sequence (a rewritten line
				// wouldn't map cleanly onto a single repeated occurrence) — never let this drag
				// transition into a move, just a click-to-navigate.
				locked: composeToggle.checked,
				// A flow-positioned item (SPACEB/SPACEA/SKIPB/SKIPA) has no Line entry to rewrite —
				// the server adjusts its own SPACEB instead when this is set (see moveElement).
				flow: el.dataset.flow === '1',
				width: el.textContent.length,
				grabOffsetX: e.clientX - rect.left,
				grabOffsetY: e.clientY - rect.top,
				metrics
			};
			e.preventDefault();
		});

		page.addEventListener('contextmenu', e => {
			if (composeToggle.checked) return; // Nothing editable while composing — same as drag.
			const el = e.target.closest('[data-line]');
			if (!el) return;
			e.preventDefault();
			vscode.postMessage({ type: 'editSpacing', lineIndex: Number(el.dataset.line) });
		});

		document.addEventListener('mousemove', e => {
			if (!dragState) return;
			if (dragState.locked) return;
			if (!dragState.moved) {
				const dx = e.clientX - dragState.startX;
				const dy = e.clientY - dragState.startY;
				if (Math.hypot(dx, dy) < 4) return;
				dragState.moved = true;
				dragState.ghost = document.createElement('div');
				dragState.ghost.className = 'pf-ghost';
				// Fixed at the page's own origin; every subsequent move only ever writes the CSS
				// transform, never left/top — transform is compositor-only (no layout
				// recalculation), which is what actually makes the drag feel smooth, not how often
				// we compute a new cell.
				dragState.ghost.style.left = (dragState.metrics.pageRect.left + dragState.metrics.padLeft) + 'px';
				dragState.ghost.style.top = (dragState.metrics.pageRect.top + dragState.metrics.padTop) + 'px';
				dragState.ghost.style.width = (dragState.width * dragState.metrics.charWidth) + 'px';
				dragState.ghost.style.height = dragState.metrics.rowHeight + 'px';
				document.body.appendChild(dragState.ghost);
			};
			const cell = cellFromEvent(e, dragState);
			// Skip the DOM write entirely when the mouse moved but the snapped cell didn't —
			// avoids paying for a style update (and a message on drop) on every sub-cell pixel of
			// mouse jitter, not just avoiding layout thrashing.
			if (cell.row === dragState.row && cell.col === dragState.col) return;
			dragState.row = cell.row;
			dragState.col = cell.col;
			const x = (cell.col - 1) * dragState.metrics.charWidth;
			const y = (cell.row - 1) * dragState.metrics.rowHeight;
			dragState.ghost.style.transform = 'translate(' + x + 'px, ' + y + 'px)';
		});

		function endDrag(shouldApply) {
			if (!dragState) return;
			if (dragState.moved) {
				if (dragState.ghost) dragState.ghost.remove();
				if (shouldApply) {
					vscode.postMessage({ type: 'moveItem', lineIndex: dragState.lineIndex, newRow: dragState.row, newCol: dragState.col, flow: dragState.flow });
				};
			} else if (shouldApply) {
				vscode.postMessage({ type: 'gotoLine', lineIndex: dragState.lineIndex });
			};
			dragState = null;
		};

		document.addEventListener('mouseup', () => endDrag(true));

		document.addEventListener('keydown', e => {
			if (e.key !== 'Escape') return;
			if (placingKind) {
				setPlacingKind(null);
				return;
			};
			endDrag(false);
		});

		const toolbarRowSpacing = document.getElementById('toolbarRowSpacing');
		const spacingList = document.getElementById('spacingList');

		function renderSpacingRow(lineIndex) {
			spacingList.innerHTML = '';
			const el = lineIndex === null || lineIndex === undefined
				? null
				: document.querySelector('[data-line="' + lineIndex + '"][data-spacing]');
			const entries = el ? (() => { try { return JSON.parse(el.dataset.spacing); } catch (e) { return null; }; })() : null;
			if (!entries || !entries.length) {
				toolbarRowSpacing.style.display = 'none';
				return;
			};
			entries.forEach(entry => {
				const btn = document.createElement('button');
				btn.type = 'button';
				btn.className = 'spacing-item-btn' + (entry.active ? ' active' : '');
				btn.textContent = entry.keyword + '(' + entry.value + ')';
				btn.title = (entry.active ? 'Active' : 'Not active (indicator condition not met)') + ' — click to change ' + entry.keyword;
				btn.addEventListener('click', () => {
					vscode.postMessage({ type: 'editSpacing', lineIndex, keyword: entry.keyword });
				});
				spacingList.appendChild(btn);
			});
			toolbarRowSpacing.style.display = '';
		};

		function applyHighlight(lineIndex) {
			document.querySelectorAll('.pf-highlight').forEach(el => el.classList.remove('pf-highlight'));
			currentHighlightLine = lineIndex;
			refreshSelectionButtonsState();
			if (lineIndex !== null && lineIndex !== undefined) {
				document.querySelectorAll('[data-line="' + lineIndex + '"]').forEach(el => el.classList.add('pf-highlight'));
			};
			renderSpacingRow(lineIndex);
		};
		window.addEventListener('message', event => {
			if (event.data.type === 'highlightLine') applyHighlight(event.data.lineIndex);
			if (event.data.type === 'focusModeChanged') {
				const focusModeBtn = document.getElementById('focusModeBtn');
				focusModeBtn.textContent = event.data.active ? '🗗 Show code' : '🗖 Focus';
				focusModeBtn.classList.toggle('active', event.data.active);
			};
			if (event.data.type === 'rulerChanged') {
				document.getElementById('page').classList.toggle('pf-ruler-on', event.data.active);
				document.getElementById('rulerBtn').classList.toggle('active', event.data.active);
			};
		});
		applyHighlight(${JSON.stringify(this.highlightLineIndex ?? null)});
	</script>
</body>
</html>`;
	};

	private dispose(): void {
		RecordPreviewPanel.current = undefined;
		this.panel.dispose();
		while (this.disposables.length) {
			const d = this.disposables.pop();
			if (d) {d.dispose();}
		};
	};
};

function clampPageSize(value: unknown, fallback: number): number {
	const n = Number(value);
	if (!Number.isFinite(n) || n < 1) {return fallback;}
	return Math.min(Math.floor(n), 255);
};
