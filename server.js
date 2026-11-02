#!/usr/bin/env node
'use strict';
/*
 * todotxt-lsp — servidor LSP mínimo para archivos todo.txt
 * Sin dependencias: solo Node.js (>= 14). Habla JSON-RPC por stdio.
 *
 * Autocompleta:
 *   +proyecto     → proyectos usados en el archivo (y en todo.txt / done.txt de la misma carpeta)
 *   @contexto     → contextos usados
 *   (             → prioridades (A) … (Z)
 *   due: t: …     → fechas (hoy, mañana, próximo lunes, +1 semana, fin de mes…)
 *   clave:        → valores ya usados para esa clave
 *   inicio línea  → "x <fecha>" (completar), prioridades, fecha de creación
 */

const fs = require('fs');
const path = require('path');
const { fileURLToPath } = require('url');

const docs = new Map(); // uri -> texto
const DATE_KEYS = new Set(['due', 't', 'threshold', 'scheduled', 'start', 'until', 'wait']);
const COMMON_KEYS = [
  ['due', 'fecha límite'],
  ['t', 'fecha umbral (no mostrar antes de)'],
  ['rec', 'recurrencia (ej. rec:1w, rec:+1m)'],
  ['pri', 'prioridad original'],
  ['id', 'identificador'],
  ['dep', 'depende de id'],
];
const URL_SCHEMES = new Set(['http', 'https', 'ftp', 'mailto', 'file']);
const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

// ---------------------------------------------------------------- transporte
let buffer = Buffer.alloc(0);
process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const sep = buffer.indexOf('\r\n\r\n');
    if (sep < 0) return;
    const header = buffer.slice(0, sep).toString('ascii');
    const m = header.match(/Content-Length:\s*(\d+)/i);
    if (!m) { buffer = buffer.slice(sep + 4); continue; }
    const len = parseInt(m[1], 10);
    const start = sep + 4;
    if (buffer.length < start + len) return;
    const body = buffer.slice(start, start + len).toString('utf8');
    buffer = buffer.slice(start + len);
    let msg;
    try { msg = JSON.parse(body); } catch { continue; }
    try { handle(msg); } catch (err) {
      if (msg.id !== undefined) send({ id: msg.id, error: { code: -32603, message: String(err && err.message || err) } });
    }
  }
});

function send(msg) {
  const s = JSON.stringify(Object.assign({ jsonrpc: '2.0' }, msg));
  process.stdout.write(`Content-Length: ${Buffer.byteLength(s, 'utf8')}\r\n\r\n${s}`);
}

// ---------------------------------------------------------------- dispatcher
function handle(msg) {
  const { method, id, params } = msg;
  switch (method) {
    case 'initialize':
      return send({ id, result: {
        capabilities: {
          textDocumentSync: 1, // full
          completionProvider: { triggerCharacters: ['+', '@', ':', '('] },
        },
        serverInfo: { name: 'todotxt-lsp', version: '0.1.0' },
      } });
    case 'shutdown':
      return send({ id, result: null });
    case 'exit':
      return process.exit(0);
    case 'textDocument/didOpen':
      docs.set(params.textDocument.uri, params.textDocument.text);
      return;
    case 'textDocument/didChange': {
      const changes = params.contentChanges || [];
      if (changes.length) docs.set(params.textDocument.uri, changes[changes.length - 1].text);
      return;
    }
    case 'textDocument/didClose':
      docs.delete(params.textDocument.uri);
      return;
    case 'textDocument/completion':
      return send({ id, result: { isIncomplete: false, items: complete(params) } });
    default:
      if (id !== undefined && method) send({ id, error: { code: -32601, message: `Método no soportado: ${method}` } });
  }
}

// ---------------------------------------------------------------- fechas
const pad = (n) => String(n).padStart(2, '0');
const fmt = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
function addDays(d, n) { const r = new Date(d); r.setDate(r.getDate() + n); return r; }
function today() { const d = new Date(); d.setHours(0, 0, 0, 0); return d; }

function dateSuggestions() {
  const t = today();
  const list = [
    ['hoy', t],
    ['mañana', addDays(t, 1)],
    ['pasado mañana', addDays(t, 2)],
  ];
  for (let i = 1; i <= 7; i++) {
    const d = addDays(t, i);
    if (i > 2) list.push([`próximo ${DIAS[d.getDay()]}`, d]);
  }
  list.push(['en 1 semana', addDays(t, 7)]);
  list.push(['en 2 semanas', addDays(t, 14)]);
  const m = new Date(t); m.setMonth(m.getMonth() + 1);
  list.push(['en 1 mes', m]);
  list.push(['fin de mes', new Date(t.getFullYear(), t.getMonth() + 1, 0)]);
  // quitar duplicados de fecha conservando el primer nombre
  const seen = new Set();
  return list.filter(([, d]) => { const k = fmt(d); if (seen.has(k)) return false; seen.add(k); return true; })
    .map(([name, d]) => ({ name: `${name} (${DIAS[d.getDay()]})`, date: fmt(d) }));
}

// ---------------------------------------------------------------- índice de etiquetas
function collectTexts(uri) {
  const texts = [];
  for (const t of docs.values()) texts.push(t);
  let dir = null;
  try { dir = path.dirname(fileURLToPath(uri)); } catch { /* uri no-file */ }
  if (dir) {
    const openPaths = new Set();
    for (const u of docs.keys()) { try { openPaths.add(fileURLToPath(u)); } catch {} }
    for (const name of ['todo.txt', 'done.txt']) {
      const p = path.join(dir, name);
      if (openPaths.has(p)) continue;
      try { texts.push(fs.readFileSync(p, 'utf8')); } catch {}
    }
  }
  return texts;
}

function buildIndex(uri) {
  const projects = new Map(), contexts = new Map(), keys = new Map();
  const bump = (map, k) => map.set(k, (map.get(k) || 0) + 1);
  for (const text of collectTexts(uri)) {
    for (const tok of text.split(/\s+/)) {
      if (tok.length > 1 && tok[0] === '+') bump(projects, tok);
      else if (tok.length > 1 && tok[0] === '@') bump(contexts, tok);
      else {
        const m = tok.match(/^([A-Za-z0-9_-]+):([^\s:]+)$/);
        if (m && !URL_SCHEMES.has(m[1].toLowerCase()) && !m[2].startsWith('/')) {
          if (!keys.has(m[1])) keys.set(m[1], new Map());
          bump(keys.get(m[1]), m[2]);
        }
      }
    }
  }
  return { projects, contexts, keys };
}

const byFreq = (map) => [...map.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

// ---------------------------------------------------------------- completado
const KIND = { Text: 1, Keyword: 14, Value: 12, Constant: 21, Folder: 19, Event: 23, EnumMember: 20 };

function complete(params) {
  const { textDocument, position } = params;
  const text = docs.get(textDocument.uri) || '';
  const line = text.split(/\r?\n/)[position.line] || '';
  const before = line.slice(0, position.character);
  const word = (before.match(/(\S*)$/) || ['', ''])[1];
  const wordStart = position.character - word.length;
  const range = (startCol) => ({
    start: { line: position.line, character: startCol },
    end: { line: position.line, character: position.character },
  });
  const item = (label, newText, kind, detail, sort, startCol = wordStart) => ({
    label, kind, detail,
    sortText: String(sort).padStart(4, '0'),
    filterText: newText.trim(),
    textEdit: { range: range(startCol), newText },
  });

  const idx = buildIndex(textDocument.uri);
  const items = [];
  const todayStr = fmt(today());

  // +proyecto
  if (word.startsWith('+')) {
    byFreq(idx.projects).forEach(([p, n], i) => items.push(item(p, p, KIND.Folder, `proyecto · ${n} uso(s)`, i)));
    return items;
  }
  // @contexto
  if (word.startsWith('@')) {
    byFreq(idx.contexts).forEach(([c, n], i) => items.push(item(c, c, KIND.EnumMember, `contexto · ${n} uso(s)`, i)));
    return items;
  }
  // clave:valor
  const kv = word.match(/^([A-Za-z0-9_-]+):(\S*)$/);
  if (kv && !URL_SCHEMES.has(kv[1].toLowerCase())) {
    const key = kv[1];
    const valStart = wordStart + key.length + 1;
    let i = 0;
    if (DATE_KEYS.has(key)) {
      for (const s of dateSuggestions()) {
        const it = item(s.date, s.date, KIND.Event, s.name, i++, valStart);
        it.filterText = s.date;
        items.push(it);
      }
    }
    const used = idx.keys.get(key);
    if (used) for (const [v, n] of byFreq(used)) {
      if (DATE_KEYS.has(key) && items.some((x) => x.label === v)) continue;
      const it = item(v, v, KIND.Value, `usado ${n} vez/veces`, i++, valStart);
      it.filterText = v;
      items.push(it);
    }
    return items;
  }
  // ( → prioridades
  if (/^\(\w?\)?$/.test(word) && wordStart === 0) {
    for (let c = 65; c <= 90; c++) {
      const p = `(${String.fromCharCode(c)})`;
      const it = item(p, `${p} `, KIND.Constant, c <= 67 ? ['alta', 'media', 'baja'][c - 65] : 'prioridad', c);
      it.filterText = p;
      items.push(it);
    }
    return items;
  }

  // inicio de línea
  if (wordStart === 0) {
    let i = 0;
    items.push(item(`x ${todayStr}`, `x ${todayStr} `, KIND.Keyword, 'marcar como completada hoy', i++));
    ['A', 'B', 'C'].forEach((p) => items.push(item(`(${p})`, `(${p}) `, KIND.Constant, 'prioridad', i++)));
    items.push(item(todayStr, `${todayStr} `, KIND.Event, 'fecha de creación (hoy)', i++));
    return items;
  }
  // después de "(A) " o "x " → fecha
  if (/^(\([A-Z]\)|x) $/.test(before.slice(0, wordStart))) {
    const label = before.startsWith('x ') ? 'fecha de completado (hoy)' : 'fecha de creación (hoy)';
    items.push(item(todayStr, `${todayStr} `, KIND.Event, label, 0));
  }

  // en medio de la línea: claves conocidas + comunes
  let i = 10;
  const keyNames = new Set([...COMMON_KEYS.map(([k]) => k), ...idx.keys.keys()]);
  for (const k of keyNames) {
    const desc = (COMMON_KEYS.find(([c]) => c === k) || [])[1] || 'clave usada en el archivo';
    const it = item(`${k}:`, `${k}:`, KIND.Keyword, desc, i++);
    it.filterText = `${k}:`;
    it.command = { title: 'sugerir', command: 'editor.action.triggerSuggest' };
    items.push(it);
  }
  return items;
}
