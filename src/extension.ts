/*
	Christian Larsen, 2026
	"PRTF structure"
	extension.ts
*/

import * as vscode from 'vscode';
import { PrtfNode, PrtfTreeProvider } from './prtf-edit.providers/prtf-edit.providers';
import { ExtensionState } from './prtf-edit.states/state';
import { initializeDocumentListeners } from './prtf-edit.listeners/listeners';
import { registerPreviewRecordCommand } from './prtf-edit.commands/prtf-edit.preview-record';
import { revealLine } from './prtf-edit.utils/prtf-edit.navigation';

// Activate extension
export function activate(context: vscode.ExtensionContext) {

	// Create the tree data provider
	const treeProvider = new PrtfTreeProvider();

	// Create the TreeView and register it
	const treeView = vscode.window.createTreeView('prtf-edit.schema-view', {
		treeDataProvider: treeProvider
	});

	// Clicking a node navigates the source editor to its line, when it has one.
	context.subscriptions.push(
		treeView.onDidChangeSelection(event => {
			const node = event.selection[0] as PrtfNode | undefined;
			const lineIndex = (node?.source as { lineIndex?: number } | undefined)?.lineIndex;
			if (typeof lineIndex === 'number') {
				revealLine(lineIndex);
			};
		})
	);

	// Store references in the global state
	ExtensionState.treeProvider = treeProvider;
	ExtensionState.treeView = treeView;
	ExtensionState.diagnosticCollection = vscode.languages.createDiagnosticCollection('prtf-edit');

	// Add treeView and diagnostics to subscriptions for proper disposal
	context.subscriptions.push(treeView, ExtensionState.diagnosticCollection);

	registerPreviewRecordCommand(context);
	initializeDocumentListeners(context, treeProvider);
};

export function deactivate() {
	ExtensionState.clearTimeout();
};
