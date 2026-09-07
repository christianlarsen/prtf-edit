/*
	Christian Larsen, 2026
	"PRTF structure"
	prtf-edit.configure-preview.ts
*/

import * as vscode from 'vscode';
import { ConfigurationPanel } from '../prtf-edit.webview/prtf-edit.configuration-panel';

export function registerConfigurePreviewCommand(context: vscode.ExtensionContext): void {
	context.subscriptions.push(
		vscode.commands.registerCommand('prtf-edit.configure-preview', () => ConfigurationPanel.show())
	);
};
