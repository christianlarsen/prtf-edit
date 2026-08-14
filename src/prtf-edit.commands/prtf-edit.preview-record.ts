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

export function registerPreviewRecordCommand(context: vscode.ExtensionContext): void {
	context.subscriptions.push(
		vscode.commands.registerCommand('prtf-edit.preview-record', previewRecord)
	);
};
