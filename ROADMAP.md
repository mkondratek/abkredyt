# Roadmap (ustalone w dyskusji 02.09.2026)

## Generalizacja (przed publikacją)
1. ✅ Usunąć presety banków — tylko ręcznie podawana stopa, rozbita na marża + wskaźnik
   referencyjny (WIBOR/WIRON); zdarzenie „zmiana wskaźnika” zamiast „nowa stopa nominalna”.
2. ✅ Etykieta przy tytule scenariusza jako jednolinijkowe streszczenie: kwota · okres · stopa ·
   strategia (np. „500 000 zł · 30 lat · 5,50 % · nadpłata 500 zł/mies. od m. 1”) — używana też
   jako legenda wykresu.
3. ✅ Presety wydarzeń zostają z kwotami bezwzględnymi (są czytelniejsze niż procenty i tak
   zaprojektowane celowo); zamiast parametryzacji — chip, który nie ma sensu dla aktualnych
   parametrów kredytu (miesiąc poza okresem, kwota nie mniejsza niż kredyt, nadpłata
   miesięczna nie mniejsza niż rata, wskaźnik poniżej 1 p.p., zdarzenie już dodane), jest
   wyłączany z powodem w `title`.
4. ✅ Przełącznik „Kredyt w programie RKM” włączający cały moduł (spłata rodzinna, próg gwarancji,
   licznik nadpłat w 36 mies.). Wyłączony = zwykły kalkulator A/B (okres 5–35 lat).
5. ✅ Koszt alternatywny gotówki (lokata X % netto) — jeden globalny parametr
   „oprocentowanie lokaty netto” (domyślnie 3,0) w pasku nad panelami, `RKM.kosztZLokata()`
   liczy wartość przyszłą wypływów kredytobiorcy (rata + nadpłata + opłaty, plus opłata za
   gwarancję w m. 0; bez spłaty rodzinnej) na koniec wspólnego horyzontu = dłuższego z dwóch
   kredytów, i wchodzi jako jeden wiersz porównania A vs B razem z KPI „Suma wpłat”.
6. ✅ Stan w URL oprócz localStorage — przycisk „Kopiuj link do tego porównania”, ładunek
   we fragmencie `#s=` (deflate-raw + base64url, awaryjnie sam base64url JSON-a), link ma
   pierwszeństwo nad localStorage i po wczytaniu jest z adresu usuwany.
7. ✅ Disclaimer + „wersja zasad RKM z dnia …” w stopce, linki do polityki prywatności i kodu.

## Publikacja
- ✅ Cloudflare Pages, katalog `public/`, bez backendu; Cloudflare Web Analytics (bez cookies,
  opt-out `?bez-statystyk=1`). Kroki ręczne: `DEPLOY.md`.
- ✅ Fonty systemowe zamiast Google Fonts.
- Po wdrożeniu: wkleić token analityki, sprawdzić kartę OG (og.png) w podglądzie linku.
- ✅ Audyt logiki (Opus) i audyt UI (Sonnet) — wykonane 02–03.09.2026, poprawki wdrożone.

## Do zrobienia (zgłoszone 03.09.2026)
8. ✅ „Kopiuj z A” / „Kopiuj z B” — przycisk w nagłówku panelu nadpisuje ten scenariusz głęboką
   kopią drugiego (wydarzenia z nowymi `id`), bez potwierdzenia, z jednorazowym „Cofnij”
   przez 8 s w notce renderowanej ze stanu; przy identycznych scenariuszach jest wyłączony.
9. ✅ Tryb RKM per scenariusz (`s.rkm`, checkbox w panelu) zamiast globalnego — z opłatą
   prowizyjną 1 % za gwarancję BGK (art. 4a ust. 5) w łącznym koszcie, podpowiedzią
   o wkładzie 10–20 % poza programem (rekomendacja S KNF), prefiksem „RKM · ” w streszczeniu
   i legendzie oraz stanem w wersji 6 (linki v4/v5 z globalnym `rkmOn` są podnoszone).
10. ✅ Znaczniki na wykresie (przerywana linia m. 36, pusty romb wygaśnięcia gwarancji przed
    końcem okna, kreska ostatniego miesiąca z saldem ≥ 60 000 zł) i badge'y w rozwiniętym
    harmonogramie, z wierszem roku obejmującego m. 36 wyróżnionym lewą krawędzią; opisy mówią
    wprost, że wygaśnięcie gwarancji nie jest terminem na dziecko. Silnik zwraca
    `guaranteeExhaustedMonth` i `fullChildRepaymentUntilMonth`.
11. ✅ Opłata za wcześniejszą spłatę wg ustawy o kredycie hipotecznym (art. 40): podpowiedź
    i `max="36"` na oknie opłaty (ust. 1, stopa zmienna) plus pułap kwotowy w silniku —
    `fee = min(amt·feePct/100, amt·r·12)` od stopy obowiązującej w miesiącu nadpłaty (ust. 4).
12. ✅ Podstrona „Gotowe porównania” (`public/scenariusze.html`) — 5 pytań z gotowymi
    linkami `#s=`, generowana z `tools/scenarios.json` przez `node tools/build-scenarios.mjs`.

## Do rozstrzygnięcia (wątpliwe punkty z audytu)
- Skrócić notkę „Reguła RKM” do 2–3 punktów, cytat ustawy tylko w stopce?
- „Obniż ratę” + nadpłata cykliczna kończy się wcześniej ratą kilku złotych — dodać zdanie
  wyjaśnienia przy KPI?
- Kolumna opłaty za wcześniejszą spłatę w harmonogramie?
- Naruszenie i spłata rodzinna w tym samym miesiącu = utrata (ostrożnie) — zostawić?

## Pomysły dalsze
- Trzeci scenariusz; eksport CSV harmonogramu; rata malejąca; transze (kredyt na budowę/remont).
- Zaciąganie aktualnych limitów cen mieszkań w RKM (limit ceny za m² zależny od lokalizacji,
  ogłaszany na podstawie wskaźnika przeliczeniowego) i sprawdzanie, czy wpisana cena się w nich
  mieści — pomysł z 02.09.2026, świadomie nie na teraz.
