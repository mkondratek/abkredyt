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
- Reguła RKM (zweryfikowana z tekstem ustawy 02.09.2026, patrz niżej): część kredytu objęta
  gwarancją BGK maleje z każdą spłatą kapitału (rata, nadpłata dobrowolna, spłata rodzinna —
  art. 4a ust. 6). W pierwszych 36 mies. nadpłata DOBROWOLNA jest bezpieczna tylko do
  wysokości *aktualnej* (nie początkowej) części gwarantowanej; próg jest więc ruchomy, nie
  stały jak wcześniej modelowano. Rata umowna sama w sobie nigdy nie narusza reguły (to nie
  nadpłata), ale zużywa gwarantowaną część, więc krótszy okres zmniejsza dostępny zapas na
  przyszłe nadpłaty — nie jest już „neutralny", jak wcześniej zakładano. Bez gwarancji BGK
  (wkład ≥ 20%) próg wynosi zero: każda przedterminowa spłata w oknie narusza regułę. Skutek
  naruszenia to WYŁĄCZNIE utrata przyszłych spłat rodzinnych — już wypłacone nie podlegają
  zwrotowi (art. 8 ust. 7 nie wymienia tego jako podstawy zwrotu). Spłaty rodzinne
  przypadające po naruszeniu są oznaczane „utracona” i pomijane; checkbox „ignoruj regułę”
  zostaje. Uproszczenie silnika: okno 36 mies. liczone od miesiąca uruchomienia kredytu, nie
  od dnia jego udzielenia (zawarcia umowy), jak dosłownie stanowi ustawa — to świadome
  uproszczenie (patrz lokalnie `docs/wnioski-modelu.md` dla wcześniejszego modelu).
- Scenariusz nie ma już pól `rkmThreshold`/`rkmMonths` w stanie — próg to `gwarancja`
  (dynamiczny, patrz wyżej), a okno to stała silnika `RKM_WINDOW_MONTHS` (36 mies.).
- Stan w `localStorage` (klucz `abkredyt-state-v3`), w try/catch, z kontrolą kształtu
  (`looksLikeState`) — przy zmianie schematu stanu podbij sufiks klucza.

## Zasady RKM — skrót (pełny research z cytatami: lokalnie `docs/zasady-rkm.md`)
Zweryfikowane 02.09.2026 z tekstem jednolitym ustawy z 1.10.2021 o rodzinnym kredycie
mieszkaniowym i bezpiecznym kredycie 2% — **Dz.U. 2024 poz. 1724** (stan prawny 30.10.2024),
przeczytanym przez Sejmowe API ELI (`https://api.sejm.gov.pl/eli/acts/DU/2024/1724/text.html`
— nie CAPTCHA-gated, w odróżnieniu od isap.sejm.gov.pl). Spłata rodzinna: 20k (2. dziecko) /
60k (3.+, art. 7 ust. 3), dziecko urodzone po dniu udzielenia kredytu, wniosek do banku do
12 mies. od narodzin (albo od pierwszej wypłaty, jeśli dziecko urodziło się wcześniej — art. 8
ust. 1 pkt 2), zmniejsza kapitał; 5-letni zakaz sprzedaży/wynajmu (zwrot proporcjonalny wg
wzoru w art. 8 ust. 7 pkt 2). Warunek (**art. 7 ust. 1 pkt 7**, nie pkt 6 jak wcześniej
zapisane — pkt 6 to brak upadłości): w ciągu 3 lat od dnia UDZIELENIA kredytu brak
przedterminowej spłaty ponad część objętą gwarancją BGK; ta część maleje z każdą spłatą
kapitału (art. 4a ust. 6) — próg jest dynamiczny. Bez gwarancji BGK próg wynosi zero (pkt 7
nie ma wyjątku dla braku gwarancji — to ODWROTNOŚĆ wcześniejszej spekulacji w tym pliku).
Naruszenie odbiera TYLKO przyszłe spłaty rodzinne, nie te już wypłacone. Wkład własny max 20%
(zmienna) / 30% (stała), wkład+gwarancja ≤ 200k; gwarancja (art. 4a) ≤ 100k, opłata
jednorazowa 1% bez odrębnego pułapu kwotowego. Okres: **minimum 15 lat** (art. 3 ust. 3 pkt 3,
ustawowe); **35 lat to praktyka bankowa, nie zapis ustawy** — górnej granicy ustawa nie
przewiduje. Kredyt może być udzielony do **31.12.2030** (art. 3 ust. 4, potwierdzone) — to
termin udzielenia, nie termin ważności prawa do spłaty rodzinnej dla kredytów już udzielonych.
Refinansowanie = utrata spłaty rodzinnej — nadal wniosek z logiki programu, NIE potwierdzone
dosłownym tekstem ustawy (brak trafień dla „refinans”). Luka rezydualna: nowelizacja
**Dz.U. 2026 poz. 635** (w mocy od 27.05.2026) nie została przeczytana (tylko PDF) — tytuł
sugeruje finansowanie Rządowego Funduszu Mieszkaniowego, nie zmiany w art. 7/4a, ale to
niepotwierdzone.

## Konwencje
- Jeden plik, bez bundlera, bez bibliotek; wykres w inline SVG. Fonty wyłącznie systemowe
  (tokeny `--font-sans/--font-serif/--font-mono`) — żadnych zewnętrznych żądań poza beaconem
  Cloudflare Web Analytics; CSP w `public/_headers` i tak by je zablokowała.
- Plik strony to `public/index.html` (katalog `public/` jest build output directory
  dla Cloudflare Pages — patrz `DEPLOY.md`); reszta `public/` to statyczne towarzyszące
  pliki (`_headers`, `robots.txt`, `sitemap.xml`, `404.html`, `favicon.svg`, `og.png`
  generowany z `og-image.html`, `polityka-prywatnosci.html`).
- Analityka: skrypt Cloudflare Web Analytics na końcu `index.html` (token to publiczny
  identyfikator, nie sekret); startuje tylko na hoście `abkredyt.kondratek.pl`, opt-out przez
  `/?bez-statystyk=1`. Jeśli token zostanie zastąpiony placeholderem `CF_ANALYTICS_TOKEN`,
  beacon się nie ładuje wcale.
- Motyw jasny/ciemny przez tokeny CSS na `:root` (+ `prefers-color-scheme`, `[data-theme]`).
- Formatowanie liczb: spacje jako separator tysięcy, „zł”.
- Test: `python3 tools/shot.py` robi pełny screenshot `public/index.html` przez Playwright
  (chromium) i zgłasza błędy konsoli, kończąc się kodem != 0, gdy są jakiekolwiek — to on
  jest testem dymnym w CI (`.github/workflows/ci.yml`, razem z `tools/check-html.mjs`
  i `node tools/test-engine.mjs`). Lokalnie bez instalowania Playwrighta:
  `PW_CHANNEL=chrome uv run --with playwright python tools/shot.py` (używa systemowego Chrome).
- Jeden skonsolidowany disclaimer w stopce (poglądowe, pozycja Dz.U., data sprawdzenia,
  nowelizacja nieuwzględniona, potwierdź w banku) — bez rozproszonych etykiet „do weryfikacji”
  w UI.
- Tekst ustawy RKM jest dostępny do pobrania przez Sejmowe API ELI, mimo że isap.sejm.gov.pl
  jest CAPTCHA-gated dla skryptów: `curl https://api.sejm.gov.pl/eli/acts/DU/2024/1724/text.html`.
- Wdrożenie na Cloudflare Pages: checklista krok po kroku w `DEPLOY.md`.
