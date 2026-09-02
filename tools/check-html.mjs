// Szybka walidacja public/index.html dla CI — bez uruchamiania przeglądarki
// (to robi tools/shot.py). Sprawdza: doctype, zbalansowane <script>/</script>
// i to, że JS wewnątrz <script> w ogóle się parsuje (node --check, bez
// wykonywania kodu).
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const path = 'public/index.html';
const html = readFileSync(path, 'utf8');

if (!/^\s*<!doctype html>/i.test(html)) {
  console.error(`${path}: brak <!doctype html> na początku pliku`);
  process.exit(1);
}

// Dopasowanie nie-zachłanne: każdy <script> paruje się z NAJBLIŻSZYM </script>,
// więc to jest jednocześnie ekstrakcja treści i sprawdzenie parowania — bez
// naiwnego liczenia osobno "<script" i "</script>" w całym pliku (plik
// zawiera w komentarzu JS literalny tekst „<script id="engine">” jako
// odniesienie do drugiego bloku, co fałszywie zawyżałoby taką liczbę).
const blockRe = /<script(\s[^>]*)?>([\s\S]*?)<\/script>/gi;
const blocks = [...html.matchAll(blockRe)];
if (blocks.length === 0) {
  console.error(`${path}: nie znaleziono żadnego znacznika <script>`);
  process.exit(1);
}

// Po wycięciu sparowanych bloków nie powinno zostać żadne osierocone
// <script> ani </script> — to złapałoby np. brakujący tag zamykający.
const remainder = html.replace(blockRe, '');
if (/<script\b/i.test(remainder) || /<\/script>/i.test(remainder)) {
  console.error(`${path}: niezbalansowany albo osierocony znacznik <script>/</script>`);
  process.exit(1);
}

// Tylko skrypty inline (bez src) — to one zawierają logikę kalkulatora.
const inlineScripts = blocks
  .filter((m) => !/\bsrc=/.test(m[1] || ''))
  .map((m) => m[2])
  .join('\n;\n');

if (!inlineScripts.trim()) {
  console.error(`${path}: brak inline <script> do sprawdzenia`);
  process.exit(1);
}

const tmpFile = join(tmpdir(), `index-inline-${Date.now()}.js`);
writeFileSync(tmpFile, inlineScripts);
let syntaxOk = true;
try {
  // --check tylko parsuje, nie wykonuje kodu. Błąd składni ląduje na stderr
  // (stdio: 'inherit').
  execFileSync(process.execPath, ['--check', tmpFile], { stdio: 'inherit' });
} catch {
  syntaxOk = false;
}
unlinkSync(tmpFile);
if (!syntaxOk) {
  console.error(`${path}: JS wewnątrz <script> nie parsuje się (patrz błąd powyżej)`);
  process.exit(1);
}

console.log(`${path}: OK (doctype, ${blocks.length} <script> w parze, JS parsuje się poprawnie)`);
