"""Test dymny: serwuje public/ lokalnym http.server (tak jak w produkcji —
strona używa ścieżek bezwzględnych typu /favicon.svg, więc file:// dałoby
fałszywe błędy), otwiera / w headless Chromium, robi zrzut ekranu do shot.png
(katalog główny repo, w .gitignore) i kończy się kodem != 0, jeśli strona
zgłosiła błąd JS albo cokolwiek wylądowało w konsoli jako error — dzięki temu
może służyć jako krok w CI, nie tylko jako ręczne narzędzie.

Zmienna PW_CHANNEL (np. "chrome") pozwala lokalnie użyć zainstalowanej
przeglądarki zamiast pobierać chromium Playwrighta — w CI zostaw pustą.
"""
import asyncio, functools, os, sys, threading
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from playwright.async_api import async_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PUBLIC = os.path.join(ROOT, 'public')
SHOT = os.path.join(ROOT, 'shot.png')

async def main():
    handler = functools.partial(SimpleHTTPRequestHandler, directory=PUBLIC)
    server = ThreadingHTTPServer(('127.0.0.1', 0), handler)
    port = server.server_address[1]
    threading.Thread(target=server.serve_forever, daemon=True).start()

    errors = []
    try:
        async with async_playwright() as p:
            launch_kwargs = {}
            channel = os.environ.get('PW_CHANNEL')
            if channel:
                launch_kwargs['channel'] = channel
            browser = await p.chromium.launch(**launch_kwargs)
            page = await browser.new_page(viewport={'width': 1280, 'height': 900})
            page.on('pageerror', lambda e: errors.append(f'pageerror: {e}'))
            page.on('console', lambda m: errors.append(f'console.{m.type}: {m.text}') if m.type == 'error' else None)
            await page.goto(f'http://127.0.0.1:{port}/')
            await page.wait_for_timeout(1500)
            await page.screenshot(path=SHOT, full_page=True)
            await browser.close()
    finally:
        server.shutdown()

    if errors:
        print(f'Błędy strony ({len(errors)}):')
        for e in errors:
            print(' -', e)
        sys.exit(1)
    print('OK — brak błędów, zrzut zapisany w', SHOT)

asyncio.run(main())
