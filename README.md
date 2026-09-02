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

Reguła RKM: część kredytu objęta gwarancją BGK **maleje z każdą spłatą kapitału** —
ratą, nadpłatą dobrowolną i spłatą rodzinną. W ciągu pierwszych 36 miesięcy od
uruchomienia kredytu nadpłata dobrowolna jest bezpieczna tylko do wysokości tej
*aktualnej* (bieżącej, a nie początkowej) części gwarantowanej; nadpłata ją
przekraczająca oznacza spłaty rodzinne przypadające po przekroczeniu jako „utracona"
i pomija je w wyliczeniu — z checkboksem pozwalającym regułę zignorować. Rata spłacana
zgodnie z harmonogramem nigdy sama w sobie nie narusza progu (to nie jest nadpłata),
ale zmniejsza gwarantowaną część i tym samym zużywa dostępny zapas na przyszłe
nadpłaty — formalnie krótszy okres jest więc neutralny wobec reguły, tylko zmienia
tempo, w jakim ten zapas maleje. Przy zerowej gwarancji BGK (wkład własny ≥ 20%) próg
wynosi zero — każda nadpłata w pierwszych 36 miesiącach narusza regułę. Uproszczenie
świadome: silnik liczy te 36 miesięcy od miesiąca uruchomienia kredytu, podczas gdy
ustawa liczy od dnia jego udzielenia (zawarcia umowy) — to zwykle bliskie, ale nie
identyczne daty.

### Liczby kontrolne

Silnik jest zweryfikowany na kredycie 579 200 zł / 5,39%:

| Okres | Rata |
|---|---|
| 30 lat | 3 249 zł |
| 15 lat | 4 699 zł |

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
utratę tych przyszłych. Wkład własny może wynosić maksymalnie 20% przy stopie zmiennej albo
30% przy stopie stałej, a suma wkładu własnego i gwarancji BGK nie może przekroczyć
200 000 zł (sama gwarancja — art. 4a — maks. 100 000 zł, opłata jednorazowa 1%). Okres
kredytowania to **minimum 15 lat** (art. 3 ust. 3 pkt 3); górnej granicy ustawa nie
przewiduje — 35 lat to praktyka banków, nie zapis ustawy. Kredyt może zostać udzielony do
31 grudnia 2030 r. (art. 3 ust. 4) — to termin udzielenia, nie termin ważności prawa do
spłaty rodzinnej dla kredytów już udzielonych wcześniej. Refinansowanie kredytu = utrata
prawa do spłaty rodzinnej — to pozostaje wnioskiem z logiki programu, nie dosłownym
zapisem ustawy.

## Prywatność

Wszystko liczy się w przeglądarce — nic z tego, co wpisujesz, nie opuszcza Twojego
urządzenia. Stan porównania zapisuje się w `localStorage` (klucz `abkredyt-state-v3`),
żeby przetrwał odświeżenie strony; usuwa się razem z danymi strony w przeglądarce.
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
