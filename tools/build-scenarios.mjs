#!/usr/bin/env node
/**
 * Generator podstrony „Gotowe porównania” (public/scenariusze.html).
 *
 * Źródłem prawdy są tools/scenarios.json (pytania, opisy i PEŁNY stan v6 dla
 * każdej karty) oraz silnik z <script id="engine"> w public/index.html — ten sam
 * blok, który uruchamia tools/test-engine.mjs. Skrypt:
 *   1. wczytuje silnik i wystawia go jako globalThis.RKM,
 *   2. sprawdza kształt każdego stanu (odpowiednik looksLikeState z UI, tylko
 *      ostrzejszy — tu wolno zawieść build, nie użytkownika),
 *   3. liczy kilka liczb nagłówkowych przez RKM.simulateScenario,
 *   4. koduje stan tak samo jak przycisk „Kopiuj link do tego porównania”:
 *      shortenState → JSON → deflate-raw → base64url → „/#s=d.<ładunek>”,
 *   5. zapisuje public/scenariusze.html z szablonu poniżej.
 *
 * Pliku wynikowego NIE edytuje się ręcznie — tools/test-scenarios.mjs pilnuje,
 * żeby był świeży (porównanie bajt w bajt) i żeby każdy link dawał się odczytać.
 *
 * Uruchomienie:  node tools/build-scenarios.mjs
 * Zero zależności, Node >= 20.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { deflateRawSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..");
export const INDEX_PATH = join(ROOT, "public", "index.html");
export const SCENARIOS_PATH = join(here, "scenarios.json");
export const OUT_PATH = join(ROOT, "public", "scenariusze.html");

/* ============ silnik ============ */
/* Ta sama ekstrakcja co w tools/test-engine.mjs — silnik jest czysty (bez DOM
   i bez localStorage), więc wystarczy go wykonać w Node. */
export function loadEngine() {
  const html = readFileSync(INDEX_PATH, "utf8");
  const m = html.match(/<script id="engine">([\s\S]*?)<\/script>/);
  if (!m) throw new Error('nie znaleziono <script id="engine"> w ' + INDEX_PATH);
  new Function(m[1])();
  const RKM = globalThis.RKM;
  if (!RKM || typeof RKM.simulateScenario !== "function") {
    throw new Error("globalThis.RKM nie wystawia simulateScenario");
  }
  return RKM;
}

/* ============ walidacja stanu ============ */
/* Odpowiednik looksLikeScenario/looksLikeState z public/index.html (te same pola
   liczbowe, ten sam format daty), rozszerzony o kontrole, które w UI robią
   normaliseState i formularz: zakresy okresu, typy zdarzeń, tryby. Build ma
   paść, zanim niesprawny link trafi na stronę. */
const SCN_NUMS = ["cena", "wklad", "marza", "wskaznik", "years", "feePct", "feeMonths"];
const TRYBY = ["skroc", "obniz"];
const TRYB_OVERRIDES = ["skroc", "obniz", "auto"];
const EVENT_FIELDS = {
  jednorazowa: ["month", "amount"],
  cykliczna: ["startMonth", "endMonth", "monthlyAmount"],
  dziecko: ["month", "amount", "childNumber"],
  zmiana_wskaznika: ["month", "newWskaznik"]
};

function isNum(v) { return typeof v === "number" && isFinite(v); }

function validateScenario(s, where, errs) {
  if (!s || typeof s !== "object") { errs.push(where + ": nie jest obiektem"); return; }
  SCN_NUMS.forEach((k) => { if (!isNum(s[k])) errs.push(where + "." + k + ": oczekiwano liczby"); });
  if (typeof s.rkm !== "boolean") errs.push(where + ".rkm: oczekiwano true/false");
  if (typeof s.start !== "string" || !/^\d{4}-\d{2}$/.test(s.start)) errs.push(where + ".start: oczekiwano „RRRR-MM”");
  if (TRYBY.indexOf(s.tryb) < 0) errs.push(where + '.tryb: oczekiwano "skroc" albo "obniz"');
  if ("gwarancja" in s) errs.push(where + ".gwarancja: gwarancja BGK jest wyliczana, nie wpisywana");
  // Okres: w RKM ustawowe minimum 15 lat (art. 3 ust. 3 pkt 3), poza programem 5;
  // górne 35 to praktyka bankowa i granica suwaka w UI.
  const minYears = s.rkm ? 15 : 5;
  if (isNum(s.years) && (s.years < minYears || s.years > 35)) {
    errs.push(where + ".years: " + s.years + " poza zakresem " + minYears + "–35");
  }
  if (isNum(s.feeMonths) && (s.feeMonths < 0 || s.feeMonths > 36)) {
    errs.push(where + ".feeMonths: poza zakresem 0–36 (art. 40 ust. 1 u.k.h.)");
  }
  if (!Array.isArray(s.events)) { errs.push(where + ".events: oczekiwano tablicy"); return; }
  s.events.forEach((e, i) => {
    const at = where + ".events[" + i + "]";
    if (!e || typeof e !== "object" || typeof e.type !== "string") { errs.push(at + ": brak pola type"); return; }
    const fields = EVENT_FIELDS[e.type];
    if (!fields) { errs.push(at + ": nieznany typ „" + e.type + "”"); return; }
    fields.forEach((k) => { if (!isNum(e[k])) errs.push(at + "." + k + ": oczekiwano liczby"); });
    if (e.type === "dziecko" && [2, 3].indexOf(e.childNumber) < 0) errs.push(at + ".childNumber: 2 albo 3");
    if (e.trybOverride !== undefined && TRYB_OVERRIDES.indexOf(e.trybOverride) < 0) errs.push(at + ".trybOverride: skroc/obniz/auto");
    if (e.type === "cykliczna" && isNum(e.startMonth) && isNum(e.endMonth) && e.endMonth < e.startMonth) {
      errs.push(at + ": endMonth < startMonth");
    }
  });
}

export function validateState(st, RKM) {
  const errs = [];
  if (!st || typeof st !== "object") return ["stan nie jest obiektem"];
  if (st.v !== RKM.STATE_VERSION) errs.push("v: oczekiwano " + RKM.STATE_VERSION + ", jest " + st.v);
  if (!isNum(st.lokata) || st.lokata < 0) errs.push("lokata: oczekiwano liczby >= 0");
  if (["saldo", "rata"].indexOf(st.chartMode) < 0) errs.push('chartMode: "saldo" albo "rata"');
  if (["A", "B"].indexOf(st.tableScn) < 0) errs.push('tableScn: "A" albo "B"');
  validateScenario(st.A, "A", errs);
  validateScenario(st.B, "B", errs);
  return errs;
}

/* ============ stan scenariusza -> wejście silnika ============ */
/* Lustro toEngineConfig z public/index.html: stopa nominalna = marża + wskaźnik,
   gwarancja BGK wyliczana z ustawy, poza programem RKM zdarzenia „dziecko”
   nie trafiają do silnika, a opłata za gwarancję znika razem z gwarancją. */
function round2(v) { return Math.round(v * 100) / 100; }

export function toEngineConfig(s, RKM) {
  const events = (s.rkm ? s.events : s.events.filter((e) => e.type !== "dziecko")).map((e) => {
    if (e.type === "dziecko") return { type: "dziecko", month: e.month, amount: e.amount, childNumber: e.childNumber, trybOverride: e.trybOverride };
    if (e.type === "cykliczna") return { type: "cykliczna", startMonth: e.startMonth, endMonth: e.endMonth, monthlyAmount: e.monthlyAmount, trybOverride: e.trybOverride };
    if (e.type === "zmiana_wskaznika") return { type: "zmiana_oprocentowania", month: e.month, newRatePct: round2(s.marza + e.newWskaznik) };
    return { type: "jednorazowa", month: e.month, amount: e.amount, trybOverride: e.trybOverride };
  });
  const limits = { cena: s.cena, wklad: s.wklad, remont: s.remont };
  return {
    principal: Math.max(0, s.cena - s.wklad) + s.remont,
    ratePct: round2(s.marza + s.wskaznik),
    years: s.years,
    startDate: s.start + "-01",
    tryb: s.tryb,
    feePct: s.feePct,
    feeMonths: s.feeMonths,
    gwarancja: s.rkm ? RKM.gwarancjaBGK(limits) : 0,
    gwarancjaFeePct: s.rkm ? 1 : 0,
    events
  };
}

/* ============ formatowanie ============ */
/* Własne grupowanie zamiast toLocaleString: wynik ma być identyczny niezależnie
   od wersji ICU w Node, bo test porównuje plik bajt w bajt. Separator to spacja
   nierozdzielająca — tak samo jak w kalkulatorze. */
const NBSP = "\u00a0"; // spacja nierozdzielająca (U+00A0), zapisana escape'em — w kodzie jest niewidoczna
function groupPl(n) {
  const s = String(Math.abs(n));
  let out = "";
  for (let i = 0; i < s.length; i++) {
    if (i > 0 && (s.length - i) % 3 === 0) out += NBSP;
    out += s.charAt(i);
  }
  return (n < 0 ? "-" : "") + out;
}
function money(n) { return groupPl(Math.round(n)) + " zł"; }
const MONTHS_PL = ["sty", "lut", "mar", "kwi", "maj", "cze", "lip", "sie", "wrz", "paź", "lis", "gru"];
function fmtDate(d) { return d ? MONTHS_PL[d.getUTCMonth()] + " " + d.getUTCFullYear() : "—"; }

/* Liczby nagłówkowe, które karta może pokazać. Nazwy etykiet są celowo takie same
   jak w KPI kalkulatora — karta ma mówić, gdzie szukać po otwarciu linku. */
export const METRICS = {
  rataPoczatkowa: { label: "Rata początkowa", get: (r) => money(r.initialRata) },
  rataKoncowa: { label: "Rata po ostatnim wydarzeniu", get: (r) => money(r.finalRata) },
  sumaOdsetek: { label: "Suma odsetek", get: (r) => money(r.totalInterest) },
  lacznyKoszt: { label: "Łączny koszt (odsetki + opłaty)", get: (r) => money(r.totalCost) },
  dataOstatniejRaty: { label: "Data ostatniej raty", get: (r) => fmtDate(r.payoffDate) },
  splataRodzinna: { label: "Wypłacona spłata rodzinna", get: (r) => money(r.totalSplataRodzinna) },
  czescGwarantowana36: { label: "Część gwarantowana po 3 latach", get: (r) => money(r.guaranteeLeftAt36) }
};

/* ============ link #s=d.… ============ */
/* Ten sam ładunek co przycisk „Kopiuj link do tego porównania” w kalkulatorze,
   tylko deflate robi zlib zamiast CompressionStream (oba dają strumień
   deflate-raw, więc DecompressionStream w przeglądarce go odczyta). */
export function encodeLink(state, RKM) {
  const json = JSON.stringify(RKM.shortenState(state));
  const raw = deflateRawSync(Buffer.from(json, "utf8"), { level: 9 });
  return "/#s=d." + RKM.bytesToB64url(new Uint8Array(raw));
}

/* ============ szablon ============ */
function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const HEAD = `<!doctype html>
<!-- Plik generowany przez tools/build-scenarios.mjs — nie edytuj ręcznie.
     Treść kart i stany scenariuszy siedzą w tools/scenarios.json; po zmianie
     uruchom „node tools/build-scenarios.mjs”. -->
<html lang="pl">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
    <link rel="canonical" href="https://abkredyt.kondratek.pl/scenariusze" />
    <meta name="description" content="Pięć gotowych porównań kredytu hipotecznego z kalkulatora abkredyt: nadpłata a spłata rodzinna z RKM, 15 czy 30 lat, RKM przy 20 % wkładu, wzrost WIBOR-u, skrócenie okresu kontra niższa rata. Każde otwiera się w kalkulatorze jednym kliknięciem." />
    <title>Gotowe porównania — kalkulator kredytu abkredyt</title>
    <style>
      /* Paleta i typografia jak w kalkulatorze (public/index.html) — te same nazwy
         tokenów, żeby obie strony czytało się jako jedno miejsce. Podstrona nie ma
         przełącznika motywu, więc ciemna paleta jest zapisana raz, pod
         prefers-color-scheme. */
      :root {
        --bg: #eef1ec;
        --surface: #ffffff;
        --surface-2: #f5f6f1;
        --border: #c3cdb9;
        --ink: #1f2a26;
        --ink-muted: #4a5750;
        --ink-faint: #5f6c64;
        --accent-a-ink: #066049;
        --accent-a-bg: #e2f2ec;
        --accent-a-solid: #08795b;
        --on-accent: #ffffff;
        --focus: #0a8a68;
        --shadow: 0 1px 2px rgba(31, 42, 38, 0.06), 0 6px 20px -8px rgba(31, 42, 38, 0.12);
        color-scheme: light dark;
      }

      @media (prefers-color-scheme: dark) {
        :root {
          --bg: #141d19;
          --surface: #1b2622;
          --surface-2: #20302a;
          --border: #43594d;
          --ink: #eef1ec;
          --ink-muted: #b6c3bb;
          --ink-faint: #8fa398;
          --accent-a-ink: #8fe0c6;
          --accent-a-bg: #1c332b;
          --accent-a-solid: #3ea88a;
          --on-accent: #0f1714;
          --focus: #3ea88a;
          --shadow: 0 1px 2px rgba(0, 0, 0, 0.3), 0 8px 24px -8px rgba(0, 0, 0, 0.5);
        }
      }

      * { box-sizing: border-box; }

      body {
        margin: 0 auto;
        max-width: 46rem;
        padding: 1.5rem 1.25rem 4rem;
        background: var(--bg);
        color: var(--ink);
        font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
        line-height: 1.6;
      }

      a { color: inherit; }
      a:focus-visible, .btn-primary:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }

      .back { display: inline-block; font-size: 0.875rem; color: var(--ink-muted); text-decoration: none; margin-bottom: 1.5rem; }
      .back:hover { text-decoration: underline; }

      h1 { font-size: 1.75rem; letter-spacing: -0.02em; margin: 0 0 0.5rem; }
      .lede { color: var(--ink-muted); margin: 0 0 0.75rem; }
      .note { color: var(--ink-faint); font-size: 0.875rem; margin: 0 0 2rem; }

      .card {
        background: var(--surface);
        border: 1px solid var(--border);
        border-radius: 12px;
        box-shadow: var(--shadow);
        padding: 1.25rem 1.25rem 1.5rem;
        margin: 0 0 1.5rem;
      }

      .card h2 { font-size: 1.125rem; line-height: 1.4; margin: 0 0 0.75rem; }
      .card h3 {
        font-size: 0.6875rem; text-transform: uppercase; letter-spacing: 0.08em;
        color: var(--ink-faint); font-weight: 600; margin: 1.25rem 0 0.4rem;
      }
      .card p { margin: 0; }
      .why { color: var(--ink-muted); }

      .settings { list-style: none; margin: 0; padding: 0; }
      .settings li {
        font-size: 0.9375rem; padding: 0.3rem 0.6rem; border-left: 3px solid var(--border);
        background: var(--surface-2); margin-bottom: 2px;
      }
      .settings li:first-child { border-left-color: var(--accent-a-solid); }

      .numbers { display: grid; grid-template-columns: 1fr auto; gap: 0.15rem 1rem; margin: 0.75rem 0 0; font-size: 0.875rem; }
      .numbers dt { color: var(--ink-faint); }
      .numbers dd {
        margin: 0; text-align: right; white-space: nowrap;
        font-variant-numeric: tabular-nums; font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      }
      .numbers .vs { color: var(--ink-faint); }

      .cta { margin-top: 1.25rem; }
      .btn-primary {
        display: inline-block; padding: 0.55rem 1.1rem; border-radius: 8px;
        background: var(--accent-a-solid); color: var(--on-accent);
        text-decoration: none; font-weight: 600; font-size: 0.9375rem;
      }
      .btn-primary:hover { filter: brightness(1.08); }

      .look { background: var(--accent-a-bg); color: var(--accent-a-ink); border-radius: 8px; padding: 0.6rem 0.8rem; font-size: 0.9375rem; }

      footer { margin-top: 3rem; padding-top: 1.5rem; border-top: 1px solid var(--border); font-size: 0.8125rem; color: var(--ink-muted); }
      footer p { margin: 0 0 0.75rem; }
      footer nav a { margin-right: 0.5rem; }

      @media (max-width: 30rem) {
        body { padding: 1rem 0.875rem 3rem; }
        .card { padding: 1rem 1rem 1.25rem; border-radius: 10px; }
        .numbers { grid-template-columns: 1fr; gap: 0 0; }
        .numbers dd { text-align: left; margin-bottom: 0.35rem; }
      }
    </style>
  </head>
  <body>
    <a class="back" href="/">← kalkulator</a>
    <h1>Gotowe porównania</h1>
    <p class="lede">
      Pięć pytań, które ludzie zadają sobie przed podpisaniem umowy kredytowej — każde
      rozpisane na dwa scenariusze i gotowe do otwarcia w kalkulatorze.
    </p>
    <p class="note">
      Kwoty są przykładowe (mieszkanie 500 000 zł, marża 1,90 % + wskaźnik 3,60 %) — po
      otwarciu zmień je na swoje. Wyliczenia mają charakter poglądowy.
    </p>
    <main>
`;

function footer(dateLabel) {
  return `    </main>
    <footer>
      <p>
        Kalkulator ma charakter poglądowy — nie jest ofertą ani poradą finansową lub prawną.
        Zasady programu Rodzinny Kredyt Mieszkaniowy sprawdzono z tekstem jednolitym ustawy
        (Dz.U. 2024 poz. 1724) w dniu 2 września 2026 r.; nowelizacja z 2026 r.
        (Dz.U. 2026 poz. 635) nie została uwzględniona. Przed decyzją potwierdź wyliczenia
        w banku.
      </p>
      <p>Autor: Mikołaj Kondratek. Strona wygenerowana ${dateLabel}</p>
      <nav>
        <a href="/polityka-prywatnosci">Polityka prywatności</a> ·
        <a href="/pytania">Pytania i odpowiedzi</a> ·
        <a href="/zrodla">Źródła</a> ·
        <a href="https://github.com/mkondratek/abkredyt">Kod źródłowy</a> ·
        <a href="https://github.com/mkondratek/abkredyt/issues/new">Znalazłeś błąd? Zgłoś na GitHubie</a>
      </nav>
    </footer>
  </body>
</html>
`;
}

/* Data w stopce nie może pochodzić z zegara — inaczej wygenerowany plik zmieniałby
   się co dobę i test świeżości fałszywie by padał. Bierzemy ją z pliku źródłowego
   (mtime nie, bo git go nie przechowuje) — po prostu stała, aktualizowana ręcznie
   razem z treścią kart. */
const GENERATED_LABEL = "5 września 2026 r.";

/* ============ złożenie strony ============ */
export function buildHtml() {
  const RKM = loadEngine();
  const scenarios = JSON.parse(readFileSync(SCENARIOS_PATH, "utf8"));
  if (!Array.isArray(scenarios) || scenarios.length === 0) throw new Error("scenarios.json: pusta lista");

  let html = HEAD;
  scenarios.forEach((sc) => {
    ["id", "question", "why", "lookAt"].forEach((k) => {
      if (typeof sc[k] !== "string" || !sc[k].trim()) throw new Error("scenariusz „" + sc.id + "”: brak pola " + k);
    });
    if (!Array.isArray(sc.settings) || sc.settings.length < 2) throw new Error("scenariusz „" + sc.id + "”: settings musi mieć co najmniej 2 pozycje");
    const errs = validateState(sc.state, RKM);
    if (errs.length) throw new Error("scenariusz „" + sc.id + "”: niepoprawny stan\n  - " + errs.join("\n  - "));

    const resA = RKM.simulateScenario(toEngineConfig(sc.state.A, RKM));
    const resB = RKM.simulateScenario(toEngineConfig(sc.state.B, RKM));
    const metrics = Array.isArray(sc.metrics) ? sc.metrics : [];
    if (metrics.length < 2 || metrics.length > 3) throw new Error("scenariusz „" + sc.id + "”: podaj 2–3 liczby w metrics");

    html += '      <article class="card" id="' + esc(sc.id) + '">\n';
    html += "        <h2>" + esc(sc.question) + "</h2>\n";
    html += '        <p class="why">' + esc(sc.why) + "</p>\n";
    html += "        <h3>Ustawienia</h3>\n";
    html += '        <ul class="settings">\n';
    sc.settings.forEach((line) => { html += "          <li>" + esc(line) + "</li>\n"; });
    html += "        </ul>\n";
    html += '        <dl class="numbers">\n';
    metrics.forEach((key) => {
      const m = METRICS[key];
      if (!m) throw new Error("scenariusz „" + sc.id + "”: nieznana metryka „" + key + "”");
      html += "          <dt>" + esc(m.label) + "</dt>\n";
      html += "          <dd>" + esc(m.get(resA)) + ' <span class="vs">vs</span> ' + esc(m.get(resB)) + "</dd>\n";
    });
    html += "        </dl>\n";
    html += '        <p class="cta"><a class="btn-primary" href="' + esc(encodeLink(sc.state, RKM)) + '">Otwórz porównanie</a></p>\n';
    html += "        <h3>Na co patrzeć</h3>\n";
    html += '        <p class="look">' + esc(sc.lookAt) + "</p>\n";
    html += "      </article>\n";
  });
  html += footer(GENERATED_LABEL);
  return html;
}

/* Uruchomione bezpośrednio (a nie zaimportowane przez tools/test-scenarios.mjs) —
   zapisz plik. */
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const html = buildHtml();
  writeFileSync(OUT_PATH, html, "utf8");
  console.log("zapisano " + OUT_PATH + " (" + html.length + " znaków)");
}
