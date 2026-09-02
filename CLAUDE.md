# Kalkulator RKM — porównanie scenariuszy kredytu hipotecznego

Jednoplikowa aplikacja (`public/index.html`, czysty HTML/CSS/JS, bez zależności) do porównywania
dwóch scenariuszy spłaty kredytu hipotecznego (A vs B) z wydarzeniami w czasie, ze
świadomością zasad polskiego programu Rodzinny Kredyt Mieszkaniowy (RKM). Język UI: polski.
Opublikowana pod https://abkredyt.kondratek.pl (Cloudflare Pages, repo publiczne
`mkondratek/abkredyt`). Dane domyślne są ilustracyjne i mają takie pozostać — nie wpisuj
tu żadnych realnych ofert ani prywatnych parametrów. Dalsze plany: `ROADMAP.md`.

## Katalog `docs/` jest lokalny, niepublikowany
`docs/` (research zasad RKM z cytatami, przegląd kalkulatorów, wnioski z modelu) jest w
`.gitignore` — istnieje tylko na dysku autora, nie w repo. Odwołania do `docs/…` poniżej
działają wyłącznie lokalnie; w README streszczaj zamiast linkować.

## Dlaczego istnieje (research rynku, 09.2026 — lokalnie `docs/kalkulatory-rynek.md`)
Żaden znaleziony kalkulator (bankier, totalmoney, hipoteczny.pl, kalkulator.pl, Expander, Iwuć)
nie łączy: (1) wielu wydarzeń w czasie (nadpłaty jednorazowe + cykliczne, zmiany stopy),
(2) porównania dwóch dowolnie skonfigurowanych scenariuszy obok siebie, (3) logiki RKM
(spłata rodzinna 20k/60k po urodzeniu dziecka, limit nadpłat w pierwszych 3 latach). Najbliżej
jest Expander (wiele zdarzeń, ale tylko porównanie z „bez nadpłat”).

## Silnik (`public/index.html`, `<script id="engine">`)
- Czysta logika (bez DOM/localStorage) siedzi w osobnym `<script id="engine">` i jest
  wystawiona jako `globalThis.RKM`; `tools/test-engine.mjs` wycina ten blok regexem i
  odpala go w Node — każdą zmianę silnika dokładaj z przypadkiem regresyjnym tam.
- Rata równa (annuitet), kapitalizacja miesięczna, `r = nominal/12`. Weryfikacja: 579 200 zł /
  5,39% / 30 lat → 3 249 zł; 15 lat → 4 699 zł.
- Oprocentowanie w UI = marża + wskaźnik referencyjny (WIBOR/WIRON); silnik dostaje stopę
  nominalną. Presetów banków nie ma i nie dodawaj ich (to była personalizacja).
- Wydarzenia: nadpłata jednorazowa, nadpłata cykliczna (od–do miesiąca), narodziny dziecka →
  spłata rodzinna (20 000 dla 2. dziecka, 60 000 dla 3.+; capped do salda), zmiana wskaźnika
  (UI: `zmiana_wskaznika`, nowy wskaźnik → silnik: `zmiana_oprocentowania` z nominalną =
  marża + wskaźnik). Tryb nadpłat globalny + per zdarzenie: „skróć okres” (rata bez zmian) /
  „obniż ratę” (okres bez zmian). Zmiana stopy zawsze przelicza ratę.
- Przełącznik „Kredyt w programie RKM” (`state.rkmOn`, atrybut `data-rkm` na `<html>`):
  wyłączony chowa moduł RKM (gwarancja, reguła, spłata rodzinna, KPI nadpłat), filtruje
  zdarzenia `dziecko` z konfiguracji silnika i luzuje okres do 5–35 lat.
- Opłata za wcześniejszą spłatę: % przez N miesięcy, dotyczy tylko nadpłat dobrowolnych
  (nie spłaty rodzinnej).
- Reguła RKM (oznaczona w UI „do weryfikacji”): jeśli w pierwszych 36 mies. suma nadpłat
  DOBROWOLNYCH przekroczy próg (domyślnie = kwota gwarancji BGK, 100 000), spłaty rodzinne
  przypadające PO przekroczeniu są oznaczane „utracona” i pomijane; checkbox „ignoruj regułę”.
  Wyższa rata umowna (krótszy okres) NIE jest nadpłatą i nie zużywa progu — to celowe i
  kluczowe (patrz lokalnie `docs/wnioski-modelu.md`).
- Stan w `localStorage` (klucz `abkredyt-state-v2`), w try/catch, z kontrolą kształtu
  (`looksLikeState`) — przy zmianie schematu stanu podbij sufiks klucza.

## Zasady RKM — skrót (pełny research z cytatami: lokalnie `docs/zasady-rkm.md`)
Spłata rodzinna: 20k (2. dziecko) / 60k (3.+), dziecko urodzone po umowie, wniosek do banku
do 12 mies., zmniejsza kapitał; 5-letni zakaz sprzedaży/wynajmu (zwrot proporcjonalny).
Warunek: w ciągu 3 lat od udzielenia kredytu brak przedterminowej spłaty ponad część objętą
gwarancją BGK (art. 7 ust. 1 pkt 6 — brzmienie NIE zweryfikowane z tekstem ustawy; strony
isap/BGK były niedostępne). Wkład własny max 20% (zmienna) / 30% (stała), wkład+gwarancja
≤ 200k; gwarancja ≤ 100k, koszt 1%. Okres 15–35 lat. Refinansowanie = utrata spłaty rodzinnej.
Data końca programu (~2030) niepotwierdzona.

## Konwencje
- Jeden plik, bez bundlera, bez bibliotek; wykres w inline SVG. Fonty wyłącznie systemowe
  (tokeny `--font-sans/--font-serif/--font-mono`) — żadnych zewnętrznych żądań poza beaconem
  Cloudflare Web Analytics; CSP w `public/_headers` i tak by je zablokowała.
- Plik strony to `public/index.html` (katalog `public/` jest build output directory
  dla Cloudflare Pages — patrz `DEPLOY.md`); reszta `public/` to statyczne towarzyszące
  pliki (`_headers`, `robots.txt`, `sitemap.xml`, `404.html`, `favicon.svg`, `og.png`
  generowany z `og-image.html`, `polityka-prywatnosci.html`).
- Analityka: placeholder `CF_ANALYTICS_TOKEN` na końcu `index.html`; dopóki stoi, beacon
  się nie ładuje. Token wkleja właściciel (DEPLOY.md), nie commituj go z automatu.
- Motyw jasny/ciemny przez tokeny CSS na `:root` (+ `prefers-color-scheme`, `[data-theme]`).
- Formatowanie liczb: spacje jako separator tysięcy, „zł”.
- Test: `python3 tools/shot.py` robi pełny screenshot `public/index.html` przez Playwright
  (chromium) i zgłasza błędy konsoli, kończąc się kodem != 0, gdy są jakiekolwiek — to on
  jest testem dymnym w CI (`.github/workflows/ci.yml`, razem z `tools/check-html.mjs`
  i `node tools/test-engine.mjs`). Lokalnie bez instalowania Playwrighta:
  `PW_CHANNEL=chrome uv run --with playwright python tools/shot.py` (używa systemowego Chrome).
- Zawsze utrzymuj widoczny disclaimer „poglądowe, reguły RKM do weryfikacji w banku” i datę
  wersji zasad (ustawa jest nowelizowana).
- Wdrożenie na Cloudflare Pages: checklista krok po kroku w `DEPLOY.md`.
