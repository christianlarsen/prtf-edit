/*
	Christian Larsen, 2026
	"PRTF structure"
	prtf-edit.record-preview-panel.ts
*/

import * as vscode from 'vscode';
import { PrtfElement, PrtfField, PrtfConstant, PrtfRecord, PrtfAttribute, systemKeywordPlaceholder, findTextKeyword } from '../prtf-edit.model/prtf-edit.model';
import { simulateRecordFlow } from '../prtf-edit.parser/prtf-edit.parser';
import { revealLine } from '../prtf-edit.utils/prtf-edit.navigation';
import { revealInTree } from '../prtf-edit.providers/prtf-edit.providers';
import { moveElement } from '../prtf-edit.commands/prtf-edit.move-element';
import { addConstantAt } from '../prtf-edit.commands/prtf-edit.add-constant';
import { addFieldAt } from '../prtf-edit.commands/prtf-edit.add-field';

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
interface EditCodeInfo {
	commas: boolean;
	sign: 'none' | 'suffixMinus' | 'suffixCr' | 'prefixMinus';
};

const EDIT_CODES: Record<string, EditCodeInfo> = {
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
function parseEdtcde(attributes: PrtfAttribute[] | undefined): { code: string; currency?: string } | undefined {
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
 */
function editedNumericPlaceholder(field: PrtfField): string | undefined {
	const edtcde = parseEdtcde(field.attributes);
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

function fieldPlaceholderText(field: PrtfField): string {
	const edited = editedNumericPlaceholder(field);
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
 * Placeholder text for a constant. A bare DATE/TIME/PAGNBR keyword (no quoted literal — see
 * "Constant fields in printer files" in the DDS reference) prints a system-supplied value at run
 * time; approximate that with a representative pattern instead of showing nothing.
 */
function constantPlaceholderText(constant: PrtfConstant): string {
	for (const attr of constant.attributes ?? []) {
		const placeholder = systemKeywordPlaceholder(attr.value);
		if (placeholder) {return placeholder;};
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
const COLOR_NAMES: Record<string, string> = {
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
 * True when the field/constant carries HIGHLIGHT, or its owning record does — HIGHLIGHT is valid
 * at either level (see "HIGHLIGHT (Highlight) keyword in printer files"), and a record-level one
 * applies to every field in that record.
 */
function hasHighlight(itemAttributes: PrtfAttribute[] | undefined, recordAttributes: PrtfAttribute[] | undefined): boolean {
	const carries = (attrs: PrtfAttribute[] | undefined) => (attrs ?? []).some(attr => /\bHIGHLIGHT\b/i.test(attr.value));
	return carries(itemAttributes) || carries(recordAttributes);
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
 * simulation instead of the field's own (isolated-record) resolved `row`. */
function buildFieldPageItem(field: PrtfField, rowOverride?: number, forceFlowFlag?: boolean, recordAttributes?: PrtfAttribute[]): PageItem | undefined {
	const row = rowOverride ?? field.row;
	if (row === undefined || field.column === undefined) {return undefined;};

	const textDescription = findTextKeyword(field.attributes);
	const flowPositioned = forceFlowFlag ?? (field.positionSource === 'flow');
	const title = [textDescription ? `${field.name} — ${textDescription}` : field.name, flowPositioned ? '(flow-positioned; drag moves column only)' : '']
		.filter(Boolean).join(' ');
	return {
		row, col: field.column, text: fieldPlaceholderText(field), title, lineIndex: field.lineIndex,
		underline: hasUnderline(field.attributes), flowPositioned,
		bold: hasHighlight(field.attributes, recordAttributes), color: getColor(field.attributes)
	};
};

/** Builds one constant's PageItem — see buildFieldPageItem. */
function buildConstantPageItem(constant: PrtfConstant, rowOverride?: number, forceFlowFlag?: boolean, recordAttributes?: PrtfAttribute[]): PageItem {
	const row = rowOverride ?? constant.row;
	const flowPositioned = forceFlowFlag ?? (constant.positionSource === 'flow');
	const title = [findTextKeyword(constant.attributes), flowPositioned ? '(flow-positioned; drag moves column only)' : ''].filter(Boolean).join(' ') || undefined;
	return {
		row, col: constant.column, text: constantPlaceholderText(constant), title, lineIndex: constant.lineIndex,
		underline: hasUnderline(constant.attributes), flowPositioned,
		bold: hasHighlight(constant.attributes, recordAttributes), color: getColor(constant.attributes)
	};
};

/**
 * Collects the visible (row, col, text) items for one record: fields and constants with a
 * resolved absolute position, skipping program-to-system fields (usage `P` — they never print).
 * A record positioned via SPACEB/SPACEA/SKIPB/SKIPA flow (no explicit Line) is included too, its
 * rows already normalized to absolute coordinates by the parser's resolveFlowModePositions.
 */
export function collectPageItems(elements: PrtfElement[], recordName: string): PageItem[] {
	const items: PageItem[] = [];
	const recordAttributes = elements.find((el): el is PrtfRecord => el.kind === 'record' && el.name === recordName)?.attributes;

	for (const el of elements) {
		if (el.kind === 'field' && el.recordname === recordName && !el.programToSystem) {
			const item = buildFieldPageItem(el, undefined, undefined, recordAttributes);
			if (item) {items.push(item);};
		} else if (el.kind === 'constant' && el.recordname === recordName) {
			items.push(buildConstantPageItem(el, undefined, undefined, recordAttributes));
		};
	};

	return items;
};

/** One entry in a composed multi-record sequence: a record format, repeated `repeat` times. */
export interface SequenceEntry {
	recordName: string;
	repeat: number;
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
 */
function positionRecordEntry(
	elements: PrtfElement[],
	record: PrtfRecord,
	startLine: number,
	tagOverlay: boolean
): { items: PageItem[]; endLine: number } {
	const recordItems = elements
		.filter((el): el is PrtfField | PrtfConstant => (el.kind === 'field' || el.kind === 'constant') && el.recordname === record.name)
		.sort((a, b) => a.lineIndex - b.lineIndex);
	if (recordItems.length === 0) {return { items: [], endLine: startLine };};

	const items: PageItem[] = [];
	let currentLine = startLine;
	const tag = (item: PageItem): PageItem => tagOverlay ? { ...item, overlay: true } : item;

	if (recordItems.every(item => item.positionSource !== 'explicit')) {
		const { rows, endLine } = simulateRecordFlow(record, recordItems, startLine);
		for (const item of recordItems) {
			const row = rows.get(item.lineIndex);
			if (row === undefined) {continue;};
			if (item.kind === 'field') {
				if (item.programToSystem) {continue;};
				const built = buildFieldPageItem(item, row, true, record.attributes);
				if (built) {items.push(tag(built));};
			} else {
				items.push(tag(buildConstantPageItem(item, row, true, record.attributes)));
			};
		};
		currentLine = endLine;
	} else {
		for (const item of recordItems) {
			if (item.kind === 'field') {
				if (item.programToSystem) {continue;};
				const built = buildFieldPageItem(item, undefined, undefined, record.attributes);
				if (built) {
					items.push(tag(built));
					// +1: the default handoff is the line *after* the highest one this record
					// used, not that same line again.
					currentLine = Math.max(currentLine, built.row + 1);
				};
			} else {
				const built = buildConstantPageItem(item, undefined, undefined, record.attributes);
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
 * @param elements - The full parsed document
 * @param sequence - The ordered, repeat-counted record formats to compose
 * @param overflowLine - The page length (OVRFLW/PAGESIZE) to roll over at
 */
export function collectComposedPageItems(elements: PrtfElement[], sequence: SequenceEntry[], overflowLine: number): PageItem[] {
	const items: PageItem[] = [];
	const records = elements.filter((el): el is PrtfRecord => el.kind === 'record');
	const pageLength = Math.max(1, Math.floor(overflowLine) || 1);
	let currentLine = 0;
	let currentPage = 1;

	for (const entry of sequence) {
		const record = records.find(r => r.name === entry.recordName);
		if (!record) {continue;};

		const repeatCount = Math.max(1, Math.floor(entry.repeat) || 1);
		for (let i = 0; i < repeatCount; i++) {
			let result = positionRecordEntry(elements, record, currentLine, false);
			const highestRow = Math.max(currentLine, result.endLine - 1, ...result.items.map(it => it.row));

			if (highestRow > pageLength && currentLine > 0) {
				// Would overflow the current (non-empty) page — start this instance fresh at the
				// top of a new one instead of letting it spill across the page boundary.
				currentPage += 1;
				currentLine = 0;
				result = positionRecordEntry(elements, record, currentLine, false);
			};

			for (const item of result.items) {items.push({ ...item, page: currentPage });};
			currentLine = result.endLine;

			if (hasEndPage(record.attributes)) {
				currentPage += 1;
				currentLine = 0;
			};
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
 */
export function collectPageItemsWithOverlay(elements: PrtfElement[], recordName: string, overlayRecordName: string): PageItem[] {
	const records = elements.filter((el): el is PrtfRecord => el.kind === 'record');
	const activeRecord = records.find(r => r.name === recordName);
	if (!activeRecord) {return [];};

	const overlayRecord = records.find(r => r.name === overlayRecordName);
	if (!overlayRecord) {return positionRecordEntry(elements, activeRecord, 0, false).items;};

	const activeIsFirst = activeRecord.lineIndex <= overlayRecord.lineIndex;
	const firstRecord = activeIsFirst ? activeRecord : overlayRecord;
	const secondRecord = activeIsFirst ? overlayRecord : activeRecord;

	const firstResult = positionRecordEntry(elements, firstRecord, 0, !activeIsFirst);
	const secondResult = positionRecordEntry(elements, secondRecord, firstResult.endLine, activeIsFirst);

	const overlayItems = activeIsFirst ? secondResult.items : firstResult.items;
	const activeItems = activeIsFirst ? firstResult.items : secondResult.items;
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
			const styleAttr = item.color ? ` style="color:${item.color}"` : '';
			const cssClass = [
				'pf-item',
				item.underline ? 'pf-underline' : '',
				item.bold ? 'pf-bold' : '',
				item.overlay ? 'pf-overlay' : ''
			].filter(Boolean).join(' ');
			html += `<span class="${cssClass}"${lineAttr}${flowAttr}${titleAttr}${styleAttr}>${segment}</span>`;
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
	 * Mirrors dspf-edit's own Overlay control. Not offered while composing a sequence. */
	private overlayRecordName: string | undefined;
	private disposables: vscode.Disposable[] = [];

	public static createOrShow(recordName: string, elements: PrtfElement[]): void {
		if (RecordPreviewPanel.current) {
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

	/** Re-renders the currently open preview with freshly parsed elements (e.g. after a source
	 * edit), if a panel is open — a no-op otherwise. */
	public static refreshIfOpen(elements: PrtfElement[]): void {
		if (!RecordPreviewPanel.current) {return;}
		RecordPreviewPanel.current.elements = elements;
		RecordPreviewPanel.current.render();
	};

	/**
	 * Follows the source cursor: switches the previewed record (re-rendering) when the cursor
	 * lands in a different one, or just moves the highlight (no re-render — avoids flicker/losing
	 * scroll position on every keystroke) when it's still within the currently shown record.
	 */
	public static syncFromSourceLine(elements: PrtfElement[], lineIndex: number): void {
		const panel = RecordPreviewPanel.current;
		if (!panel) {return;}

		const target = findElementAtLine(elements, lineIndex);
		if (!target) {return;}

		if (target.recordName !== panel.recordName) {
			panel.recordName = target.recordName;
			panel.elements = elements;
			panel.highlightLineIndex = target.targetLineIndex;
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

	private onDidReceiveMessage(message: any): void {
		switch (message.type) {
			case 'setRecord':
				this.recordName = message.recordName;
				this.highlightLineIndex = undefined;
				this.overlayRecordName = undefined;
				this.render();
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
						.map((it: any) => ({ recordName: it.recordName, repeat: Math.max(1, Math.floor(Number(it.repeat)) || 1) }))
					: [];
				this.render();
				break;
			case 'setOverlay':
				this.overlayRecordName = typeof message.recordName === 'string' && message.recordName ? message.recordName : undefined;
				this.render();
				break;
			case 'gotoLine':
				if (typeof message.lineIndex === 'number') {
					revealLine(message.lineIndex);
					const target = findElementAtLine(this.elements, message.lineIndex);
					revealInTree(target?.recordName ?? this.recordName, message.lineIndex);
				};
				break;
			case 'moveItem':
				if (this.sequence.length === 0 && typeof message.lineIndex === 'number' && typeof message.newRow === 'number' && typeof message.newCol === 'number') {
					moveElement(message.lineIndex, message.newRow, message.newCol, this.rows, this.cols, Boolean(message.columnOnly));
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

	private render(): void {
		const records = this.elements.filter((e): e is PrtfRecord => e.kind === 'record');
		if (!records.some(r => r.name === this.recordName) && records.length > 0) {
			this.recordName = records[0].name;
		};

		const composing = this.sequence.length > 0;
		// positionRecordEntry lists the overlay's items first — buildPageGrid/buildOwnerGrid
		// resolve a shared cell to whichever item comes *last* in the array, so the active
		// record's own content (and its interactivity) always wins where the two overlap.
		const items = composing
			? collectComposedPageItems(this.elements, this.sequence, this.overflowLine)
			: this.overlayRecordName
				? collectPageItemsWithOverlay(this.elements, this.recordName, this.overlayRecordName)
				: collectPageItems(this.elements, this.recordName);

		this.panel.title = composing ? 'Preview: (composed)' : `Preview: ${this.recordName || '(no records)'}`;
		this.panel.webview.html = this.getHtml(records, items);
	};

	private getHtml(records: PrtfRecord[], items: PageItem[]): string {
		const options = records
			.map(r => `<option value="${escapeHtml(r.name)}" ${r.name === this.recordName ? 'selected' : ''}>${escapeHtml(r.name)}</option>`)
			.join('');

		const overlayOptions = [`<option value="">(none)</option>`]
			.concat(records
				.filter(r => r.name !== this.recordName)
				.map(r => `<option value="${escapeHtml(r.name)}" ${r.name === this.overlayRecordName ? 'selected' : ''}>${escapeHtml(r.name)}</option>`))
			.join('');

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
			return `<div class="pf-page-group">${label}<div class="page">${rowsHtml}</div></div>`;
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
	.toolbar {
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 8px 12px;
		border-bottom: 1px solid #ccc;
		position: sticky;
		top: 0;
		background: #f3f3f3;
	}
	.toolbar label {
		display: flex;
		align-items: center;
		gap: 4px;
		font-size: 12px;
		color: #000000;
	}
	.toolbar select, .toolbar input {
		background: #ffffff;
		color: #000000;
		border: 1px solid #999;
		border-radius: 2px;
		padding: 2px 4px;
	}
	.toolbar input[type=number] {
		width: 4em;
	}
	.toolbar button {
		background: #ffffff;
		color: #000000;
		border: 1px solid #999;
		border-radius: 2px;
		padding: 3px 8px;
		font-size: 12px;
		cursor: pointer;
	}
	.toolbar button.active {
		background: #337aff;
		color: #ffffff;
		border-color: #337aff;
	}
	#sequenceBar {
		display: none;
		flex-wrap: wrap;
		border-top: 1px solid #ddd;
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
	.page-wrapper {
		padding: 16px;
		overflow: auto;
	}
	.page {
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
	.pf-line {
		padding: 0 6px;
	}
	.pf-item {
		cursor: pointer;
	}
	.pf-underline {
		text-decoration: underline;
	}
	.pf-bold {
		font-weight: bold;
	}
	.pf-overlay {
		opacity: 0.4;
		cursor: default;
		pointer-events: none;
	}
	.pf-item:hover {
		background: #cce4ff;
	}
	.pf-item.pf-highlight {
		background: #ffe08a;
		outline: 1px solid #cc9900;
	}
	.pf-ghost {
		position: fixed;
		background: rgba(51, 122, 255, 0.25);
		border: 1px dashed #337aff;
		pointer-events: none;
		z-index: 1000;
		will-change: transform;
	}
	.note {
		padding: 8px 12px;
		font-size: 12px;
		color: #555;
	}
</style>
</head>
<body>
	<div class="toolbar">
		<label><input type="checkbox" id="composeToggle" ${this.sequence.length > 0 ? 'checked' : ''}> Compose sequence</label>
		<label id="recordLabel">Record
			<select id="record">${options}</select>
		</label>
		<label id="overlayLabel" title="Show another record dimmed behind this one, as a read-only reference — e.g. to check a detail row doesn't collide with the header above it">Overlay
			<select id="overlaySelect">${overlayOptions}</select>
		</label>
		<label>Rows
			<input id="rows" type="number" min="1" max="255" value="${this.rows}">
		</label>
		<label>Cols
			<input id="cols" type="number" min="1" max="255" value="${this.cols}">
		</label>
		<label id="overflowLabel" title="OVRFLW/page length — when composed content would go past this line, it rolls onto a new page instead">Overflow
			<input id="overflow" type="number" min="1" max="255" value="${this.overflowLine}">
		</label>
		<button id="addConstantBtn" title="Click, then click a point on the page to place a new constant there">+ Constant</button>
		<button id="addFieldBtn" title="Click, then click a point on the page to place a new field there">+ Field</button>
	</div>
	<div class="toolbar" id="sequenceBar">
		<span id="sequenceRows"></span>
		<button id="addSequenceRowBtn" title="Add another record format to the composed sequence">+ Row</button>
	</div>
	<div class="page-wrapper">
		<div id="page">${pagesHtml}</div>
	</div>
	<div class="note">Fields show as O (character/date/time) or 6 (numeric) — hover a field to see
	its name (and its TEXT() description, if any). A numeric field with EDTCDE shows its edited
	worst-case width instead (9s with commas/decimal point/sign, like RLU's own design view), and
	UNDERLINE renders as underline, HIGHLIGHT (field- or record-level) as bold, and COLOR's named
	colors (BLK/BLU/BRN/GRN/PNK/RED/TRQ/YLW) in that color — the RGB/CMYK/CIELAB/Highlight color
	models aren't simple enough to map here, so those show in the default color. Click a field or
	constant to jump to it in the source; drag it
	to reposition (rewrites only its Line/Position columns — name, type and keywords are
	untouched). "+ Constant" or "+ Field", then click the page, to add a new one there. Moving the
	cursor in the source highlights it back here.
	Page size is not stored in DDS source — set it here to match your CRTPRTF PAGESIZE.
	A record positioned via SPACEB/SPACEA/SKIPB/SKIPA flow (no explicit Line) is shown as one pass
	down the page in source order — dragging one of its fields/constants only moves it sideways
	(rewrites Position, not Line), since its row comes from simulating those keywords, not from a
	Line entry to rewrite.
	"Compose sequence" combines several record formats (with a repeat count each, e.g. a header
	once and a detail row several times) onto one page, chaining flow-mode records' current line
	across the whole sequence — editing (drag, "+ Constant"/"+ Field") is unavailable while
	composing.
	Overlay shows a second record dimmed behind this one, read-only, as a reference while you drag
	or place things in the active record — e.g. to see whether a detail row would collide with the
	header above it. Not offered while composing a sequence.
	Overflow (only shown while composing) is the OVRFLW/page-length line — composed content that
	would go past it rolls onto a new page instead, shown as a separate sheet below; a record with
	the ENDPAGE keyword always starts a new page right after it prints, regardless of Overflow.</div>
	<script>
		const vscode = acquireVsCodeApi();
		document.getElementById('record').addEventListener('change', e => {
			vscode.postMessage({ type: 'setRecord', recordName: e.target.value });
		});
		document.getElementById('overlaySelect').addEventListener('change', e => {
			vscode.postMessage({ type: 'setOverlay', recordName: e.target.value || null });
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

		// "Compose sequence": combine several record formats (each with a repeat count) onto one
		// page instead of previewing a single one — see collectComposedPageItems.
		const composeToggle = document.getElementById('composeToggle');
		const recordLabel = document.getElementById('recordLabel');
		const overlayLabel = document.getElementById('overlayLabel');
		const overflowLabel = document.getElementById('overflowLabel');
		const sequenceBar = document.getElementById('sequenceBar');
		const sequenceRows = document.getElementById('sequenceRows');
		const addSequenceRowBtn = document.getElementById('addSequenceRowBtn');
		const recordOptionsHtml = document.getElementById('record').innerHTML;
		const initialSequence = ${JSON.stringify(this.sequence)};

		function makeSequenceRow(recordName, repeat) {
			const row = document.createElement('span');
			row.className = 'seq-row';
			const select = document.createElement('select');
			select.innerHTML = recordOptionsHtml;
			if (recordName) select.value = recordName;
			const timesLabel = document.createTextNode(' × ');
			const repeatInput = document.createElement('input');
			repeatInput.type = 'number';
			repeatInput.min = '1';
			repeatInput.value = String(repeat || 1);
			const removeBtn = document.createElement('button');
			removeBtn.type = 'button';
			removeBtn.textContent = '\\u00d7';
			removeBtn.title = 'Remove this row';
			row.appendChild(select);
			row.appendChild(timesLabel);
			row.appendChild(repeatInput);
			row.appendChild(removeBtn);
			select.addEventListener('change', postSequence);
			repeatInput.addEventListener('change', postSequence);
			removeBtn.addEventListener('click', () => { row.remove(); postSequence(); });
			return row;
		};

		function postSequence() {
			const items = Array.from(sequenceRows.querySelectorAll('.seq-row')).map(row => ({
				recordName: row.querySelector('select').value,
				repeat: Number(row.querySelector('input').value) || 1
			}));
			vscode.postMessage({ type: 'setSequence', items });
		};

		addSequenceRowBtn.addEventListener('click', () => {
			sequenceRows.appendChild(makeSequenceRow('', 1));
			postSequence();
		});

		function setComposeMode(active) {
			recordLabel.style.display = active ? 'none' : '';
			overlayLabel.style.display = active ? 'none' : '';
			// Overflow/page length only means anything once several record instances are chained
			// onto a page — the reverse of recordLabel/overlayLabel, which only make sense outside
			// composition.
			overflowLabel.style.display = active ? '' : 'none';
			sequenceBar.classList.toggle('visible', active);
			addConstantBtn.disabled = active;
			addFieldBtn.disabled = active;
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
			initialSequence.forEach(it => sequenceRows.appendChild(makeSequenceRow(it.recordName, it.repeat)));
		} else {
			sequenceRows.appendChild(makeSequenceRow('', 1));
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
			if (!el) return;
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
				// A flow-positioned item (SPACEB/SPACEA/SKIPB/SKIPA) has no Line entry to rewrite,
				// but its Position is a real column — dragging it can still move it sideways, the
				// row just snaps back to where it already was.
				columnOnly: el.dataset.flow === '1',
				originalRow: Math.round((rect.top - metrics.pageRect.top - metrics.padTop) / metrics.rowHeight) + 1,
				width: el.textContent.length,
				grabOffsetX: e.clientX - rect.left,
				grabOffsetY: e.clientY - rect.top,
				metrics
			};
			e.preventDefault();
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
			if (dragState.columnOnly) { cell.row = dragState.originalRow; };
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
					vscode.postMessage({ type: 'moveItem', lineIndex: dragState.lineIndex, newRow: dragState.row, newCol: dragState.col, columnOnly: dragState.columnOnly });
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

		function applyHighlight(lineIndex) {
			document.querySelectorAll('.pf-highlight').forEach(el => el.classList.remove('pf-highlight'));
			if (lineIndex === null || lineIndex === undefined) return;
			document.querySelectorAll('[data-line="' + lineIndex + '"]').forEach(el => el.classList.add('pf-highlight'));
		};
		window.addEventListener('message', event => {
			if (event.data.type === 'highlightLine') applyHighlight(event.data.lineIndex);
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
