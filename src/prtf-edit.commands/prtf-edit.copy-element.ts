/*
	Christian Larsen, 2026
	"PRTF structure"
	prtf-edit.copy-element.ts
*/

import * as vscode from 'vscode';
import { ExtensionState } from '../prtf-edit.states/state';
import { PrtfNode } from '../prtf-edit.providers/prtf-edit.providers';
import { findBlockEndLineIndex } from './prtf-edit.move-element';
import { keywordPattern, applyKeywordToLine } from './prtf-edit.edit-spacing';
import { NAME_PATTERN } from './prtf-edit.add-field';

const SPACING_KEYWORDS = ['SKIPB', 'SPACEB', 'SPACEA', 'SKIPA'] as const;

type CopyableItem = {
	kind: 'field' | 'constant';
	lineIndex: number;
	lastLineIndex?: number;
	recordname: string;
	attributes?: { value: string; lineIndex: number }[];
	indicatorLineIndices?: number[];
};

function hasSpacingKeyword(attributes: CopyableItem['attributes']): boolean {
	return (attributes ?? []).some(attr => SPACING_KEYWORDS.some(kw => keywordPattern(kw).test(attr.value)));
};

/** True when nothing remains in the keyword zone (columns 45-80) — deliberately narrower than
 * move-element.ts's isEmptyKeywordOnlyLine, which also requires the *indicator* zone (columns
 * 7-16) to be blank: a trailing continuation line can carry both a spacing keyword and its own
 * indicator condition (e.g. "IN30 SPACEB(2)"), and once the keyword's gone, keeping just the
 * indicator would misattach that conditioning to whatever the next real element happens to be —
 * worse than dropping it. */
function isKeywordZoneBlank(line: string): boolean {
	return line.length <= 44 || line.substring(44).trim() === '';
};

/** Removes any of the four spacing keywords from the item's own block (its primary definition
 * line, at index 0, through every trailing keyword-only continuation line) — never from any
 * *preceding* indicator continuation line, which callers must exclude first (those condition the
 * item itself, not its spacing, and have nothing to do with this choice). The primary line is
 * always kept regardless of whether its own keyword zone ends up blank (it still carries the
 * field/constant's real name/type/definition); a trailing continuation line that ends up
 * contributing nothing is dropped instead of left as dead weight.
 */
function stripSpacingFromOwnBlock(ownLines: string[]): string[] {
	const result: string[] = [];
	ownLines.forEach((originalLine, i) => {
		let line = originalLine;
		for (const kw of SPACING_KEYWORDS) {
			if (keywordPattern(kw).test(line)) {line = applyKeywordToLine(line, kw, undefined);};
		};
		if (i === 0 || !isKeywordZoneBlank(line)) {result.push(line);};
	});
	return result;
};

/** Gathers a field/constant's full source block, in physical order: each of its preceding
 * indicator continuation lines individually (indicator continuation lines precede, rather than
 * follow, the element they condition — see indicatorLineIndices in prtf-edit.model.ts), then its
 * own primary line through every trailing keyword-only continuation line (findBlockEndLineIndex).
 * `primaryIndexInBlock` is where the item's own definition line lands in the returned array —
 * that's the one a field copy's rename needs to target.
 */
function gatherBlockLines(document: vscode.TextDocument, elements: any[], item: CopyableItem): { lines: string[]; primaryIndexInBlock: number } {
	const precedingIndicatorLines = (item.indicatorLineIndices ?? []).slice(0, -1);
	const lines = precedingIndicatorLines.map(idx => document.lineAt(idx).text);
	const primaryIndexInBlock = lines.length;

	const blockEnd = findBlockEndLineIndex(elements, item.lineIndex, document.lineCount);
	for (let i = item.lineIndex; i <= blockEnd; i++) {
		lines.push(document.lineAt(i).text);
	};

	return { lines, primaryIndexInBlock };
};

/** Rewrites just the name zone (columns 19-28) of a field's own definition line — identical
 * column/width to a record's own name zone (see record-crud.ts's renameRecordLine), left
 * unfactored since it's a two-line operation used in exactly one place here. */
function renameFieldLine(originalLine: string, newName: string): string {
	const padded = originalLine.length < 28 ? originalLine.padEnd(28) : originalLine;
	return padded.substring(0, 18) + newName.padEnd(10) + padded.substring(28);
};

/**
 * Copies a field or constant's entire source block — verbatim, including Line/Position, TEXT/
 * COLOR/HIGHLIGHT/UNDERLINE/EDTCDE, and indicator conditioning — into a chosen record (the same
 * one, or a different one). The one exception: SKIPB/SPACEB/SPACEA/SKIPA describe where the item
 * sits *relative to whatever came before it in the flow*, not a property of the item itself, so
 * if present the user is asked whether to bring them along. Positioning the copy afterward
 * (either way) is left to dragging, which already handles both explicit Line/Position and
 * flow-mode SPACEB recalculation correctly — same "paste verbatim, then drag" precedent as
 * "Copy Record".
 */
export async function copyElementFromNode(node: PrtfNode): Promise<void> {
	if (!node || (node.source.kind !== 'field' && node.source.kind !== 'constant')) {return;}
	const item = node.source as CopyableItem;

	const document = ExtensionState.lastPrtfDocument;
	if (!document) {return;}

	const elements = ExtensionState.lastPrtfElements;
	const records = elements.filter((e: any) => e.kind === 'record') as { name: string; lineIndex: number; endIndex?: number }[];

	const gathered = gatherBlockLines(document, elements, item);
	let lines = gathered.lines;
	const primaryIndexInBlock = gathered.primaryIndexInBlock;

	if (hasSpacingKeyword(item.attributes)) {
		const choice = await vscode.window.showQuickPick(
			[
				{ label: 'Copy its spacing too', description: 'SKIPB/SPACEB/SPACEA/SKIPA come along unchanged', withSpacing: true },
				{ label: 'Without spacing', description: 'Leave the copy unpositioned here — drag it into place after', withSpacing: false }
			],
			{ placeHolder: `'${item.recordname}' item carries SKIPB/SPACEB/SPACEA/SKIPA — copy it too?` }
		);
		if (!choice) {return;} // Cancelled.
		if (!choice.withSpacing) {
			// Only the item's own block (primary line onward) — never a preceding indicator
			// continuation line, which conditions the item itself and has nothing to do with this.
			const precedingLines = lines.slice(0, primaryIndexInBlock);
			const ownLines = stripSpacingFromOwnBlock(lines.slice(primaryIndexInBlock));
			lines = [...precedingLines, ...ownLines];
		};
	};

	let targetRecordName = item.recordname;
	if (records.length > 1) {
		const choices = [
			{ label: `${item.recordname} (current)`, name: item.recordname },
			...records.filter(r => r.name !== item.recordname).map(r => ({ label: r.name, name: r.name }))
		];
		const picked = await vscode.window.showQuickPick(choices, { placeHolder: 'Copy into which record?' });
		if (!picked) {return;} // Cancelled.
		targetRecordName = picked.name;
	};

	if (item.kind === 'field') {
		const existingNames = new Set(
			elements
				.filter((e: any) => e.kind === 'field' && e.recordname === targetRecordName)
				.map((e: any) => String(e.name).toUpperCase())
		);
		const rawName = await vscode.window.showInputBox({
			prompt: `New name for the copy in '${targetRecordName}'`,
			placeHolder: 'FIELDNAME',
			validateInput: value => {
				const upper = value.trim().toUpperCase();
				if (!NAME_PATTERN.test(upper)) {return 'Must start with a letter (or @#$) and be 1-10 letters/digits/@#$.';}
				if (existingNames.has(upper)) {return `A field named ${upper} already exists in '${targetRecordName}'.`;}
				return undefined;
			}
		});
		if (!rawName) {return;} // Cancelled.
		lines[primaryIndexInBlock] = renameFieldLine(lines[primaryIndexInBlock], rawName.trim().toUpperCase());
	};

	const targetRecord = records.find(r => r.name === targetRecordName);
	if (!targetRecord) {return;}

	const insertPosition = document.lineAt(targetRecord.endIndex ?? targetRecord.lineIndex).range.end;
	const edit = new vscode.WorkspaceEdit();
	edit.insert(document.uri, insertPosition, '\n' + lines.join('\n'));

	const applied = await vscode.workspace.applyEdit(edit);
	if (applied) {
		vscode.window.showInformationMessage(`PRTF: ${item.kind} copied into '${targetRecordName}'.`);
	} else {
		vscode.window.showErrorMessage('PRTF: could not copy — the document may be read-only.');
	};
};

export function registerCopyElementCommand(context: vscode.ExtensionContext): void {
	context.subscriptions.push(
		vscode.commands.registerCommand('prtf-edit.copy-element', copyElementFromNode)
	);
};
