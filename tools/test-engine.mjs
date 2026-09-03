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
/* Zwykła pętla miesiąc po miesiącu, napisana tu od zera — pełny model, żeby liczby
   oczekiwane w testach nie były przepisane z silnika:
     • odsetki = saldo·r, kapitał = rata − odsetki, nadpłata zbija saldo;
       „skróć okres" trzyma ratę, „obniż ratę" przelicza ją na pozostałe miesiące,
     • `rates` = {miesiąc: nowa stopa nominalna %} — obowiązuje OD tego miesiąca,
       rata przeliczana od razu (jeszcze przed naliczeniem odsetek tego miesiąca),
     • opłata za wcześniejszą spłatę = feePct od min(kwota, saldo), tylko w oknie
       feeMonths i tylko od nadpłat dobrowolnych,
     • reguła RKM: część gwarantowana startuje z min(gwarancja, kapitał) i maleje
       o KAŻDĄ spłatę kapitału (rata, nadpłata, spłata rodzinna), nigdy nie przekracza
       salda; przekroczenie = nadpłata dobrowolna > pozostała część w oknie 36 mies.;
       po przekroczeniu przyszłe spłaty rodzinne przepadają.
   `oneOff` i `extras` różnią się tym, że `extras[m]` to LISTA nadpłat w jednym
   miesiącu (do testu kolejności zdarzeń). */
function refSim(o) {
  const tryb = o.tryb || "skroc";
  const oneOff = o.oneOff || {};
  const extras = o.extras || {};
  const monthly = o.monthly || null;
  const rates = o.rates || {};
  const children = o.children || [];
  const feePct = o.feePct || 0;
  const feeMonths = o.feeMonths || 0;
  const principal = Math.max(0, o.principal);
  const gwarancja = Math.min(Math.max(0, o.gwarancja || 0), principal);

  let r = o.ratePct / 100 / 12;
  const n = Math.max(1, Math.round(o.years * 12));
  let balance = principal;
  let rata = rataRef(principal, r, n);
  let remaining = n;
  let guarantee = Math.min(gwarancja, balance);
  let guaranteeAt36 = guarantee;
  let totalInterest = 0, totalFees = 0, voluntary = 0, splataRodzinna = 0;
  let breachMonth = null, breachAllowanceAtStart = 0, breachMonthTotal = 0;
  const lostChildren = [], childrenAfterPayoff = [];
  let initialRata = rata;
  let month = 0;

  while (balance > 0.5 && month < 900) {
    month++;
    if (rates[month] !== undefined) {
      r = rates[month] / 100 / 12;
      rata = rataRef(balance, r, remaining);
    }
    const interest = balance * r;
    let capital = rata - interest;
    let payment = rata;
    if (capital >= balance) { capital = balance; payment = balance + interest; }
    balance -= capital;
    guarantee = Math.min(Math.max(0, guarantee - capital), balance);
    remaining = Math.max(0, remaining - 1);
    totalInterest += interest;
    if (month === 1) initialRata = payment;

    const allowanceAtMonthStart = guarantee;
    let monthVoluntary = 0;
    let list = [];
    if (oneOff[month]) list.push(oneOff[month]);
    if (extras[month]) list = list.concat(extras[month]);
    if (monthly && month >= monthly.from && month <= monthly.to) list.push(monthly.amount);
    list.forEach((raw) => {
      if (balance <= 0.5) return;
      const amt = Math.min(Math.max(0, raw), balance);
      if (amt <= 0) return;
      if (month <= 36) {
        voluntary += amt;
        if (amt - guarantee > 0.005 && breachMonth === null) breachMonth = month;
      }
      guarantee = Math.min(Math.max(0, guarantee - amt), balance - amt);
      if (month <= feeMonths) totalFees += amt * (feePct / 100);
      balance -= amt;
      monthVoluntary += amt;
      if (balance > 0.5) {
        if (tryb === "obniz") rata = rataRef(balance, r, remaining);
        else remaining = monthsRef(balance, r, rata);
      }
    });
    if (breachMonth === month) { breachMonthTotal = monthVoluntary; breachAllowanceAtStart = allowanceAtMonthStart; }

    children.filter((c) => c.month === month).forEach((c) => {
      if (balance <= 0.5) { childrenAfterPayoff.push(c.childNumber); return; }
      if (breachMonth !== null && month >= breachMonth) { lostChildren.push(c.childNumber); return; }
      const amt = Math.min(c.amount, balance);
      balance -= amt;
      splataRodzinna += amt;
      guarantee = Math.min(Math.max(0, guarantee - amt), balance);
      if (amt > 0 && balance > 0.5) {
        if (tryb === "obniz") rata = rataRef(balance, r, remaining);
        else remaining = monthsRef(balance, r, rata);
      }
    });

    if (month <= 36) guaranteeAt36 = guarantee;
    if (balance <= 0.5) break;
  }
  const paidOff = balance <= 0.5;
  children.filter((c) => c.month > month).forEach((c) => { if (paidOff) childrenAfterPayoff.push(c.childNumber); });

  return {
    totalInterest, totalFees, payoffMonths: month, paidOff, initialRata,
    voluntary, splataRodzinna, guaranteeLeftAt36: guaranteeAt36,
    breachMonth, breachAllowanceAtStart, breachMonthTotal,
    lostChildren, childrenAfterPayoff, guaranteeStart: gwarancja,
  };
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
/* Ten sam kredyt w referencji — do porównań liczbowych zamiast stałych wpisanych
   z palca (te stałe brały się z silnika, więc nie były niezależną kontrolą). */
function ref(over = {}) {
  return refSim(Object.assign({ principal: P, ratePct: RATE, years: 30, gwarancja: 100000 }, over));
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
   ~6,7 tys. gwarancji → zostaje ~93 tys.: 90 000 jest bezpieczne, 95 000 już nie.
   Dokładną kwotę bierzemy z referencji, nie z silnika. */
const g90 = simulateScenario(cfg({ events: [{ type: "jednorazowa", month: 12, amount: 90000, trybOverride: "auto" }] }));
const g95 = simulateScenario(cfg({ events: [{ type: "jednorazowa", month: 12, amount: 95000, trybOverride: "auto" }] }));
const g90ref = ref({ oneOff: { 12: 90000 } });
const g95ref = ref({ oneOff: { 12: 95000 } });
ok("nadpłata 90 000 w m. 12 mieści się w gwarancji", g90.rkmBreachMonth === null, "jest " + g90.rkmBreachMonth);
ok("referencja też nie widzi przekroczenia przy 90 000", g90ref.breachMonth === null, "jest " + g90ref.breachMonth);
near("licznik nadpłat w oknie 36 mies. = referencja", g90.voluntaryOverpayWindow, g90ref.voluntary, 1, " zł");
ok("nadpłata 95 000 w m. 12 łamie regułę w m. 12", g95.rkmBreachMonth === 12, "jest " + g95.rkmBreachMonth);
ok("referencja wskazuje ten sam miesiąc przekroczenia", g95ref.breachMonth === 12, "jest " + g95ref.breachMonth);
near("pozostała część gwarantowana w m. 12 = referencja", g95.rkmBreachAllowance, g95ref.breachAllowanceAtStart, 1, " zł");
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
const g50x2ref = ref({ oneOff: { 6: 50000, 30: 50000 } });
ok("druga nadpłata 50 000 (m. 30) łamie regułę, pierwsza nie", g50x2.rkmBreachMonth === 30, "jest " + g50x2.rkmBreachMonth);
ok("referencja: przekroczenie też w m. 30", g50x2ref.breachMonth === 30, "jest " + g50x2ref.breachMonth);
near("pozostała część gwarantowana w m. 30 = referencja", g50x2.rkmBreachAllowance, g50x2ref.breachAllowanceAtStart, 1, " zł");
near("licznik nadpłat w oknie 36 mies. = referencja", g50x2.voluntaryOverpayWindow, g50x2ref.voluntary, 1, " zł");

/* 4c. Bez nadpłat reguła nie może się złamać, ale krótszy okres zjada gwarancję
   szybciej — a więc i limit na przyszłe nadpłaty w oknie 3 lat. */
ok("bez nadpłat: brak przekroczenia (30 lat)", s30.rkmBreachMonth === null, "jest " + s30.rkmBreachMonth);
ok("bez nadpłat: brak przekroczenia (15 lat)", s15.rkmBreachMonth === null, "jest " + s15.rkmBreachMonth);
ok("bez nadpłat: licznik nadpłat = 0 (15 lat)", s15.voluntaryOverpayWindow === 0, "jest " + s15.voluntaryOverpayWindow);
near("część gwarantowana po 3 latach, 30 lat = referencja", s30.guaranteeLeftAt36, ref({ years: 30 }).guaranteeLeftAt36, 1, " zł");
near("część gwarantowana po 3 latach, 15 lat = referencja", s15.guaranteeLeftAt36, ref({ years: 15 }).guaranteeLeftAt36, 1, " zł");
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
const gDzieckoRef = ref({ children: [{ month: 24, amount: 60000, childNumber: 3 }] });
ok("spłata rodzinna nie łamie reguły", gDziecko.rkmBreachMonth === null, "jest " + gDziecko.rkmBreachMonth);
near("spłata rodzinna zaliczona (60 000 zł)", gDziecko.totalSplataRodzinna, gDzieckoRef.splataRodzinna, 1, " zł");
near("część gwarantowana po 3 latach po spłacie rodzinnej = referencja", gDziecko.guaranteeLeftAt36, gDzieckoRef.guaranteeLeftAt36, 1, " zł");
near("odsetki ze spłatą rodzinną = referencja", gDziecko.totalInterest, gDzieckoRef.totalInterest, 1, " zł");
near("miesiąc spłaty ze spłatą rodzinną = referencja", gDziecko.payoffMonths, gDzieckoRef.payoffMonths, 1, " mies.");
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

/* Opłata liczy się od kwoty FAKTYCZNIE spłaconej, czyli min(nadpłata, saldo) —
   nadpłata większa od salda nie generuje opłaty od nadwyżki. */
const oplataOdSalda = simulateScenario(
  cfg({ years: 30, feePct: 3, feeMonths: 36, events: [{ type: "jednorazowa", month: 1, amount: 5000000, trybOverride: "auto" }] })
);
const oplataOdSaldaRef = ref({ oneOff: { 1: 5000000 }, feePct: 3, feeMonths: 36 });
const saldoPoPierwszejRacie = P - (rataRef(P, r, 360) - P * r);
near("opłata 3 % od min(nadpłata, saldo) = wzór", oplataOdSalda.totalFees, 0.03 * saldoPoPierwszejRacie, 1, " zł");
near("opłata 3 % od min(nadpłata, saldo) = referencja", oplataOdSalda.totalFees, oplataOdSaldaRef.totalFees, 1, " zł");
ok(
  "opłata nie jest liczona od kwoty wpisanej (5 mln), tylko od salda",
  oplataOdSalda.totalFees < 0.03 * 5000000 * 0.2,
  "jest " + Math.round(oplataOdSalda.totalFees)
);
near("nadpłata większa od salda kończy kredyt w m. 1", oplataOdSalda.payoffMonths, 1, 0, " mies.");

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

/* Cała symulacja ze zmianą stopy musi się zgadzać z referencją, nie tylko kierunek. */
const zmianaRef = ref({ rates: { 24: 4.5 } });
near("zmiana stopy w m. 24: odsetki = referencja", zmiana.totalInterest, zmianaRef.totalInterest, 1, " zł");
near("zmiana stopy w m. 24: miesiąc spłaty = referencja", zmiana.payoffMonths, zmianaRef.payoffMonths, 1, " mies.");

/* Zmiana obowiązuje DOKŁADNIE od wskazanego miesiąca: odsetki m. 24 liczone są już
   nową stopą (od salda po m. 23), a odsetki m. 23 — jeszcze starą. */
const rOld = RATE / 100 / 12, rNew = 4.5 / 100 / 12;
const mo = zmiana.months;
near("odsetki m. 23 wg starej stopy", mo[22].odsetki, mo[21].saldo * rOld, 0.01, " zł");
near("odsetki m. 24 wg nowej stopy", mo[23].odsetki, mo[22].saldo * rNew, 0.01, " zł");
ok("stara stopa nie obowiązuje już w m. 24", Math.abs(mo[23].odsetki - mo[22].saldo * rOld) > 1, String(mo[23].odsetki));

/* Zmiana w 1. miesiącu: rata początkowa musi być TĄ nową — pierwotna nigdy nie
   została zapłacona. Wykres rat czyta `rataHistory`, więc jej pierwszy punkt też. */
const zmianaM1 = simulateScenario(cfg({ years: 30, events: [{ type: "zmiana_oprocentowania", month: 1, newRatePct: 3.5 }] }));
const zmianaM1Ref = ref({ rates: { 1: 3.5 } });
near("zmiana stopy w m. 1 → rata początkowa wg nowej stopy", zmianaM1.initialRata, rataRef(P, 3.5 / 100 / 12, 360), 1, " zł");
near("zmiana stopy w m. 1 → rata początkowa = referencja", zmianaM1.initialRata, zmianaM1Ref.initialRata, 1, " zł");
near("zmiana stopy w m. 1 → pierwszy punkt wykresu rat = rata początkowa", zmianaM1.rataHistory[0].rata, zmianaM1.initialRata, 0.01, " zł");
ok(
  "zmiana stopy w m. 1 nie zostawia raty widmo w historii rat",
  zmianaM1.rataHistory.every((h) => Math.abs(h.rata - zmianaM1.initialRata) < 0.01),
  JSON.stringify(zmianaM1.rataHistory)
);
near("zmiana stopy w m. 1: odsetki = referencja", zmianaM1.totalInterest, zmianaM1Ref.totalInterest, 1, " zł");

/* ---------- 7b. baza „bez nadpłat" zostawia zmiany stopy ----------
   KPI „oszczędność odsetek" porównuje scenariusz z tym samym kredytem i tymi samymi
   zmianami wskaźnika, ale bez nadpłat — inaczej mierzyłoby ruch rynku, nie decyzję.
   Tu odtwarzamy dokładnie te dwa przebiegi, których używa UI. */
const rateEvt = { type: "zmiana_oprocentowania", month: 24, newRatePct: 4.5 };
const nadplataEvt = { type: "jednorazowa", month: 12, amount: 50000, trybOverride: "auto" };
const pelny = simulateScenario(cfg({ years: 30, events: [nadplataEvt, rateEvt] }));
const bazaZeStopa = simulateScenario(cfg({ years: 30, events: [rateEvt] })); // baselineConfig()
const bazaBezNiczego = simulateScenario(cfg({ years: 30, events: [] }));
const oszczednoscWlasciwa = bazaZeStopa.totalInterest - pelny.totalInterest;
const oszczednoscZawyzona = bazaBezNiczego.totalInterest - pelny.totalInterest;
const refPelny = ref({ oneOff: { 12: 50000 }, rates: { 24: 4.5 } });
const refBaza = ref({ rates: { 24: 4.5 } });
near(
  "oszczędność vs baza ze zmianą stopy = różnica odsetek w referencji",
  oszczednoscWlasciwa,
  refBaza.totalInterest - refPelny.totalInterest,
  1,
  " zł"
);
ok("oszczędność liczona poprawnie jest dodatnia", oszczednoscWlasciwa > 0, String(Math.round(oszczednoscWlasciwa)));
ok(
  "baza bez zmiany stopy zawyżałaby oszczędność (efekt rynku doklejony do nadpłaty)",
  oszczednoscZawyzona > oszczednoscWlasciwa + 1000,
  Math.round(oszczednoscZawyzona) + " vs " + Math.round(oszczednoscWlasciwa)
);
near(
  "baza ze zmianą stopy ma odsetki jak sama zmiana stopy",
  bazaZeStopa.totalInterest,
  zmiana.totalInterest,
  0.01,
  " zł"
);

/* ---------- 8. solveMonths ---------- */
/* Silnik zaokrągla w górę celowo (lepiej jedna rata więcej niż niedopłata), ale dla
   raty dokładnie 30-letniej wynik musi wyjść równo 360 — bez „albo 361". */
const sm360 = solveMonths(P, r, annuity(P, r, 360));
ok("solveMonths(P, r, rata 30-letnia) = 360", sm360 === 360, String(sm360));
ok("solveMonths = referencja dla raty 30-letniej", sm360 === monthsRef(P, r, annuity(P, r, 360)), sm360 + " vs " + monthsRef(P, r, annuity(P, r, 360)));
ok("solveMonths przy racie < odsetek = 1 (brak amortyzacji)", solveMonths(P, r, 1) === 1);
ok("solveMonths przy stopie 0 = saldo / rata", solveMonths(120000, 0, 1000) === 120, String(solveMonths(120000, 0, 1000)));
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

/* ---------- 10. wartości ujemne i bezsensowne (obrona w głąb) ----------
   UI przycina wejście, ale silnik musi być bezpieczny wywołany bezpośrednio
   (link, testy, konsola): kwoty → ≥ 0, miesiące → ≥ 1. */
const ujemnaNadplata = simulateScenario(cfg({ years: 30, events: [{ type: "jednorazowa", month: 12, amount: -50000, trybOverride: "auto" }] }));
ok("ujemna nadpłata nie zmniejsza (ani nie zwiększa) kapitału", ujemnaNadplata.totalNadplaty === 0, "jest " + ujemnaNadplata.totalNadplaty);
near("ujemna nadpłata = przebieg bez wydarzeń (odsetki)", ujemnaNadplata.totalInterest, s30.totalInterest, 0.01, " zł");
ok("ujemna nadpłata = przebieg bez wydarzeń (miesiąc spłaty)", ujemnaNadplata.payoffMonths === s30.payoffMonths, ujemnaNadplata.payoffMonths + " vs " + s30.payoffMonths);
ok("ujemna nadpłata nie łamie reguły RKM", ujemnaNadplata.rkmBreachMonth === null, "jest " + ujemnaNadplata.rkmBreachMonth);

const ujemnyKapital = simulateScenario(cfg({ principal: -100000, years: 30 }));
ok("ujemny kapitał → kredyt zerowy, nie NaN", ujemnyKapital.payoffMonths === 0 && isFinite(ujemnyKapital.totalInterest) && ujemnyKapital.totalInterest === 0, JSON.stringify({ m: ujemnyKapital.payoffMonths, i: ujemnyKapital.totalInterest }));
ok("ujemny kapitał → brak daty spłaty", ujemnyKapital.payoffDate === null);

const ujemnaStopa = simulateScenario(cfg({ ratePct: -5, years: 30 }));
ok("ujemna stopa traktowana jak 0 %", ujemnaStopa.totalInterest === 0, "jest " + ujemnaStopa.totalInterest);

const miesiacZero = simulateScenario(cfg({ years: 30, events: [{ type: "jednorazowa", month: 0, amount: 10000, trybOverride: "auto" }] }));
const miesiacUjemny = simulateScenario(cfg({ years: 30, events: [{ type: "jednorazowa", month: -7, amount: 10000, trybOverride: "auto" }] }));
const miesiacJeden = simulateScenario(cfg({ years: 30, events: [{ type: "jednorazowa", month: 1, amount: 10000, trybOverride: "auto" }] }));
ok("miesiąc 0 przycięty do 1", Math.abs(miesiacZero.totalInterest - miesiacJeden.totalInterest) < 0.01 && miesiacZero.payoffMonths === miesiacJeden.payoffMonths);
ok("miesiąc ujemny przycięty do 1", Math.abs(miesiacUjemny.totalInterest - miesiacJeden.totalInterest) < 0.01 && miesiacUjemny.payoffMonths === miesiacJeden.payoffMonths);
ok("nadpłata w m. 1 trafia do eventLog z miesiącem 1", miesiacZero.eventLog.some((l) => l.type === "nadplata" && l.month === 1), JSON.stringify(miesiacZero.eventLog.slice(0, 2)));

const ujemnaOplata = simulateScenario(cfg({ years: 30, feePct: -3, feeMonths: -12, events: [{ type: "jednorazowa", month: 1, amount: 50000, trybOverride: "auto" }] }));
ok("ujemna opłata i ujemne okno opłaty → brak opłat", ujemnaOplata.totalFees === 0, "jest " + ujemnaOplata.totalFees);

const ujemnaGwarancja = simulateScenario(cfg({ gwarancja: -100000, years: 30, events: [{ type: "jednorazowa", month: 2, amount: 1000, trybOverride: "auto" }] }));
ok("ujemna gwarancja = brak gwarancji (próg zero)", ujemnaGwarancja.gwarancja === 0 && ujemnaGwarancja.rkmBreachMonth === 2, JSON.stringify({ g: ujemnaGwarancja.gwarancja, b: ujemnaGwarancja.rkmBreachMonth }));

/* ---------- 11. gwarancja większa od kapitału ----------
   BGK poręcza CZĘŚĆ kredytu, więc gwarancja nie może przekraczać kapitału — wpisana
   wyżej jest przycinana (inaczej KPI „część gwarantowana" pokazywałoby kwotę większą
   od samego kredytu). Skutek uboczny reguły: kredyt objęty gwarancją w całości nie da
   się przekroczyć żadną nadpłatą — każda spłata kapitału zjada gwarancję w tym samym
   tempie, w jakim topi saldo. */
const gwarancjaPonad = simulateScenario(cfg({ principal: 100000, gwarancja: 200000, years: 30 }));
const gwarancjaPonadRef = ref({ principal: 100000, gwarancja: 200000 });
ok("gwarancja > kapitał przycięta do kapitału", gwarancjaPonad.gwarancja === 100000, "jest " + gwarancjaPonad.gwarancja);
near("część gwarantowana po 3 latach = referencja", gwarancjaPonad.guaranteeLeftAt36, gwarancjaPonadRef.guaranteeLeftAt36, 1, " zł");
ok(
  "część gwarantowana nigdy nie przekracza salda",
  gwarancjaPonad.guaranteeLeftAt36 <= gwarancjaPonad.months[35].saldo + 1,
  Math.round(gwarancjaPonad.guaranteeLeftAt36) + " vs saldo " + Math.round(gwarancjaPonad.months[35].saldo)
);
const gwarancjaPonadNadplata = simulateScenario(
  cfg({ principal: 100000, gwarancja: 200000, years: 30, events: [{ type: "jednorazowa", month: 2, amount: 90000, trybOverride: "auto" }] })
);
const gwarancjaPonadNadplataRef = ref({ principal: 100000, gwarancja: 200000, oneOff: { 2: 90000 } });
ok(
  "kredyt w całości objęty gwarancją: nadpłata 90 000 z 100 000 nie łamie reguły",
  gwarancjaPonadNadplata.rkmBreachMonth === null,
  "jest " + gwarancjaPonadNadplata.rkmBreachMonth
);
ok("referencja zgadza się co do braku przekroczenia", gwarancjaPonadNadplataRef.breachMonth === null, "jest " + gwarancjaPonadNadplataRef.breachMonth);
near("kredyt w całości objęty gwarancją: odsetki = referencja", gwarancjaPonadNadplata.totalInterest, gwarancjaPonadNadplataRef.totalInterest, 1, " zł");

/* ---------- 12. dwie nadpłaty w jednym miesiącu ----------
   Przekroczenie musi zależeć od SUMY nadpłat miesiąca, nie od kolejności wpisania:
   30 + 70 tys. i 70 + 30 tys. dają ten sam miesiąc, tę samą sumę i ten sam zapas
   gwarancji z początku miesiąca (to właśnie te dwie liczby idą do komunikatu). */
function dwieNadplaty(a, b) {
  return simulateScenario(
    cfg({
      years: 30,
      events: [
        { type: "jednorazowa", month: 12, amount: a, trybOverride: "auto" },
        { type: "jednorazowa", month: 12, amount: b, trybOverride: "auto" },
      ],
    })
  );
}
const par3070 = dwieNadplaty(30000, 70000);
const par7030 = dwieNadplaty(70000, 30000);
const parRef = ref({ extras: { 12: [30000, 70000] } });
ok("dwie nadpłaty 30 + 70 tys. w m. 12 łamią regułę w m. 12", par3070.rkmBreachMonth === 12, "jest " + par3070.rkmBreachMonth);
ok("odwrotna kolejność łamie regułę w tym samym miesiącu", par7030.rkmBreachMonth === 12, "jest " + par7030.rkmBreachMonth);
ok("referencja: przekroczenie w m. 12 niezależnie od kolejności", parRef.breachMonth === 12, "jest " + parRef.breachMonth);
near("suma nadpłat miesiąca przekroczenia = 100 000 zł", par3070.rkmBreachMonthTotal, 100000, 1, " zł");
near("suma nadpłat miesiąca nie zależy od kolejności", par7030.rkmBreachMonthTotal, par3070.rkmBreachMonthTotal, 0.01, " zł");
near("suma nadpłat miesiąca = referencja", par3070.rkmBreachMonthTotal, parRef.breachMonthTotal, 1, " zł");
near("zapas gwarancji z początku miesiąca = referencja", par3070.rkmBreachAllowanceAtMonthStart, parRef.breachAllowanceAtStart, 1, " zł");
near("zapas gwarancji z początku miesiąca nie zależy od kolejności", par7030.rkmBreachAllowanceAtMonthStart, par3070.rkmBreachAllowanceAtMonthStart, 0.01, " zł");
near(
  "zapas z początku miesiąca = ten sam co przy jednej nadpłacie 95 000 w m. 12",
  par3070.rkmBreachAllowanceAtMonthStart,
  g95.rkmBreachAllowance,
  1,
  " zł"
);
ok(
  "kwota z pojedynczego zdarzenia (rkmBreachAmount) zależy od kolejności — dlatego komunikat jej nie używa",
  Math.abs(par3070.rkmBreachAmount - par7030.rkmBreachAmount) > 1,
  par3070.rkmBreachAmount + " vs " + par7030.rkmBreachAmount
);

/* ---------- 13. dziecko po spłacie kredytu ----------
   Zdarzenie „dziecko" wypadające po ostatniej racie nie może zniknąć bez śladu —
   silnik loguje `dziecko-zero` (i to samo zdanie w miesiącu spłaty, i po nim). */
const dzieckoPoSplacie = simulateScenario(
  cfg({
    years: 30,
    events: [
      { type: "jednorazowa", month: 40, amount: 900000, trybOverride: "auto" },
      { type: "dziecko", month: 60, amount: 60000, childNumber: 3, trybOverride: "auto" },
    ],
  })
);
const dzieckoPoSplacieRef = ref({ oneOff: { 40: 900000 }, children: [{ month: 60, amount: 60000, childNumber: 3 }] });
ok("nadpłata poza oknem 36 mies. nie łamie reguły", dzieckoPoSplacie.rkmBreachMonth === null, "jest " + dzieckoPoSplacie.rkmBreachMonth);
ok("kredyt spłacony w m. 40", dzieckoPoSplacie.payoffMonths === 40, "jest " + dzieckoPoSplacie.payoffMonths);
const logZero = dzieckoPoSplacie.eventLog.filter((l) => l.type === "dziecko-zero");
ok("dziecko po spłacie trafia do eventLog jako dziecko-zero", logZero.length === 1, JSON.stringify(dzieckoPoSplacie.eventLog.slice(-3)));
ok("wpis dziecko-zero zachowuje miesiąc zdarzenia (60)", logZero.length === 1 && logZero[0].month === 60, JSON.stringify(logZero));
ok("wpis dziecko-zero mówi wprost, że spłata nie przysługuje", logZero.length === 1 && /nie przysługuje/.test(logZero[0].text), JSON.stringify(logZero));
ok("dziecko po spłacie nie daje spłaty rodzinnej", dzieckoPoSplacie.totalSplataRodzinna === 0, "jest " + dzieckoPoSplacie.totalSplataRodzinna);
ok("referencja też odnotowuje dziecko po spłacie", dzieckoPoSplacieRef.childrenAfterPayoff.length === 1, JSON.stringify(dzieckoPoSplacieRef.childrenAfterPayoff));
ok("dziecko po spłacie nie jest oznaczane jako „utracona”", dzieckoPoSplacie.eventLog.every((l) => l.type !== "dziecko-lost"));

/* Dziecko dokładnie w miesiącu spłaty: saldo dochodzi do zera przed jego obsługą,
   więc opis musi być identyczny jak dla dziecka po spłacie. */
const dzieckoWMiesiacuSplaty = simulateScenario(
  cfg({
    years: 30,
    events: [
      { type: "jednorazowa", month: 40, amount: 900000, trybOverride: "auto" },
      { type: "dziecko", month: 40, amount: 60000, childNumber: 3, trybOverride: "auto" },
    ],
  })
);
const logZero40 = dzieckoWMiesiacuSplaty.eventLog.filter((l) => l.type === "dziecko-zero");
ok("dziecko w miesiącu spłaty też daje dziecko-zero", logZero40.length === 1 && logZero40[0].month === 40, JSON.stringify(logZero40));
ok(
  "opis jest ten sam dla dziecka w miesiącu spłaty i po spłacie",
  logZero40.length === 1 && logZero.length === 1 && logZero40[0].text === logZero[0].text,
  JSON.stringify([logZero40[0] && logZero40[0].text, logZero[0] && logZero[0].text])
);

/* Dziecko poza harmonogramem, ale kredyt spłacany normalnie do końca okresu. */
const dzieckoPoOkresie = simulateScenario(cfg({ years: 30, events: [{ type: "dziecko", month: 400, amount: 60000, childNumber: 3, trybOverride: "auto" }] }));
ok("dziecko po ostatniej racie 30-letniego kredytu = dziecko-zero", dzieckoPoOkresie.eventLog.filter((l) => l.type === "dziecko-zero").length === 1, JSON.stringify(dzieckoPoOkresie.eventLog));
near("dziecko po ostatniej racie nie zmienia odsetek", dzieckoPoOkresie.totalInterest, s30.totalInterest, 0.01, " zł");

/* ---------- 14. przypadki brzegowe: stopa 0, kapitał 1 zł, brak amortyzacji ---------- */
const zeroStopa = simulateScenario(cfg({ principal: 120000, ratePct: 0, years: 10, gwarancja: 0 }));
const zeroStopaRef = refSim({ principal: 120000, ratePct: 0, years: 10 });
near("stopa 0 %: rata = kapitał / liczba rat", zeroStopa.initialRata, 1000, 0.01, " zł");
ok("stopa 0 %: brak odsetek", zeroStopa.totalInterest === 0, "jest " + zeroStopa.totalInterest);
ok("stopa 0 %: kredyt kończy się w m. 120", zeroStopa.payoffMonths === 120, "jest " + zeroStopa.payoffMonths);
near("stopa 0 %: miesiąc spłaty = referencja", zeroStopa.payoffMonths, zeroStopaRef.payoffMonths, 1, " mies.");
const zeroStopaNadplata = simulateScenario(
  cfg({ principal: 120000, ratePct: 0, years: 10, gwarancja: 0, events: [{ type: "jednorazowa", month: 1, amount: 12000, trybOverride: "auto" }] })
);
const zeroStopaNadplataRef = refSim({ principal: 120000, ratePct: 0, years: 10, oneOff: { 1: 12000 } });
near("stopa 0 % + nadpłata: miesiąc spłaty = referencja", zeroStopaNadplata.payoffMonths, zeroStopaNadplataRef.payoffMonths, 1, " mies.");
ok("stopa 0 % + nadpłata: nadal zero odsetek", zeroStopaNadplata.totalInterest === 0, "jest " + zeroStopaNadplata.totalInterest);

const drobny = simulateScenario(cfg({ principal: 1, years: 30, gwarancja: 0 }));
const drobnyRef = refSim({ principal: 1, ratePct: RATE, years: 30 });
ok("kapitał 1 zł: symulacja się kończy i nic nie jest NaN", isFinite(drobny.totalInterest) && isFinite(drobny.initialRata) && drobny.payoffMonths > 0 && drobny.payoffMonths < 900, JSON.stringify({ m: drobny.payoffMonths, i: drobny.totalInterest }));
near("kapitał 1 zł: miesiąc spłaty = referencja", drobny.payoffMonths, drobnyRef.payoffMonths, 1, " mies.");
near("kapitał 1 zł: odsetki = referencja", drobny.totalInterest, drobnyRef.totalInterest, 0.01, " zł");
ok("kapitał 1 zł: kredyt uznany za spłacony", drobny.paidOff === true, "jest " + drobny.paidOff);

/* Kredyt, który nie mieści się w limicie symulacji (900 mies.) — np. 100 lat
   z podrzuconego linku. UI pokazuje wtedy „nie spłaca się" zamiast fikcyjnej daty. */
const zaDlugi = simulateScenario(cfg({ years: 100 }));
ok("okres poza limitem symulacji: urywa się na 900 mies.", zaDlugi.payoffMonths === 900 && zaDlugi.months.length === 900, "jest " + zaDlugi.payoffMonths);
ok("okres poza limitem symulacji: paidOff = false", zaDlugi.paidOff === false, "jest " + zaDlugi.paidOff);
ok("silnik podaje limit symulacji (maxMonths)", zaDlugi.maxMonths === 900, "jest " + zaDlugi.maxMonths);
ok("zwykły kredyt jest oznaczony jako spłacony", s30.paidOff === true && s30.payoffMonths < s30.maxMonths);
ok("dziecko po urwanej symulacji NIE jest oznaczane jako po spłacie", simulateScenario(cfg({ years: 100, events: [{ type: "dziecko", month: 950, amount: 60000, childNumber: 3, trybOverride: "auto" }] })).eventLog.every((l) => l.type !== "dziecko-zero"));

/* ---------- podsumowanie ---------- */
if (failures > 0) {
  console.error("\n" + failures + " z " + checks + " testów nie przeszło.");
  process.exit(1);
}
console.log("OK — " + checks + " testów silnika przeszło (public/index.html, <script id=\"engine\">).");
