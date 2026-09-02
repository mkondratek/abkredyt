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
      rkmThreshold: 100000,
      rkmMonths: 36,
      ignorujRegule: false,
      events: [],
    },
    over
  );
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

/* ---------- 4. reguła RKM: przekroczenie progu odbiera spłatę rodzinną ---------- */
const przekroczenie = [
  { type: "jednorazowa", month: 1, amount: 150000, trybOverride: "auto" },
  { type: "dziecko", month: 24, amount: 60000, childNumber: 3, trybOverride: "auto" },
];
const zRegula = simulateScenario(cfg({ years: 30, events: przekroczenie, ignorujRegule: false }));
const bezReguly = simulateScenario(cfg({ years: 30, events: przekroczenie, ignorujRegule: true }));

ok("próg przekroczony w m. 1", zRegula.rkmBreachMonth === 1, "jest " + zRegula.rkmBreachMonth);
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

/* ---------- 5. wyższa rata umowna (krótszy okres) nie zużywa progu ---------- */
/* To kluczowa reguła modelu: formalnie 15 lat płaci ~4 699 zł/mies. zamiast 3 249 zł,
   ale nadwyżka nie jest przedterminową spłatą — licznik nadpłat zostaje na 0. */
const krotszyOkres = simulateScenario(
  cfg({ years: 15, events: [{ type: "dziecko", month: 24, amount: 60000, childNumber: 3, trybOverride: "auto" }] })
);
ok("15 lat: licznik nadpłat dobrowolnych = 0", krotszyOkres.voluntaryOverpayWindow === 0, "jest " + krotszyOkres.voluntaryOverpayWindow);
ok("15 lat: próg nieprzekroczony", krotszyOkres.rkmBreachMonth === null, "jest " + krotszyOkres.rkmBreachMonth);
near("15 lat: spłata rodzinna zaliczona (60 000 zł)", krotszyOkres.totalSplataRodzinna, 60000, 1, " zł");

/* Kontrola: „elastyczne 15” (30 lat + nadpłata 1 450/mies.) zużywa próg. */
const elastyczne15 = simulateScenario(
  cfg({ years: 30, events: [{ type: "cykliczna", startMonth: 1, endMonth: 360, monthlyAmount: 1450, trybOverride: "auto" }] })
);
ok(
  "„elastyczne 15” zużywa próg nadpłat w 36 mies. (~52 tys.)",
  elastyczne15.voluntaryOverpayWindow > 50000 && elastyczne15.voluntaryOverpayWindow < 54000,
  "jest " + Math.round(elastyczne15.voluntaryOverpayWindow)
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
