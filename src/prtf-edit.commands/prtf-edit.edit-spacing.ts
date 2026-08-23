/*
	Christian Larsen, 2026
	"PRTF structure"
	prtf-edit.edit-spacing.ts
*/

import * as vscode from 'vscode';
import { ExtensionState } from '../prtf-edit.states/state';
import { isEmptyKeywordOnlyLine, recordAttrsAnchorLineIndex } from './prtf-edit.move-element';
import { PrtfFile, PrtfRecord } from '../prtf-edit.model/prtf-edit.model';
import { PrtfNode } from '../prtf-edit.providers/prtf-edit.providers';

/** The four DDS keywords that control vertical flow positioning — see prtf-edit.parser.ts's
 * applySkipSpaceBefore/applySkipSpaceAfter for how they combine during simulation. */
const SPACING_KEYWORDS = ['SKIPB', 'SPACEB', 'SPACEA', 'SKIPA'] as const;
type SpacingKeyword = typeof SPACING_KEYWORDS[number];

/** Of the four, only these two are valid at file level (confirmed against IBM's DDS reference —
 * SKIPB/SKIPA there are absolute jumps, so "file-wide default" is well-defined; SPACEB/SPACEA are
 * relative to whatever printed immediately before, which has no single file-wide meaning — RLU's
 * own "Work with File Keywords" screen agrees, listing SKIPA/SKIPB but not SPACEA/SPACEB). Applies
 * as the default for every record that doesn't set its own SKIPB/SKIPA, the same one-per-level
 * cascade record-level already applies to its own fields. */
const FILE_SPACING_KEYWORDS = ['SKIPB', 'SKIPA'] as const satisfies readonly SpacingKeyword[];

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
 * line without a CPD7826/CPD7860 conflict).
 *
 * Any *other* field/constant in the record still using an explicit Line would still conflict with
 * the record as a whole (CPD5238) once this one gets its own spacing keyword — rather than letting
 * that slip through and rely on the validator to catch it after the fact, setting SKIPB offers to
 * convert every other still-explicit item too, at its current row (safe and general, since SKIPB
 * is an absolute jump); SPACEB/SPACEA/SKIPA can't be auto-converted the same way — they're
 * relative, and would need the items reordered to match row order first — so those are simply
 * blocked outright until the other items are converted (via SKIPB, or one at a time).
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

	// Any *other* field/constant in the same record still using an explicit Line is a real
	// CRTPRTF conflict (CPD5238/CPD7826/CPD7860 — see prtf-edit.validation.ts, which only catches
	// this after the fact) once this item gets a SPACEA/SPACEB/SKIPA/SKIPB of its own — this
	// item's *own* explicit Line (if any) is already handled below via shouldBlankLine, so what's
	// left to worry about is only its siblings.
	if (newValue !== undefined) {
		const otherExplicitItems = ExtensionState.lastPrtfElements.filter((e: any) =>
			(e.kind === 'field' || e.kind === 'constant') &&
			e.recordname === item.recordname &&
			e.lineIndex !== lineIndex &&
			e.positionSource === 'explicit'
		) as (SpacingItem & { lineIndex: number })[];

		if (otherExplicitItems.length > 0) {
			// SKIPB, specifically, can safely stand in for *every* other still-explicit item in the
			// record too (see the doc comment above) — offer to convert the whole record in one step
			// rather than leaving the rest for separate right-clicks. SPACEB/SPACEA/SKIPA are
			// relative and can't be auto-converted the same way (they'd need the items reordered to
			// match row order first), so those are just blocked outright.
			if (picked.keyword === 'SKIPB') {
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
			} else {
				vscode.window.showErrorMessage(
					`PRTF: '${item.recordname}' has ${otherExplicitItems.length} other field(s)/constant(s) still using an explicit Line — CRTPRTF rejects mixing that with ${picked.keyword}. Convert them to flow positioning first (SKIPB can convert the whole record in one step; ${picked.keyword} can't, since it's relative).`
				);
				return;
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

/**
 * Lets the user set or clear one of a record format's own SKIPB/SPACEB/SPACEA/SKIPA values —
 * the tree's counterpart to editSpacing above, for a record instead of a field/constant. Much
 * simpler than editSpacing: a record's own primary line has no Line/Position zone at all (see
 * buildRecordLine, record-crud.ts), so there's no explicit-Line-vs-flow conflict to resolve and
 * no "convert the whole record" case — that's specifically about a field/constant's own Line
 * entry, which a record never has. The keyword can still be written inline on the record's own
 * "R recordname" line (e.g. the samples' own "...R DETALLE   SPACEA(1)"), so that branch is kept.
 */
export async function editRecordSpacing(record: PrtfRecord): Promise<void> {
	const document = ExtensionState.lastPrtfDocument;
	if (!document) {return;}

	const choices = SPACING_KEYWORDS.map(keyword => {
		const currentValue = readKeywordValue(record.attributes, keyword);
		return {
			label: keyword,
			description: currentValue !== undefined ? String(currentValue) : '(not set)',
			detail: KEYWORD_DESCRIPTIONS[keyword],
			keyword,
			currentValue
		};
	});

	const picked = await vscode.window.showQuickPick(choices, { placeHolder: `Which spacing keyword do you want to set or clear on '${record.name}'?` });
	if (!picked) {return;}

	const input = await vscode.window.showInputBox({
		prompt: `${picked.keyword}(n) — 1 to 255, or leave blank to remove it`,
		value: picked.currentValue !== undefined ? String(picked.currentValue) : '',
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

	// CRTPRTF rejects the whole record format when a record-level SPACEA/SPACEB/SKIPA/SKIPB
	// coexists with an explicit Line on any of its own fields/constants (CPD5238/CPD7826/CPD7860 —
	// see prtf-edit.validation.ts, which only catches this *after* the fact). Only setting a new
	// value is blocked here — clearing one is always allowed, since that's how an already-mixed
	// record (e.g. hand-edited) gets fixed.
	if (newValue !== undefined) {
		const hasExplicitItems = ExtensionState.lastPrtfElements.some((e: any) =>
			(e.kind === 'field' || e.kind === 'constant') && e.recordname === record.name && e.positionSource === 'explicit'
		);
		if (hasExplicitItems) {
			vscode.window.showErrorMessage(
				`PRTF: '${record.name}' has field(s)/constant(s) using an explicit Line — CRTPRTF rejects mixing that with a record-level ${picked.keyword}. Move them to flow positioning first (e.g. via "Edit spacing" on each one).`
			);
			return;
		};
	};

	const edit = new vscode.WorkspaceEdit();
	const existingAttr = (record.attributes ?? []).find(attr => keywordPattern(picked.keyword).test(attr.value));
	const primaryLine = document.lineAt(record.lineIndex);

	if (existingAttr && existingAttr.lineIndex === record.lineIndex) {
		edit.replace(document.uri, primaryLine.range, applyKeywordToLine(primaryLine.text, picked.keyword, newValue));
	} else if (existingAttr) {
		const keywordLine = document.lineAt(existingAttr.lineIndex);
		const updatedText = applyKeywordToLine(keywordLine.text, picked.keyword, newValue);
		if (newValue === undefined && isEmptyKeywordOnlyLine(updatedText)) {
			edit.delete(document.uri, keywordLine.rangeIncludingLineBreak);
		} else {
			edit.replace(document.uri, keywordLine.range, updatedText);
		};
	} else if (newValue !== undefined) {
		const insertPosition = document.lineAt(recordAttrsAnchorLineIndex(record)).range.end;
		const newLine = ' '.repeat(5) + 'A' + ' '.repeat(38) + `${picked.keyword}(${newValue})`;
		edit.insert(document.uri, insertPosition, '\n' + newLine);
	};

	const applied = await vscode.workspace.applyEdit(edit);
	if (!applied) {
		vscode.window.showErrorMessage('PRTF: could not apply the change — the document may be read-only.');
	};
};

export function editRecordSpacingFromNode(node: PrtfNode): void {
	if (!node || node.source.kind !== 'record') {return;}
	void editRecordSpacing(node.source as PrtfRecord);
};

/**
 * Lets the user set or clear the file's own SKIPB/SKIPA (see FILE_SPACING_KEYWORDS above for why
 * SPACEB/SPACEA are excluded). Structurally identical to editRecordSpacing, minus the explicit-
 * Line conflict check that one runs before allowing a new value: unlike a record-level SPACEA/
 * SPACEB/SKIPA/SKIPB, which CRTPRTF rejects outright when any of that same record's own fields
 * still use an explicit Line, a file-level SKIPB/SKIPA is documented as applying "for all records"
 * without that restriction — it simply doesn't affect a record that positions everything
 * explicitly, rather than conflicting with it.
 */
export async function editFileSpacing(file: PrtfFile): Promise<void> {
	const document = ExtensionState.lastPrtfDocument;
	if (!document) {return;}

	const choices = FILE_SPACING_KEYWORDS.map(keyword => {
		const currentValue = readKeywordValue(file.attributes, keyword);
		return {
			label: keyword,
			description: currentValue !== undefined ? String(currentValue) : '(not set)',
			detail: KEYWORD_DESCRIPTIONS[keyword],
			keyword,
			currentValue
		};
	});

	const picked = await vscode.window.showQuickPick(choices, { placeHolder: 'Which file-level spacing keyword do you want to set or clear?' });
	if (!picked) {return;}

	const input = await vscode.window.showInputBox({
		prompt: `${picked.keyword}(n) — 1 to 255, or leave blank to remove it`,
		value: picked.currentValue !== undefined ? String(picked.currentValue) : '',
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
	const existingAttr = (file.attributes ?? []).find(attr => keywordPattern(picked.keyword).test(attr.value));
	const primaryLine = document.lineAt(file.lineIndex);

	if (existingAttr && existingAttr.lineIndex === file.lineIndex) {
		edit.replace(document.uri, primaryLine.range, applyKeywordToLine(primaryLine.text, picked.keyword, newValue));
	} else if (existingAttr) {
		const keywordLine = document.lineAt(existingAttr.lineIndex);
		const updatedText = applyKeywordToLine(keywordLine.text, picked.keyword, newValue);
		if (newValue === undefined && isEmptyKeywordOnlyLine(updatedText)) {
			edit.delete(document.uri, keywordLine.rangeIncludingLineBreak);
		} else {
			edit.replace(document.uri, keywordLine.range, updatedText);
		};
	} else if (newValue !== undefined) {
		const insertPosition = document.lineAt(recordAttrsAnchorLineIndex(file)).range.end;
		const newLine = ' '.repeat(5) + 'A' + ' '.repeat(38) + `${picked.keyword}(${newValue})`;
		edit.insert(document.uri, insertPosition, '\n' + newLine);
	};

	const applied = await vscode.workspace.applyEdit(edit);
	if (!applied) {
		vscode.window.showErrorMessage('PRTF: could not apply the change — the document may be read-only.');
	};
};

export function editFileSpacingFromNode(node: PrtfNode): void {
	if (!node || node.source.kind !== 'file') {return;}
	void editFileSpacing(node.source as PrtfFile);
};

export function registerEditRecordSpacingCommand(context: vscode.ExtensionContext): void {
	context.subscriptions.push(
		vscode.commands.registerCommand('prtf-edit.edit-record-spacing', editRecordSpacingFromNode),
		vscode.commands.registerCommand('prtf-edit.edit-file-spacing', editFileSpacingFromNode)
	);
};
