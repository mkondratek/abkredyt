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
- Rata równa (annuitet), kapitalizacja miesięczna, `r = nominal/12`. Weryfikacja na kredycie
  ilustracyjnym 500 000 zł / 5,50 %: 30 lat → 2 839 zł; 25 lat → 3 070 zł; 15 lat → 4 085 zł.
  Testy nie przepisują liczb z silnika: rata bierze się z wzoru na annuitet zapisanego wprost
  w `tools/test-engine.mjs`, a sumy odsetek i miesiąc spłaty z niezależnej symulacji
  referencyjnej w tym samym pliku (zgodność ±1 zł / ±1 mies.).
- Oprocentowanie w UI = marża + wskaźnik referencyjny (WIBOR/WIRON); silnik dostaje stopę
  nominalną. Presetów banków nie ma i nie dodawaj ich (to była personalizacja).
- Wydarzenia: nadpłata jednorazowa, nadpłata cykliczna (od–do miesiąca), narodziny dziecka →
  spłata rodzinna (20 000 dla 2. dziecka, 60 000 dla 3.+; capped do salda), zmiana wskaźnika
  (UI: `zmiana_wskaznika`, nowy wskaźnik → silnik: `zmiana_oprocentowania` z nominalną =
  marża + wskaźnik). Tryb nadpłat globalny + per zdarzenie: „skróć okres” (rata bez zmian) /
  „obniż ratę” (okres bez zmian). Zmiana stopy zawsze przelicza ratę.
- Przełącznik „Kredyt w programie RKM” jest **per scenariusz** (`s.rkm`, checkbox w panelu
  pod jednolinijkowym streszczeniem) — dzięki temu da się zestawić kredyt w programie ze
  zwykłym (np. wkład ≥ 20 %: spłata rodzinna kontra swoboda nadpłat od 1. miesiąca).
  Wyłączony w danym panelu chowa moduł RKM tego scenariusza (gwarancja, banner limitów,
  reguła, chipy i przycisk dziecka, KPI nadpłat i gwarancji, opłata za gwarancję), filtruje
  zdarzenia `dziecko` z konfiguracji silnika, luzuje okres do 5–35 lat i pokazuje pod
  wkładem własnym podpowiedź „Poza RKM banki wymagają zwykle 10–20 % wkładu własnego
  (rekomendacja S KNF)”. Streszczenie scenariusza w RKM ma prefiks „RKM · ” (a więc i
  legenda wykresu). Atrybut `data-rkm` na `<html>` mówi tylko, czy **którykolwiek**
  scenariusz jest w programie (`on`/`off`) — steruje globalną klasą `.rkm-only` (notka
  nad panelami) oraz doborem nagłówka i lede; części panelu sterują się w JS przez `s.rkm`.
  `applyRkmMode()` jest wołane na starcie `doRecompute()`, bo flagę zmienia też „Kopiuj z A/B”.
- **Opłata prowizyjna za gwarancję BGK** (art. 4a ust. 5): 1,0 % objętej gwarancją części
  kredytu, jednorazowo przy uruchomieniu. Silnik przyjmuje `gwarancjaFeePct` (domyślnie 1,
  UI podaje 0 dla scenariusza spoza RKM) i zwraca `gwarancjaFee`; opłata wchodzi do
  `totalCost` (KPI „Łączny koszt (odsetki + opłaty)” z podwierszem „w tym opłata za
  gwarancję …”) i do `totalWplaty`, ale **nie** do `totalFees` (tam siedzą wyłącznie opłaty
  za wcześniejszą spłatę).
- Opłata za wcześniejszą spłatę: % przez N miesięcy, dotyczy tylko nadpłat dobrowolnych
  (nie spłaty rodzinnej). Dwa limity z ustawy o kredycie hipotecznym z 23.03.2017:
  okno maks. **36 mies.** przy stopie zmiennej (art. 40 ust. 2) — `max="36"` na polu
  „Obowiązuje przez (mies.)”, `field-hint` z podstawą prawną, przycinanie przy wpisywaniu
  (`FEE_MONTHS_MAX`), w `toEngineConfig` i w `normaliseState`; oraz pułap kwotowy
  (art. 40 ust. 3) — opłata nie większa niż odsetki od nadpłacanej kwoty za 12 miesięcy,
  czyli w silniku `fee = min(amt·feePct/100, amt·r·12)` licząc `r` ze stopy
  **obowiązującej w tym miesiącu** (po zmianie wskaźnika limit idzie za nową stopą).
  Kalkulator modeluje wyłącznie stopę zmienną, więc wariantu 3-letniego dla stopy stałej
  nie ma.
- **Koszt alternatywny gotówki (lokata)**: jeden GLOBALNY parametr `state.lokata`
  (domyślnie 3,0; pole w pasku nad panelami, bo to cecha rynku, nie scenariusza).
  `RKM.kosztZLokata(result, lokataPct, horizonMonths)` zwraca wartość przyszłą wszystkich
  **wypływów kredytobiorcy** na koniec horyzontu, przy kapitalizacji miesięcznej
  `r = lokata/100/12`: per miesiąc `rata + nadplata + oplata`, plus `gwarancjaFee`
  w miesiącu 0. Spłata rodzinna jest wyłączona — to pieniądz BGK, nie kredytobiorcy.
  UI liczy `horizon = max(payoffMonths A, payoffMonths B)` i pokazuje jeden wiersz
  `.compare-row` pod siatką porównania. Przy lokacie 0 % wynik równa się `result.totalWplaty`
  (KPI „Suma wpłat (raty + nadpłaty + opłaty)”).
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
  przypadające po naruszeniu są oznaczane „utracona” i pomijane. Reguła obowiązuje
  bezwarunkowo — checkboksa „ignoruj regułę” (ani pola `ignorujRegule`) już nie ma, bo przy
  wyłączonym RKM zdarzenia `dziecko` i tak nie trafiają do silnika. Uproszczenie silnika: okno 36 mies. liczone od miesiąca uruchomienia kredytu, nie
  od dnia jego udzielenia (zawarcia umowy), jak dosłownie stanowi ustawa — to świadome
  uproszczenie (patrz lokalnie `docs/wnioski-modelu.md` dla wcześniejszego modelu).
- Naruszenie reguły i spłata rodzinna w tym samym miesiącu: silnik przetwarza nadpłaty przed
  zdarzeniem `dziecko`, więc taka spłata rodzinna jest już „utracona” — ustawa kolejności nie
  rozstrzyga, to świadomy wybór po ostrożnej stronie.
- **Znaczniki RKM** (tylko scenariusze z `s.rkm`): silnik zwraca `guaranteeExhaustedMonth`
  (pierwszy miesiąc, w którym część objęta gwarancją zeszła do zera — art. 4a ust. 6;
  `null`, gdy gwarancji nie było) i `fullChildRepaymentUntilMonth` (ostatni miesiąc z saldem
  ≥ `RKM_PELNA_SPLATA_RODZINNA` = 60 000 zł; `null`, gdy saldo nigdy nie schodzi poniżej
  progu przed spłatą). Na wykresie: pionowa przerywana linia w m. 36 z podpisem „koniec
  okna RKM” (rysowana RAZ, neutralnym kolorem, tylko gdy którykolwiek scenariusz jest w RKM),
  pusty romb w kolorze scenariusza tam, gdzie gwarancja wygasa **przed** m. 36, i krótka
  kreska w `fullChildRepaymentUntilMonth` — wszystko siada na linii scenariusza
  (`valueAt`), z opisem w `<title>`. W harmonogramie: badge w pierwszej komórce
  rozwiniętego miesiąca („koniec okna RKM”, „gwarancja spłacona”, „pełna spłata rodzinna do
  tego miesiąca”) i delikatna lewa krawędź na wierszu roku z 36. miesiącem
  (`.year-row.rkm-window`). Opisy mówią wprost, że wygaśnięcie gwarancji NIE jest terminem
  na urodzenie dziecka — prawo do spłaty rodzinnej od niego nie zależy.
- Znaczniki na wykresie mają teraz wyjaśnienie widoczne bez zawieszania kursora (SVG
  `<title>` samo w sobie nie działa na dotyku i pokazuje się z opóźnieniem): druga linijka
  legendy (`#chart-legend-markers`, tylko gdy dany znacznik faktycznie istnieje na bieżącym
  wykresie) renderuje mini-swatch + etykietę jako `<button class="legend-info">`, klik/Enter
  przełącza wyjaśnienie w jednej wspólnej notce (`#legend-note`, `role="status"`, drugi klik
  albo klik na innym znaczniku zamyka/przełącza — `setLegendNote()`); dymek wykresu
  (`showTooltipAt`) dokłada te same opisy pod wartościami A/B, gdy najechany/tapnięty miesiąc
  leży w promieniu ±2 mies. od znacznika (`markerTooltipLines`, na bazie `markerFacts`
  policzonych raz w `renderChart()`). Treść (etykiety + not) mieszka wyłącznie w jednej mapie
  `MARKER_INFO` (klucze `window`/`guarantee`/`fullChild`), żeby legenda, notka i dymek nie
  mogły się rozjechać ze sobą — `computeMarkerFacts()` powtarza dokładnie te same warunki
  rysowania, na jakich `rkmWindowLine()`/`rkmMarkers()` w `buildChart()` decydują, czy dany
  znacznik w ogóle istnieje.
- Scenariusz nie ma już pól `rkmThreshold`/`rkmMonths` w stanie — próg to gwarancja
  (dynamiczna, patrz wyżej), a okno to stała silnika `RKM_WINDOW_MONTHS` (36 mies.).
- **Gwarancja BGK jest WYLICZANA i tylko do czytania** — nie ma jej ani w stanie
  scenariusza, ani w `defaultScenario`, ani w `looksLikeScenario`, ani w mapie kluczy linku
  (decyzja właściciela: „zróbmy ją read-only, nie pozwalajmy użytkownikowi na błąd”).
  Silnik liczy ją w `RKM.gwarancjaBGK({cena, wklad, remont})`:
  `min(max(0, 0,2·wydatki − wkład), 100 000, 200 000 − wkład, kwota kredytu)`, gdzie
  „całkowita kwota wydatków" = cena + dodatkowa kwota kredytu (art. 3 ust. 3b — gwarancją
  objęta jest różnica między 20 % wydatków a wkładem; art. 4a ust. 3 — sama gwarancja
  maks. 100 000 zł; art. 4a ust. 2 pkt 1 — gwarancja + wkład maks. 200 000 zł). UI ma jedno
  opakowanie (`gwarancjaOf(s)`), które podaje wynik do `toEngineConfig`; silnik dalej
  przyjmuje `gwarancja` jako liczbę, więc `simulateScenario` nie zmienia kontraktu.
  Pole „Gwarancja BGK” to `input[readonly]` (jak „Kwota kredytu (razem)”) z podpisem
  „(20 % wydatków − wkład, maks. 100 000 zł)”, tylko w trybie RKM.
- **Banner „Kredyt nie spełnia warunków RKM”** (tylko tryb RKM) renderuje się w panelu
  bezpośrednio pod blokiem „Kredyt”, w formie `warning-banner` z paletą krytyczną
  (`.warning-banner.critical`, `role="status"`), po jednym punkcie na naruszony limit.
  Kody z `RKM.rkmLimitIssues({cena, wklad, remont})` (zwraca `{issues, wydatki, minWklad,
  maxWklad, brakDo20, gwarancjaPotrzebna, gwarancja, pctWkladu}`): `wklad_pct` (wkład > 20 %
  wydatków — art. 5 ust. 1 pkt 5 lit. a), `wklad_kwota` (wkład > 200 000 zł — art. 3 ust. 3
  pkt 1), `gwarancja_niedobor` (`0,2·wydatki − wkład > 100 000`, czyli nawet pełna gwarancja
  nie domyka 20 % — trzeba dołożyć wkładu co najmniej `0,2·wydatki − 100 000`) i `suma_200k`
  (wkład + potrzebna gwarancja > 200 000 zł). `suma_200k` raportujemy TYLKO wtedy, gdy nie
  wynika już z któregoś z poprzednich, żeby banner nie powtarzał tej samej przyczyny.
  Banner jest informacyjny — kalkulator dalej liczy, wkładu nie przycinamy po cichu; pod
  „Wkładem własnym” dochodzi w trybie RKM `field-hint` z dopuszczalnym przedziałem
  („W RKM: od W zł do 20 % wydatków (V zł)”, W = `max(0, 0,2·wydatki − 100 000)`).
  Świadomie NIE modelowane (tylko w dokumentacji): art. 5 ust. 2 (rodzina z dwojgiem dzieci
  posiadająca jedno mieszkanie — wkład ≤ 10 %), art. 3 ust. 3a w zw. z art. 5 ust. 2d (wkład
  wyłącznie w postaci działki — bez limitu procentowego, wkład + kredyt ≤ 1 000 000 zł),
  art. 9f (Rada Ministrów może podnieść limity rozporządzeniem — na 09.2026 nie podniosła:
  strona produktowa BGK podaje te same 200 tys. / 20–30 % / 100 tys.).
  Także art. 7 ust. 2: gdy warunek braku innego mieszkania spełniono w trybie art. 5 ust. 2,
  spłata rodzinna przysługuje dopiero po wygaśnięciu gwarancji — niemodelowane, opisane
  w /pytania.html przy pytaniu o „termin na dziecko”.
- Stan w `localStorage` (klucz `abkredyt-state-v6`), w try/catch, z kontrolą kształtu
  (`looksLikeState`) — przy zmianie schematu stanu podbij sufiks klucza **i** stałą
  `RKM.STATE_VERSION` (= 6; siedzi w silniku, stan nosi ją jako pole `v`). Dekoder linku
  przyjmuje wersje z `RKM.ACCEPTED_STATE_VERSIONS` (`[4, 5, 6]`) i podnosi je do bieżącej:
  ładunek v4 nosił dodatkowo pole `gwarancja` (dziś ignorowane), a v4 i v5 miały GLOBALNY
  tryb RKM (`rkmOn`, klucz „k”) — przy dekodowaniu trafia on do OBU scenariuszy
  (`A.rkm = B.rkm = rkmOn`, `LEGACY_GLOBAL_RKM_VERSIONS`), a brakująca lokata dostaje
  `DEFAULT_LOKATA_PCT`. To samo domykanie robi `normaliseState()` dla stanu z dysku.
  Każda inna wersja przechodzi dalej bez zmian i UI ją odrzuca.
- Stan w linku: przycisk „Kopiuj link do tego porównania” koduje `{v, chartMode,
  tableScn, lokata, A, B}` (z `rkm` w każdym scenariuszu) jako JSON ze skróconymi
  (jednoznakowymi) kluczami → `deflate-raw`
  (`CompressionStream`) → base64url → fragment `#s=d.<ładunek>`. Gdy przeglądarka nie ma
  `CompressionStream`, powstaje wariant `#s=j.<base64url JSON-a>`; dekoder przyjmuje oba.
  Mapy kluczy i base64url są w silniku (`RKM.shortenState/expandState/encodeStateJson/
  decodeStateJson/bytesToB64url/b64urlToBytes`) i mają test round-tripu; sama kompresja
  zostaje w UI, bo to API przeglądarki. `id` zdarzeń nie jedzie w linku — jest lokalnym
  uchwytem UI i po dekodowaniu nadaje się je od nowa.
- Pierwszeństwo: link > `localStorage`. Poprawny `#s=` nadpisuje zapisany stan, od razu go
  utrwala i **czyści fragment** (`history.replaceState`), żeby kolejne edycje i odświeżenia
  nie wracały do stanu z linku. Zły ładunek albo inna wersja (`v`) → link ignorowany i pokazuje
  się notka do zamknięcia „Nie udało się odczytać linku…”. Świadomie fragment, nie query
  string: fragment nigdy nie idzie na serwer ani do logów proxy, a parametry kredytu to dane
  wrażliwe. Konsekwencja: pierwszy render przy obecnym `#s=` jest asynchroniczny
  (`DecompressionStream`), więc `boot()` odpala się z promisy.
- Presety wydarzeń zostają z kwotami bezwzględnymi (celowo — nie parametryzuj ich), ale chip,
  który nie ma sensu dla scenariusza, renderuje się jako `disabled` z powodem w `title`
  (`PRESETS` + `presetDisabledReason` w UI): miesiąc poza okresem kredytu, kwota nadpłaty
  jednorazowej ≥ kwota kredytu, nadpłata cykliczna ≥ rata początkowa, „wskaźnik −1 p.p.”
  przy wskaźniku < 1, identyczne zdarzenie już dodane (`EVENT_IDENTITY`); chipy dziecka tylko
  w trybie RKM. Handler dodatkowo ignoruje klik w wyłączony chip.
- „Kopiuj z A” / „Kopiuj z B” w nagłówku panelu (`.panel-head-row`) nadpisuje ten scenariusz
  głęboką kopią drugiego (wydarzenia dostają świeże `id` z `uid()`), po czym `recompute()`
  zapisuje stan. Bez potwierdzenia, ale z jednorazowym cofnięciem: bufor `pendingUndo`
  (`{key, from, snapshot, timer}`) i notka „Skopiowano z X · Cofnij” (`role="status"`) żyją
  `UNDO_MS` = 8 s i renderują się ZE STANU w `renderPanel`, bo `#scenarios` jest przerysowywane
  przez `innerHTML`. Bufor kasuje każde inne przerysowanie — przeżywa tylko to z flagą
  `keepUndo`, którą ustawia wyłącznie kopiowanie i cofanie. Fokus prowadzi `pendingFocus`
  (ma pierwszeństwo przed `captureFocusState()`): po kopiowaniu ląduje na „Cofnij”
  (`data-key="undo-copy"`), a po cofnięciu i po wygaśnięciu wraca na „Kopiuj z …”
  (`data-key="copy-from-A"`/`"copy-from-B"`). Gdy scenariusze są identyczne co do treści
  (`sameScenario` — porównanie `stableJson` bez `id` zdarzeń), przycisk renderuje się jako
  `aria-disabled` + `.is-disabled` z `title="Scenariusze są identyczne"`, a handler ignoruje
  klik (ta sama konwencja co przy chipach presetów — bez atrybutu `disabled`, żeby przycisk
  został focusowalny).
- „Data uruchomienia” to dwa własne `<select>` (miesiąc po polsku + rok: od bieżącego −2 do
  +10, plus rok ze stanu, jeśli wypada poza zakresem) zamiast `<input type="month">`, którego
  picker lokalizuje przeglądarka, a nie strona; `state.start` zostaje w formacie `"YYYY-MM"`.

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
Naruszenie odbiera TYLKO przyszłe spłaty rodzinne, nie te już wypłacone. Wkład własny:
≤ 20% wydatków przy stopie zmiennej / ≤ 30% przy stopie stałej na co najmniej 5 lat
(**art. 5 ust. 1 pkt 5**) i ≤ 200 000 zł w kwocie (**art. 3 ust. 3 pkt 1**); gwarancją objęta
jest różnica między 20% wydatków a wkładem (**art. 3 ust. 3b**), sama gwarancja ≤ 100 000 zł
(**art. 4a ust. 3**), a gwarancja + wkład ≤ 200 000 zł i ≤ 20% wydatków (**art. 4a ust. 2**),
opłata jednorazowa 1% bez odrębnego pułapu kwotowego (art. 4a ust. 5). Praktyczna
konsekwencja, którą kalkulator pokazuje wprost: przy wydatkach > 500 000 zł 20% nie da się
już domknąć samą gwarancją, więc **wkład własny musi wynieść co najmniej `0,2·wydatki −
100 000`** (600 tys. → 20 tys., 1 mln → 100 tys.), a wydatki **powyżej 1 mln zł wykluczają
program** (wkład + gwarancja to dokładnie 20% wydatków, a ich suma nie może przejść 200k). Wyjątków od limitu procentowego
kalkulator nie modeluje: art. 5 ust. 2 (dwoje dzieci + jedno mieszkanie → wkład ≤ 10%),
art. 3 ust. 3a w zw. z art. 5 ust. 2d (wkład wyłącznie w postaci działki → bez limitu
procentowego, wkład + kredyt ≤ 1 mln) i art. 9f (Rada Ministrów może podnieść limity
rozporządzeniem — na 09.2026 nie podniosła; strona produktowa BGK podaje te same kwoty). Okres: **minimum 15 lat** (art. 3 ust. 3 pkt 3,
ustawowe); **35 lat to praktyka bankowa, nie zapis ustawy** — górnej granicy ustawa nie
przewiduje. Kredyt może być udzielony do **31.12.2030** (art. 3 ust. 4, potwierdzone) — to
termin udzielenia, nie termin ważności prawa do spłaty rodzinnej dla kredytów już udzielonych.
Refinansowanie = utrata spłaty rodzinnej — nadal wniosek z logiki programu, NIE potwierdzone
dosłownym tekstem ustawy (brak trafień dla „refinans”). Luka rezydualna: nowelizacja
**Dz.U. 2026 poz. 635** (w mocy od 27.05.2026) nie została przeczytana (tylko PDF) — tytuł
sugeruje finansowanie Rządowego Funduszu Mieszkaniowego, nie zmiany w art. 7/4a, ale to
niepotwierdzone.

## Gotowe porównania (`public/scenariusze.html`)
Podstrona z 5 kartami „pytanie → dwa scenariusze → link `#s=`”, pod
https://abkredyt.kondratek.pl/scenariusze.html. **Plik jest generowany — nie edytuj go
ręcznie.** Źródło prawdy to `tools/scenarios.json` (pytanie, „dlaczego to ważne”,
lista ustawień, „na co patrzeć”, wybrane metryki i PEŁNY stan v6 dla każdej karty);
`tools/build-scenarios.mjs` wczytuje silnik z `<script id="engine">` tak samo jak
`tools/test-engine.mjs`, waliduje kształt stanu (ostrzejszy odpowiednik `looksLikeState`
plus zakresy okresu/opłaty i typy zdarzeń), liczy 2–3 liczby nagłówkowe przez
`simulateScenario` i koduje link dokładnie jak przycisk „Kopiuj link…”:
`shortenState` → JSON → `deflateRawSync` (zlib zamiast `CompressionStream`) → base64url.
Regeneracja: `node tools/build-scenarios.mjs`. `tools/test-scenarios.mjs` (w CI po teście
silnika) sprawdza świeżość pliku bajt w bajt, rozpakowuje każdy link i weryfikuje tezę
każdej karty (naruszenie reguły w m. 6, gwarancja 0 przy wkładzie 20 %, rosnąca rata po
zmianie wskaźnika itd.). Liczby w kartach nie są przepisane — biorą się z silnika przy
każdym buildzie, więc zmiana silnika albo `STATE_VERSION` wymaga podbicia pól `v`
w `tools/scenarios.json` i ponownego wygenerowania strony. Data w stopce jest stałą
(`GENERATED_LABEL`), nie zegarem — inaczej test świeżości padałby co dobę.

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
  Paleta ciemna jest zapisana DWA razy (pod `prefers-color-scheme` i pod `[data-theme="dark"]`)
  — obie kopie muszą zostać identyczne. Kontrast: każdy token użyty jako kolor tekstu ma
  ≥ 4.5:1 (WCAG AA, mały tekst) na każdym tle, na którym występuje, w obu paletach — najciaśniej
  jest przy `--ink-faint` na `--surface-3` (4,56 jasny / 4,53 ciemny), więc to on pierwszy się
  psuje przy zmianie odcieni. `--accent-a`/`--accent-b` zostają bez zmian, bo to kolory linii
  wykresu, nie tekstu; dla wypełnień z tekstem (segmenty, przyciski primary, `::selection`)
  są `--accent-a-solid`/`--accent-b-solid` + `--on-accent`.
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
- Kontrakt przywracania fokusu: każde przerysowanie `#scenarios` (`scenariosEl.innerHTML = …`
  w `recompute()`) musi zachować fokus i pozycję scrolla — złap `document.activeElement` PRZED
  przerysowaniem (patrz `captureFocusState()`), odtwórz PO nim przez `el.focus({preventScroll:true})`
  (`restoreFocusState()`). Klucz identyfikujący pole: `data-f` (+ `value` dla radiów), `data-id`
  wiersza zdarzenia gdy pole w nim siedzi, `data-start-part` dla selectów daty uruchomienia, albo
  `data-add-preset`/`data-add-event`/`data-key` dla chipów i przycisków.
