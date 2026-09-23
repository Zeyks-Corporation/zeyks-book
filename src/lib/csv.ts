/**
 * CSV export that survives Excel.
 *
 * Two things the old exporter got wrong:
 *   1. A cell beginning = + - @ is executed as a formula on open. A customer
 *      named `=HYPERLINK("http://evil","Invoice")` became a live link in the
 *      user's spreadsheet. Those cells are now prefixed with a single quote.
 *   2. Embedded double quotes were not doubled, so one apostrophe-heavy name
 *      corrupted every row after it.
 * Download now goes through a Blob rather than a `data:` URI, which has no
 * length ceiling and does not choke on `#`.
 */

const FORMULA_LEAD = /^[=+\-@\t\r]/;

export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '""';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '0';
  let text = String(value);
  if (FORMULA_LEAD.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

export function csvRow(cells: unknown[]): string {
  return `${cells.map(csvCell).join(',')}\n`;
}

export function downloadCsv(filename: string, content: string): void {
  // The BOM makes Excel open UTF-8 (Nepali names, रू) correctly.
  const blob = new Blob([`\uFEFF${content}`], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

export function downloadJson(filename: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
