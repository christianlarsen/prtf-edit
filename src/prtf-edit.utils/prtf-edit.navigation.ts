/*
	Christian Larsen, 2026
	"PRTF structure"
	prtf-edit.navigation.ts
*/

import * as vscode from 'vscode';
import { ExtensionState } from '../prtf-edit.states/state';

/**
 * Reveals and selects a source line in the tracked PRTF document — shared by the tree view's
 * click-to-navigate and the preview panel's click-to-navigate, so both land in the editor the
 * same way.
 * @param lineIndex - Zero-based line index to navigate to
 */
export async function revealLine(lineIndex: number): Promise<void> {
	const document = ExtensionState.lastPrtfDocument;
	if (!document) {return;}

	// Reuse whichever view column the source is already visible in, rather than letting
	// showTextDocument guess from "the active column" — with focus on a webview (the preview
	// panel, the tree view), that guess can resolve to the webview's own column and open a
	// second, unwanted copy of the source there instead of reusing the existing one.
	const visibleEditor = vscode.window.visibleTextEditors.find(e => e.document === document);
	const viewColumn = visibleEditor?.viewColumn ?? vscode.ViewColumn.One;

	const editor = await vscode.window.showTextDocument(document, { viewColumn, preserveFocus: true, preview: false });
	const line = Math.max(0, Math.min(lineIndex, document.lineCount - 1));
	const position = new vscode.Position(line, 0);
	editor.selection = new vscode.Selection(position, position);
	editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
};
