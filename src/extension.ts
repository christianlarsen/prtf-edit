/*
	Christian Larsen, 2026
	"PRTF structure"
	extension.ts
*/

import * as vscode from 'vscode';
import { PrtfTreeProvider } from './prtf-edit.providers/prtf-edit.providers';
import { ExtensionState } from './prtf-edit.states/state';
import { initializeDocumentListeners } from './prtf-edit.listeners/listeners';

// Activate extension
export function activate(context: vscode.ExtensionContext) {

	// Create the tree data provider
	const treeProvider = new PrtfTreeProvider();

	// Create the TreeView and register it
	const treeView = vscode.window.createTreeView('prtf-edit.schema-view', {
		treeDataProvider: treeProvider
	});

	// Store references in the global state
	ExtensionState.treeProvider = treeProvider;

	// Add treeView to subscriptions for proper disposal
	context.subscriptions.push(treeView);

	initializeDocumentListeners(context, treeProvider);
};

export function deactivate() {
	ExtensionState.clearTimeout();
};
