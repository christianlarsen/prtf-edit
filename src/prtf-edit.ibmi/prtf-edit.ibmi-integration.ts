/*
	Christian Larsen, 2026
	"PRTF structure"
	prtf-edit.ibmi-integration.ts
*/

import * as vscode from 'vscode';
import { DecimalFormat } from '../prtf-edit.utils/prtf-edit.decimal-format';
import { DateSeparatorFormat } from '../prtf-edit.utils/prtf-edit.date-format';

/**
 * Isolated from the rest of the extension on purpose: this is the only file that knows about the
 * Code for i extension's API, which its own docs say may change between releases. Not a hard
 * dependency — `getIBMiConnection` returns undefined rather than throwing when that extension
 * isn't installed or has no active connection, so callers decide how to surface that.
 *
 * Deliberately NOT typed against `@halcyontech/vscode-ibmi-types`: importing its `IBMi`/
 * `CodeForIBMi` types pulls in transitive type dependencies (`@ibm/mapepire-js`, `node-ssh`,
 * `ssh2`) that aren't installed and aren't declared by that package either, which breaks `tsc` for
 * anything that just wants types. Instead, a minimal structural interface covers only what's
 * actually called here.
 */

const CODE_FOR_IBMI_EXTENSION_ID = 'halcyontechltd.code-for-ibmi';

/** The slice of Code for i's `IBMi` connection this module actually calls. */
interface MinimalIBMiConnection {
	runSQL(statements: string | string[], options?: { bindings?: (string | number | null)[] }): Promise<Record<string, string | number | null>[]>;
};

/** The slice of Code for i's exported API this module actually calls. */
interface MinimalCodeForIBMi {
	instance: {
		getConnection(): MinimalIBMiConnection | undefined;
	};
};

/**
 * Gets the active IBM i connection from the Code for i extension, if installed and connected.
 * Returns undefined rather than throwing: callers decide how to surface "no connection" to the user.
 */
export function getIBMiConnection(): MinimalIBMiConnection | undefined {
	const codeForIBMi = vscode.extensions.getExtension<MinimalCodeForIBMi>(CODE_FOR_IBMI_EXTENSION_ID);
	return codeForIBMi?.exports?.instance?.getConnection();
};

/**
 * Maps the IBM i QDECFMT system value's raw character to the extension's DecimalFormat: '0' (the
 * default) uses a period decimal point and comma thousands separator; '1' and 'J' both use a
 * comma decimal point and period thousands separator — 'J' only differs from '1' in its
 * zero-suppression style for a zero-balance value, which this placeholder-based preview doesn't
 * simulate, so both map to 'European' here.
 */
const QDECFMT_TO_DECIMAL_FORMAT: Record<string, DecimalFormat> = {
	'0': 'US',
	'1': 'European',
	J: 'European'
};

/**
 * Reads the connected IBM i's QDECFMT system value and maps it to the extension's decimal format.
 * Throws (no connection, unrecognized value) rather than returning a sentinel — callers show it to
 * the user.
 */
export async function resolveDecimalFormatFromSystem(): Promise<DecimalFormat> {
	const connection = getIBMiConnection();
	if (!connection) {
		throw new Error('No active IBM i connection. Connect via the Code for i extension first.');
	};

	const rows = await connection.runSQL(
		`SELECT CURRENT_CHARACTER_VALUE FROM QSYS2.SYSTEM_VALUE_INFO WHERE SYSTEM_VALUE_NAME = 'QDECFMT'`
	);
	const raw = String(rows[0]?.CURRENT_CHARACTER_VALUE ?? '').trim().toUpperCase();
	const mapped = QDECFMT_TO_DECIMAL_FORMAT[raw];
	if (!mapped) {
		throw new Error(`Unrecognized QDECFMT value '${raw}' on the connected IBM i.`);
	};
	return mapped;
};

/**
 * Maps the IBM i QDATSEP system value's raw character to the extension's DateSeparatorFormat: '/'
 * (the default) and '-' (common in European locales). QDATSEP also allows '.' and ',', which
 * aren't mapped since neither format is exposed in the Configuration panel.
 */
const QDATSEP_TO_DATE_SEPARATOR_FORMAT: Record<string, DateSeparatorFormat> = {
	'/': 'US',
	'-': 'European'
};

/**
 * Reads the connected IBM i's QDATSEP system value and maps it to the extension's date separator
 * format. Throws (no connection, unrecognized value) rather than returning a sentinel — callers
 * show it to the user.
 */
export async function resolveDateSeparatorFormatFromSystem(): Promise<DateSeparatorFormat> {
	const connection = getIBMiConnection();
	if (!connection) {
		throw new Error('No active IBM i connection. Connect via the Code for i extension first.');
	};

	const rows = await connection.runSQL(
		`SELECT CURRENT_CHARACTER_VALUE FROM QSYS2.SYSTEM_VALUE_INFO WHERE SYSTEM_VALUE_NAME = 'QDATSEP'`
	);
	const raw = String(rows[0]?.CURRENT_CHARACTER_VALUE ?? '').trim();
	const mapped = QDATSEP_TO_DATE_SEPARATOR_FORMAT[raw];
	if (!mapped) {
		throw new Error(`Unrecognized QDATSEP value '${raw}' on the connected IBM i.`);
	};
	return mapped;
};
