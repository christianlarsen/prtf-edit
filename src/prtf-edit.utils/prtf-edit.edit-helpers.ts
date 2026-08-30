/*
	Christian Larsen, 2026
	"PRTF structure"
	prtf-edit.edit-helpers.ts
*/

import * as vscode from 'vscode';

/**
 * The range to delete in order to remove lines `startLineIndex` through `endLineIndex` (inclusive)
 * entirely — including whichever single surrounding newline is needed so no blank line is left
 * behind, and no line above or below the deleted block gets merged into it.
 *
 * Normally that's the block's *own* trailing newline (extending the delete through
 * `endLine.rangeIncludingLineBreak.end`), same as removing lines anywhere else in the file. But the
 * document's very last line has no trailing newline of its own to include — `rangeIncludingLineBreak`
 * then equals `range` itself, so deleting only that would erase the block's *text* while leaving the
 * newline that used to separate it from the line above still in place, now trailing nothing: a blank
 * final line. Deleting the *preceding* line's own newline instead — starting the range from its end
 * rather than the block's own start — merges the block into the line above instead, avoiding that.
 * @param document - The document the range is being computed against
 * @param startLineIndex - Zero-based index of the first line to delete
 * @param endLineIndex - Zero-based index of the last line to delete
 */
export function deletableLineRange(
	document: vscode.TextDocument,
	startLineIndex: number,
	endLineIndex: number
): vscode.Range {
	const startLine = document.lineAt(startLineIndex);
	const endLine = document.lineAt(endLineIndex);

	const isFinalLineWithNoTrailingNewline = endLine.rangeIncludingLineBreak.end.isEqual(endLine.range.end);
	const from = isFinalLineWithNoTrailingNewline && startLineIndex > 0
		? document.lineAt(startLineIndex - 1).range.end
		: startLine.range.start;

	return new vscode.Range(from, endLine.rangeIncludingLineBreak.end);
};
