/*
	Christian Larsen, 2026
	"PRTF structure"
	prtf-edit.preview-record.ts
*/

import * as vscode from 'vscode';
import { PrtfNode } from '../prtf-edit.providers/prtf-edit.providers';
import { RecordPreviewPanel } from '../prtf-edit.webview/prtf-edit.record-preview-panel';
import { ExtensionState } from '../prtf-edit.states/state';
import { parseDocument } from '../prtf-edit.parser/prtf-edit.parser';

/** Opens (or refreshes) the page-layout preview for the record behind the given tree node. */
export function previewRecord(node: PrtfNode): void {
	if (!node || node.source.kind !== 'record') {return;}
	if (!ExtensionState.lastPrtfDocument) {return;}

	const elements = parseDocument(ExtensionState.lastPrtfDocument.getText());
	RecordPreviewPanel.createOrShow(node.source.name, elements);
};

/** Same as previewRecord, but invoked by the "Preview Page Layout" CodeLens (see
 * prtf-edit.record-codelens-provider.ts) with just the record's name, rather than a tree node. */
export function previewRecordByName(recordName: string): void {
	if (!ExtensionState.lastPrtfDocument) {return;}

	const elements = parseDocument(ExtensionState.lastPrtfDocument.getText());
	RecordPreviewPanel.createOrShow(recordName, elements);
};

export function registerPreviewRecordCommand(context: vscode.ExtensionContext): void {
	context.subscriptions.push(
		vscode.commands.registerCommand('prtf-edit.preview-record', previewRecord),
		vscode.commands.registerCommand('prtf-edit.preview-record-by-name', previewRecordByName)
	);
};
