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
       feeMonths i tylko od nadpłat dobrowolnych (art. 40 ustawy o kredycie
       hipotecznym): w okresie stałej stopy (`fixedMonths`) stawka z umowy bez pułapów
       (ust. 6); poza nim tylko do m. 36 (ust. 2), przycięta do 3 % i do odsetek za
       12 miesięcy od spłacanej kwoty (ust. 3), a gdy do końca umowy zostało < 12 mies.
       — do odsetek za ten pozostały okres (ust. 4),
     • `flows[m-1]` = wszystko, co kredytobiorca wpłacił w miesiącu m (rata + nadpłaty
       + opłaty) — do niezależnej referencji kosztu z lokatą,
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
  const fixedMonths = o.fixedMonths || 0;
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
  const lostChildren = [], childrenAfterPayoff = [], flows = [];
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
    let monthVoluntary = 0, monthFees = 0;
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
      if (month <= feeMonths) {
        let fee = 0;
        if (month <= fixedMonths) fee = amt * (feePct / 100);
        else if (month <= 36) {
          fee = Math.min(amt * (feePct / 100), amt * 0.03, amt * r * 12);
          const left = n - month;
          if (left < 12) fee = Math.min(fee, amt * r * Math.max(0, left));
        }
        totalFees += fee;
        monthFees += fee;
      }
      balance -= amt;
      monthVoluntary += amt;
      if (balance > 0.5) {
        if (tryb === "obniz") rata = rataRef(balance, r, remaining);
        else remaining = monthsRef(balance, r, rata);
      }
    });
    if (breachMonth === month) { breachMonthTotal = monthVoluntary; breachAllowanceAtStart = allowanceAtMonthStart; }
    flows.push(payment + monthVoluntary + monthFees);

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
    lostChildren, childrenAfterPayoff, guaranteeStart: gwarancja, flows,
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

/* ---------- 4h. limity wkładu własnego i WYLICZANA gwarancja BGK ----------
   Gwarancja nie jest już parametrem wpisywanym w UI — ustawa wyznacza ją jednoznacznie:
     gwarancja = min(max(0, 20 % wydatków − wkład), 100 000, 200 000 − wkład, kwota kredytu)
   (art. 3 ust. 3b, art. 4a ust. 2 pkt 1, art. 4a ust. 3). „Całkowita kwota wydatków"
   w kalkulatorze = cena + dodatkowa kwota kredytu (wykończenie/remont).
   Liczby oczekiwane są tu wyliczone ręcznie z tych przepisów, nie przepisane z silnika. */
const { gwarancjaBGK, rkmLimitIssues } = RKM;
ok("silnik wystawia gwarancjaBGK / rkmLimitIssues", typeof gwarancjaBGK === "function" && typeof rkmLimitIssues === "function");
ok("pułapy ustawowe są wystawione", RKM.RKM_GWARANCJA_MAX === 100000 && RKM.RKM_SUMA_MAX === 200000 && RKM.RKM_WKLAD_MAX_KWOTA === 200000 && RKM.RKM_WKLAD_MAX_PCT === 0.2);

function issuesOf(o) { return rkmLimitIssues(o).issues.join(","); }

/* 500 000 bez wkładu: 20 % = 100 000, czyli dokładnie pułap gwarancji. */
near("500 000 / wkład 0 → gwarancja 100 000", gwarancjaBGK({ cena: 500000, wklad: 0, remont: 0 }), 100000, 0.01, " zł");
ok("500 000 / wkład 0 → brak naruszeń", issuesOf({ cena: 500000, wklad: 0, remont: 0 }) === "", issuesOf({ cena: 500000, wklad: 0, remont: 0 }));

/* 600 000 bez wkładu: 20 % = 120 000 > 100 000 → gwarancja obcięta, brakuje 20 000
   wkładu własnego, żeby kredyt spełniał warunek. */
const l600 = rkmLimitIssues({ cena: 600000, wklad: 0, remont: 0 });
near("600 000 / wkład 0 → gwarancja obcięta do 100 000", gwarancjaBGK({ cena: 600000, wklad: 0, remont: 0 }), 100000, 0.01, " zł");
ok("600 000 / wkład 0 → niedobór gwarancji", l600.issues.join(",") === "gwarancja_niedobor", l600.issues.join(","));
near("600 000 / wkład 0 → minimalny wkład 20 000", l600.minWklad, 20000, 0.01, " zł");
near("600 000 / wkład 0 → maksymalny wkład (20 %) 120 000", l600.maxWklad, 120000, 0.01, " zł");
near("600 000 / wkład 0 → do 20 % brakuje 120 000", l600.brakDo20, 120000, 0.01, " zł");

/* Ten sam kredyt z wkładem 20 000: 120 000 − 20 000 = 100 000 mieści się w pułapie. */
near("600 000 / wkład 20 000 → gwarancja 100 000", gwarancjaBGK({ cena: 600000, wklad: 20000, remont: 0 }), 100000, 0.01, " zł");
ok("600 000 / wkład 20 000 → brak naruszeń", issuesOf({ cena: 600000, wklad: 20000, remont: 0 }) === "", issuesOf({ cena: 600000, wklad: 20000, remont: 0 }));

/* Wkład dokładnie 20 % → gwarancja zero, ale kredyt nadal spełnia warunki. */
near("500 000 / wkład 100 000 (20 %) → gwarancja 0", gwarancjaBGK({ cena: 500000, wklad: 100000, remont: 0 }), 0, 0.01, " zł");
ok("500 000 / wkład 100 000 → brak naruszeń", issuesOf({ cena: 500000, wklad: 100000, remont: 0 }) === "", issuesOf({ cena: 500000, wklad: 100000, remont: 0 }));

/* Wkład ponad 20 % wydatków — art. 5 ust. 1 pkt 5 lit. a. */
const l120 = rkmLimitIssues({ cena: 500000, wklad: 120000, remont: 0 });
near("500 000 / wkład 120 000 → gwarancja 0", gwarancjaBGK({ cena: 500000, wklad: 120000, remont: 0 }), 0, 0.01, " zł");
ok("500 000 / wkład 120 000 → wkład ponad 20 %", l120.issues.join(",") === "wklad_pct", l120.issues.join(","));
near("500 000 / wkład 120 000 → to 24 % wydatków", l120.pctWkladu, 24, 0.01);

/* 1 200 000 / wkład 200 000: 20 % = 240 000, więc do domknięcia brakuje 40 000
   gwarancji — ale art. 4a ust. 2 pkt 1 nie pozwala, by gwarancja i wkład dały razem
   więcej niż 200 000 zł (a wkład sam już tyle wynosi). Kredyt więc warunków nie
   spełnia (`suma_200k`), a gwarancja prawnie możliwa to ZERO — nie 40 000. */
const l12 = rkmLimitIssues({ cena: 1200000, wklad: 200000, remont: 0 });
near("1 200 000 / wkład 200 000 → potrzebna gwarancja 40 000", l12.gwarancjaPotrzebna, 40000, 0.01, " zł");
near("1 200 000 / wkład 200 000 → gwarancja możliwa prawnie = 0 (pułap 200 000 z wkładem)", l12.gwarancja, 0, 0.01, " zł");
ok("1 200 000 / wkład 200 000 → suma wkładu i gwarancji ponad 200 000", l12.issues.join(",") === "suma_200k", l12.issues.join(","));
ok("1 200 000 / wkład 200 000 → wkład 200 000 sam w sobie nie narusza limitu kwotowego", l12.issues.indexOf("wklad_kwota") < 0);

/* 1 500 000 / wkład 250 000: 16,67 % wydatków (więc procentowo w porządku), ale ponad
   ustawowe 200 000 zł (art. 3 ust. 3 pkt 1). `suma_200k` jest wtedy pomijana — wynika
   już z naruszenia kwotowego i tylko powtarzałaby tę samą przyczynę. */
const l15 = rkmLimitIssues({ cena: 1500000, wklad: 250000, remont: 0 });
near("1 500 000 / wkład 250 000 → to 16,67 % wydatków", l15.pctWkladu, 100 * 250000 / 1500000, 0.01);
ok("1 500 000 / wkład 250 000 → wkład ponad 200 000 zł", l15.issues.join(",") === "wklad_kwota", l15.issues.join(","));
near("1 500 000 / wkład 250 000 → gwarancja 0", l15.gwarancja, 0, 0.01, " zł");

/* Dodatkowa kwota kredytu (wykończenie) wchodzi do „całkowitej kwoty wydatków". */
near(
  "400 000 + 100 000 remontu, wkład 0 → gwarancja 100 000 (20 % z 500 000)",
  gwarancjaBGK({ cena: 400000, wklad: 0, remont: 100000 }),
  100000,
  0.01,
  " zł"
);
ok(
  "400 000 + 100 000 remontu, wkład 0 → brak naruszeń",
  issuesOf({ cena: 400000, wklad: 0, remont: 100000 }) === "",
  issuesOf({ cena: 400000, wklad: 0, remont: 100000 })
);
near(
  "remont podnosi wydatki, więc i gwarancję",
  gwarancjaBGK({ cena: 400000, wklad: 0, remont: 0 }),
  80000,
  0.01,
  " zł"
);

/* Sufit programu wynikający z samych limitów: wkład + gwarancja muszą dać dokładnie 20 %
   wydatków (art. 3 ust. 3b), a ich suma nie może przekroczyć 200 000 zł (art. 4a ust. 2
   pkt 1) — więc powyżej 1 000 000 zł wydatków nie istnieje wkład własny bez naruszenia. */
function istniejeDobryWklad(wydatki) {
  for (let wk = 0; wk <= wydatki; wk += 1000) {
    if (rkmLimitIssues({ cena: wydatki, wklad: wk, remont: 0 }).issues.length === 0) return wk;
  }
  return null;
}
ok("wydatki 1 000 000 → wkład 100 000 spełnia limity", istniejeDobryWklad(1000000) === 100000, String(istniejeDobryWklad(1000000)));
ok("wydatki 1 100 000 → żaden wkład nie spełnia limitów", istniejeDobryWklad(1100000) === null, String(istniejeDobryWklad(1100000)));

/* Obrona w głąb: śmieci na wejściu nie mogą dać NaN ani kwoty ujemnej. */
ok("brak argumentu → gwarancja 0", gwarancjaBGK() === 0 && gwarancjaBGK(null) === 0);
ok("ujemna cena i ujemny wkład → gwarancja 0, brak naruszeń", gwarancjaBGK({ cena: -500000, wklad: -100 }) === 0 && issuesOf({ cena: -500000, wklad: -100 }) === "");
ok("NaN na wejściu → gwarancja 0", gwarancjaBGK({ cena: NaN, wklad: NaN, remont: NaN }) === 0);
/* Gwarancja nigdy nie przekracza kwoty kredytu — istotne tylko dla wejścia z wkładem
   większym od ceny (kredyt jest wtedy mniejszy niż 20 % wydatków). */
ok(
  "gwarancja nie przekracza kwoty kredytu",
  gwarancjaBGK({ cena: 100000, wklad: 100000, remont: 0 }) === 0,
  String(gwarancjaBGK({ cena: 100000, wklad: 100000, remont: 0 }))
);

/* Wyliczona gwarancja wchodzi do symulacji tak samo jak dawna wpisywana wartość:
   domyślny kredyt (500 000, wkład 0) daje próg 100 000, więc nadpłata 95 000 w m. 12
   łamie regułę, a 90 000 nie — dokładnie jak w pkt 4a. */
const gwDomyslna = gwarancjaBGK({ cena: 500000, wklad: 0, remont: 0 });
const gwSym = simulateScenario(cfg({ gwarancja: gwDomyslna, events: [{ type: "jednorazowa", month: 12, amount: 95000, trybOverride: "auto" }] }));
ok("wyliczona gwarancja działa w silniku jak wpisana", gwSym.rkmBreachMonth === 12 && gwSym.gwarancja === 100000, JSON.stringify({ b: gwSym.rkmBreachMonth, g: gwSym.gwarancja }));

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

/* ---------- 6b. limit opłaty za wcześniejszą spłatę (art. 40 ust. 3 u.k.h.) ----------
   Rekompensata nie może przekroczyć odsetek, które kredytobiorca zapłaciłby od
   spłacanej kwoty przez rok. Przy 2 % rocznie odsetki od 10 000 zł to 200 zł, więc
   umowne 3 % (300 zł) jest przycinane; przy 5,50 % limit (550 zł) nie wiąże. */
function oplataOd10k(ratePct) {
  return simulateScenario(
    cfg({ years: 30, ratePct: ratePct, feePct: 3, feeMonths: 36, events: [{ type: "jednorazowa", month: 1, amount: 10000, trybOverride: "auto" }] })
  ).totalFees;
}
near("stopa 2 %: opłata 3 % przycięta do odsetek za 12 mies. = 200 zł", oplataOd10k(2), 200, 0.01, " zł");
near("stopa 5,50 %: opłata 3 % bez przycięcia = 300 zł", oplataOd10k(5.5), 300, 0.01, " zł");
ok("limit z art. 40 ust. 3 realnie obniża opłatę przy niskiej stopie", oplataOd10k(2) < oplataOd10k(5.5), oplataOd10k(2) + " vs " + oplataOd10k(5.5));
near("stopa 2 %: opłata = referencja", oplataOd10k(2), refSim({ principal: P, ratePct: 2, years: 30, oneOff: { 1: 10000 }, feePct: 3, feeMonths: 36 }).totalFees, 0.01, " zł");
/* Limit liczy się od stopy OBOWIĄZUJĄCEJ w miesiącu spłaty, nie od pierwotnej:
   po spadku wskaźnika do 2 % opłata za nadpłatę w m. 24 jest już przycięta. */
const oplataPoSpadku = simulateScenario(
  cfg({
    years: 30, feePct: 3, feeMonths: 36,
    events: [
      { type: "zmiana_oprocentowania", month: 12, newRatePct: 2 },
      { type: "jednorazowa", month: 24, amount: 10000, trybOverride: "auto" },
    ],
  })
);
near("limit opłaty idzie za aktualną stopą (po spadku do 2 % → 200 zł)", oplataPoSpadku.totalFees, 200, 0.01, " zł");
/* Art. 40 ust. 3 ma DWA pułapy: odsetki za rok i 3 % spłacanej kwoty. Umowne 5 % przy
   stopie zmiennej 5,50 % jest więc przycinane do 3 % (300 zł od 10 000 zł). */
near(
  "stopa zmienna: umowne 5 % przycięte do 3 % (art. 40 ust. 3)",
  simulateScenario(cfg({ years: 30, feePct: 5, feeMonths: 36, events: [{ type: "jednorazowa", month: 1, amount: 10000, trybOverride: "auto" }] })).totalFees,
  300, 0.01, " zł"
);
/* Silnik sam pilnuje 36 mies. z ust. 2 — okno z umowy dłuższe niż ustawowe nie daje
   opłaty w m. 40 przy stopie zmiennej (obrona w głąb; UI i tak przycina pole). */
ok(
  "stopa zmienna: opłata nie przysługuje po 36. miesiącu mimo dłuższego okna z umowy",
  simulateScenario(cfg({ years: 30, feePct: 3, feeMonths: 60, events: [{ type: "jednorazowa", month: 40, amount: 10000, trybOverride: "auto" }] })).totalFees === 0
);
/* Ust. 4: do końca umowy zostało mniej niż rok → nie więcej niż odsetki za ten okres.
   Kredyt na 3 lata, nadpłata w m. 30: zostaje 6 mies., więc 10 000·r·6 = 275 zł < 300 zł. */
near(
  "stopa zmienna: mniej niż rok do końca umowy → odsetki za pozostały okres (art. 40 ust. 4)",
  simulateScenario(cfg({ years: 3, gwarancja: 0, feePct: 3, feeMonths: 36, events: [{ type: "jednorazowa", month: 30, amount: 10000, trybOverride: "auto" }] })).totalFees,
  10000 * r * 6, 0.01, " zł"
);
near(
  "art. 40 ust. 4: silnik = referencja",
  simulateScenario(cfg({ years: 3, gwarancja: 0, feePct: 3, feeMonths: 36, events: [{ type: "jednorazowa", month: 30, amount: 10000, trybOverride: "auto" }] })).totalFees,
  refSim({ principal: P, ratePct: RATE, years: 3, oneOff: { 30: 10000 }, feePct: 3, feeMonths: 36 }).totalFees,
  0.01, " zł"
);

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
ok("wersja stanu = 7", STATE_VERSION === 7, "jest " + STATE_VERSION);
ok("akceptowane wersje linku 4–7", JSON.stringify(RKM.ACCEPTED_STATE_VERSIONS) === "[4,5,6,7]", JSON.stringify(RKM.ACCEPTED_STATE_VERSIONS));
ok("silnik podaje domyślne oprocentowanie lokaty", RKM.DEFAULT_LOKATA_PCT === 3, "jest " + RKM.DEFAULT_LOKATA_PCT);

const sampleState = {
  v: STATE_VERSION,
  chartMode: "rata",
  tableScn: "B",
  lokata: 4.5,
  A: {
    rkm: true,
    cena: 500000, wklad: 0, remont: 25000,
    marza: 1.9, wskaznik: 3.6, start: "2027-03", tryb: "skroc",
    feePct: 3, feeMonths: 36, years: 30,
    stopa: "zmienna", stalaPct: 5.8, stalaLata: 5,
    events: [
      { id: "x1", type: "cykliczna", startMonth: 1, endMonth: 360, monthlyAmount: 500, trybOverride: "auto" },
      { id: "x2", type: "jednorazowa", month: 37, amount: 50000, trybOverride: "obniz" },
      { id: "x3", type: "zmiana_wskaznika", month: 24, newWskaznik: 2.6 },
    ],
  },
  B: {
    rkm: false,
    cena: 500000, wklad: 60000, remont: 0,
    marza: 2.1, wskaznik: 3.6, start: "2026-12", tryb: "obniz",
    feePct: 0, feeMonths: 0, years: 25,
    stopa: "stala", stalaPct: 6.1, stalaLata: 7,
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
  "tryb RKM jedzie w linku osobno dla A i B",
  roundTrip.A.rkm === true && roundTrip.B.rkm === false,
  JSON.stringify([roundTrip.A.rkm, roundTrip.B.rkm])
);
ok("oprocentowanie lokaty przeżywa round trip", roundTrip.lokata === 4.5, "jest " + roundTrip.lokata);
ok(
  "rodzaj oprocentowania (v7) przeżywa round trip osobno dla A i B",
  roundTrip.A.stopa === "zmienna" && roundTrip.B.stopa === "stala" && roundTrip.B.stalaPct === 6.1 && roundTrip.B.stalaLata === 7,
  JSON.stringify([roundTrip.A.stopa, roundTrip.B.stopa, roundTrip.B.stalaPct, roundTrip.B.stalaLata])
);
ok("rodzaj oprocentowania jedzie w linku skrócony do jednego znaku", shortenState(sampleState).b.z === "s" && shortenState(sampleState).a.z === "z", JSON.stringify(shortenState(sampleState).b));
ok("stan nie nosi już globalnego rkmOn", shortenState(sampleState).k === undefined && roundTrip.rkmOn === undefined);
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

/* Zgodność w tył. Ładunek z wersji 4 nosił pole `gwarancja` (skrócony klucz „g”),
   dziś wyliczane; ładunki 4 i 5 miały GLOBALNY tryb RKM (klucz „k”), dziś będący
   cechą scenariusza. Dekoder musi obie różnice wygładzić i podnieść wersję do 6 —
   inaczej stare linki niepotrzebnie wyświetlałyby notkę „nie udało się odczytać”. */
function legacyPayload(version, rkmOn) {
  const short = shortenState(sampleState);
  short.v = version;
  short.k = rkmOn;             // globalny tryb RKM (v4/v5)
  delete short.a.r;            // per-scenariuszowej flagi jeszcze nie było
  delete short.b.r;
  delete short.o;              // ani oprocentowania lokaty
  ["a", "b"].forEach((k) => { delete short[k].z; delete short[k].q; delete short[k].j; }); // ani stopy stałej (v7)
  if (version === 4) { short.a.g = 100000; short.b.g = 0; }
  return bytesToB64url(new TextEncoder().encode(JSON.stringify(short)));
}
const fromV4 = decodeStateJson(legacyPayload(4, true));
ok("ładunek v4 daje się odczytać", !!fromV4, JSON.stringify(fromV4));
ok("ładunek v4 jest podnoszony do wersji 6", fromV4 && fromV4.v === STATE_VERSION, "jest " + (fromV4 && fromV4.v));
ok(
  "ładunek v4 traci pole gwarancja",
  fromV4 && fromV4.A.gwarancja === undefined && fromV4.B.gwarancja === undefined,
  JSON.stringify([fromV4 && fromV4.A.gwarancja, fromV4 && fromV4.B.gwarancja])
);
/* Porównanie niezależne od kolejności kluczy: przy migracji `rkm` dopisywane jest
   na końcu obiektu, w oryginale stoi na początku — JSON.stringify by je rozróżnił. */
function sortedJson(v) {
  if (Array.isArray(v)) return "[" + v.map(sortedJson).join(",") + "]";
  if (v && typeof v === "object") {
    return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + sortedJson(v[k])).join(",") + "}";
  }
  return JSON.stringify(v === undefined ? null : v);
}
ok(
  "ładunek v4 zachowuje pozostałe pola scenariuszy",
  fromV4 &&
    sortedJson(stripIds(fromV4).A) === sortedJson(Object.assign(stripIds(sampleState).A, { rkm: true, stopa: "zmienna", stalaPct: 5.8, stalaLata: 5 })) &&
    sortedJson(stripIds(fromV4).B) === sortedJson(Object.assign(stripIds(sampleState).B, { rkm: true, stopa: "zmienna", stalaPct: 5.8, stalaLata: 5 })),
  sortedJson(fromV4 && stripIds(fromV4).A)
);

/* Sedno migracji do wersji 6: jedna globalna flaga staje się dwiema. */
const fromV5on = decodeStateJson(legacyPayload(5, true));
const fromV5off = decodeStateJson(legacyPayload(5, false));
ok("ładunek v5 jest podnoszony do wersji 6", fromV5on && fromV5on.v === STATE_VERSION, "jest " + (fromV5on && fromV5on.v));
ok(
  "globalne rkmOn=true z v5 trafia do OBU scenariuszy",
  fromV5on && fromV5on.A.rkm === true && fromV5on.B.rkm === true,
  JSON.stringify(fromV5on && [fromV5on.A.rkm, fromV5on.B.rkm])
);
ok(
  "globalne rkmOn=false z v5 też trafia do obu (nie gubimy trybu)",
  fromV5off && fromV5off.A.rkm === false && fromV5off.B.rkm === false,
  JSON.stringify(fromV5off && [fromV5off.A.rkm, fromV5off.B.rkm])
);
ok(
  "ładunek bez lokaty dostaje wartość domyślną",
  fromV5on && fromV5on.lokata === RKM.DEFAULT_LOKATA_PCT,
  "jest " + (fromV5on && fromV5on.lokata)
);
ok(
  "ładunek v5 nie zostawia po sobie globalnego rkmOn",
  fromV5on && fromV5on.rkmOn === undefined
);
ok(
  "ładunek z nieznanej wersji zostaje odrzucony (wersja nietknięta)",
  (() => {
    const short = shortenState(sampleState);
    short.v = 8;
    const decoded = decodeStateJson(bytesToB64url(new TextEncoder().encode(JSON.stringify(short))));
    return decoded && decoded.v === 8;
  })()
);

/* Sedno migracji do wersji 7: ładunek v6 nie zna rodzaju oprocentowania — dostaje
   stopę zmienną (i domyślne parametry stopy stałej na wypadek przełączenia w UI),
   a wszystko inne zostaje tak, jak było. */
function v6Payload() {
  const short = shortenState(sampleState);
  short.v = 6;
  ["a", "b"].forEach((k) => { delete short[k].z; delete short[k].q; delete short[k].j; });
  return bytesToB64url(new TextEncoder().encode(JSON.stringify(short)));
}
const fromV6 = decodeStateJson(v6Payload());
ok("ładunek v6 jest podnoszony do wersji 7", fromV6 && fromV6.v === 7, "jest " + (fromV6 && fromV6.v));
ok(
  "ładunek v6 dostaje stopę zmienną w obu scenariuszach",
  fromV6 && fromV6.A.stopa === "zmienna" && fromV6.B.stopa === "zmienna",
  JSON.stringify(fromV6 && [fromV6.A.stopa, fromV6.B.stopa])
);
ok(
  "ładunek v6 dostaje domyślne parametry stopy stałej (5,80 % / 5 lat)",
  fromV6 && fromV6.B.stalaPct === RKM.DEFAULT_STALA_PCT && fromV6.B.stalaLata === RKM.DEFAULT_STALA_LATA && RKM.DEFAULT_STALA_PCT === 5.8 && RKM.DEFAULT_STALA_LATA === 5,
  JSON.stringify(fromV6 && [fromV6.B.stalaPct, fromV6.B.stalaLata])
);
ok(
  "ładunek v6 zachowuje pozostałe pola (tryb RKM, lokata, zdarzenia)",
  fromV6 && fromV6.A.rkm === true && fromV6.B.rkm === false && fromV6.lokata === 4.5 && fromV6.A.events.length === 3 && fromV6.B.marza === 2.1,
  JSON.stringify(fromV6 && stripIds(fromV6).B)
);
ok(
  "ładunek v7 NIE jest nadpisywany domyślną stopą zmienną",
  roundTrip.B.stopa === "stala"
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

/* ---------- 15. opłata prowizyjna za gwarancję BGK (art. 4a ust. 5) ----------
   „Z tytułu udzielenia gwarancji BGK pobiera od kredytobiorcy jednorazową opłatę
   prowizyjną w wysokości 1,0 % objętej tą gwarancją części kredytu" — płatna przy
   uruchomieniu, bezzwrotna, więc wchodzi do łącznego kosztu kredytu. */
near("opłata za gwarancję: 1 % ze 100 000 zł = 1 000 zł", s30.gwarancjaFee, 1000, 0.01, " zł");
ok("domyślna stawka opłaty to 1,0 %", s30.gwarancjaFeePct === 1, "jest " + s30.gwarancjaFeePct);
near("łączny koszt = odsetki + opłaty za nadpłaty + opłata za gwarancję", s30.totalCost, s30.totalInterest + s30.totalFees + s30.gwarancjaFee, 0.01, " zł");
ok("brak gwarancji → brak opłaty prowizyjnej", g0bez.gwarancjaFee === 0, "jest " + g0bez.gwarancjaFee);
const pozaProgramem = simulateScenario(cfg({ years: 30, gwarancjaFeePct: 0 }));
ok(
  "kredyt spoza RKM (gwarancjaFeePct 0) nie płaci opłaty i ma koszt bez niej",
  pozaProgramem.gwarancjaFee === 0 && Math.abs(pozaProgramem.totalCost - (pozaProgramem.totalInterest + pozaProgramem.totalFees)) < 0.01,
  JSON.stringify({ f: pozaProgramem.gwarancjaFee, c: Math.round(pozaProgramem.totalCost) })
);
near(
  "opłata liczona od gwarancji PRZYCIĘTEJ do kapitału, nie od wpisanej",
  simulateScenario(cfg({ principal: 100000, gwarancja: 200000, years: 30 })).gwarancjaFee,
  1000,
  0.01,
  " zł"
);

/* ---------- 16. suma wpłat i koszt alternatywny gotówki (lokata) ----------
   Wypływy kredytobiorcy = rata + nadpłata dobrowolna + opłata za wcześniejszą spłatę
   (co miesiąc) plus jednorazowa opłata za gwarancję w miesiącu 0. Spłata rodzinna to
   pieniądz BGK — do wpłat nie wchodzi i na lokacie pracować nie może.
   Referencyjne FV liczone tu zwykłą pętlą, nie przez RKM.kosztZLokata. */
const { kosztZLokata } = RKM;
ok("silnik wystawia kosztZLokata", typeof kosztZLokata === "function");
function wplatyRef(res) {
  let sum = res.wklad + res.gwarancjaFee;
  res.months.forEach((mo) => { sum += mo.rata + mo.nadplata + mo.oplata; });
  return sum;
}
function fvRef(res, lokataPct, horizon) {
  const rl = lokataPct / 100 / 12;
  let fv = (res.wklad + res.gwarancjaFee) * Math.pow(1 + rl, horizon);
  res.months.forEach((mo) => {
    fv += (mo.rata + mo.nadplata + mo.oplata) * Math.pow(1 + rl, Math.max(0, horizon - mo.month));
  });
  return fv;
}
near("suma wpłat = wkład + raty + nadpłaty + opłaty + opłata za gwarancję", s30.totalWplaty, wplatyRef(s30), 0.01, " zł");
near("lokata 0 % → wartość przyszła równa sumie wpłat", kosztZLokata(s30, 0, s30.payoffMonths), s30.totalWplaty, 0.01, " zł");
ok(
  "lokata > 0 % → wartość przyszła większa niż suma wpłat",
  kosztZLokata(s30, 3, s30.payoffMonths) > s30.totalWplaty + 1,
  Math.round(kosztZLokata(s30, 3, s30.payoffMonths)) + " vs " + Math.round(s30.totalWplaty)
);
near("koszt z lokatą 3 % = referencja", kosztZLokata(s30, 3, 360), fvRef(s30, 3, 360), 1, " zł");
near("koszt z lokatą 4,5 % = referencja", kosztZLokata(s30, 4.5, 400), fvRef(s30, 4.5, 400), 1, " zł");
ok(
  "wyższe oprocentowanie lokaty podnosi koszt alternatywny",
  kosztZLokata(s30, 7, 360) > kosztZLokata(s30, 3, 360),
  Math.round(kosztZLokata(s30, 7, 360)) + " vs " + Math.round(kosztZLokata(s30, 3, 360))
);
/* Spłata rodzinna poza wypłatami: gdyby wchodziła, suma wpłat urosłaby dokładnie o nią. */
let sumaZeSplata = gDziecko.wklad + gDziecko.gwarancjaFee;
gDziecko.months.forEach((mo) => { sumaZeSplata += mo.rata + mo.nadplata + mo.oplata + mo.splataRodzinna; });
ok("scenariusz kontrolny naprawdę dostał spłatę rodzinną", gDziecko.totalSplataRodzinna > 0, String(gDziecko.totalSplataRodzinna));
near("suma wpłat pomija spłatę rodzinną", sumaZeSplata - gDziecko.totalSplataRodzinna, gDziecko.totalWplaty, 1, " zł");
near("koszt z lokatą też pomija spłatę rodzinną (lokata 0 % = suma wpłat)", kosztZLokata(gDziecko, 0, gDziecko.payoffMonths), gDziecko.totalWplaty, 0.01, " zł");

/* Sedno punktu 5 roadmapy: „nadpłacić teraz" kontra „poczekać do m. 37".
   Przy lokacie niższej niż oprocentowanie kredytu odłożenie nadpłaty jest droższe,
   przy wyższej — tańsze. Bez kosztu alternatywnego widać tylko jedną stronę. */
const nadplataTeraz = simulateScenario(cfg({ years: 30, events: [{ type: "jednorazowa", month: 1, amount: 100000, trybOverride: "auto" }] }));
const nadplataPozniej = simulateScenario(cfg({ years: 30, events: [{ type: "jednorazowa", month: 37, amount: 100000, trybOverride: "auto" }] }));
const HOR = Math.max(nadplataTeraz.payoffMonths, nadplataPozniej.payoffMonths);
const fvTeraz3 = kosztZLokata(nadplataTeraz, 3, HOR), fvPozniej3 = kosztZLokata(nadplataPozniej, 3, HOR);
const fvTeraz7 = kosztZLokata(nadplataTeraz, 7, HOR), fvPozniej7 = kosztZLokata(nadplataPozniej, 7, HOR);
near("odłożona nadpłata: koszt z lokatą 3 % = referencja", fvPozniej3, fvRef(nadplataPozniej, 3, HOR), 1, " zł");
ok(
  "lokata 3 % < kredyt 5,5 %: odłożenie nadpłaty do m. 37 wychodzi drożej",
  fvPozniej3 > fvTeraz3,
  Math.round(fvPozniej3) + " vs " + Math.round(fvTeraz3)
);
ok(
  "lokata 7 % > kredyt 5,5 %: odłożenie nadpłaty do m. 37 wychodzi taniej",
  fvPozniej7 < fvTeraz7,
  Math.round(fvPozniej7) + " vs " + Math.round(fvTeraz7)
);
ok("obrona w głąb: kosztZLokata na śmieciach nie daje NaN", kosztZLokata(null, 3, 100) === 0 && isFinite(kosztZLokata(s30, -5, -10)));

/* ---------- 17. znaczniki: wygaśnięcie gwarancji i pełna spłata rodzinna ----------
   `guaranteeExhaustedMonth` — pierwszy miesiąc, w którym część objęta gwarancją
   zeszła do zera (art. 4a ust. 6: „Gwarancja wygasa z dniem spłaty części kapitałowej
   kredytu w wysokości objętej tą gwarancją").
   `fullChildRepaymentUntilMonth` — ostatni miesiąc z saldem co najmniej 60 000 zł,
   czyli takim, które mieści jeszcze PEŁNĄ spłatę rodzinną za trzecie dziecko
   (art. 7 ust. 3). To nie jest termin na dziecko — prawo do spłaty od niego nie zależy. */
ok("silnik podaje kwotę pełnej spłaty rodzinnej", RKM.RKM_PELNA_SPLATA_RODZINNA === 60000, "jest " + RKM.RKM_PELNA_SPLATA_RODZINNA);
function wygasnieciaRef(res) {
  let left = Math.min(res.gwarancja, res.months.length ? res.months[0].saldo + res.months[0].kapital : 0);
  if (left <= 0) return null;
  for (let i = 0; i < res.months.length; i++) {
    const mo = res.months[i];
    left = Math.min(Math.max(0, left - mo.kapital - mo.nadplata - mo.splataRodzinna), mo.saldo);
    if (left <= 0.005) return mo.month;
  }
  return null;
}
function pelnaSplataRef(res) {
  for (let i = res.months.length - 1; i >= 0; i--) {
    if (res.months[i].saldo >= 60000) return res.months[i].month === res.payoffMonths ? null : res.months[i].month;
  }
  return null;
}
ok("wygaśnięcie gwarancji (30 lat) = referencja", s30.guaranteeExhaustedMonth === wygasnieciaRef(s30), s30.guaranteeExhaustedMonth + " vs " + wygasnieciaRef(s30));
ok("wygaśnięcie gwarancji przy 30 latach wypada dużo po oknie 36 mies.", s30.guaranteeExhaustedMonth > 36, String(s30.guaranteeExhaustedMonth));
ok("krótszy okres wyczerpuje gwarancję wcześniej", s15.guaranteeExhaustedMonth < s30.guaranteeExhaustedMonth, s15.guaranteeExhaustedMonth + " vs " + s30.guaranteeExhaustedMonth);
ok("brak gwarancji → brak miesiąca wygaśnięcia (null, nie 1)", g0bez.guaranteeExhaustedMonth === null, String(g0bez.guaranteeExhaustedMonth));
/* Duża nadpłata w oknie 36 mies. zjada całą gwarancję od razu — to właśnie ten
   przypadek rysuje na wykresie pusty romb (znacznik przed końcem okna). */
const gwWyczerpanaWcześnie = simulateScenario(cfg({ years: 30, events: [{ type: "jednorazowa", month: 2, amount: 150000, trybOverride: "auto" }] }));
ok("nadpłata 150 000 w m. 2 wyczerpuje gwarancję w m. 2", gwWyczerpanaWcześnie.guaranteeExhaustedMonth === 2, String(gwWyczerpanaWcześnie.guaranteeExhaustedMonth));
ok("i wypada przed końcem okna RKM (znacznik ma sens)", gwWyczerpanaWcześnie.guaranteeExhaustedMonth < RKM.RKM_WINDOW_MONTHS);

ok("ostatni miesiąc z saldem ≥ 60 000 (30 lat) = referencja", s30.fullChildRepaymentUntilMonth === pelnaSplataRef(s30), s30.fullChildRepaymentUntilMonth + " vs " + pelnaSplataRef(s30));
ok(
  "saldo w tym miesiącu jest ≥ 60 000, a w następnym już nie",
  s30.months[s30.fullChildRepaymentUntilMonth - 1].saldo >= 60000 && s30.months[s30.fullChildRepaymentUntilMonth].saldo < 60000,
  JSON.stringify([Math.round(s30.months[s30.fullChildRepaymentUntilMonth - 1].saldo), Math.round(s30.months[s30.fullChildRepaymentUntilMonth].saldo)])
);
ok("nadpłaty przesuwają ten miesiąc w przód (kredyt topi się szybciej)", cyk.fullChildRepaymentUntilMonth < s30.fullChildRepaymentUntilMonth, cyk.fullChildRepaymentUntilMonth + " vs " + s30.fullChildRepaymentUntilMonth);
const malyKredyt = simulateScenario(cfg({ principal: 50000, years: 30, gwarancja: 0 }));
ok("kredyt zawsze poniżej 60 000 → brak znacznika (null)", malyKredyt.fullChildRepaymentUntilMonth === null, String(malyKredyt.fullChildRepaymentUntilMonth));
ok("kredyt, który się nie amortyzuje, też nie dostaje znacznika", zaDlugi.fullChildRepaymentUntilMonth === null, String(zaDlugi.fullChildRepaymentUntilMonth));

/* ---------- 16b. wkład własny w sumie wpłat i w koszcie z lokatą ----------
   Wkład własny to wpłata kredytobiorcy w dniu startu (miesiąc 0). Bez niego większy
   wkład wyglądałby na darmowy, a „mniejszy wkład + nadpłata później" byłby karany
   za gotówkę, która w obu wariantach i tak idzie do banku — tylko w innym czasie.
   Referencja FV liczona tu z przepływów niezależnej symulacji (`refSim().flows`). */
function fvFromFlows(wkladRef, flows, lokataPct, horizon) {
  const rl = lokataPct / 100 / 12;
  let fv = wkladRef * Math.pow(1 + rl, horizon);
  flows.forEach((f, i) => { fv += f * Math.pow(1 + rl, Math.max(0, horizon - (i + 1))); });
  return fv;
}
const zWkladem = simulateScenario(cfg({ principal: 400000, wklad: 100000, gwarancja: 0, years: 30 }));
const zWklademBez = simulateScenario(cfg({ principal: 400000, gwarancja: 0, years: 30 }));
ok("silnik oddaje wkład własny w wyniku", zWkladem.wklad === 100000, "jest " + zWkladem.wklad);
near("wkład nie zmienia odsetek (kapitał przychodzi w principal)", zWkladem.totalInterest, zWklademBez.totalInterest, 0.01, " zł");
near("suma wpłat = wkład + suma wpłat bez wkładu", zWkladem.totalWplaty, 100000 + zWklademBez.totalWplaty, 0.01, " zł");
near("lokata 0 % → FV = wkład + wpłaty bez wkładu", kosztZLokata(zWkladem, 0, 360), 100000 + zWklademBez.totalWplaty, 0.01, " zł");
near("lokata 3 % → wkład rośnie jak lokata przez cały horyzont", kosztZLokata(zWkladem, 3, 360) - kosztZLokata(zWklademBez, 3, 360), 100000 * Math.pow(1 + 0.03 / 12, 360), 0.01, " zł");
ok("obrona w głąb: ujemny wkład = brak wkładu", simulateScenario(cfg({ wklad: -5000 })).wklad === 0);

/* Ta sama gotówka, różny moment: X wpłaca 100 000 więcej wkładu, Y bierze o 100 000
   większy kredyt i nadpłaca te 100 000 w m. 37 (poza oknem RKM i opłatą, gwarancja 0,
   tryb „obniż ratę”, żeby oba kredyty trwały tyle samo). Przy lokacie niższej niż
   oprocentowanie kredytu wkład z góry jest tańszy, przy wyższej — odwrotnie. */
const cashX = { principal: 300000, wklad: 200000, gwarancja: 0, gwarancjaFeePct: 0, years: 30, tryb: "obniz" };
const cashY = { principal: 400000, wklad: 100000, gwarancja: 0, gwarancjaFeePct: 0, years: 30, tryb: "obniz", events: [{ type: "jednorazowa", month: 37, amount: 100000, trybOverride: "auto" }] };
const resX = simulateScenario(cfg(cashX)), resY = simulateScenario(cfg(cashY));
const refX = refSim({ principal: 300000, ratePct: RATE, years: 30, tryb: "obniz" });
const refY = refSim({ principal: 400000, ratePct: RATE, years: 30, tryb: "obniz", oneOff: { 37: 100000 } });
const HXY = Math.max(resX.payoffMonths, resY.payoffMonths);
[3, 7].forEach((lok) => {
  near("ta sama gotówka: FV X (lokata " + lok + " %) = referencja", kosztZLokata(resX, lok, HXY), fvFromFlows(200000, refX.flows, lok, HXY), 1, " zł");
  near("ta sama gotówka: FV Y (lokata " + lok + " %) = referencja", kosztZLokata(resY, lok, HXY), fvFromFlows(100000, refY.flows, lok, HXY), 1, " zł");
});
ok(
  "lokata 3 % < kredyt 5,5 %: większy wkład z góry wychodzi taniej niż mniejszy wkład + nadpłata w m. 37",
  kosztZLokata(resX, 3, HXY) < kosztZLokata(resY, 3, HXY) && fvFromFlows(200000, refX.flows, 3, HXY) < fvFromFlows(100000, refY.flows, 3, HXY),
  Math.round(kosztZLokata(resX, 3, HXY)) + " vs " + Math.round(kosztZLokata(resY, 3, HXY))
);
ok(
  "lokata 7 % > kredyt 5,5 %: mniejszy wkład + nadpłata później wychodzi taniej",
  kosztZLokata(resY, 7, HXY) < kosztZLokata(resX, 7, HXY) && fvFromFlows(100000, refY.flows, 7, HXY) < fvFromFlows(200000, refX.flows, 7, HXY),
  Math.round(kosztZLokata(resY, 7, HXY)) + " vs " + Math.round(kosztZLokata(resX, 7, HXY))
);
const bezWkladuRoznica = (kosztZLokata(resY, 3, HXY) - resY.wklad * Math.pow(1.0025, HXY)) - (kosztZLokata(resX, 3, HXY) - resX.wklad * Math.pow(1.0025, HXY));
ok(
  "bez wkładu w FV Y wyglądałby na droższy o ponad 100 000 zł — dodatkowy wkład X byłby „darmowy”",
  bezWkladuRoznica > 100000,
  String(Math.round(bezWkladuRoznica))
);

/* Przypadek kontrolny od właściciela (cena 599 000 zł, 20 lat, 5,50 %, lokata 3 %,
   start 2027-01, opłata 3 % przez 36 mies., nadpłaty w trybie „obniż ratę”):
     A — bez RKM, wkład 200 000, bez zdarzeń,
     C — RKM, wkład 119 800 (20 % → gwarancja 0), nadpłata 80 200 w m. 37.
   Bez dziecka C jest droższe o ≈ 7 750 zł na koniec horyzontu (≈ 4 260 zł dziś);
   z 3. dzieckiem w m. 24 C jest tańsze o ≈ 117 500 zł. */
const kontrolaBase = { ratePct: 5.5, years: 20, startDate: "2027-01-01", tryb: "obniz", feePct: 3, feeMonths: 36 };
const kA = simulateScenario(Object.assign({}, kontrolaBase, { principal: 399000, wklad: 200000, gwarancja: 0, gwarancjaFeePct: 0, events: [] }));
const gwC = gwarancjaBGK({ cena: 599000, wklad: 119800, remont: 0 });
function kontrolaC(zDzieckiem) {
  const evts = [{ type: "jednorazowa", month: 37, amount: 80200, trybOverride: "auto" }];
  if (zDzieckiem) evts.push({ type: "dziecko", month: 24, amount: 60000, childNumber: 3, trybOverride: "auto" });
  return simulateScenario(Object.assign({}, kontrolaBase, { principal: 479200, wklad: 119800, gwarancja: gwC, events: evts }));
}
const kC = kontrolaC(false), kC3 = kontrolaC(true);
const kH = Math.max(kA.payoffMonths, kC.payoffMonths);
const kDisc = Math.pow(1 + 0.03 / 12, kH);
ok("kontrola: gwarancja C = 0 (wkład równo 20 %)", gwC === 0, String(gwC));
ok("kontrola: wspólny horyzont 240 mies.", kH === 240, String(kH));
ok("kontrola: nadpłata w m. 37 bez opłaty i bez naruszenia reguły", kC.totalFees === 0 && kC.rkmBreachMonth === null && kC3.rkmBreachMonth === null);
const kDiff = kosztZLokata(kC, 3, kH) - kosztZLokata(kA, 3, kH);
const kDiff3 = kosztZLokata(kC3, 3, kH) - kosztZLokata(kA, 3, kH);
near("kontrola: bez dziecka C droższe o ≈ 7 750 zł na koniec horyzontu", kDiff, 7750, 50, " zł");
near("kontrola: to ≈ 4 260 zł w dzisiejszych pieniądzach", kDiff / kDisc, 4260, 50, " zł");
near("kontrola: z 3. dzieckiem w m. 24 C tańsze o ≈ 117 500 zł", kDiff3, -117500, 50, " zł");
const kRefA = refSim({ principal: 399000, ratePct: 5.5, years: 20, tryb: "obniz", feePct: 3, feeMonths: 36 });
const kRefC = refSim({ principal: 479200, ratePct: 5.5, years: 20, tryb: "obniz", feePct: 3, feeMonths: 36, oneOff: { 37: 80200 } });
near("kontrola: różnica = referencja", kDiff, fvFromFlows(119800, kRefC.flows, 3, kH) - fvFromFlows(200000, kRefA.flows, 3, kH), 1, " zł");

/* ---------- 18. okresowo stała stopa ----------
   Plan oprocentowania (RKM.planOprocentowania): stopa stała do m. 12·L, w m. 12·L + 1
   zmiana na marża + wskaźnik obowiązujący w tym momencie; zmiany wskaźnika wewnątrz
   okresu stałej stopy nie zmieniają raty. */
const { planOprocentowania, feeMonthsMax } = RKM;
ok("silnik wystawia planOprocentowania / feeMonthsMax", typeof planOprocentowania === "function" && typeof feeMonthsMax === "function");
const planZm = planOprocentowania({ marza: 1.9, wskaznik: 3.6, stopa: "zmienna", zmianyWskaznika: [{ month: 24, newWskaznik: 5.6 }] });
ok("stopa zmienna: stopa = marża + wskaźnik, zmiana wskaźnika = zmiana stopy od jej miesiąca",
  planZm.ratePct === 5.5 && planZm.fixedMonths === 0 && planZm.events.length === 1 && planZm.events[0].month === 24 && planZm.events[0].newRatePct === 7.5,
  JSON.stringify(planZm));
const planSt = planOprocentowania({ marza: 1.9, wskaznik: 3.6, stopa: "stala", stalaPct: 5.8, stalaLata: 5, zmianyWskaznika: [{ month: 24, newWskaznik: 5.6 }, { month: 80, newWskaznik: 2.6 }] });
ok("stała 5,80 % na 5 lat: stopa początkowa 5,80 %, okres 60 mies., przejście w m. 61",
  planSt.ratePct === 5.8 && planSt.fixedMonths === 60 && planSt.switchMonth === 61, JSON.stringify(planSt));
ok("przejście w m. 61 na marżę + wskaźnik z m. 24 (1,90 + 5,60 = 7,50 %)",
  planSt.events[0].month === 61 && planSt.events[0].newRatePct === 7.5 && planSt.rateAfterPct === 7.5, JSON.stringify(planSt.events));
ok("zmiana wskaźnika po okresie stałej stopy działa normalnie (m. 80 → 4,50 %)",
  planSt.events.length === 2 && planSt.events[1].month === 80 && planSt.events[1].newRatePct === 4.5, JSON.stringify(planSt.events));
ok("zmiana wskaźnika w okresie stałej stopy oznaczona jako bez wpływu", JSON.stringify(planSt.ignoredMonths) === "[24]", JSON.stringify(planSt.ignoredMonths));
const planBez = planOprocentowania({ marza: 1.9, wskaznik: 3.6, stopa: "stala", stalaPct: 5.8, stalaLata: 5, zmianyWskaznika: [] });
ok("bez zmian wskaźnika przejście na marżę + wskaźnik wyjściowy (5,50 %)", planBez.events.length === 1 && planBez.events[0].newRatePct === 5.5, JSON.stringify(planBez.events));
const planM61 = planOprocentowania({ marza: 1.9, wskaznik: 3.6, stopa: "stala", stalaPct: 5.8, stalaLata: 5, zmianyWskaznika: [{ month: 61, newWskaznik: 4.1 }] });
ok("zmiana wskaźnika dokładnie w m. przejścia wchodzi w przejście (bez duplikatu)", planM61.events.length === 1 && planM61.events[0].newRatePct === 6 && planM61.ignoredMonths.length === 0, JSON.stringify(planM61));
ok("okres stałej stopy przycinany do 1–10 lat",
  planOprocentowania({ stopa: "stala", stalaLata: 0 }).fixedMonths === 12 && planOprocentowania({ stopa: "stala", stalaLata: 15 }).fixedMonths === 120,
  planOprocentowania({ stopa: "stala", stalaLata: 0 }).fixedMonths + " / " + planOprocentowania({ stopa: "stala", stalaLata: 15 }).fixedMonths);

/* Symulacja z tym planem: odsetki do m. 60 stopą 5,80 %, od m. 61 stopą 7,50 %,
   a rata w m. 61 przeliczona annuitetem na pozostałe 180 mies. od salda po m. 60. */
const PST = 400000;
const stSim = simulateScenario(cfg({ principal: PST, gwarancja: 0, years: 20, ratePct: planSt.ratePct, fixedRateMonths: planSt.fixedMonths, events: planSt.events }));
const stRef = refSim({ principal: PST, ratePct: 5.8, years: 20, rates: { 61: 7.5, 80: 4.5 } });
const rSt = 5.8 / 100 / 12, rPo = 7.5 / 100 / 12;
near("stała stopa: rata początkowa wg 5,80 %", stSim.initialRata, rataRef(PST, rSt, 240), 0.01, " zł");
near("stała stopa: odsetki m. 60 wg 5,80 %", stSim.months[59].odsetki, stSim.months[58].saldo * rSt, 0.01, " zł");
near("po przejściu: odsetki m. 61 wg 7,50 %", stSim.months[60].odsetki, stSim.months[59].saldo * rPo, 0.01, " zł");
near("rata m. 60 = rata początkowa (bez zmian w okresie stałej stopy)", stSim.months[59].rata, stSim.initialRata, 0.01, " zł");
near("rata m. 61 przeliczona na pozostałe 180 mies.", stSim.months[60].rata, rataRef(stSim.months[59].saldo, rPo, 180), 0.01, " zł");
near("stała stopa: odsetki = referencja", stSim.totalInterest, stRef.totalInterest, 1, " zł");
near("stała stopa: miesiąc spłaty = referencja", stSim.payoffMonths, stRef.payoffMonths, 1, " mies.");
const stSimBez = simulateScenario(cfg({ principal: PST, gwarancja: 0, years: 20, ratePct: 5.8, fixedRateMonths: 60,
  events: planOprocentowania({ marza: 1.9, wskaznik: 3.6, stopa: "stala", stalaPct: 5.8, stalaLata: 5, zmianyWskaznika: [{ month: 80, newWskaznik: 2.6 }] }).events }));
const stSimZ24 = simulateScenario(cfg({ principal: PST, gwarancja: 0, years: 20, ratePct: 5.8, fixedRateMonths: 60,
  events: planOprocentowania({ marza: 1.9, wskaznik: 3.6, stopa: "stala", stalaPct: 5.8, stalaLata: 5, zmianyWskaznika: [{ month: 24, newWskaznik: 5.6 }, { month: 80, newWskaznik: 2.6 }] }).events }));
ok("zmiana wskaźnika w m. 24 nie zmienia żadnej raty w okresie stałej stopy",
  stSimBez.months.slice(0, 60).every((mo, i) => Math.abs(mo.rata - stSimZ24.months[i].rata) < 0.005 && Math.abs(mo.odsetki - stSimZ24.months[i].odsetki) < 0.005));
ok("…ale ustala wskaźnik na moment przejścia (rata m. 61 wyższa)", stSimZ24.months[60].rata > stSimBez.months[60].rata + 1,
  Math.round(stSimZ24.months[60].rata) + " vs " + Math.round(stSimBez.months[60].rata));

/* Opłata za wcześniejszą spłatę w okresie stałej stopy — art. 40 ust. 6: bank „może
   pobierać rekompensatę w tym okresie"; pułapy z ust. 3 (3 %, odsetki za rok) dotyczą
   wyłącznie rekompensaty z ust. 2 (stopa zmienna, 36 mies.). */
ok("okno opłaty: stopa zmienna 36 mies.", feeMonthsMax({ stopa: "zmienna" }) === 36);
ok("okno opłaty: stała na 5 lat → 60 mies. (cały okres stałej stopy)", feeMonthsMax({ stopa: "stala", stalaLata: 5 }) === 60);
ok("okno opłaty: stała na 10 lat → 120 mies.", feeMonthsMax({ stopa: "stala", stalaLata: 10 }) === 120);
ok("okno opłaty: stała na 2 lata → 36 mies. (ust. 2 po przejściu na zmienną)", feeMonthsMax({ stopa: "stala", stalaLata: 2 }) === 36);
function oplataStala(o) {
  return simulateScenario(cfg(Object.assign({ gwarancja: 0, years: 20, feePct: 3 }, o, {
    events: [{ type: "jednorazowa", month: o.at, amount: 10000, trybOverride: "auto" }]
  }))).totalFees;
}
near("stała 5 lat: nadpłata w m. 37 płaci 3 % (bez limitu 36 mies.)", oplataStala({ ratePct: 5.8, fixedRateMonths: 60, feeMonths: 60, at: 37 }), 300, 0.01, " zł");
near("stała 5 lat, stopa 2 %: bez pułapu odsetek za rok (300 zł, nie 200 zł)", oplataStala({ ratePct: 2, fixedRateMonths: 60, feeMonths: 60, at: 50 }), 300, 0.01, " zł");
near("stała 5 lat: umowne 5 % bez przycięcia do 3 %", oplataStala({ ratePct: 5.8, fixedRateMonths: 60, feeMonths: 60, feePct: 5, at: 12 }), 500, 0.01, " zł");
ok("stała 5 lat: po okresie stałej stopy (m. 61) opłaty już nie ma", oplataStala({ ratePct: 5.8, fixedRateMonths: 60, feeMonths: 120, at: 61 }) === 0);
ok("okno z umowy nadal obowiązuje w okresie stałej stopy (36 mies. z umowy → m. 37 bez opłaty)", oplataStala({ ratePct: 5.8, fixedRateMonths: 60, feeMonths: 36, at: 37 }) === 0);
/* Stała na 2 lata, potem zmienna 2 %: w m. 20 stawka z umowy (ust. 6), w m. 30 —
   już reżim zmienny do 36. miesiąca, więc pułap odsetek za rok (200 zł). */
const plan2 = planOprocentowania({ marza: 1, wskaznik: 1, stopa: "stala", stalaPct: 2, stalaLata: 2 });
function oplata2(at) {
  return simulateScenario(cfg({ gwarancja: 0, years: 20, feePct: 3, feeMonths: 36, ratePct: plan2.ratePct, fixedRateMonths: plan2.fixedMonths, events: plan2.events.concat([{ type: "jednorazowa", month: at, amount: 10000, trybOverride: "auto" }]) })).totalFees;
}
near("stała 2 lata (2 %): nadpłata w m. 20 — stawka z umowy 300 zł (ust. 6)", oplata2(20), 300, 0.01, " zł");
near("stała 2 lata, potem zmienna 2 %: nadpłata w m. 30 — pułap odsetek za rok 200 zł (ust. 2–3)", oplata2(30), 200, 0.01, " zł");
ok("stała 2 lata: nadpłata w m. 37 — bez opłaty (ust. 2)", oplata2(37) === 0);
near("stała 2 lata: m. 30 = referencja", oplata2(30),
  refSim({ principal: P, ratePct: 2, years: 20, rates: { 25: 2 }, fixedMonths: 24, oneOff: { 30: 10000 }, feePct: 3, feeMonths: 36 }).totalFees, 0.01, " zł");
near("stała 5 lat: m. 50 = referencja", oplataStala({ ratePct: 2, fixedRateMonths: 60, feeMonths: 60, at: 50 }),
  refSim({ principal: P, ratePct: 2, years: 20, fixedMonths: 60, oneOff: { 50: 10000 }, feePct: 3, feeMonths: 60 }).totalFees, 0.01, " zł");

/* ---------- 19. limit wkładu własnego przy stopie stałej (art. 5 ust. 1 pkt 5 lit. b) ----------
   30 % wydatków, gdy stopa jest stała na co najmniej 5 lat; krócej — 20 %. Wzór gwarancji
   bez zmian (domyka do 20 %), więc przy wkładzie 20–30 % gwarancja wynosi zero. */
ok("stała na 5 lat: wkład 150 000 z 500 000 (30 %) mieści się w limicie", issuesOf({ cena: 500000, wklad: 150000, remont: 0, stala: true, stalaLata: 5 }) === "", issuesOf({ cena: 500000, wklad: 150000, remont: 0, stala: true, stalaLata: 5 }));
const l30 = rkmLimitIssues({ cena: 500000, wklad: 150000, remont: 0, stala: true, stalaLata: 5 });
ok("stała na 5 lat: limit 30 % i 150 000 zł", l30.maxWkladPct === 30 && Math.abs(l30.maxWklad - 150000) < 0.01 && l30.stala30 === true, JSON.stringify(l30));
near("wkład 30 % → gwarancja 0 (domyka tylko do 20 %)", l30.gwarancja, 0, 0.01, " zł");
ok("stała na 3 lata: wkład 30 % przekracza limit 20 %", issuesOf({ cena: 500000, wklad: 150000, remont: 0, stala: true, stalaLata: 3 }) === "wklad_pct", issuesOf({ cena: 500000, wklad: 150000, remont: 0, stala: true, stalaLata: 3 }));
ok("stała na 3 lata: limit zostaje 20 %", rkmLimitIssues({ cena: 500000, wklad: 150000, remont: 0, stala: true, stalaLata: 3 }).maxWkladPct === 20);
ok("stopa zmienna: wkład 30 % przekracza limit 20 %", issuesOf({ cena: 500000, wklad: 150000, remont: 0 }) === "wklad_pct");
ok("stała na 5 lat: wkład 32 % przekracza limit 30 %", issuesOf({ cena: 500000, wklad: 160000, remont: 0, stala: true, stalaLata: 5 }) === "wklad_pct");
ok("stała na 5 lat: 26 % z 800 000 = 208 000 > 200 000 zł (art. 3 ust. 3 pkt 1)", issuesOf({ cena: 800000, wklad: 208000, remont: 0, stala: true, stalaLata: 5 }) === "wklad_kwota", issuesOf({ cena: 800000, wklad: 208000, remont: 0, stala: true, stalaLata: 5 }));
ok("stała na 10 lat też daje 30 %", rkmLimitIssues({ cena: 500000, wklad: 0, remont: 0, stala: true, stalaLata: 10 }).maxWkladPct === 30);
ok("próg 20 % (do gwarancji) nie zależy od stopy", rkmLimitIssues({ cena: 500000, wklad: 0, remont: 0, stala: true, stalaLata: 5 }).prog20 === 100000);

/* ---------- podsumowanie ---------- */
if (failures > 0) {
  console.error("\n" + failures + " z " + checks + " testów nie przeszło.");
  process.exit(1);
}
console.log("OK — " + checks + " testów silnika przeszło (public/index.html, <script id=\"engine\">).");
