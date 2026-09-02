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

Reguła RKM (oznaczona w interfejsie jako „do weryfikacji"): jeśli w ciągu pierwszych 36
miesięcy suma nadpłat **dobrowolnych** przekroczy próg (domyślnie kwota gwarancji BGK,
100 000 zł), spłaty rodzinne przypadające po przekroczeniu progu są oznaczone jako
„utracona" i pomijane w wyliczeniu — z checkboksem pozwalającym regułę zignorować.
Celowo i świadomie: **wyższa rata umowna (formalnie krótszy okres kredytu) nie jest
nadpłatą i nie zużywa progu** — to rozróżnienie jest kluczowe dla opłacalności, bo
oznacza, że pod RKM formalnie krótszy okres bywa korzystniejszy niż „30 lat i nadpłacam
z nadwyżki".

### Liczby kontrolne

Silnik jest zweryfikowany na kredycie 579 200 zł / 5,39%:

| Okres | Rata |
|---|---|
| 30 lat | 3 249 zł |
| 15 lat | 4 699 zł |

## Zasady RKM — skrót

*(stan na 2 września 2026, do weryfikacji w banku; brzmienie art. 7 ust. 1 pkt 6 ustawy z dnia
1 października 2021 r. o rodzinnym kredycie mieszkaniowym i bezpiecznym kredycie 2%
niezweryfikowane bezpośrednio z tekstem ustawy)*

Spłata rodzinna wynosi 20 000 zł przy urodzeniu drugiego dziecka i 60 000 zł przy trzecim
i każdym kolejnym, o ile dziecko urodziło się już w trakcie trwania kredytu; wniosek do
banku trzeba złożyć w ciągu 12 miesięcy od urodzenia, a kwota pomniejsza kapitał kredytu.
Obowiązuje 5-letni zakaz sprzedaży lub wynajmu nieruchomości (naruszenie skutkuje
proporcjonalnym zwrotem spłaty rodzinnej). Warunkiem otrzymania spłaty rodzinnej jest brak
przedterminowej spłaty kredytu ponad część objętą gwarancją BGK w ciągu pierwszych 3 lat od
udzielenia kredytu. Wkład własny może wynosić maksymalnie 20% przy stopie zmiennej albo 30%
przy stopie stałej, a suma wkładu własnego i gwarancji BGK nie może przekroczyć 200 000 zł
(sama gwarancja — 100 000 zł, kosztuje 1%). Okres kredytowania mieści się w przedziale
15–35 lat. Refinansowanie kredytu oznacza utratę prawa do spłaty rodzinnej. Data końca
programu (orientacyjnie około 2030 r.) nie jest potwierdzona.

## Prywatność

Wszystko liczy się w przeglądarce — nic z tego, co wpisujesz, nie opuszcza Twojego
urządzenia. Stan porównania zapisuje się w `localStorage` (klucz `abkredyt-state-v2`),
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
Autor jest programistą, nie doradcą kredytowym. Zasady programu RKM opisane wyżej są
podsumowaniem według stanu na 2 września 2026 r. — ustawa jest nowelizowana, a przed decyzją
kredytową należy je zweryfikować w banku.
