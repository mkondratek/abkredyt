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
5. Koszt alternatywny gotówki (lokata X% netto) — bez tego porównanie „nadpłacić vs trzymać”
   jest połowiczne. Ustalony kształt: jeden globalny parametr „oprocentowanie lokaty netto”
   (wspólny dla A i B, bo to cecha rynku, nie scenariusza) i dodatkowy wiersz w porównaniu —
   łączny koszt scenariusza liczony tak, jakby każda złotówka wpłacona do banku (rata,
   nadpłata, opłata) mogła do końca wspólnego horyzontu pracować na lokacie. Bez tego
   porównania „nadpłacić teraz” vs „trzymać gotówkę do m. 37 i zachować spłatę rodzinną”
   nie da się przeprowadzić uczciwie: pierwsze wygrywa na odsetkach, drugie na odsetkach
   z lokaty plus zachowanej spłacie rodzinnej, a dziś kalkulator widzi tylko jedną stronę.
6. ✅ Stan w URL oprócz localStorage — przycisk „Kopiuj link do tego porównania”, ładunek
   we fragmencie `#s=` (deflate-raw + base64url, awaryjnie sam base64url JSON-a), link ma
   pierwszeństwo nad localStorage i po wczytaniu jest z adresu usuwany.
7. ✅ Disclaimer + „wersja zasad RKM z dnia …” w stopce, linki do polityki prywatności i kodu.

## Publikacja
- ✅ Cloudflare Pages, katalog `public/`, bez backendu; Cloudflare Web Analytics (bez cookies,
  opt-out `?bez-statystyk=1`). Kroki ręczne: `DEPLOY.md`.
- ✅ Fonty systemowe zamiast Google Fonts.
- Po wdrożeniu: wkleić token analityki, sprawdzić kartę OG (og.png) w podglądzie linku.
- Audyt logiki (Opus) i audyt UI (Sonnet) — po zamknięciu powyższych.

## Do zrobienia (zgłoszone 03.09.2026)
8. „Kopiuj z A” / „Kopiuj z B” — przycisk w nagłówku panelu, który nadpisuje ten scenariusz
   kopią drugiego (parametry kredytu, oprocentowanie, wydarzenia z nowymi `id`), żeby łatwo
   zrobić wariant „to samo, tylko jedna rzecz inaczej”. Nadpisanie bez potwierdzenia, ale
   z możliwością cofnięcia (jednorazowe „Cofnij” przez kilka sekund), bo kasuje pracę.
9. Tryb RKM per scenariusz zamiast globalnego — porównanie „kredyt w RKM” vs „zwykły kredyt”
   (np. wkład ≥ 20 %: spłata rodzinna kontra swoboda nadpłat od 1. miesiąca). Wymaga: opłaty
   za gwarancję 1 % (art. 4a ust. 5) w łącznym koszcie i podpowiedzi o wkładzie 10–20 %
   w zwykłym kredycie. Najlepiej razem z punktem 5, bo dopiero z kosztem alternatywnym
   gotówki porównanie jest uczciwe.

## Pomysły dalsze
- Trzeci scenariusz; eksport CSV harmonogramu; rata malejąca; transze (kredyt na budowę/remont).
- Zaciąganie aktualnych limitów cen mieszkań w RKM (limit ceny za m² zależny od lokalizacji,
  ogłaszany na podstawie wskaźnika przeliczeniowego) i sprawdzanie, czy wpisana cena się w nich
  mieści — pomysł z 02.09.2026, świadomie nie na teraz.
