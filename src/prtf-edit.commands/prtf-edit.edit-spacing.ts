/*
	Christian Larsen, 2026
	"PRTF structure"
	prtf-edit.edit-spacing.ts
*/

import * as vscode from 'vscode';
import { ExtensionState } from '../prtf-edit.states/state';
import { isEmptyKeywordOnlyLine } from './prtf-edit.move-element';

/** The four DDS keywords that control vertical flow positioning — see prtf-edit.parser.ts's
 * applySkipSpaceBefore/applySkipSpaceAfter for how they combine during simulation. */
const SPACING_KEYWORDS = ['SKIPB', 'SPACEB', 'SPACEA', 'SKIPA'] as const;
type SpacingKeyword = typeof SPACING_KEYWORDS[number];

const KEYWORD_DESCRIPTIONS: Record<SpacingKeyword, string> = {
	SKIPB: 'Jump to an absolute line before printing this item (never moves backwards)',
	SPACEB: 'Advance this many lines before printing this item (relative to whatever came before)',
	SPACEA: 'Advance this many lines after printing this item (relative — affects whatever comes next)',
	SKIPA: 'Jump to an absolute line after printing this item (never moves backwards)'
};

export function keywordPattern(keyword: string): RegExp {
	// The left boundary is `\b` OR "immediately preceded by a digit" — DDS's fixed-column layout
	// often abuts a keyword directly against the previous zone with no space (e.g. a 3-char
	// Position "  1" immediately followed by a keyword, as in the real "...1DATE(...)" shape this
	// codebase's own samples use) — plain `\b` never matches there, since a digit and a letter are
	// both "word" characters to it. Still rejects being preceded by a letter (e.g. "XSPACEB"),
	// which is what `\b` was guarding against in the first place.
	return new RegExp(`\\s?(?:\\b|(?<=\\d))${keyword}\\(\\s*(\\d+)\\s*\\)`, 'i');
};

export function readKeywordValue(attributes: { value: string }[] | undefined, keyword: string): number | undefined {
	for (const attr of attributes ?? []) {
		const match = attr.value.match(keywordPattern(keyword));
		if (match) {return Number(match[1]);};
	};
	return undefined;
};

/** Replaces an existing keyword's value, or removes the keyword entirely when newValue is
 * undefined. Assumes the line already contains that keyword — callers only reach this once
 * they've confirmed that via keywordPattern. */
export function applyKeywordToLine(lineText: string, keyword: string, newValue: number | undefined): string {
	const pattern = keywordPattern(keyword);
	return newValue !== undefined
		? lineText.replace(pattern, ` ${keyword}(${newValue})`)
		: lineText.replace(pattern, '');
};

/** Blanks just the Line zone (columns 39-41), leaving Position (42-44) and everything else on the
 * line untouched — the counterpart to move-element.ts's buildRepositionedLine, for converting a
 * single explicit-mode item to flow positioning without touching any other item in its record
 * (which may need the same treatment separately before the record as a whole is valid again — see
 * prtf-edit.validation.ts, which flags that as a real CRTPRTF conflict in the meantime). */
export function blankLineNumber(lineText: string): string {
	return lineText.substring(0, 38) + '   ' + lineText.substring(41);
};

type SpacingItem = { row?: number; positionSource?: string; lastLineIndex?: number; recordname: string; attributes?: { value: string; lineIndex: number }[] };

function hasAnySpacingKeyword(attributes: { value: string }[] | undefined): boolean {
	return SPACING_KEYWORDS.some(keyword => readKeywordValue(attributes, keyword) !== undefined);
};

/**
 * Lets the user directly set or clear one of a field/constant's own SKIPB/SPACEB/SPACEA/SKIPA
 * values — the manual complement to the automatic SPACEB the drag/add features already manage:
 * covers SKIPA/SKIPB (never touched by dragging) and setting an absolute jump instead of a
 * relative advance. Scoped to just this one item by default: adding a spacing keyword to an item
 * that still has an explicit Line blanks *that item's own* Line (the two can't coexist on the same
 * line without a CPD7826/CPD7860 conflict), but doesn't touch any other item in the record — if the
 * record ends up mixed as a result, the existing validator flags it.
 *
 * Setting SKIPB specifically is the one case with a safe, general way to convert the *whole*
 * record in the same step, because — unlike SPACEB/SPACEA, which are relative and would need
 * reordering to handle items that aren't already in row order — SKIPB is an absolute jump, so
 * giving every other still-explicit item its own `SKIPB(<its current row>)` preserves the record's
 * exact current layout regardless of order. When there are other explicit items left, this offers
 * that as a choice rather than doing it silently.
 * @param lineIndex - Zero-based source line of the field/constant to edit
 */
export async function editSpacing(lineIndex: number): Promise<void> {
	const document = ExtensionState.lastPrtfDocument;
	if (!document) {return;}

	const item = ExtensionState.lastPrtfElements.find((e: any) =>
		(e.kind === 'field' || e.kind === 'constant') && e.lineIndex === lineIndex) as SpacingItem | undefined;
	if (!item) {return;}

	const choices = SPACING_KEYWORDS.map(keyword => {
		const currentValue = readKeywordValue(item.attributes, keyword);
		return {
			label: keyword,
			description: currentValue !== undefined ? String(currentValue) : '(not set)',
			detail: KEYWORD_DESCRIPTIONS[keyword],
			keyword,
			currentValue
		};
	});

	const picked = await vscode.window.showQuickPick(choices, { placeHolder: 'Which spacing keyword do you want to set or clear?' });
	if (!picked) {return;}

	// A blank explicit-mode item converting to SKIPB most often wants "jump to wherever I already
	// print" as the starting point — pre-fill with the item's own current row for that specific
	// case; otherwise pre-fill with whatever the keyword is already set to, if anything.
	const prefill = picked.currentValue !== undefined
		? String(picked.currentValue)
		: (picked.keyword === 'SKIPB' && item.positionSource === 'explicit' && item.row !== undefined ? String(item.row) : '');

	const input = await vscode.window.showInputBox({
		prompt: `${picked.keyword}(n) — 1 to 255, or leave blank to remove it`,
		value: prefill,
		validateInput: value => {
			const trimmed = value.trim();
			if (trimmed === '') {return undefined;};
			return /^[1-9][0-9]*$/.test(trimmed) && Number(trimmed) <= 255 ? undefined : 'Enter a whole number from 1 to 255, or leave blank to remove.';
		}
	});
	if (input === undefined) {return;} // Cancelled.

	const trimmed = input.trim();
	const newValue = trimmed === '' ? undefined : Number(trimmed);
	if (newValue === undefined && picked.currentValue === undefined) {return;} // Nothing to remove.

	const edit = new vscode.WorkspaceEdit();

	// SKIPB, specifically, can safely stand in for *every* other still-explicit item in the record
	// too (see the doc comment above) — offer to convert the whole record in one step rather than
	// leaving the rest for separate right-clicks.
	if (picked.keyword === 'SKIPB' && newValue !== undefined && item.positionSource === 'explicit') {
		const otherExplicitItems = ExtensionState.lastPrtfElements.filter((e: any) =>
			(e.kind === 'field' || e.kind === 'constant') &&
			e.recordname === item.recordname &&
			e.lineIndex !== lineIndex &&
			e.positionSource === 'explicit'
		) as (SpacingItem & { lineIndex: number })[];

		if (otherExplicitItems.length > 0) {
			const choice = await vscode.window.showWarningMessage(
				`'${item.recordname}' has ${otherExplicitItems.length} other field(s)/constant(s) still using an explicit Line — ` +
				`left as-is, they'll conflict with this SKIPB. Convert them too, at their current row?`,
				{ modal: true },
				'Convert whole record', 'Just this item'
			);
			if (choice === undefined) {return;} // Cancelled — leave everything untouched.
			if (choice === 'Convert whole record') {
				for (const other of otherExplicitItems) {
					if (other.row === undefined) {continue;};
					const otherLine = document.lineAt(other.lineIndex);
					edit.replace(document.uri, otherLine.range, blankLineNumber(otherLine.text));
					if (!hasAnySpacingKeyword(other.attributes)) {
						const anchorLineIndex = other.lastLineIndex ?? other.lineIndex;
						const insertPosition = document.lineAt(anchorLineIndex).range.end;
						const newLine = ' '.repeat(5) + 'A' + ' '.repeat(38) + `SKIPB(${other.row})`;
						edit.insert(document.uri, insertPosition, '\n' + newLine);
					};
				};
			};
		};
	};

	const existingAttr = (item.attributes ?? []).find(attr => keywordPattern(picked.keyword).test(attr.value));
	const primaryLine = document.lineAt(lineIndex);
	const shouldBlankLine = newValue !== undefined && item.positionSource === 'explicit';

	if (existingAttr && existingAttr.lineIndex === lineIndex) {
		// Inline on the item's own line — fold the keyword edit and the Line blank (if any) into
		// one replace so the two changes can't overlap.
		let updatedPrimaryText = shouldBlankLine ? blankLineNumber(primaryLine.text) : primaryLine.text;
		updatedPrimaryText = applyKeywordToLine(updatedPrimaryText, picked.keyword, newValue);
		edit.replace(document.uri, primaryLine.range, updatedPrimaryText);
	} else {
		if (shouldBlankLine) {
			edit.replace(document.uri, primaryLine.range, blankLineNumber(primaryLine.text));
		};
		if (existingAttr) {
			const keywordLine = document.lineAt(existingAttr.lineIndex);
			const updatedKeywordText = applyKeywordToLine(keywordLine.text, picked.keyword, newValue);
			if (newValue === undefined && isEmptyKeywordOnlyLine(updatedKeywordText)) {
				edit.delete(document.uri, keywordLine.rangeIncludingLineBreak);
			} else {
				edit.replace(document.uri, keywordLine.range, updatedKeywordText);
			};
		} else if (newValue !== undefined) {
			const anchorLineIndex = item.lastLineIndex ?? lineIndex;
			const insertPosition = document.lineAt(anchorLineIndex).range.end;
			const newLine = ' '.repeat(5) + 'A' + ' '.repeat(38) + `${picked.keyword}(${newValue})`;
			edit.insert(document.uri, insertPosition, '\n' + newLine);
		};
	};

	const applied = await vscode.workspace.applyEdit(edit);
	if (!applied) {
		vscode.window.showErrorMessage('PRTF: could not apply the change — the document may be read-only.');
	};
};
