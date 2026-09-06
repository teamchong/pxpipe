// Lossless research representation. Selection never uses the question or gold.
import assert from 'node:assert/strict';
export function compactJsonl(source) {
  const lines = source.split('\n'), chunks = [];
  for (let i = 0; i < lines.length;) {
    const records = []; let keys;
    for (let j = i; j < lines.length; j++) {
      let r; try { r = JSON.parse(lines[j]); } catch { break; }
      // Reject duplicate keys, unsafe numbers, noncanonical escaping/whitespace.
      if (!r || Array.isArray(r) || typeof r !== 'object' || JSON.stringify(r) !== lines[j]) break;
      if (keys && JSON.stringify(keys) !== JSON.stringify(Object.keys(r))) break;
      keys = Object.keys(r); records.push(r);
    }
    if (records.length < 4) { chunks.push({ text: lines[i++] }); continue; }
    const constants = Object.fromEntries(keys.filter(k => records.every(r => JSON.stringify(r[k]) === JSON.stringify(records[0][k]))).map(k => [k, records[0][k]]));
    const columns = keys.filter(k => !Object.hasOwn(constants, k));
    chunks.push({ keys, constants, columns, rows: records.map(r => columns.map(k => r[k])) }); i += records.length;
  }
  const text = chunks.map(c => 'text' in c ? c.text : [
    `[JSONL table: columns=${JSON.stringify(c.columns)}; constants=${JSON.stringify(c.constants)}. Each following array is one record; column order binds values.]`,
    ...c.rows.map(row => JSON.stringify(row)), '[End JSONL table]',
  ].join('\n')).join('\n');
  assert.equal(restoreJsonl(chunks), source);
  return { text, chunks };
}
export function restoreJsonl(chunks) {
  return chunks.flatMap(c => 'text' in c ? [c.text] : c.rows.map(row => JSON.stringify(Object.fromEntries(
    c.keys.map(k => [k, Object.hasOwn(c.constants, k) ? c.constants[k] : row[c.columns.indexOf(k)]]),
  )))).join('\n');
}
