# Roadmap (ustalone w dyskusji 02.09.2026)

## Generalizacja (przed publikacją)
1. ✅ Usunąć presety banków — tylko ręcznie podawana stopa, rozbita na marża + wskaźnik
   referencyjny (WIBOR/WIRON); zdarzenie „zmiana wskaźnika” zamiast „nowa stopa nominalna”.
2. ✅ Etykieta przy tytule scenariusza jako jednolinijkowe streszczenie: kwota · okres · stopa ·
   strategia (np. „500 000 zł · 30 lat · 5,50 % · nadpłata 500 zł/mies. od m. 1”) — używana też
   jako legenda wykresu.
3. Presety wydarzeń zostają (klik → edycja pod siebie); sparametryzować kwotę/miesiąc.
4. ✅ Przełącznik „Kredyt w programie RKM” włączający cały moduł (spłata rodzinna, próg gwarancji,
   licznik nadpłat w 36 mies.). Wyłączony = zwykły kalkulator A/B (okres 5–35 lat).
5. Koszt alternatywny gotówki (lokata X% netto) — bez tego porównanie „nadpłacić vs trzymać”
   jest połowiczne. Możliwy KPI: „koszt odroczenia nadpłat = odroczona kwota × (stopa − lokata)
   × czas”.
6. Stan w URL (query/hash) zamiast/oprócz localStorage — żeby dało się wysłać komuś link do
   konkretnego porównania.
7. ✅ Disclaimer + „wersja zasad RKM z dnia …” w stopce, linki do polityki prywatności i kodu.

## Publikacja
- ✅ Cloudflare Pages, katalog `public/`, bez backendu; Cloudflare Web Analytics (bez cookies,
  opt-out `?bez-statystyk=1`). Kroki ręczne: `DEPLOY.md`.
- ✅ Fonty systemowe zamiast Google Fonts.
- Po wdrożeniu: wkleić token analityki, sprawdzić kartę OG (og.png) w podglądzie linku.

## Pomysły dalsze
- Trzeci scenariusz; eksport CSV harmonogramu; rata malejąca; transze (kredyt na budowę/remont).
