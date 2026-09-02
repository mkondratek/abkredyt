#!/usr/bin/env node
/**
 * Testy regresyjne silnika kalkulatora.
 *
 * Wyciąga zawartość <script id="engine"> z public/index.html i uruchamia ją w Node
 * (silnik jest czysty — bez DOM i bez localStorage), po czym sprawdza liczby z
 * docs/wnioski-modelu.md i CLAUDE.md.
 *
 * Uruchomienie:  node tools/test-engine.mjs
 * Zero zależności, Node >= 20.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const htmlPath = join(here, "..", "public", "index.html");
const html = readFileSync(htmlPath, "utf8");

const m = html.match(/<script id="engine">([\s\S]*?)<\/script>/);
if (!m) {
  console.error('FAIL: nie znaleziono <script id="engine"> w ' + htmlPath);
  process.exit(1);
}
// Silnik sam wystawia się na globalThis.RKM.
new Function(m[1])();
const { simulateScenario, annuity, solveMonths } = globalThis.RKM ?? {};
if (typeof simulateScenario !== "function" || typeof annuity !== "function" || typeof solveMonths !== "function") {
  console.error("FAIL: globalThis.RKM nie wystawia simulateScenario/annuity/solveMonths");
  process.exit(1);
}

/* ---------- mini-framework ---------- */
let failures = 0;
let checks = 0;
function ok(name, cond, detail) {
  checks++;
  if (cond) return;
  failures++;
  console.error("FAIL  " + name + (detail ? "  — " + detail : ""));
}
function near(name, actual, expected, tol, unit) {
  const diff = Math.abs(actual - expected);
  ok(
    name,
    diff <= tol,
    "oczekiwano " + fmt(expected) + (unit || "") + " ±" + fmt(tol) + ", jest " + fmt(actual) + (unit || "")
  );
}
function nearPct(name, actual, expected, pct) {
  near(name, actual, expected, Math.abs(expected) * pct, " zł");
}
function fmt(v) {
  return Math.abs(v) >= 100 ? Math.round(v).toString() : (Math.round(v * 100) / 100).toString();
}

/* ---------- wspólna konfiguracja ---------- */
const P = 579200;
const RATE = 5.39;

function cfg(over = {}) {
  return Object.assign(
    {
      principal: P,
      ratePct: RATE,
      years: 30,
      startDate: "2027-01-01",
      tryb: "skroc",
      feePct: 0,
      feeMonths: 0,
      gwarancja: 100000,
      ignorujRegule: false,
      events: [],
    },
    over
  );
}

/* Druga baza — okrągłe liczby dla testów reguły RKM (art. 7 ust. 1 pkt 7). */
function cfgRkm(over = {}) {
  return cfg(Object.assign({ principal: 500000, ratePct: 5.5, years: 30 }, over));
}

/* ---------- 1. rata równa (annuitet) ---------- */
const r = RATE / 100 / 12;
near("annuity 579 200 / 5,39% / 30 lat = 3 249 zł", annuity(P, r, 360), 3249, 1, " zł");
near("annuity 579 200 / 5,39% / 15 lat = 4 699 zł", annuity(P, r, 180), 4699, 1, " zł");

const s30 = simulateScenario(cfg({ years: 30 }));
const s15 = simulateScenario(cfg({ years: 15 }));
near("rata początkowa 30 lat", s30.initialRata, 3249, 1, " zł");
near("rata początkowa 15 lat", s15.initialRata, 4699, 1, " zł");

/* ---------- 2. suma odsetek bez wydarzeń ---------- */
nearPct("odsetki 30 lat ≈ 590 358 zł", s30.totalInterest, 590358, 0.005);
nearPct("odsetki 15 lat ≈ 266 585 zł", s15.totalInterest, 266585, 0.005);
ok("30 lat kończy się w m. 360", s30.payoffMonths === 360, "jest " + s30.payoffMonths);
ok("15 lat kończy się w m. 180", s15.payoffMonths === 180, "jest " + s15.payoffMonths);

/* ---------- 3. nadpłata 100 000 w m. 1: skróć vs obniż ---------- */
const nadplata100 = [{ type: "jednorazowa", month: 1, amount: 100000, trybOverride: "auto" }];
const skroc = simulateScenario(cfg({ years: 30, tryb: "skroc", ignorujRegule: true, events: nadplata100 }));
const obniz = simulateScenario(cfg({ years: 30, tryb: "obniz", ignorujRegule: true, events: nadplata100 }));
ok("nadpłata 100k m.1 / skróć → spłata w m. 243", skroc.payoffMonths === 243, "jest " + skroc.payoffMonths);
nearPct("nadpłata 100k m.1 / skróć → odsetki ≈ 309 585 zł", skroc.totalInterest, 309585, 0.005);
nearPct("nadpłata 100k m.1 / obniż → odsetki ≈ 488 767 zł", obniz.totalInterest, 488767, 0.005);
ok(
  "„skróć okres” tańsze niż „obniż ratę”",
  skroc.totalInterest < obniz.totalInterest,
  skroc.totalInterest + " vs " + obniz.totalInterest
);
ok("tryb „obniż ratę” nie skraca okresu", obniz.payoffMonths === 360, "jest " + obniz.payoffMonths);

/* ---------- 4. reguła RKM: nadpłata ponad pozostałą część gwarantowaną ----------
   Art. 7 ust. 1 pkt 7 w zw. z art. 4a ust. 6: każda spłata kapitału (rata, nadpłata,
   spłata rodzinna) zalicza się najpierw na część objętą gwarancją i ją pomniejsza,
   więc limit bezpiecznej nadpłaty dobrowolnej maleje w czasie. Okno = 36 miesięcy. */

/* 4a. 500 000 / 5,5 % / 30 lat, gwarancja 100 000. Po 12 ratach kapitał umowny zjadł
   ~6,7 tys. gwarancji → zostaje ~93 265 zł: 90 000 jest bezpieczne, 95 000 już nie. */
const g90 = simulateScenario(cfgRkm({ events: [{ type: "jednorazowa", month: 12, amount: 90000, trybOverride: "auto" }] }));
const g95 = simulateScenario(cfgRkm({ events: [{ type: "jednorazowa", month: 12, amount: 95000, trybOverride: "auto" }] }));
ok("nadpłata 90 000 w m. 12 mieści się w gwarancji", g90.rkmBreachMonth === null, "jest " + g90.rkmBreachMonth);
near("licznik nadpłat w oknie 36 mies. = 90 000 zł", g90.voluntaryOverpayWindow, 90000, 1, " zł");
ok("nadpłata 95 000 w m. 12 łamie regułę w m. 12", g95.rkmBreachMonth === 12, "jest " + g95.rkmBreachMonth);
near("pozostała część gwarantowana w m. 12 ≈ 93 265 zł", g95.rkmBreachAllowance, 93264.55, 1, " zł");
near("kwota nadpłaty zapisana przy przekroczeniu", g95.rkmBreachAmount, 95000, 1, " zł");

/* 4b. Dwie nadpłaty po 50 000 (m. 6 i m. 30): druga wypada już poza gwarancję,
   bo pierwsza nadpłata + raty kapitałowe zdążyły ją niemal wyczerpać. */
const g50x2 = simulateScenario(
  cfgRkm({
    events: [
      { type: "jednorazowa", month: 6, amount: 50000, trybOverride: "auto" },
      { type: "jednorazowa", month: 30, amount: 50000, trybOverride: "auto" },
    ],
  })
);
ok("druga nadpłata 50 000 (m. 30) łamie regułę, pierwsza nie", g50x2.rkmBreachMonth === 30, "jest " + g50x2.rkmBreachMonth);
near("pozostała część gwarantowana w m. 30 ≈ 26 642 zł", g50x2.rkmBreachAllowance, 26642.48, 1, " zł");
near("licznik nadpłat w oknie 36 mies. = 100 000 zł", g50x2.voluntaryOverpayWindow, 100000, 1, " zł");

/* 4c. Bez nadpłat reguła nie może się złamać, ale krótszy okres zjada gwarancję
   szybciej — a więc i limit na przyszłe nadpłaty w oknie 3 lat. */
const g30y = simulateScenario(cfgRkm({ years: 30 }));
const g15y = simulateScenario(cfgRkm({ years: 15 }));
ok("bez nadpłat: brak przekroczenia (30 lat)", g30y.rkmBreachMonth === null, "jest " + g30y.rkmBreachMonth);
ok("bez nadpłat: brak przekroczenia (15 lat)", g15y.rkmBreachMonth === null, "jest " + g15y.rkmBreachMonth);
ok("bez nadpłat: licznik nadpłat = 0 (15 lat)", g15y.voluntaryOverpayWindow === 0, "jest " + g15y.voluntaryOverpayWindow);
near("część gwarantowana po 3 latach, 30 lat ≈ 78 632 zł", g30y.guaranteeLeftAt36, 78632.43, 1, " zł");
near("część gwarantowana po 3 latach, 15 lat ≈ 29 966 zł", g15y.guaranteeLeftAt36, 29966.0, 1, " zł");
ok(
  "krótszy okres zostawia mniejszy limit nadpłat po 3 latach",
  g15y.guaranteeLeftAt36 < g30y.guaranteeLeftAt36,
  Math.round(g15y.guaranteeLeftAt36) + " vs " + Math.round(g30y.guaranteeLeftAt36)
);

/* 4d. Brak gwarancji (wkład ≥ 20 %) = brak limitu: łamie ją każda nadpłata. */
const g0evt = simulateScenario(cfgRkm({ gwarancja: 0, events: [{ type: "jednorazowa", month: 2, amount: 1000, trybOverride: "auto" }] }));
const g0bez = simulateScenario(cfgRkm({ gwarancja: 0 }));
ok("gwarancja 0: nadpłata 1 000 w m. 2 łamie regułę", g0evt.rkmBreachMonth === 2, "jest " + g0evt.rkmBreachMonth);
ok("gwarancja 0 bez nadpłat: brak przekroczenia", g0bez.rkmBreachMonth === null, "jest " + g0bez.rkmBreachMonth);
ok("gwarancja 0: część gwarantowana po 3 latach = 0", g0bez.guaranteeLeftAt36 === 0, "jest " + g0bez.guaranteeLeftAt36);

/* 4e. Spłata rodzinna jest wyłączona z reguły (nie łamie jej), ale pomniejsza część
   objętą gwarancją — art. 4a ust. 6 nie robi wyjątku dla źródła spłaty. */
const gDziecko = simulateScenario(
  cfgRkm({ events: [{ type: "dziecko", month: 24, amount: 60000, childNumber: 3, trybOverride: "auto" }] })
);
ok("spłata rodzinna nie łamie reguły", gDziecko.rkmBreachMonth === null, "jest " + gDziecko.rkmBreachMonth);
near("spłata rodzinna zaliczona (60 000 zł)", gDziecko.totalSplataRodzinna, 60000, 1, " zł");
near("część gwarantowana po 3 latach po spłacie rodzinnej ≈ 15 248 zł", gDziecko.guaranteeLeftAt36, 15247.96, 1, " zł");
ok(
  "spłata rodzinna pomniejsza część gwarantowaną",
  gDziecko.guaranteeLeftAt36 < g30y.guaranteeLeftAt36,
  Math.round(gDziecko.guaranteeLeftAt36) + " vs " + Math.round(g30y.guaranteeLeftAt36)
);

/* 4f. Po oknie 36 miesięcy nadpłata dowolnej wysokości jest bezpieczna. */
const gPo36 = simulateScenario(cfgRkm({ events: [{ type: "jednorazowa", month: 37, amount: 200000, trybOverride: "auto" }] }));
ok("nadpłata 200 000 w m. 37 nie łamie reguły", gPo36.rkmBreachMonth === null, "jest " + gPo36.rkmBreachMonth);
ok("nadpłata po oknie nie wchodzi do licznika 36 mies.", gPo36.voluntaryOverpayWindow === 0, "jest " + gPo36.voluntaryOverpayWindow);

/* 4g. Przekroczenie odbiera spłatę rodzinną; „ignoruj regułę” ją przywraca. */
const przekroczenie = [
  { type: "jednorazowa", month: 1, amount: 150000, trybOverride: "auto" },
  { type: "dziecko", month: 24, amount: 60000, childNumber: 3, trybOverride: "auto" },
];
const zRegula = simulateScenario(cfg({ years: 30, events: przekroczenie, ignorujRegule: false }));
const bezReguly = simulateScenario(cfg({ years: 30, events: przekroczenie, ignorujRegule: true }));

ok("nadpłata 150 000 w m. 1 łamie regułę w m. 1", zRegula.rkmBreachMonth === 1, "jest " + zRegula.rkmBreachMonth);
ok(
  "spłata rodzinna oznaczona jako utracona (eventLog: dziecko-lost)",
  zRegula.eventLog.some((l) => l.type === "dziecko-lost")
);
ok("utracona spłata rodzinna nie zmniejsza kapitału", zRegula.totalSplataRodzinna === 0, "jest " + zRegula.totalSplataRodzinna);
ok(
  "„ignoruj regułę” → spłata rodzinna zaliczona",
  bezReguly.eventLog.some((l) => l.type === "dziecko") && !bezReguly.eventLog.some((l) => l.type === "dziecko-lost")
);
near("„ignoruj regułę” → spłata rodzinna 60 000 zł", bezReguly.totalSplataRodzinna, 60000, 1, " zł");
ok(
  "utrata spłaty rodzinnej podnosi koszt odsetek",
  zRegula.totalInterest > bezReguly.totalInterest,
  zRegula.totalInterest + " vs " + bezReguly.totalInterest
);

/* ---------- 5. wyższa rata umowna (krótszy okres) nie jest nadpłatą ---------- */
/* To kluczowa reguła modelu: formalnie 15 lat płaci ~4 699 zł/mies. zamiast 3 249 zł,
   ale nadwyżka nie jest przedterminową spłatą — licznik nadpłat zostaje na 0 i reguła
   nie może się złamać. Konsekwencja (nowa): szybsza amortyzacja zjada część objętą
   gwarancją, więc limit ewentualnych nadpłat w oknie 3 lat topi się szybciej. */
const krotszyOkres = simulateScenario(
  cfg({ years: 15, events: [{ type: "dziecko", month: 24, amount: 60000, childNumber: 3, trybOverride: "auto" }] })
);
ok("15 lat: licznik nadpłat dobrowolnych = 0", krotszyOkres.voluntaryOverpayWindow === 0, "jest " + krotszyOkres.voluntaryOverpayWindow);
ok("15 lat: reguła nieprzekroczona", krotszyOkres.rkmBreachMonth === null, "jest " + krotszyOkres.rkmBreachMonth);
near("15 lat: spłata rodzinna zaliczona (60 000 zł)", krotszyOkres.totalSplataRodzinna, 60000, 1, " zł");
ok(
  "15 lat: gwarancja wyczerpana przed końcem okna 36 mies.",
  krotszyOkres.guaranteeLeftAt36 === 0,
  "jest " + krotszyOkres.guaranteeLeftAt36
);

/* Kontrola: „elastyczne 15” (30 lat + nadpłata 1 450/mies.) zużywa limit nadpłat,
   ale pojedyncza rata nadpłaty nigdy nie wychodzi poza część gwarantowaną — więc
   rozłożenie nadpłat w czasie NIE łamie reguły. */
const elastyczne15 = simulateScenario(
  cfg({ years: 30, events: [{ type: "cykliczna", startMonth: 1, endMonth: 360, monthlyAmount: 1450, trybOverride: "auto" }] })
);
ok(
  "„elastyczne 15” zużywa limit nadpłat w 36 mies. (~52 tys.)",
  elastyczne15.voluntaryOverpayWindow > 50000 && elastyczne15.voluntaryOverpayWindow < 54000,
  "jest " + Math.round(elastyczne15.voluntaryOverpayWindow)
);
ok(
  "„elastyczne 15”: rozłożone nadpłaty nie łamią reguły (mieszczą się w gwarancji)",
  elastyczne15.rkmBreachMonth === null,
  "jest " + elastyczne15.rkmBreachMonth
);
nearPct("„elastyczne 15” ≈ odsetki jak 15 lat (266 566 zł)", elastyczne15.totalInterest, 266566, 0.01);

/* ---------- 6. opłata za wcześniejszą spłatę: tylko nadpłaty dobrowolne ---------- */
const zOplata = simulateScenario(
  cfg({
    years: 30,
    feePct: 3,
    feeMonths: 36,
    ignorujRegule: true,
    events: [
      { type: "jednorazowa", month: 1, amount: 100000, trybOverride: "auto" },
      { type: "dziecko", month: 12, amount: 60000, childNumber: 3, trybOverride: "auto" },
    ],
  })
);
near("opłata 3% liczona tylko od nadpłaty 100 000 zł", zOplata.totalFees, 3000, 1, " zł");

const oplataPoOkresie = simulateScenario(
  cfg({ years: 30, feePct: 3, feeMonths: 36, ignorujRegule: true, events: [{ type: "jednorazowa", month: 37, amount: 100000, trybOverride: "auto" }] })
);
ok("po okresie opłaty nadpłata jest bezpłatna", oplataPoOkresie.totalFees === 0, "jest " + oplataPoOkresie.totalFees);

/* ---------- 7. zmiana oprocentowania przelicza ratę ---------- */
const zmiana = simulateScenario(
  cfg({ years: 30, events: [{ type: "zmiana_oprocentowania", month: 24, newRatePct: 4.5, note: "wskaźnik 2,60 % + marża 1,90 %" }] })
);
ok(
  "zmiana oprocentowania trafia do eventLog z opisem",
  zmiana.eventLog.some((l) => l.type === "rate" && l.text.includes("4.5") && l.text.includes("marża")),
  JSON.stringify(zmiana.eventLog.filter((l) => l.type === "rate"))
);
ok("spadek stopy obniża ratę", zmiana.finalRata < s30.initialRata, zmiana.finalRata + " vs " + s30.initialRata);
ok("spadek stopy obniża odsetki", zmiana.totalInterest < s30.totalInterest);

/* ---------- 8. solveMonths ---------- */
/* Math.ceil + błąd zaokrąglenia zmiennoprzecinkowego daje tu 360 albo 361 — silnik
   zaokrągla w górę celowo (lepiej jedna rata więcej niż niedopłata). */
const sm360 = solveMonths(P, r, annuity(P, r, 360));
ok("solveMonths(P, r, rata 30-letnia) ≈ 360", sm360 === 360 || sm360 === 361, String(sm360));
ok("solveMonths przy racie < odsetek = 1 (brak amortyzacji)", solveMonths(P, r, 1) === 1);

/* ---------- podsumowanie ---------- */
if (failures > 0) {
  console.error("\n" + failures + " z " + checks + " testów nie przeszło.");
  process.exit(1);
}
console.log("OK — " + checks + " testów silnika przeszło (public/index.html, <script id=\"engine\">).");
