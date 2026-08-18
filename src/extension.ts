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
import { registerEditAttributesCommand } from './prtf-edit.commands/prtf-edit.edit-attributes';
import { registerEditIndicatorsCommand } from './prtf-edit.commands/prtf-edit.edit-indicators';
import { registerRecordCrudCommands } from './prtf-edit.commands/prtf-edit.record-crud';
import { registerCopyElementCommand } from './prtf-edit.commands/prtf-edit.copy-element';
import { registerDeleteElementCommand } from './prtf-edit.commands/prtf-edit.delete-element';
import { registerRenameCommands } from './prtf-edit.commands/prtf-edit.rename-element';
import { registerEditConstantTextCommand } from './prtf-edit.commands/prtf-edit.edit-constant-text';
import { registerFillConstantCommand } from './prtf-edit.commands/prtf-edit.fill-constant';
import { revealLine } from './prtf-edit.utils/prtf-edit.navigation';
import { RecordPreviewPanel } from './prtf-edit.webview/prtf-edit.record-preview-panel';

// Activate extension
export function activate(context: vscode.ExtensionContext) {

	// Create the tree data provider
	const treeProvider = new PrtfTreeProvider();

	// Create the TreeView and register it
	const treeView = vscode.window.createTreeView('prtf-edit.schema-view', {
		treeDataProvider: treeProvider
	});

	// Clicking a node navigates the source editor to its line, and (if the preview is open) points
	// the preview at it too — the one and only other place besides a click inside the preview
	// itself that changes what the preview shows; it deliberately does *not* follow the source
	// cursor around on its own (see listeners.ts).
	context.subscriptions.push(
		treeView.onDidChangeSelection(event => {
			const node = event.selection[0] as PrtfNode | undefined;
			const lineIndex = (node?.source as { lineIndex?: number } | undefined)?.lineIndex;
			if (typeof lineIndex === 'number') {
				revealLine(lineIndex);
				RecordPreviewPanel.syncToLine(ExtensionState.lastPrtfElements, lineIndex);
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
	registerEditAttributesCommand(context);
	registerEditIndicatorsCommand(context);
	registerRecordCrudCommands(context);
	registerCopyElementCommand(context);
	registerDeleteElementCommand(context);
	registerRenameCommands(context);
	registerEditConstantTextCommand(context);
	registerFillConstantCommand(context);
	initializeDocumentListeners(context, treeProvider);
};

export function deactivate() {
	ExtensionState.clearTimeout();
};
