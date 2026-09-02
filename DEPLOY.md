# Wdrożenie na Cloudflare Pages

Krótka, konkretna checklista dla człowieka — wykonywana raz, ręcznie w panelu
Cloudflare. Analogicznie do siostrzanego projektu `pit-2027` (pit.kondratek.pl):
**brak** `wrangler.toml` czy jakiejkolwiek konfiguracji CLI w tym repo —
sprawdzone w `pit-2027`, tam też całość idzie przez integrację GitHub w panelu,
bez Wranglera. Ten projekt robi dokładnie to samo.

## 1. Podłączenie repo do Cloudflare Pages

1. Panel Cloudflare → **Workers & Pages** → **Create** → zakładka **Pages** →
   **Connect to Git**.
2. Wybierz repozytorium `mkondratek/abkredyt` (musi być publiczne albo
   Cloudflare musi mieć do niego dostęp przez GitHub App).
3. Ustawienia builda:
   - **Production branch**: `main`
   - **Framework preset**: `None`
   - **Build command**: *(puste)*
   - **Build output directory**: `public`
4. Zapisz i wdróż. Pierwszy deploy pojedzie automatycznie po podłączeniu.

Od tej pory każdy push na `main` wdraża produkcję, a każdy PR dostaje własny
podgląd pod `https://<hash-albo-branch>.abkredyt.pages.dev`.

## 2. Domena własna: abkredyt.kondratek.pl

1. W projekcie Pages → zakładka **Custom domains** → **Set up a custom domain**.
2. Wpisz `abkredyt.kondratek.pl` i potwierdź.
3. Ponieważ strefa `kondratek.pl` jest już w Cloudflare DNS, rekord CNAME
   (`abkredyt` → `abkredyt.pages.dev`) zostanie dodany **automatycznie** — nie
   trzeba nic klikać w zakładce DNS ręcznie.
4. Certyfikat SSL wystawia się sam, zwykle w ciągu kilku minut.

## 3. Cloudflare Web Analytics

1. Panel Cloudflare → **Analytics & Logs** → **Web Analytics** → **Add a site**.
2. Jako adres podaj `abkredyt.kondratek.pl`.
3. Cloudflare pokaże fragment JS z tokenem (`token: "…"` w atrybucie
   `data-cf-beacon`) — skopiuj sam **token** (ciąg znaków), nie cały snippet.
4. Wklej ten token w miejsce placeholdera `CF_ANALYTICS_TOKEN` w skrypcie
   analityki na końcu `public/index.html`. Dopóki stoi tam placeholder, beacon
   w ogóle się nie ładuje — strona działa bez statystyk. Beacon startuje
   wyłącznie na hoście `abkredyt.kondratek.pl`, a własne urządzenie wyłącza
   się wchodząc raz na `/?bez-statystyk=1`.

Beacon (`static.cloudflareinsights.com`) jest już dopuszczony w
`public/_headers` (CSP: `script-src`/`connect-src`), więc po wklejeniu tokenu
nic więcej nie trzeba odblokowywać.

**Uwaga**: token analityki jest zwykle gated do hosta produkcyjnego —
podglądy na `*.abkredyt.pages.dev` nie będą raportować ruchu do tej samej
usługi (to zamierzone: podglądy PR-ów nie powinny zaśmiecać statystyk
produkcyjnych).

## Co jest, a czego nie ma w tym repo

- Jest: `public/_headers` (nagłówki bezpieczeństwa + CSP), `public/robots.txt`,
  `public/sitemap.xml`, `public/404.html`, `public/favicon.svg`, `public/og.png`
  (wygenerowany z `og-image.html`).
- Nie ma: żadnego `wrangler.toml`, żadnego kroku deployu w
  `.github/workflows/ci.yml` — ten workflow tylko **weryfikuje** (walidacja
  HTML + test dymny Playwrightem), wdrożenie robi wyłącznie integracja
  Cloudflare Pages ↔ GitHub opisana w punkcie 1.
