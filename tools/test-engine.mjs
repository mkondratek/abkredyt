#!/usr/bin/env node
/**
 * Testy regresyjne silnika kalkulatora.
 *
 * Wyciąga zawartość <script id="engine"> z public/index.html i uruchamia ją w Node
 * (silnik jest czysty — bez DOM i bez localStorage).
 *
 * Liczby oczekiwane nie są przepisane z silnika: rata bierze się z zapisanego tutaj
 * wzoru na annuitet, a sumy odsetek i miesiąc spłaty — z niezależnej, prostej
 * symulacji referencyjnej (`refSim`) napisanej w tym pliku. Silnik i referencja
 * muszą się zgadzać z tolerancją ±1 zł / ±1 mies.
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
const RKM = globalThis.RKM ?? {};
const { simulateScenario, annuity, solveMonths } = RKM;
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

/* ---------- niezależna referencja ----------
   Wzór na ratę równą zapisany tu od zera (nie przez RKM.annuity): rata taka, że
   zdyskontowana suma n rat równa się kapitałowi. Postać z potęgą w liczniku jest
   algebraicznie tożsama z tą w silniku, ale napisana niezależnie. */
function rataRef(P, r, n) {
  if (n <= 0) return P;
  if (r === 0) return P / n;
  const q = Math.pow(1 + r, n);
  return (P * r * q) / (q - 1);
}
/* Ile rat zostało przy danym saldzie i niezmienionej racie (z równania annuitetu). */
function monthsRef(balance, r, rata) {
  if (r === 0) return Math.max(1, Math.ceil(balance / rata));
  const denom = rata - r * balance;
  if (denom <= 0) return 1;
  return Math.max(1, Math.ceil(Math.log(rata / denom) / Math.log(1 + r)));
}
/* Zwykła pętla miesiąc po miesiącu: odsetki = saldo·r, kapitał = rata − odsetki,
   nadpłata zbija saldo; „skróć okres" trzyma ratę, „obniż ratę" przelicza ją ze
   wzoru na pozostałą liczbę miesięcy. Bez reguł RKM i bez opłat — te sprawdzamy
   osobno wprost na silniku. */
function refSim({ principal, ratePct, years, tryb = "skroc", oneOff = {}, monthly = null }) {
  const r = ratePct / 100 / 12;
  const n = Math.round(years * 12);
  let balance = principal;
  let rata = rataRef(principal, r, n);
  let remaining = n;
  let totalInterest = 0;
  let month = 0;
  while (balance > 0.5 && month < 900) {
    month++;
    const interest = balance * r;
    let capital = rata - interest;
    if (capital >= balance) capital = balance;
    balance -= capital;
    remaining = Math.max(0, remaining - 1);
    totalInterest += interest;

    let extra = oneOff[month] || 0;
    if (monthly && month >= monthly.from && month <= monthly.to) extra += monthly.amount;
    if (extra > 0 && balance > 0.5) {
      const amt = Math.min(extra, balance);
      balance -= amt;
      if (balance > 0.5) {
        if (tryb === "obniz") rata = rataRef(balance, r, remaining);
        else remaining = monthsRef(balance, r, rata);
      }
    }
  }
  return { totalInterest, payoffMonths: month };
}

/* ---------- wspólna konfiguracja ----------
   Kredyt ilustracyjny (taki jak domyślny w UI): 500 000 zł, 5,50 % nominalnie. */
const P = 500000;
const RATE = 5.5;
const r = RATE / 100 / 12;

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
      events: [],
    },
    over
  );
}

/* ---------- 1. rata równa (annuitet) ---------- */
near("annuity 500 000 / 5,50 % / 30 lat = wzór", annuity(P, r, 360), rataRef(P, r, 360), 0.01, " zł");
near("annuity 500 000 / 5,50 % / 25 lat = wzór", annuity(P, r, 300), rataRef(P, r, 300), 0.01, " zł");
near("annuity 500 000 / 5,50 % / 15 lat = wzór", annuity(P, r, 180), rataRef(P, r, 180), 0.01, " zł");
/* Liczby kontrolne z README/CLAUDE.md — jeśli się rozjadą, trzeba zmienić dokumentację. */
near("liczba kontrolna: 30 lat → 2 839 zł", annuity(P, r, 360), 2839, 1, " zł");
near("liczba kontrolna: 25 lat → 3 070 zł", annuity(P, r, 300), 3070, 1, " zł");
near("liczba kontrolna: 15 lat → 4 085 zł", annuity(P, r, 180), 4085, 1, " zł");

const s30 = simulateScenario(cfg({ years: 30 }));
const s25 = simulateScenario(cfg({ years: 25 }));
const s15 = simulateScenario(cfg({ years: 15 }));
near("rata początkowa 30 lat", s30.initialRata, rataRef(P, r, 360), 1, " zł");
near("rata początkowa 25 lat", s25.initialRata, rataRef(P, r, 300), 1, " zł");
near("rata początkowa 15 lat", s15.initialRata, rataRef(P, r, 180), 1, " zł");

/* ---------- 2. suma odsetek bez wydarzeń = referencja ---------- */
const ref30 = refSim({ principal: P, ratePct: RATE, years: 30 });
const ref15 = refSim({ principal: P, ratePct: RATE, years: 15 });
near("odsetki 30 lat = referencja", s30.totalInterest, ref30.totalInterest, 1, " zł");
near("odsetki 15 lat = referencja", s15.totalInterest, ref15.totalInterest, 1, " zł");
ok("30 lat kończy się w m. 360", s30.payoffMonths === 360, "jest " + s30.payoffMonths);
ok("15 lat kończy się w m. 180", s15.payoffMonths === 180, "jest " + s15.payoffMonths);

/* ---------- 3. nadpłata 100 000 w m. 1: skróć vs obniż ---------- */
const nadplata100 = [{ type: "jednorazowa", month: 1, amount: 100000, trybOverride: "auto" }];
const skroc = simulateScenario(cfg({ years: 30, tryb: "skroc", events: nadplata100 }));
const obniz = simulateScenario(cfg({ years: 30, tryb: "obniz", events: nadplata100 }));
const refSkroc = refSim({ principal: P, ratePct: RATE, years: 30, tryb: "skroc", oneOff: { 1: 100000 } });
const refObniz = refSim({ principal: P, ratePct: RATE, years: 30, tryb: "obniz", oneOff: { 1: 100000 } });
near("nadpłata 100k m.1 / skróć → odsetki = referencja", skroc.totalInterest, refSkroc.totalInterest, 1, " zł");
near("nadpłata 100k m.1 / skróć → miesiąc spłaty = referencja", skroc.payoffMonths, refSkroc.payoffMonths, 1, " mies.");
near("nadpłata 100k m.1 / obniż → odsetki = referencja", obniz.totalInterest, refObniz.totalInterest, 1, " zł");
near("nadpłata 100k m.1 / obniż → miesiąc spłaty = referencja", obniz.payoffMonths, refObniz.payoffMonths, 1, " mies.");
ok(
  "„skróć okres” tańsze niż „obniż ratę”",
  skroc.totalInterest < obniz.totalInterest,
  Math.round(skroc.totalInterest) + " vs " + Math.round(obniz.totalInterest)
);
ok("tryb „obniż ratę” nie skraca okresu", obniz.payoffMonths === 360, "jest " + obniz.payoffMonths);

/* Nadpłata cykliczna też musi się zgadzać z referencją. */
const cyk = simulateScenario(
  cfg({ years: 30, events: [{ type: "cykliczna", startMonth: 1, endMonth: 360, monthlyAmount: 1000, trybOverride: "auto" }] })
);
const refCyk = refSim({ principal: P, ratePct: RATE, years: 30, monthly: { from: 1, to: 360, amount: 1000 } });
near("nadpłata 1 000 zł/mies. → odsetki = referencja", cyk.totalInterest, refCyk.totalInterest, 1, " zł");
near("nadpłata 1 000 zł/mies. → miesiąc spłaty = referencja", cyk.payoffMonths, refCyk.payoffMonths, 1, " mies.");

/* ---------- 4. reguła RKM: nadpłata ponad pozostałą część gwarantowaną ----------
   Art. 7 ust. 1 pkt 7 w zw. z art. 4a ust. 6: każda spłata kapitału (rata, nadpłata,
   spłata rodzinna) zalicza się najpierw na część objętą gwarancją i ją pomniejsza,
   więc limit bezpiecznej nadpłaty dobrowolnej maleje w czasie. Okno = 36 miesięcy.
   Reguła obowiązuje bezwarunkowo — nie ma już przełącznika „ignoruj regułę". */

/* 4a. 500 000 / 5,5 % / 30 lat, gwarancja 100 000. Po 12 ratach kapitał umowny zjadł
   ~6,7 tys. gwarancji → zostaje ~93 265 zł: 90 000 jest bezpieczne, 95 000 już nie. */
const g90 = simulateScenario(cfg({ events: [{ type: "jednorazowa", month: 12, amount: 90000, trybOverride: "auto" }] }));
const g95 = simulateScenario(cfg({ events: [{ type: "jednorazowa", month: 12, amount: 95000, trybOverride: "auto" }] }));
ok("nadpłata 90 000 w m. 12 mieści się w gwarancji", g90.rkmBreachMonth === null, "jest " + g90.rkmBreachMonth);
near("licznik nadpłat w oknie 36 mies. = 90 000 zł", g90.voluntaryOverpayWindow, 90000, 1, " zł");
ok("nadpłata 95 000 w m. 12 łamie regułę w m. 12", g95.rkmBreachMonth === 12, "jest " + g95.rkmBreachMonth);
near("pozostała część gwarantowana w m. 12 ≈ 93 265 zł", g95.rkmBreachAllowance, 93264.55, 1, " zł");
near("kwota nadpłaty zapisana przy przekroczeniu", g95.rkmBreachAmount, 95000, 1, " zł");

/* 4b. Dwie nadpłaty po 50 000 (m. 6 i m. 30): druga wypada już poza gwarancję,
   bo pierwsza nadpłata + raty kapitałowe zdążyły ją niemal wyczerpać. */
const g50x2 = simulateScenario(
  cfg({
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
ok("bez nadpłat: brak przekroczenia (30 lat)", s30.rkmBreachMonth === null, "jest " + s30.rkmBreachMonth);
ok("bez nadpłat: brak przekroczenia (15 lat)", s15.rkmBreachMonth === null, "jest " + s15.rkmBreachMonth);
ok("bez nadpłat: licznik nadpłat = 0 (15 lat)", s15.voluntaryOverpayWindow === 0, "jest " + s15.voluntaryOverpayWindow);
near("część gwarantowana po 3 latach, 30 lat ≈ 78 632 zł", s30.guaranteeLeftAt36, 78632.43, 1, " zł");
near("część gwarantowana po 3 latach, 15 lat ≈ 29 966 zł", s15.guaranteeLeftAt36, 29966.0, 1, " zł");
ok(
  "krótszy okres zostawia mniejszy limit nadpłat po 3 latach",
  s15.guaranteeLeftAt36 < s30.guaranteeLeftAt36,
  Math.round(s15.guaranteeLeftAt36) + " vs " + Math.round(s30.guaranteeLeftAt36)
);

/* 4d. Brak gwarancji (wkład ≥ 20 %) = brak limitu: łamie ją każda nadpłata. */
const g0evt = simulateScenario(cfg({ gwarancja: 0, events: [{ type: "jednorazowa", month: 2, amount: 1000, trybOverride: "auto" }] }));
const g0bez = simulateScenario(cfg({ gwarancja: 0 }));
ok("gwarancja 0: nadpłata 1 000 w m. 2 łamie regułę", g0evt.rkmBreachMonth === 2, "jest " + g0evt.rkmBreachMonth);
ok("gwarancja 0 bez nadpłat: brak przekroczenia", g0bez.rkmBreachMonth === null, "jest " + g0bez.rkmBreachMonth);
ok("gwarancja 0: część gwarantowana po 3 latach = 0", g0bez.guaranteeLeftAt36 === 0, "jest " + g0bez.guaranteeLeftAt36);

/* 4e. Spłata rodzinna jest wyłączona z reguły (nie łamie jej), ale pomniejsza część
   objętą gwarancją — art. 4a ust. 6 nie robi wyjątku dla źródła spłaty. */
const gDziecko = simulateScenario(
  cfg({ events: [{ type: "dziecko", month: 24, amount: 60000, childNumber: 3, trybOverride: "auto" }] })
);
ok("spłata rodzinna nie łamie reguły", gDziecko.rkmBreachMonth === null, "jest " + gDziecko.rkmBreachMonth);
near("spłata rodzinna zaliczona (60 000 zł)", gDziecko.totalSplataRodzinna, 60000, 1, " zł");
near("część gwarantowana po 3 latach po spłacie rodzinnej ≈ 15 248 zł", gDziecko.guaranteeLeftAt36, 15247.96, 1, " zł");
ok(
  "spłata rodzinna pomniejsza część gwarantowaną",
  gDziecko.guaranteeLeftAt36 < s30.guaranteeLeftAt36,
  Math.round(gDziecko.guaranteeLeftAt36) + " vs " + Math.round(s30.guaranteeLeftAt36)
);

/* 4f. Po oknie 36 miesięcy nadpłata dowolnej wysokości jest bezpieczna. */
const gPo36 = simulateScenario(cfg({ events: [{ type: "jednorazowa", month: 37, amount: 200000, trybOverride: "auto" }] }));
ok("nadpłata 200 000 w m. 37 nie łamie reguły", gPo36.rkmBreachMonth === null, "jest " + gPo36.rkmBreachMonth);
ok("nadpłata po oknie nie wchodzi do licznika 36 mies.", gPo36.voluntaryOverpayWindow === 0, "jest " + gPo36.voluntaryOverpayWindow);

/* 4g. Przekroczenie odbiera przyszłą spłatę rodzinną — i to bezwarunkowo.
   Dowód, że utracona spłata w ogóle nie dotyka kapitału: ten sam scenariusz bez
   zdarzenia „dziecko" daje identyczne odsetki i identyczny miesiąc spłaty. */
const dziecko3 = { type: "dziecko", month: 24, amount: 60000, childNumber: 3, trybOverride: "auto" };
const zPrzekroczeniem = simulateScenario(cfg({ years: 30, events: [{ type: "jednorazowa", month: 1, amount: 150000, trybOverride: "auto" }, dziecko3] }));
const samaNadplata = simulateScenario(cfg({ years: 30, events: [{ type: "jednorazowa", month: 1, amount: 150000, trybOverride: "auto" }] }));
ok("nadpłata 150 000 w m. 1 łamie regułę w m. 1", zPrzekroczeniem.rkmBreachMonth === 1, "jest " + zPrzekroczeniem.rkmBreachMonth);
ok(
  "spłata rodzinna oznaczona jako utracona (eventLog: dziecko-lost)",
  zPrzekroczeniem.eventLog.some((l) => l.type === "dziecko-lost")
);
ok("utracona spłata rodzinna nie zmniejsza kapitału", zPrzekroczeniem.totalSplataRodzinna === 0, "jest " + zPrzekroczeniem.totalSplataRodzinna);
near("utracona spłata = jak gdyby zdarzenia nie było (odsetki)", zPrzekroczeniem.totalInterest, samaNadplata.totalInterest, 0.01, " zł");
ok(
  "utracona spłata = jak gdyby zdarzenia nie było (miesiąc spłaty)",
  zPrzekroczeniem.payoffMonths === samaNadplata.payoffMonths,
  zPrzekroczeniem.payoffMonths + " vs " + samaNadplata.payoffMonths
);

/* A dla kontrastu: nadpłata mieszcząca się w gwarancji zostawia spłatę rodzinną,
   która realnie zbija kapitał (mniej odsetek niż bez niej). */
const wLimicie = simulateScenario(cfg({ years: 30, events: [{ type: "jednorazowa", month: 1, amount: 90000, trybOverride: "auto" }, dziecko3] }));
const wLimicieBez = simulateScenario(cfg({ years: 30, events: [{ type: "jednorazowa", month: 1, amount: 90000, trybOverride: "auto" }] }));
ok("nadpłata 90 000 w m. 1 nie łamie reguły", wLimicie.rkmBreachMonth === null, "jest " + wLimicie.rkmBreachMonth);
near("spłata rodzinna zaliczona przy nadpłacie w limicie", wLimicie.totalSplataRodzinna, 60000, 1, " zł");
ok(
  "zaliczona spłata rodzinna obniża odsetki",
  wLimicie.totalInterest < wLimicieBez.totalInterest,
  Math.round(wLimicie.totalInterest) + " vs " + Math.round(wLimicieBez.totalInterest)
);

/* ---------- 5. wyższa rata umowna (krótszy okres) nie jest nadpłatą ---------- */
/* To kluczowa reguła modelu: formalnie 15 lat płaci ~4 085 zł/mies. zamiast 2 839 zł,
   ale nadwyżka nie jest przedterminową spłatą — licznik nadpłat zostaje na 0 i reguła
   nie może się złamać. Konsekwencja: szybsza amortyzacja zjada część objętą
   gwarancją, więc limit ewentualnych nadpłat w oknie 3 lat topi się szybciej. */
const krotszyOkres = simulateScenario(cfg({ years: 15, events: [dziecko3] }));
ok("15 lat: licznik nadpłat dobrowolnych = 0", krotszyOkres.voluntaryOverpayWindow === 0, "jest " + krotszyOkres.voluntaryOverpayWindow);
ok("15 lat: reguła nieprzekroczona", krotszyOkres.rkmBreachMonth === null, "jest " + krotszyOkres.rkmBreachMonth);
near("15 lat: spłata rodzinna zaliczona (60 000 zł)", krotszyOkres.totalSplataRodzinna, 60000, 1, " zł");
ok(
  "15 lat: mniejszy zapas gwarancji po 36 mies. niż przy 30 latach",
  krotszyOkres.guaranteeLeftAt36 < s30.guaranteeLeftAt36,
  Math.round(krotszyOkres.guaranteeLeftAt36) + " vs " + Math.round(s30.guaranteeLeftAt36)
);

/* Kontrola: „elastyczne 15” (30 lat + nadpłata równa różnicy rat 15 i 30 lat)
   zużywa limit nadpłat, ale pojedyncza rata nadpłaty nigdy nie wychodzi poza część
   gwarantowaną — więc rozłożenie nadpłat w czasie NIE łamie reguły. */
const dopłata = Math.round(rataRef(P, r, 180) - rataRef(P, r, 360)); // ≈ 1 246 zł
const elastyczne15 = simulateScenario(
  cfg({ years: 30, events: [{ type: "cykliczna", startMonth: 1, endMonth: 360, monthlyAmount: dopłata, trybOverride: "auto" }] })
);
const refElastyczne = refSim({ principal: P, ratePct: RATE, years: 30, monthly: { from: 1, to: 360, amount: dopłata } });
near("„elastyczne 15”: odsetki = referencja", elastyczne15.totalInterest, refElastyczne.totalInterest, 1, " zł");
near("„elastyczne 15”: miesiąc spłaty = referencja", elastyczne15.payoffMonths, refElastyczne.payoffMonths, 1, " mies.");
near("„elastyczne 15”: licznik nadpłat w 36 mies. = 36 × dopłata", elastyczne15.voluntaryOverpayWindow, 36 * dopłata, 1, " zł");
ok(
  "„elastyczne 15”: rozłożone nadpłaty nie łamią reguły (mieszczą się w gwarancji)",
  elastyczne15.rkmBreachMonth === null,
  "jest " + elastyczne15.rkmBreachMonth
);
nearPct("„elastyczne 15” ≈ odsetki jak 15 lat", elastyczne15.totalInterest, ref15.totalInterest, 0.01);

/* ---------- 6. opłata za wcześniejszą spłatę: tylko nadpłaty dobrowolne ---------- */
const zOplata = simulateScenario(
  cfg({
    years: 30,
    feePct: 3,
    feeMonths: 36,
    events: [
      { type: "jednorazowa", month: 1, amount: 100000, trybOverride: "auto" },
      { type: "dziecko", month: 12, amount: 60000, childNumber: 3, trybOverride: "auto" },
    ],
  })
);
near("opłata 3% liczona tylko od nadpłaty 100 000 zł", zOplata.totalFees, 3000, 1, " zł");

const oplataPoOkresie = simulateScenario(
  cfg({ years: 30, feePct: 3, feeMonths: 36, events: [{ type: "jednorazowa", month: 37, amount: 100000, trybOverride: "auto" }] })
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
near("solveMonths = referencja (saldo 300 000, rata 30-letnia)", solveMonths(300000, r, annuity(P, r, 360)), monthsRef(300000, r, annuity(P, r, 360)), 1, " mies.");

/* ---------- 9. kodek stanu do linku (#s=…) ---------- */
/* Warstwa przenośna: skracanie kluczy + base64url. Kompresja (deflate-raw) siedzi
   w UI i nie jest tu testowana; format „j." (bez kompresji) przechodzi przez te
   same mapy kluczy, więc round trip pokrywa jedno i drugie. */
const { STATE_VERSION, shortenState, expandState, encodeStateJson, decodeStateJson, bytesToB64url, b64urlToBytes } = RKM;
ok("kodek jest wystawiony na RKM", [STATE_VERSION, shortenState, expandState, encodeStateJson, decodeStateJson].every((v) => v !== undefined));
ok("wersja stanu = 4", STATE_VERSION === 4, "jest " + STATE_VERSION);

const sampleState = {
  v: STATE_VERSION,
  rkmOn: true,
  chartMode: "rata",
  tableScn: "B",
  A: {
    cena: 500000, wklad: 0, gwarancja: 100000, remont: 25000,
    marza: 1.9, wskaznik: 3.6, start: "2027-03", tryb: "skroc",
    feePct: 3, feeMonths: 36, years: 30,
    events: [
      { id: "x1", type: "cykliczna", startMonth: 1, endMonth: 360, monthlyAmount: 500, trybOverride: "auto" },
      { id: "x2", type: "jednorazowa", month: 37, amount: 50000, trybOverride: "obniz" },
      { id: "x3", type: "zmiana_wskaznika", month: 24, newWskaznik: 2.6 },
    ],
  },
  B: {
    cena: 500000, wklad: 60000, gwarancja: 0, remont: 0,
    marza: 2.1, wskaznik: 3.6, start: "2026-12", tryb: "obniz",
    feePct: 0, feeMonths: 0, years: 25,
    events: [{ id: "y1", type: "dziecko", month: 24, amount: 20000, childNumber: 2, trybOverride: "auto" }],
  },
};

const roundTrip = decodeStateJson(encodeStateJson(sampleState));
function stripIds(st) {
  const clone = JSON.parse(JSON.stringify(st));
  ["A", "B"].forEach((k) => clone[k].events.forEach((e) => { delete e.id; }));
  return clone;
}
ok(
  "round trip stanu przez link odtwarza wszystkie pola (poza id zdarzeń)",
  JSON.stringify(stripIds(roundTrip)) === JSON.stringify(stripIds(sampleState)),
  JSON.stringify(stripIds(roundTrip))
);
ok(
  "id zdarzeń są nadawane od nowa i unikalne",
  (() => {
    const ids = roundTrip.A.events.concat(roundTrip.B.events).map((e) => e.id);
    return ids.every((i) => typeof i === "string" && i.length > 0) && new Set(ids).size === ids.length;
  })()
);
ok("skrócone klucze są jednoznakowe", Object.keys(shortenState(sampleState)).every((k) => k.length === 1));
ok(
  "skrócony stan nie zawiera id zdarzeń",
  JSON.stringify(shortenState(sampleState)).indexOf('"x1"') < 0
);
ok("base64url nie zawiera + / =", /^[A-Za-z0-9_-]+$/.test(encodeStateJson(sampleState)));
ok("uszkodzony ładunek zwraca null, nie wyjątek", decodeStateJson("nie-jest-base64-json!!") === null);
ok("pusty ładunek zwraca null", decodeStateJson("") === null);
ok(
  "bytesToB64url / b64urlToBytes są odwrotne dla dowolnych bajtów",
  (() => {
    const bytes = new Uint8Array(257);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 7 + 3) % 256;
    const back = b64urlToBytes(bytesToB64url(bytes));
    return back.length === bytes.length && bytes.every((b, i) => back[i] === b);
  })()
);
ok(
  "expandState zwraca null dla nie-obiektu",
  expandState(null) === null && expandState("x") === null
);

/* ---------- podsumowanie ---------- */
if (failures > 0) {
  console.error("\n" + failures + " z " + checks + " testów nie przeszło.");
  process.exit(1);
}
console.log("OK — " + checks + " testów silnika przeszło (public/index.html, <script id=\"engine\">).");
