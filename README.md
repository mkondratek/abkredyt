# abkredyt.kondratek.pl — porównanie scenariuszy kredytu hipotecznego (z zasadami RKM)

Jednoplikowy kalkulator porównujący dwa scenariusze spłaty kredytu hipotecznego (A vs B)
obok siebie, z wydarzeniami rozłożonymi w czasie: nadpłaty jednorazowe i cykliczne, zmiana
wskaźnika referencyjnego, narodziny dziecka. Każdy scenariusz ma własną kwotę, okres,
oprocentowanie i strategię — nad wykresem widać jednolinijkowe streszczenie każdego z nich
(kwota · okres · stopa · strategia), żeby dało się odczytać wykres bez zaglądania w formularz.

Osobny moduł, włączany przełącznikiem „Kredyt w programie RKM", dolicza zasady programu
Rodzinny Kredyt Mieszkaniowy: spłatę rodzinną po urodzeniu dziecka i limit nadpłat
dobrowolnych w pierwszych 3 latach kredytu. Wyłączenie przełącznika zostawia zwykły
porównywacz A/B — kalkulator działa też dla kredytów spoza programu.

Przycisk „Kopiuj link do tego porównania” pakuje cały stan (oba scenariusze, wszystkie
wydarzenia, tryb RKM) do fragmentu adresu — link można komuś wysłać albo zapisać w notatkach
i wrócić do dokładnie tego samego porównania.

Strona: <https://abkredyt.kondratek.pl>

## Dlaczego to istnieje

Żaden ze sprawdzonych polskich kalkulatorów kredytowych (bankier, totalmoney, hipoteczny.pl,
kalkulator.pl, Expander, Iwuć) nie łączy trzech rzeczy naraz: wielu wydarzeń rozłożonych
w czasie (nadpłaty jednorazowe i cykliczne, zmiany stopy), porównania dwóch dowolnie
skonfigurowanych scenariuszy obok siebie oraz logiki RKM (spłata rodzinna, limit nadpłat
w pierwszych 3 latach). Najbliżej tego jest Expander — obsługuje wiele zdarzeń, ale porównuje
tylko z wariantem „bez nadpłat".

## Jak liczy silnik

Rata równa (annuitet), kapitalizacja miesięczna, oprocentowanie miesięczne `r = nominal/12`.
Oprocentowanie wpisuje się jako marża + wskaźnik referencyjny (WIBOR/WIRON) — zdarzenie
„zmiana oprocentowania" to zmiana wskaźnika, nie ręczne wpisanie nowej stopy.

Nadpłaty (jednorazowe i cykliczne) mają dwa tryby: „skróć okres" (rata bez zmian, kredyt
spłaca się szybciej) i „obniż ratę" (okres bez zmian, rata maleje). Zmiana oprocentowania
zawsze przelicza ratę na nowo. Opłata za wcześniejszą spłatę (% przez pierwsze N miesięcy)
dotyczy wyłącznie nadpłat dobrowolnych — nie spłaty rodzinnej.

Gwarancja BGK nie jest parametrem do wpisania — kalkulator wylicza ją z ceny, wkładu
własnego i dodatkowej kwoty kredytu i pokazuje jako pole tylko do czytania:
`min(20 % wydatków − wkład; 100 000 zł; 200 000 zł − wkład; kwota kredytu)`, gdzie
„całkowita kwota wydatków" to cena plus dodatkowa kwota kredytu (art. 3 ust. 3b, art. 4a
ust. 2–3). Gdy wkład własny wychodzi poza ustawowe granice — ponad 20 % wydatków
(art. 5 ust. 1 pkt 5), ponad 200 000 zł (art. 3 ust. 3 pkt 1), za mało, by pełna gwarancja
domknęła 20 % wydatków, albo tak, że wkład i gwarancja dają razem ponad 200 000 zł
(art. 4a ust. 2 pkt 1) — panel pokazuje listę niespełnionych warunków. Kalkulator dalej
liczy taki kredyt (nic nie jest po cichu przycinane), ale mówi wprost, że nie jest to już
kredyt w programie. Praktyczny wniosek: przy wydatkach powyżej 500 000 zł 20 % nie da się
domknąć samą gwarancją, więc potrzebny jest wkład własny co najmniej
`20 % wydatków − 100 000 zł`.

Presety wydarzeń („2. dziecko w m. 24”, „nadpłata 50 000 w m. 12”, …) mają kwoty i miesiące
podane wprost. Preset, który dla aktualnych parametrów scenariusza nie ma sensu — miesiąc poza
okresem kredytu, kwota nadpłaty nie mniejsza niż sam kredyt, nadpłata miesięczna nie mniejsza
niż rata, „wskaźnik −1 p.p.” przy wskaźniku poniżej 1 p.p., zdarzenie już dodane — jest
wyłączony, z powodem widocznym po najechaniu.

Reguła RKM: część kredytu objęta gwarancją BGK **maleje z każdą spłatą kapitału** —
ratą, nadpłatą dobrowolną i spłatą rodzinną. W ciągu pierwszych 36 miesięcy od
uruchomienia kredytu nadpłata dobrowolna jest bezpieczna tylko do wysokości tej
*aktualnej* (bieżącej, a nie początkowej) części gwarantowanej; nadpłata ją
przekraczająca oznacza spłaty rodzinne przypadające po przekroczeniu jako „utracona"
i pomija je w wyliczeniu. Reguła obowiązuje bezwarunkowo — nie ma przełącznika, który
kazałby ją zignorować. Rata spłacana zgodnie z harmonogramem nigdy sama w sobie nie
narusza progu (to nie jest nadpłata), ale zmniejsza gwarantowaną część i tym samym
zużywa dostępny zapas na przyszłe nadpłaty — krótszy okres nie jest więc wobec reguły
obojętny: sam jej nie łamie, ale szybciej topi limit na ewentualne późniejsze nadpłaty.
Przy zerowej gwarancji BGK (wkład własny ≥ 20%) próg
wynosi zero — każda nadpłata w pierwszych 36 miesiącach narusza regułę. Uproszczenie
świadome: silnik liczy te 36 miesięcy od miesiąca uruchomienia kredytu, podczas gdy
ustawa liczy od dnia jego udzielenia (zawarcia umowy) — to zwykle bliskie, ale nie
identyczne daty.

### Liczby kontrolne

Silnik jest zweryfikowany na kredycie ilustracyjnym 500 000 zł / 5,50 %:

| Okres | Rata |
|---|---|
| 30 lat | 2 839 zł |
| 25 lat | 3 070 zł |
| 15 lat | 4 085 zł |

Testy w `tools/test-engine.mjs` nie przepisują liczb z silnika: ratę liczą z wzoru na
annuitet zapisanego wprost w teście, a sumy odsetek i miesiąc spłaty — z niezależnej
symulacji referencyjnej (zwykła pętla miesiąc po miesiącu) w tym samym pliku.

## Zasady RKM — skrót

*(sprawdzone z tekstem jednolitym ustawy z dnia 1 października 2021 r. o rodzinnym kredycie
mieszkaniowym i bezpiecznym kredycie 2% — Dz.U. 2024 poz. 1724, stan prawny na 30.10.2024 —
2 września 2026 r.)*

Spłata rodzinna wynosi 20 000 zł przy urodzeniu drugiego dziecka i 60 000 zł przy trzecim
i każdym kolejnym (nie więcej niż pozostały kapitał; art. 7 ust. 3), o ile dziecko urodziło
się po dniu udzielenia kredytu; wniosek do banku trzeba złożyć w ciągu 12 miesięcy od
urodzenia, a kwota pomniejsza kapitał kredytu. Obowiązuje 5-letni zakaz sprzedaży lub
wynajmu nieruchomości (naruszenie skutkuje proporcjonalnym zwrotem spłaty rodzinnej;
art. 8 ust. 7). Warunkiem otrzymania **przyszłych** spłat rodzinnych jest brak przedterminowej
spłaty kredytu ponad część objętą gwarancją BGK w ciągu pierwszych 3 lat od dnia udzielenia
kredytu (art. 7 ust. 1 pkt 7); ta część gwarantowana maleje z każdą spłatą kapitału
(art. 4a ust. 6), więc próg jest ruchomy, nie stały — a bez gwarancji BGK (wkład własny
≥ 20%) próg wynosi zero i każda przedterminowa spłata w tym okresie odbiera prawo do
przyszłych spłat rodzinnych. Naruszenie nie powoduje zwrotu spłat już wypłaconych — tylko
utratę tych przyszłych. Wkład własny może wynosić maksymalnie 20% całkowitej kwoty wydatków
przy stopie zmiennej albo 30% przy stopie stałej na co najmniej 5 lat (art. 5 ust. 1 pkt 5)
i nie więcej niż 200 000 zł (art. 3 ust. 3 pkt 1). Jeżeli wkład jest niższy niż 20% wydatków,
gwarancją BGK objęta jest ta właśnie różnica (art. 3 ust. 3b) — sama gwarancja maksymalnie
100 000 zł (art. 4a ust. 3), a gwarancja i wkład łącznie maksymalnie 200 000 zł i 20% wydatków
(art. 4a ust. 2; opłata jednorazowa 1% objętej gwarancją części). Ponieważ gwarancja urywa się
na 100 000 zł, przy wydatkach powyżej 500 000 zł program wymaga w praktyce wkładu własnego co
najmniej `20% wydatków − 100 000 zł`. Kalkulator nie modeluje trzech wyjątków od limitu
procentowego: art. 5 ust. 2 (rodzina z dwojgiem dzieci posiadająca jedno mieszkanie — wkład
do 10%), art. 3 ust. 3a w zw. z art. 5 ust. 2d (wkład wyłącznie w postaci działki — bez limitu
procentowego, wkład i kredyt razem do 1 000 000 zł) oraz art. 9f (Rada Ministrów może podnieść
limity rozporządzeniem — na wrzesień 2026 r. tego nie zrobiła). Okres
kredytowania to **minimum 15 lat** (art. 3 ust. 3 pkt 3); górnej granicy ustawa nie
przewiduje — 35 lat to praktyka banków, nie zapis ustawy. Kredyt może zostać udzielony do
31 grudnia 2030 r. (art. 3 ust. 4) — to termin udzielenia, nie termin ważności prawa do
spłaty rodzinnej dla kredytów już udzielonych wcześniej. Refinansowanie kredytu = utrata
prawa do spłaty rodzinnej — to pozostaje wnioskiem z logiki programu, nie dosłownym
zapisem ustawy.

## Prywatność

Wszystko liczy się w przeglądarce — nic z tego, co wpisujesz, nie opuszcza Twojego
urządzenia. Stan porównania zapisuje się w `localStorage` (klucz `abkredyt-state-v5`),
żeby przetrwał odświeżenie strony; usuwa się razem z danymi strony w przeglądarce.
Przycisk „Kopiuj link do tego porównania” zaszywa parametry (kwoty, oprocentowanie,
wydarzenia) w **fragmencie** adresu — a fragment, w odróżnieniu od query stringu,
nigdy nie jest wysyłany na serwer ani do logów proxy; link powstaje w całości
w przeglądarce. Sam link zawiera więc Twoje dane: komu go wyślesz, to Twoja decyzja.
Na produkcyjnym hoście działa wyłącznie bezcookiesowy Cloudflare Web Analytics, z opcją
wyłączenia przez `?bez-statystyk=1`. Pełny opis: [`public/polityka-prywatnosci.html`](public/polityka-prywatnosci.html).

## Uruchomienie lokalne

Bez bundlera, bez zależności — wystarczy otworzyć `public/index.html` w przeglądarce, albo
odpalić lokalny serwer:

```
python3 -m http.server 8080 --directory public
```

Testy silnika (część logiki jest wyeksportowana jako `RKM` i pokryta testami węzłowymi):

```
node tools/test-engine.mjs
```

Test dymny całej strony (pełny screenshot przez Playwright + kontrola błędów konsoli):

```
pip install playwright
python3 -m playwright install chromium
python3 tools/shot.py
```

Kroki wdrożenia na Cloudflare Pages: [`DEPLOY.md`](DEPLOY.md).

## Zgłaszanie błędów

[Zgłoś issue](https://github.com/mkondratek/abkredyt/issues/new) — najlepiej z konkretnym
scenariuszem (kwota, okres, oprocentowanie, wydarzenia) i wynikiem, którego się spodziewasz.
Dopisanie przypadku regresyjnego do `tools/test-engine.mjs` jest mile widzianym wkładem,
nawet bez poprawki w kodzie.

## Licencja i zastrzeżenie

MIT — patrz [`LICENSE`](LICENSE).

Kalkulator ma charakter poglądowy i nie stanowi oferty ani porady finansowej lub prawnej.
Zasady RKM wg tekstu jednolitego ustawy (Dz.U. 2024 poz. 1724), sprawdzone 2 września 2026 r.;
nowelizacja z 2026 r. (Dz.U. 2026 poz. 635) nieuwzględniona — przed decyzją potwierdź warunki
w banku.

Autorem jest Mikołaj Kondratek — programista, nie doradca kredytowy ·
[LinkedIn](https://www.linkedin.com/in/mkondratek/) · [GitHub](https://github.com/mkondratek)
