/*
	Christian Larsen, 2026
	"PRTF structure"
	prtf-edit.delete-element.ts
*/

import * as vscode from 'vscode';
import { ExtensionState } from '../prtf-edit.states/state';
import { findBlockEndLineIndex } from './prtf-edit.move-element';
import { readKeywordValue } from './prtf-edit.edit-spacing';
import { simulateRecordFlow } from '../prtf-edit.parser/prtf-edit.parser';
import { PrtfNode } from '../prtf-edit.providers/prtf-edit.providers';
import { deletableLineRange } from '../prtf-edit.utils/prtf-edit.edit-helpers';

type DeletableItem = {
	lineIndex: number; lastLineIndex?: number; recordname: string; positionSource?: string;
	attributes?: { value: string; lineIndex: number }[]; indicatorLineIndices?: number[];
};

function hasOwnBeforeKeyword(attributes: { value: string }[] | undefined): boolean {
	return readKeywordValue(attributes, 'SKIPB') !== undefined || readKeywordValue(attributes, 'SPACEB') !== undefined;
};

/**
 * Deletes a field or constant entirely: its definition line and every trailing keyword-only
 * continuation line that belongs to it — name, type, colors, underline, text, spacing, all of it —
 * the same "full block" a flow-mode swap moves as one unit (see move-element.ts's
 * findBlockEndLineIndex).
 *
 * For a flow-mode item, deleting it can shift the next field/constant (and everything after that)
 * up, because that next item's own "current line" is measured from wherever the deleted item left
 * off — not just from its own SPACEA/SKIPA, but from *any* contribution it made (its own SPACEB/
 * SKIPB, or even the "never below line 1" floor a bare item gets with no keyword at all). Rather
 * than trying to work out which of those applies and translate it by hand, this re-simulates the
 * record without the item (simulateRecordFlow already does the real math) and compares the next
 * item's row before and after: if it would move, offers to anchor it to its *current* row via its
 * own SKIPB instead — an absolute jump is exactly correct regardless of what actually caused the
 * old gap. Only offered when the next item doesn't already have a before-keyword of its own;
 * composing the anchor with an existing one isn't attempted, since what that existing one was
 * already for isn't something this can infer safely.
 * @param lineIndex - Zero-based source line of the field/constant to delete
 */
export async function deleteElement(lineIndex: number): Promise<void> {
	const document = ExtensionState.lastPrtfDocument;
	if (!document) {return;}

	const elements = ExtensionState.lastPrtfElements;
	const item = elements.find((e: any) =>
		(e.kind === 'field' || e.kind === 'constant') && e.lineIndex === lineIndex) as DeletableItem | undefined;
	if (!item) {return;}

	const edit = new vscode.WorkspaceEdit();

	if (item.positionSource === 'flow') {
		const record = elements.find((e: any) => e.kind === 'record' && e.name === item.recordname) as any;
		const items = elements
			.filter((e: any) => (e.kind === 'field' || e.kind === 'constant') && e.recordname === item.recordname)
			.sort((a: any, b: any) => a.lineIndex - b.lineIndex) as any[];
		const index = items.findIndex((e: any) => e.lineIndex === lineIndex);
		const nextItem: DeletableItem | undefined = index >= 0 && index < items.length - 1 ? items[index + 1] : undefined;

		if (record && nextItem) {
			const fileAttributes = elements.find((e: any) => e.kind === 'file')?.attributes;
			const before = simulateRecordFlow(record, items, 0, undefined, fileAttributes);
			const after = simulateRecordFlow(record, items.filter((_: any, i: number) => i !== index), 0, undefined, fileAttributes);
			const oldRow = before.rows.get(nextItem.lineIndex);
			const newRow = after.rows.get(nextItem.lineIndex);

			if (oldRow !== undefined && oldRow !== newRow) {
				if (!hasOwnBeforeKeyword(nextItem.attributes)) {
					const choice = await vscode.window.showWarningMessage(
						`Deleting this shifts what follows up (row ${oldRow} → ${newRow}). Anchor the next field/constant to its ` +
						`current row (${oldRow}) instead, so everything else stays put?`,
						{ modal: true },
						'Anchor to current row', 'Just delete it'
					);
					if (choice === undefined) {return;} // Cancelled — nothing touched.
					if (choice === 'Anchor to current row') {
						const anchorLineIndex = nextItem.lastLineIndex ?? nextItem.lineIndex;
						const insertPosition = document.lineAt(anchorLineIndex).range.end;
						const newLine = ' '.repeat(5) + 'A' + ' '.repeat(38) + `SKIPB(${oldRow})`;
						edit.insert(document.uri, insertPosition, '\n' + newLine);
					};
				} else {
					const choice = await vscode.window.showWarningMessage(
						`Deleting this shifts what follows up (row ${oldRow} → ${newRow}) — the next field/constant already has its ` +
						`own spacing, so this won't be adjusted automatically.`,
						{ modal: true },
						'Delete anyway'
					);
					if (choice === undefined) {return;};
				};
			};
		};
	};

	// Indicator continuation lines *precede* the item they condition (the opposite of every other
	// continuation convention here — see indicatorLineIndices in prtf-edit.model.ts), so they fall
	// outside findBlockEndLineIndex's forward-only block and need their own deletes. Each is
	// removed individually, not as one range, since a comment line can legally sit between two of
	// them without breaking the parser's own accumulation.
	for (const indicatorLineIndex of (item.indicatorLineIndices ?? []).slice(0, -1)) {
		edit.delete(document.uri, document.lineAt(indicatorLineIndex).rangeIncludingLineBreak);
	};

	const blockEndLineIndex = findBlockEndLineIndex(elements, lineIndex, document.lineCount);
	edit.delete(document.uri, deletableLineRange(document, lineIndex, blockEndLineIndex));

	const applied = await vscode.workspace.applyEdit(edit);
	if (!applied) {
		vscode.window.showErrorMessage('PRTF: could not delete — the document may be read-only.');
	};
};

/** Adapter for the "Definition" tree's context-menu entry — mirrors editAttributesFromNode. */
export function deleteElementFromNode(node: PrtfNode): void {
	if (!node || (node.source.kind !== 'field' && node.source.kind !== 'constant')) {return;}
	void deleteElement(node.source.lineIndex);
};

export function registerDeleteElementCommand(context: vscode.ExtensionContext): void {
	context.subscriptions.push(
		vscode.commands.registerCommand('prtf-edit.delete-element', deleteElementFromNode)
	);
};
