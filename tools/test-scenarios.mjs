#!/usr/bin/env node
/**
 * Testy podstrony „Gotowe porównania” (public/scenariusze.html).
 *
 *  1. ŚWIEŻOŚĆ — plik na dysku musi być bajt w bajt tym, co wypluwa
 *     tools/build-scenarios.mjs. Zapomniana regeneracja po zmianie
 *     tools/scenarios.json albo silnika wywala CI.
 *  2. ODCZYTYWALNOŚĆ LINKÓW — każdy href="/#s=d.…" jest rozpakowywany tak, jak
 *     zrobi to przeglądarka (inflate-raw → JSON → RKM.expandState), a odzyskany
 *     stan musi mieć bieżącą wersję, poprawny kształt i dawać się policzyć.
 *  3. TREŚĆ SCENARIUSZY — po jednym twardym stwierdzeniu na kartę, żeby zmiana
 *     silnika nie zmieniła po cichu tego, co karta obiecuje („tu przepada spłata
 *     rodzinna”, „tu gwarancja wynosi zero”, „tu rata rośnie”).
 *
 * Uruchomienie:  node tools/test-scenarios.mjs
 * Zero zależności, Node >= 20.
 */

import { readFileSync } from "node:fs";
import { inflateRawSync } from "node:zlib";
import { buildHtml, loadEngine, toEngineConfig, validateState, OUT_PATH, SCENARIOS_PATH } from "./build-scenarios.mjs";

const RKM = loadEngine();

let failures = 0;
let checks = 0;
function ok(name, cond, detail) {
  checks++;
  if (cond) return;
  failures++;
  console.error("FAIL  " + name + (detail ? "  — " + detail : ""));
}
function eq(name, actual, expected) {
  ok(name, actual === expected, "oczekiwano " + JSON.stringify(expected) + ", jest " + JSON.stringify(actual));
}

/* ---------- 1. świeżość wygenerowanego pliku ---------- */
const onDisk = readFileSync(OUT_PATH, "utf8");
const rebuilt = buildHtml();
ok(
  "public/scenariusze.html jest aktualny wobec tools/scenarios.json i silnika",
  onDisk === rebuilt,
  "uruchom „node tools/build-scenarios.mjs” i dołóż wynik do commitu (na dysku " +
    onDisk.length + " znaków, z generatora " + rebuilt.length + ")"
);

/* ---------- 2. każdy link daje się odczytać ---------- */
const scenarios = JSON.parse(readFileSync(SCENARIOS_PATH, "utf8"));
const links = [...onDisk.matchAll(/href="\/#s=d\.([A-Za-z0-9_-]+)"/g)].map((m) => m[1]);
eq("liczba linków #s= na stronie", links.length, scenarios.length);

const decoded = [];
links.forEach((payload, i) => {
  const at = "link " + (i + 1) + " (" + (scenarios[i] ? scenarios[i].id : "?") + ")";
  let st = null;
  try {
    const json = new TextDecoder().decode(inflateRawSync(Buffer.from(RKM.b64urlToBytes(payload))));
    st = RKM.expandState(JSON.parse(json));
  } catch (e) {
    ok(at + ": ładunek rozpakowuje się", false, String(e && e.message));
  }
  decoded.push(st);
  if (!st) return;
  eq(at + ": wersja stanu", st.v, RKM.STATE_VERSION);
  const errs = validateState(st, RKM);
  ok(at + ": kształt stanu po odczytaniu", errs.length === 0, errs.join("; "));
  // Zdarzenia dostają w dekoderze świeże `id` — kalkulator używa ich jako uchwytów UI.
  ["A", "B"].forEach((k) => {
    ok(at + "." + k + ": zdarzenia mają id nadane przez dekoder",
      st[k].events.every((e) => typeof e.id === "string" && e.id.length > 0));
  });
  // Ten sam stan, ta sama liczba zdarzeń co w źródle.
  const src = scenarios[i].state;
  ["A", "B"].forEach((k) => {
    eq(at + "." + k + ": liczba zdarzeń", st[k].events.length, src[k].events.length);
    eq(at + "." + k + ": tryb RKM", st[k].rkm, src[k].rkm);
    eq(at + "." + k + ": okres (lata)", st[k].years, src[k].years);
  });
  eq(at + ": chartMode", st.chartMode, src.chartMode);
  ["A", "B"].forEach((k) => {
    let res = null;
    try { res = RKM.simulateScenario(toEngineConfig(st[k], RKM)); } catch (e) { /* niżej */ }
    ok(at + "." + k + ": symulacja się liczy", !!res && Array.isArray(res.months) && res.months.length > 0);
  });
});

/* ---------- 3. twierdzenia poszczególnych kart ---------- */
function byId(id) {
  const i = scenarios.findIndex((s) => s.id === id);
  if (i < 0 || !decoded[i]) return null;
  const st = decoded[i];
  return {
    A: RKM.simulateScenario(toEngineConfig(st.A, RKM)),
    B: RKM.simulateScenario(toEngineConfig(st.B, RKM)),
    st
  };
}

/* Karta 1: nadpłata 150 000 zł w m. 6 przekracza pozostałą gwarancję i odbiera
   spłatę rodzinną za trzecie dziecko; ta sama nadpłata w m. 37 (po oknie) nie. */
const s1 = byId("nadplata-teraz-czy-po-trzech-latach");
ok("karta 1: stan odczytany", !!s1);
if (s1) {
  eq("karta 1 / A: miesiąc naruszenia reguły", s1.A.rkmBreachMonth, 6);
  ok("karta 1 / A: spłata rodzinna oznaczona jako utracona",
    s1.A.eventLog.some((e) => e.type === "dziecko-lost"));
  eq("karta 1 / A: wypłacona spłata rodzinna", s1.A.totalSplataRodzinna, 0);
  eq("karta 1 / B: brak naruszenia reguły", s1.B.rkmBreachMonth, null);
  ok("karta 1 / B: brak wpisu o utraconej spłacie",
    !s1.B.eventLog.some((e) => e.type === "dziecko-lost"));
  eq("karta 1 / B: wypłacona spłata rodzinna", s1.B.totalSplataRodzinna, 60000);
}

/* Karta 2: kredyt na 15 lat i kredyt na 30 lat z nadpłatą różnicy rat kończą się
   w tym samym miesiącu — to jest teza karty, nie liczba przepisana z silnika. */
const s2 = byId("pietnascie-czy-trzydziesci-lat");
ok("karta 2: stan odczytany", !!s2);
if (s2) {
  ok("karta 2: oba warianty spłacają się w tym samym miesiącu",
    Math.abs(s2.A.payoffMonths - s2.B.payoffMonths) <= 1,
    "A " + s2.A.payoffMonths + " mies., B " + s2.B.payoffMonths + " mies.");
  ok("karta 2: rata początkowa A wyższa niż B", s2.A.initialRata > s2.B.initialRata);
  ok("karta 2: B płaci opłatę za wcześniejszą spłatę, A nie",
    s2.B.totalFees > 0 && s2.A.totalFees === 0);
}

/* Karta 3: przy wkładzie równym 20 % wydatków gwarancja BGK wynosi zero — to na
   tym stoi cała karta (każda nadpłata w oknie odbiera spłaty rodzinne). */
const s3 = byId("rkm-czy-zwykly-kredyt");
ok("karta 3: stan odczytany", !!s3);
if (s3) {
  const gw = RKM.gwarancjaBGK({ cena: s3.st.A.cena, wklad: s3.st.A.wklad, remont: s3.st.A.remont });
  eq("karta 3 / A: gwarancja BGK", gw, 0);
  eq("karta 3 / A: gwarancja w wyniku symulacji", s3.A.gwarancja, 0);
  eq("karta 3 / A: wypłacona spłata rodzinna", s3.A.totalSplataRodzinna, 20000);
  ok("karta 3 / B: zwykły kredyt spłaca się szybciej", s3.B.payoffMonths < s3.A.payoffMonths);
}

/* Karta 4: wzrost wskaźnika podnosi ratę i nie schodzi z niej do końca okresu. */
const s4 = byId("wskaznik-w-gore-o-2-pp");
ok("karta 4: stan odczytany", !!s4);
if (s4) {
  ok("karta 4 / B: rata po zdarzeniu wyższa niż początkowa",
    s4.B.finalRata > s4.B.initialRata,
    "początkowa " + Math.round(s4.B.initialRata) + " zł, końcowa " + Math.round(s4.B.finalRata) + " zł");
  ok("karta 4 / A: rata bez zmian", Math.abs(s4.A.finalRata - s4.A.initialRata) < 0.5);
  ok("karta 4 / B: więcej odsetek niż w A", s4.B.totalInterest > s4.A.totalInterest);
  eq("karta 4: wykres otwiera się w trybie „Rata”", s4.st.chartMode, "rata");
}

/* Karta 5: „skróć okres” kończy kredyt wcześniej i taniej niż „obniż ratę”. */
const s5 = byId("skrocic-okres-czy-obnizyc-rate");
ok("karta 5: stan odczytany", !!s5);
if (s5) {
  ok("karta 5 / A: krótszy okres niż B", s5.A.payoffMonths < s5.B.payoffMonths,
    "A " + s5.A.payoffMonths + " mies., B " + s5.B.payoffMonths + " mies.");
  ok("karta 5 / A: mniej odsetek niż B", s5.A.totalInterest < s5.B.totalInterest,
    "A " + Math.round(s5.A.totalInterest) + " zł, B " + Math.round(s5.B.totalInterest) + " zł");
  ok("karta 5 / B: niższa rata na koniec", s5.B.finalRata < s5.B.initialRata);
}

/* ---------- podsumowanie ---------- */
if (failures) {
  console.error("\n" + failures + " z " + checks + " sprawdzeń nie przeszło.");
  process.exit(1);
}
console.log("OK — " + checks + " sprawdzeń przeszło (public/scenariusze.html, " + links.length + " linków #s=).");
