/*
	Christian Larsen, 2026
	"PRTF structure"
	prtf-edit.move-element.ts
*/

import * as vscode from 'vscode';
import { ExtensionState } from '../prtf-edit.states/state';
import { resolveFlowModeMove } from '../prtf-edit.parser/prtf-edit.parser';
import { PrtfAttribute } from '../prtf-edit.model/prtf-edit.model';

/**
 * Rewrites a source line's Line/Position zone (columns 39-41, 42-44 — 0-based 38-40/41-43) with
 * new values, leaving everything else on the line untouched. Same column arithmetic as dspf-edit's
 * own change-position.ts — the fixed-column layout is identical in this zone for PRTF and DSPF.
 */
export function buildRepositionedLine(originalLine: string, newRow: number, newCol: number): string {
	const formattedRow = String(newRow).padStart(3, ' ');
	const formattedCol = String(newCol).padStart(3, ' ');
	const prefix = originalLine.substring(0, 38);
	const suffix = originalLine.substring(44);
	return prefix + formattedRow + formattedCol + suffix;
};

/**
 * Same idea, but leaves the Line zone (columns 39-41) exactly as it was — only Position (42-44)
 * is rewritten. Used for a flow-mode field/constant (no explicit Line at all; its row comes from
 * simulating SPACEB/SPACEA/SKIPB/SKIPA — see resolveFlowModePositions in the parser): writing a
 * Line value there would silently convert it to explicit mode and put it at odds with the
 * record's own SPACE/SKIP keywords, which prtf-edit.validation.ts would then flag as a real
 * CRTPRTF conflict. Position is independent of Line either way, so this is always safe on its
 * own — moving such an item *vertically* additionally requires adjusting its own SPACEB, which
 * applyFlowMove below handles alongside this.
 */
export function buildRepositionedColumnOnly(originalLine: string, newCol: number): string {
	const formattedCol = String(newCol).padStart(3, ' ');
	const prefix = originalLine.substring(0, 41);
	const suffix = originalLine.substring(44);
	return prefix + formattedCol + suffix;
};

/** Matches an existing SPACEB(n) keyword anywhere in a line's text (case-insensitive), including
 * one leading whitespace character so removing it doesn't leave a stray double space behind. */
const SPACEB_PATTERN = /\s?\bSPACEB\(\s*\d+\s*\)/i;

/**
 * Replaces an existing SPACEB(n) on a line with a new value, or removes it entirely when
 * newValue is 0 (flow-mode's own "no keyword = continue on the current line" rule — same as a
 * blank Line means "same row as before" in explicit mode). Assumes the line already contains a
 * SPACEB keyword; callers only reach this once they've confirmed that via SPACEB_PATTERN.
 */
export function applySpaceBToLine(lineText: string, newValue: number): string {
	return newValue > 0
		? lineText.replace(SPACEB_PATTERN, ` SPACEB(${newValue})`)
		: lineText.replace(SPACEB_PATTERN, '');
};

/**
 * True for a keyword-only continuation line (just form-type 'A' in column 6 — see
 * buildFieldLine/buildConstantLines) that's left with nothing in its keyword zone (columns 45-80),
 * e.g. after applySpaceBToLine strips out its only keyword. Such a line is now dead weight and
 * should be deleted outright rather than left behind blank — *including* when it still carries its
 * own indicator condition (e.g. a leftover "IN30" from "IN30 SPACEB(2)" once SPACEB is gone):
 * keeping just the indicator zone wouldn't leave a meaningful line, it would leave one that's
 * structurally indistinguishable, on the next parse, from a *pending* indicator group conditioning
 * whatever field/constant happens to follow — silently attaching a condition that was never meant
 * for it. Deliberately checks only the keyword zone, not the whole line from column 6 onward.
 */
export function isEmptyKeywordOnlyLine(lineText: string): boolean {
	if (lineText.length < 6 || lineText[5] !== 'A') {return false;};
	if (lineText.substring(0, 5).trim() !== '') {return false;};
	return lineText.length <= 44 || lineText.substring(44).trim() === '';
};

/**
 * Moves a flow-mode field/constant to a new (row, col): always rewrites Position on its own
 * primary line (via buildRepositionedColumnOnly), and separately updates, removes, or adds this
 * item's own SPACEB(n) so the row the parser resolves it to (via simulateRecordFlow) matches
 * `clampedRow` — mirroring the same SPACEB-continuation-line convention addFieldAt/addConstantAt
 * already use (see prtf-edit.parser.ts's resolveFlowModeInsertion). Only this item's own SPACEB is
 * touched; anything later in the record naturally shifts by the same delta, since its own SPACEB
 * (if any) is relative to wherever this item leaves the running line — the same cascade that would
 * happen if the SPACEB were edited by hand.
 */
async function applyFlowMove(
	document: vscode.TextDocument,
	primaryLine: vscode.TextLine,
	lineIndex: number,
	clampedRow: number,
	clampedCol: number,
	baselineRow: number,
	item: { lastLineIndex?: number; attributes?: { value: string; lineIndex: number }[] }
): Promise<boolean> {
	const newSpaceB = Math.max(0, clampedRow - baselineRow);
	const existingAttr = (item.attributes ?? []).find(attr => SPACEB_PATTERN.test(attr.value));

	let updatedPrimaryText = buildRepositionedColumnOnly(primaryLine.text, clampedCol);
	const edit = new vscode.WorkspaceEdit();

	if (existingAttr && existingAttr.lineIndex === lineIndex) {
		// Inline on the item's own line (e.g. "...SPACEB(2) UNDERLINE") — fold both changes into
		// one replace so the two edits can't overlap.
		updatedPrimaryText = applySpaceBToLine(updatedPrimaryText, newSpaceB);
		edit.replace(document.uri, primaryLine.range, updatedPrimaryText);
	} else if (existingAttr) {
		edit.replace(document.uri, primaryLine.range, updatedPrimaryText);
		const spaceBLine = document.lineAt(existingAttr.lineIndex);
		const updatedSpaceBText = applySpaceBToLine(spaceBLine.text, newSpaceB);
		if (newSpaceB === 0 && isEmptyKeywordOnlyLine(updatedSpaceBText)) {
			edit.delete(document.uri, spaceBLine.rangeIncludingLineBreak);
		} else {
			edit.replace(document.uri, spaceBLine.range, updatedSpaceBText);
		};
	} else {
		edit.replace(document.uri, primaryLine.range, updatedPrimaryText);
		if (newSpaceB > 0) {
			const anchorLineIndex = item.lastLineIndex ?? lineIndex;
			const insertPosition = document.lineAt(anchorLineIndex).range.end;
			const spaceBLine = ' '.repeat(5) + 'A' + ' '.repeat(38) + `SPACEB(${newSpaceB})`;
			edit.insert(document.uri, insertPosition, '\n' + spaceBLine);
		};
	};

	return vscode.workspace.applyEdit(edit);
};

/**
 * A flow-mode item's row can never fall before its own baseline (see resolveFlowModeMove) —
 * SPACEB can't be negative, so nothing short of reordering the source can make it print earlier
 * than whatever already precedes it. Finds that immediately preceding field/constant *within the
 * same record*, so a drag past the baseline can swap places with it instead of just clamping.
 * Returns undefined when the dragged item is already the record's first field/constant (nothing
 * to swap with — the record format's own name line is not a swap candidate).
 */
export function findPreviousItemInRecord(elements: any[], recordName: string, lineIndex: number): { lineIndex: number; recordname: string } | undefined {
	const items = elements
		.filter((el: any) => (el.kind === 'field' || el.kind === 'constant') && el.recordname === recordName)
		.sort((a: any, b: any) => a.lineIndex - b.lineIndex);
	const index = items.findIndex((el: any) => el.lineIndex === lineIndex);
	return index > 0 ? items[index - 1] : undefined;
};

/**
 * The last source line belonging to an item's own block: its definition line through every
 * trailing keyword-only continuation line, up to (but not including) whatever the next record/
 * field/constant in the whole document starts on. Comment/blank lines in between are swept up as
 * part of the block too, same as they'd travel with the item in any other edit — there's no
 * separate "these belong to nobody" case in DDS's own continuation-line model.
 */
export function findBlockEndLineIndex(elements: any[], afterLineIndex: number, totalLines: number): number {
	const nextLineIndex = elements
		.filter((el: any) => (el.kind === 'record' || el.kind === 'field' || el.kind === 'constant') && el.lineIndex > afterLineIndex)
		.reduce((min: number | undefined, el: any) => min === undefined ? el.lineIndex : Math.min(min, el.lineIndex), undefined as number | undefined);
	return (nextLineIndex ?? totalLines) - 1;
};

/**
 * Where a brand-new record-level attribute continuation line must land: right after the last one
 * that already exists, or right after the record's own line if it has none — either way, always
 * before the record's first field/constant (see linkAttributesToParents in parser.ts), which is
 * what makes the new line actually belong to the record once reparsed, rather than misattaching
 * to whatever field/constant happens to follow.
 */
export function recordAttrsAnchorLineIndex(record: { lineIndex: number; attributes?: { lineIndex: number; lastLineIndex?: number }[] }): number {
	const attrs = record.attributes ?? [];
	return attrs.length === 0 ? record.lineIndex : Math.max(...attrs.map(a => a.lastLineIndex ?? a.lineIndex));
};

/**
 * Swaps a flow-mode item's entire source block with the immediately preceding item's block — the
 * only way to make an item print earlier than a flow-mode neighbor, since DDS flow order is
 * strictly source order and SPACEB can't go negative (see findPreviousItemInRecord). Swaps the two
 * full blocks (definition line through every trailing keyword-only line) verbatim: each item's own
 * keywords — including any SPACEB/SPACEA/SKIPB/SKIPA it already has — travel with it unchanged,
 * only the physical order changes, so whatever row(s) fall out are whatever simulateRecordFlow
 * naturally resolves for the new order, not a specific target (one hop per drag — dragging further
 * past a second item needs a second drag). The dragged item's own Position (col) still updates to
 * the drop point, same as a normal move.
 */
async function applyFlowSwap(
	document: vscode.TextDocument,
	prevItem: { lineIndex: number },
	item: { lineIndex: number },
	blockEndLineIndex: number,
	clampedCol: number
): Promise<boolean> {
	const prevBlockLines: string[] = [];
	for (let i = prevItem.lineIndex; i < item.lineIndex; i++) {
		prevBlockLines.push(document.lineAt(i).text);
	};
	const itemBlockLines: string[] = [];
	for (let i = item.lineIndex; i <= blockEndLineIndex; i++) {
		itemBlockLines.push(document.lineAt(i).text);
	};
	// Still land on the column dropped at — only the source order (and thus row) comes from the
	// swap itself.
	itemBlockLines[0] = buildRepositionedColumnOnly(itemBlockLines[0], clampedCol);

	const wholeRange = new vscode.Range(document.lineAt(prevItem.lineIndex).range.start, document.lineAt(blockEndLineIndex).range.end);
	const newText = [...itemBlockLines, ...prevBlockLines].join('\n');

	const edit = new vscode.WorkspaceEdit();
	edit.replace(document.uri, wholeRange, newText);
	return vscode.workspace.applyEdit(edit);
};

/**
 * Moves a field or constant to a new (row, col) — used by the preview's drag-to-reposition. For an
 * explicit-mode item this rewrites Line/Position (39-44) directly; for a flow-mode one (see
 * resolveFlowModeMove), Line stays blank and its own SPACEB is adjusted instead (applyFlowMove) —
 * dragging it vertically still works, it just moves through a different keyword. An item whose own
 * SKIPB (an absolute jump) already sets its row falls back to column-only dragging: SPACEB only
 * adds on top of wherever SKIPB jumps to, and reverse-solving what SKIPB itself would need to
 * become isn't attempted.
 * @param lineIndex - Zero-based source line of the field/constant to move
 * @param newRow - New DDS line number (1-based)
 * @param newCol - New DDS position (1-based)
 * @param maxRow - Upper bound to clamp newRow to (the preview's configured page rows)
 * @param maxCol - Upper bound to clamp newCol to (the preview's configured page cols)
 * @param flowMode - True when the preview already knows this item is flow-positioned
 * @param isAttributeActive - Optional gate (see simulateRecordFlow/resolveFlowModeMove), passed
 *   through from the preview's own current indicator-simulation state so the baseline this drag
 *   is measured against always matches what's actually on screen at the moment of the drag.
 */
export async function moveElement(
	lineIndex: number,
	newRow: number,
	newCol: number,
	maxRow: number,
	maxCol: number,
	flowMode = false,
	isAttributeActive?: (attr: PrtfAttribute) => boolean
): Promise<void> {
	const document = ExtensionState.lastPrtfDocument;
	if (!document) {return;}
	if (lineIndex < 0 || lineIndex >= document.lineCount) {return;}

	// DDS's own absolute limit is 255 for both Line and Position, regardless of the preview's
	// configured page size — clamp to whichever is smaller.
	const upperRow = Math.min(255, maxRow);
	const upperCol = Math.min(255, maxCol);
	const clampedRow = Math.min(upperRow, Math.max(1, Math.round(newRow)));
	const clampedCol = Math.min(upperCol, Math.max(1, Math.round(newCol)));

	const line = document.lineAt(lineIndex);
	if (line.text.length < 44) {
		vscode.window.showErrorMessage(
			`PRTF: can't reposition — line ${lineIndex + 1} is only ${line.text.length} characters long ` +
			`(needs at least 44 to contain a Line/Position zone).`
		);
		return;
	};

	if (flowMode) {
		const item = ExtensionState.lastPrtfElements.find((e: any) =>
			(e.kind === 'field' || e.kind === 'constant') && e.lineIndex === lineIndex) as
			{ recordname: string; lastLineIndex?: number; attributes?: { value: string; lineIndex: number }[] } | undefined;
		const flowInfo = item ? resolveFlowModeMove(ExtensionState.lastPrtfElements, item.recordname, lineIndex, isAttributeActive) : { isFlowMode: false as const };

		if (item && flowInfo.isFlowMode && !flowInfo.hasOwnSkipB) {
			const baselineRow = flowInfo.baselineRow ?? 0;

			if (clampedRow === flowInfo.currentRow) {
				// The row genuinely wasn't touched (a horizontal-only drag) — leave the item's own
				// SPACEB exactly as coded and only rewrite Position. Recomputing it from
				// clampedRow - baselineRow here would collapse a currently-inactive
				// indicator-conditioned SPACEB down to 0 (see FlowModeMoveInfo.currentRow): an
				// inactive SPACEB doesn't move the rendered row either, so the two would look
				// identical even though the coded value must survive untouched.
				const updatedLine = buildRepositionedColumnOnly(line.text, clampedCol);
				if (updatedLine !== line.text) {
					const edit = new vscode.WorkspaceEdit();
					edit.replace(document.uri, line.range, updatedLine);
					const applied = await vscode.workspace.applyEdit(edit);
					if (!applied) {
						vscode.window.showErrorMessage('PRTF: could not apply the move — the document may be read-only.');
					};
				};
				return;
			};

			if (clampedRow < baselineRow) {
				// Past what this item's own SPACEB can reach — try swapping source order with
				// whatever immediately precedes it instead of just clamping in place.
				const prevItem = findPreviousItemInRecord(ExtensionState.lastPrtfElements, item.recordname, lineIndex);
				if (prevItem) {
					const blockEnd = findBlockEndLineIndex(ExtensionState.lastPrtfElements, lineIndex, document.lineCount);
					const applied = await applyFlowSwap(document, prevItem, { lineIndex }, blockEnd, clampedCol);
					if (!applied) {
						vscode.window.showErrorMessage('PRTF: could not apply the move — the document may be read-only.');
					};
					return;
				};
				// Already the record's first item — nothing to swap with, fall through to a
				// normal clamped move (lands back on its own baseline row).
			};

			const applied = await applyFlowMove(document, line, lineIndex, clampedRow, clampedCol, baselineRow, item);
			if (!applied) {
				vscode.window.showErrorMessage('PRTF: could not apply the move — the document may be read-only.');
			};
			return;
		};

		const updatedLine = buildRepositionedColumnOnly(line.text, clampedCol);
		if (updatedLine === line.text) {return;}
		const edit = new vscode.WorkspaceEdit();
		edit.replace(document.uri, line.range, updatedLine);
		const applied = await vscode.workspace.applyEdit(edit);
		if (!applied) {
			vscode.window.showErrorMessage('PRTF: could not apply the move — the document may be read-only.');
		};
		return;
	};

	const updatedLine = buildRepositionedLine(line.text, clampedRow, clampedCol);
	if (updatedLine === line.text) {return;}

	const edit = new vscode.WorkspaceEdit();
	edit.replace(document.uri, line.range, updatedLine);

	const applied = await vscode.workspace.applyEdit(edit);
	if (!applied) {
		vscode.window.showErrorMessage('PRTF: could not apply the move — the document may be read-only.');
	};
};
