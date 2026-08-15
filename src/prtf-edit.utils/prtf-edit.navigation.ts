/*
	Christian Larsen, 2026
	"PRTF structure"
	prtf-edit.navigation.ts
*/

import { RecordPreviewPanel } from '../prtf-edit.webview/prtf-edit.record-preview-panel';

/**
 * Reveals and selects a source line in the tracked PRTF document — used by the tree view's
 * click-to-navigate (the preview panel's own click-to-navigate calls
 * RecordPreviewPanel.revealInSourceEditor directly, since it already lives in that class).
 * Focus-mode-aware: see RecordPreviewPanel.revealInSourceEditor.
 * @param lineIndex - Zero-based line index to navigate to
 */
export async function revealLine(lineIndex: number): Promise<void> {
	await RecordPreviewPanel.revealInSourceEditor(lineIndex);
};
