/*
	Christian Larsen, 2026
	"PRTF structure"
	prtf-edit.move-element.ts
*/

import * as vscode from 'vscode';
import { ExtensionState } from '../prtf-edit.states/state';

/**
 * Rewrites a source line's Line/Position zone (columns 39-41, 42-44 — 0-based 38-40/41-43) with
 * new values, leaving everything else on the line untouched. Same column arithmetic as dspf-edit's
 * own change-position.ts — the fixed-column layout is identical in this zone for PRTF and DSPF.
 */
export function buildRepositionedLine(originalLine: string, newRow: number, newCol: number): string {
	const formattedRow = String(newRow).padStart(3, ' ');
	const formattedCol = String(newCol).padStart(3, ' ');
	const prefix = originalLine.substring(0, 38);
	const suffix = originalLine.substring(44);
	return prefix + formattedRow + formattedCol + suffix;
};

/**
 * Same idea, but leaves the Line zone (columns 39-41) exactly as it was — only Position (42-44)
 * is rewritten. Used for a flow-mode field/constant (no explicit Line at all; its row comes from
 * simulating SPACEB/SPACEA/SKIPB/SKIPA — see resolveFlowModePositions in the parser): writing a
 * Line value there would silently convert it to explicit mode and put it at odds with the
 * record's own SPACE/SKIP keywords, which prtf-edit.validation.ts would then flag as a real
 * CRTPRTF conflict. Dragging such an item horizontally is still safe — Position is independent of
 * Line either way — just not vertically, since there's no Line entry to move.
 */
export function buildRepositionedColumnOnly(originalLine: string, newCol: number): string {
	const formattedCol = String(newCol).padStart(3, ' ');
	const prefix = originalLine.substring(0, 41);
	const suffix = originalLine.substring(44);
	return prefix + formattedCol + suffix;
};

/**
 * Moves a field or constant to a new (row, col) by editing its source line directly — used by the
 * preview's drag-to-reposition. Only touches columns 39-44; the name, type, keywords and
 * everything else on the line are left exactly as they were.
 * @param lineIndex - Zero-based source line of the field/constant to move
 * @param newRow - New DDS line number (1-based) — ignored when columnOnly is true
 * @param newCol - New DDS position (1-based)
 * @param maxRow - Upper bound to clamp newRow to (the preview's configured page rows)
 * @param maxCol - Upper bound to clamp newCol to (the preview's configured page cols)
 * @param columnOnly - True for a flow-mode item: rewrite Position only, leave Line untouched
 */
export async function moveElement(lineIndex: number, newRow: number, newCol: number, maxRow: number, maxCol: number, columnOnly = false): Promise<void> {
	const document = ExtensionState.lastPrtfDocument;
	if (!document) {return;}
	if (lineIndex < 0 || lineIndex >= document.lineCount) {return;}

	// DDS's own absolute limit is 255 for both Line and Position, regardless of the preview's
	// configured page size — clamp to whichever is smaller.
	const upperRow = Math.min(255, maxRow);
	const upperCol = Math.min(255, maxCol);
	const clampedRow = Math.min(upperRow, Math.max(1, Math.round(newRow)));
	const clampedCol = Math.min(upperCol, Math.max(1, Math.round(newCol)));

	const line = document.lineAt(lineIndex);
	if (line.text.length < 44) {
		vscode.window.showErrorMessage(
			`PRTF: can't reposition — line ${lineIndex + 1} is only ${line.text.length} characters long ` +
			`(needs at least 44 to contain a Line/Position zone).`
		);
		return;
	};

	const updatedLine = columnOnly
		? buildRepositionedColumnOnly(line.text, clampedCol)
		: buildRepositionedLine(line.text, clampedRow, clampedCol);
	if (updatedLine === line.text) {return;}

	const edit = new vscode.WorkspaceEdit();
	edit.replace(document.uri, line.range, updatedLine);

	const applied = await vscode.workspace.applyEdit(edit);
	if (!applied) {
		vscode.window.showErrorMessage('PRTF: could not apply the move — the document may be read-only.');
	};
};
