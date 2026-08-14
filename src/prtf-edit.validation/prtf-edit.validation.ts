/*
	Christian Larsen, 2026
	"PRTF structure"
	prtf-edit.validation.ts
*/

import * as vscode from 'vscode';
import { PrtfAttribute, PrtfConstant, PrtfElement, PrtfField, PrtfRecord } from '../prtf-edit.model/prtf-edit.model';

const SPACE_SKIP_KEYWORD = /^(SPACEA|SPACEB|SKIPA|SKIPB)\(/i;

const DIAGNOSTIC_SOURCE = 'PRTF (CRTPRTF)';

function findSpaceSkipAttributes(attributes: PrtfAttribute[] | undefined): PrtfAttribute[] {
	return (attributes || []).filter(attr => SPACE_SKIP_KEYWORD.test(attr.value.trim()));
};

function lineDiagnostic(lineIndex: number, code: string, message: string, severity: vscode.DiagnosticSeverity): vscode.Diagnostic {
	const diagnostic = new vscode.Diagnostic(new vscode.Range(lineIndex, 0, lineIndex, 80), message, severity);
	diagnostic.source = DIAGNOSTIC_SOURCE;
	diagnostic.code = code;
	return diagnostic;
};

/**
 * Mirrors CRTPRTF's own check (CPD7826/CPD7860/CPD5238): within one record format, an explicit
 * Line (positions 39-41) on any field/constant and a SPACEA/SPACEB/SKIPA/SKIPB keyword at record
 * or field level cannot coexist — the compiler rejects the whole record format ("No valid record
 * found in source"), confirmed against a real CRTPRTF joblog. `positionSource === 'explicit'` is
 * exactly that condition: it's only set when a row came from a real Line entry (or blank-row
 * inheritance within an explicit-mode record), not from resolveFlowModePositions' own SPACE/SKIP
 * simulation for legitimate flow-mode records — those must NOT be flagged just because they use
 * the very keywords that make them flow-mode in the first place.
 * @param elements - The full parsed document, as returned by parseDocument
 */
export function validatePositioningConflicts(elements: PrtfElement[]): vscode.Diagnostic[] {
	const diagnostics: vscode.Diagnostic[] = [];
	const recordElements = elements.filter((el): el is PrtfRecord => el.kind === 'record');

	for (const record of recordElements) {
		const positionedItems = elements.filter((el): el is PrtfField | PrtfConstant =>
			(el.kind === 'field' || el.kind === 'constant') &&
			el.recordname === record.name &&
			el.positionSource === 'explicit'
		);
		if (positionedItems.length === 0) {continue;}

		const recordSpaceSkip = findSpaceSkipAttributes(record.attributes);
		const fieldSpaceSkip = positionedItems.flatMap(item => findSpaceSkipAttributes(item.attributes));
		if (recordSpaceSkip.length === 0 && fieldSpaceSkip.length === 0) {continue;}

		diagnostics.push(lineDiagnostic(
			record.lineIndex,
			'CPD5238',
			`PRTF: record format '${record.name}' mixes explicit Line numbers with SPACEA/SPACEB/SKIPA/SKIPB — CRTPRTF rejects the whole record format ("No valid record found in source").`,
			vscode.DiagnosticSeverity.Error
		));

		for (const attr of [...recordSpaceSkip, ...fieldSpaceSkip]) {
			diagnostics.push(lineDiagnostic(
				attr.lineIndex,
				'CPD7826',
				'PRTF: space and skip keywords not allowed with line numbers.',
				vscode.DiagnosticSeverity.Warning
			));
		};

		for (const item of positionedItems) {
			diagnostics.push(lineDiagnostic(
				item.lineIndex,
				'CPD7860',
				'PRTF: line number not allowed with space or skip keyword.',
				vscode.DiagnosticSeverity.Error
			));
		};
	};

	return diagnostics;
};
