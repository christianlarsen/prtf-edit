/*
	Christian Larsen, 2026
	"PRTF structure"
	prtf-edit.fill-constant.ts
*/

import * as vscode from 'vscode';
import { ExtensionState } from '../prtf-edit.states/state';
import { PrtfConstant, constantPrintedWidth, stripConstantQuotes } from '../prtf-edit.model/prtf-edit.model';
import { PrtfNode } from '../prtf-edit.providers/prtf-edit.providers';
import { isPlainTextLiteral, replaceConstantText } from './prtf-edit.edit-constant-text';
import { editedNumericPlaceholder } from '../prtf-edit.webview/prtf-edit.record-preview-panel';

/** A field's printed width: its own DDS length, unless an EDTCDE would print it wider (e.g. a
 * 7,2 field with commas grouping prints as "9,999,999.99" — width 12, not the raw length 7). See
 * editedNumericPlaceholder's own doc comment for the "worst case" reasoning. */
function fieldTargetWidth(field: { length?: number; decimals?: number; type?: string; attributes?: any[] }): number {
	const edited = editedNumericPlaceholder(field as any, field.attributes ?? []);
	return edited ? edited.length : (field.length ?? 0);
};

/**
 * Pads a constant's own literal text with trailing spaces to match another field's or constant's
 * printed width, picked from anywhere in the document (not just its own record — a header
 * record's label often needs to match a field's width in a different, detail record). A one-shot
 * pad, not a persistent link: if the target's width changes later, re-running this again re-pads
 * it. Existing trailing spaces are trimmed first, then padded back to the target width, so
 * running it again against the same (or a narrower) target doesn't accumulate extra spaces.
 */
export async function fillConstantToWidthFromNode(node: PrtfNode): Promise<void> {
	if (!node || node.source.kind !== 'constant') {return;}
	const constant = node.source as PrtfConstant;

	if (!isPlainTextLiteral(constant.name)) {
		vscode.window.showInformationMessage(
			constant.name.toUpperCase().startsWith("X'")
				? "PRTF: this is a hex literal (X'...') — nothing to pad."
				: `PRTF: '${constant.name}' is a system keyword — nothing to pad.`
		);
		return;
	};

	const document = ExtensionState.lastPrtfDocument;
	if (!document) {return;}

	type Target = { label: string; description: string; width: number };
	const elements = ExtensionState.lastPrtfElements;
	const targets: Target[] = elements
		.filter((e: any) =>
			(e.kind === 'field' && typeof e.length === 'number') ||
			(e.kind === 'constant' && e.lineIndex !== constant.lineIndex))
		.sort((a: any, b: any) => a.recordname === b.recordname ? a.lineIndex - b.lineIndex : a.recordname.localeCompare(b.recordname))
		.map((e: any) => {
			const width = e.kind === 'field' ? fieldTargetWidth(e) : constantPrintedWidth(e.name);
			const display = e.kind === 'field' ? e.name : stripConstantQuotes(e.name).replace(/''/g, "'");
			return { label: `${e.recordname} / ${display}`, description: `width ${width}`, width };
		});

	if (targets.length === 0) {
		vscode.window.showInformationMessage('PRTF: no other field/constant with a determinable width found.');
		return;
	};

	const currentTextRaw = stripConstantQuotes(constant.name).replace(/''/g, "'");

	const picked = await vscode.window.showQuickPick(targets, {
		placeHolder: `Match '${currentTextRaw}'s width to which field/constant?`,
		matchOnDescription: true
	});
	if (!picked) {return;} // Cancelled.

	const currentText = currentTextRaw.replace(/ +$/, '');
	if (currentText.length >= picked.width) {
		vscode.window.showInformationMessage(
			`PRTF: already at least as wide as '${picked.label}' (${currentText.length} >= ${picked.width}) — nothing to pad.`
		);
		return;
	};

	const newText = currentText + ' '.repeat(picked.width - currentText.length);
	const applied = await replaceConstantText(document, constant, newText);
	if (applied) {
		vscode.window.showInformationMessage(`PRTF: padded to width ${picked.width}.`);
	} else {
		vscode.window.showErrorMessage('PRTF: could not update — the document may be read-only.');
	};
};

export function registerFillConstantCommand(context: vscode.ExtensionContext): void {
	context.subscriptions.push(
		vscode.commands.registerCommand('prtf-edit.fill-constant', fillConstantToWidthFromNode)
	);
};
