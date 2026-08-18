/*
	Christian Larsen, 2026
	"PRTF structure"
	prtf-edit.edit-constant-text.ts
*/

import * as vscode from 'vscode';
import { ExtensionState } from '../prtf-edit.states/state';
import { PrtfConstant, stripConstantQuotes } from '../prtf-edit.model/prtf-edit.model';
import { PrtfNode } from '../prtf-edit.providers/prtf-edit.providers';
import { buildConstantLines, MAX_CONSTANT_TEXT_LENGTH } from './prtf-edit.add-constant';

/** True for a plain quoted literal ('...') — excludes a hex literal (X'...', which starts with
 * 'X' not a quote) and a bare system keyword (DATE/TIME/PAGNBR, unquoted). Neither of those is
 * "text" this feature (or fill-constant.ts's own width-padding) can meaningfully edit. */
export function isPlainTextLiteral(name: string): boolean {
	return name.startsWith("'");
};

/**
 * Rewrites a constant's own literal text block (PrtfConstant.lineIndex..lastLineIndex) with
 * freshly-built lines for `newText`, at the same Line/Position — the shared write path behind
 * both editConstantTextFromNode's own prompt and fill-constant.ts's width-padding.
 */
export async function replaceConstantText(
	document: vscode.TextDocument,
	constant: PrtfConstant,
	newText: string
): Promise<boolean> {
	const newLines = buildConstantLines(
		constant.positionSource === 'flow' ? undefined : constant.row,
		constant.column,
		newText
	);

	const startLine = document.lineAt(constant.lineIndex);
	const endLine = document.lineAt(constant.lastLineIndex);
	const edit = new vscode.WorkspaceEdit();
	edit.replace(document.uri, new vscode.Range(startLine.range.start, endLine.range.end), newLines.join('\n'));

	return vscode.workspace.applyEdit(edit);
};

/**
 * Rewrites a constant's own literal text in place — its definition line through every trailing
 * dash-continuation line (PrtfConstant.lineIndex..lastLineIndex, the multi-line literal only;
 * COLOR/HIGHLIGHT/UNDERLINE/EDTCDE/SPACEB/indicator conditioning live on separate lines *after*
 * that range and are never touched). Reuses buildConstantLines (add-constant.ts) to rebuild the
 * quoting/splitting exactly as "+ Constant" would for a brand-new one, at the same Line/Position.
 *
 * A text-length change can shift whatever's positioned relative to this constant via a "+n"
 * Position elsewhere in the record — anything still coded as "+n" in the source re-resolves
 * against the new length automatically on the next parse; anything already absolute doesn't, and
 * may need a manual drag, same as any other flow/position change in this codebase.
 */
export async function editConstantTextFromNode(node: PrtfNode): Promise<void> {
	if (!node || node.source.kind !== 'constant') {return;}
	const constant = node.source as PrtfConstant;

	if (!isPlainTextLiteral(constant.name)) {
		vscode.window.showInformationMessage(
			constant.name.toUpperCase().startsWith("X'")
				? "PRTF: this is a hex literal (X'...') — edit it directly in the source."
				: `PRTF: '${constant.name}' is a system keyword, not literal text — nothing to edit here.`
		);
		return;
	};

	const document = ExtensionState.lastPrtfDocument;
	if (!document) {return;}

	// Undo buildConstantLines' own escaping (doubled '') so the box shows/accepts natural text,
	// same as "+ Constant"'s own prompt does when first creating one.
	const currentText = stripConstantQuotes(constant.name).replace(/''/g, "'");

	const newText = await vscode.window.showInputBox({
		prompt: `Edit text for constant at line ${constant.row}, position ${constant.column}`,
		value: currentText,
		validateInput: value => value.length > MAX_CONSTANT_TEXT_LENGTH
			? `Too long — max ${MAX_CONSTANT_TEXT_LENGTH} characters.`
			: undefined
	});
	if (!newText || newText === currentText) {return;} // Cancelled, blanked, or unchanged.

	const applied = await replaceConstantText(document, constant, newText);
	if (applied) {
		vscode.window.showInformationMessage('PRTF: constant text updated.');
	} else {
		vscode.window.showErrorMessage('PRTF: could not update — the document may be read-only.');
	};
};

export function registerEditConstantTextCommand(context: vscode.ExtensionContext): void {
	context.subscriptions.push(
		vscode.commands.registerCommand('prtf-edit.edit-constant-text', editConstantTextFromNode)
	);
};
