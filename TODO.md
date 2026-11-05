# Pendientes de Contraseñas

## Importar de otros gestores (1Password, Bitwarden, Chrome)

Pedido por el dueño el 2026-11-05: **hay que hacerlo**. Sin esto nadie se cambia.

- **Lo que ya existe:** `lib/src/import.js` lee los CSV de 1Password, Bitwarden y Chrome y
  devuelve las entradas en claro, y solo lo usa la línea de comandos
  (`node bin/passmanager.js import claves.csv`, contra la bóveda del PC).
- **Lo que falta:** importar desde la **extensión** (a su bóveda propia o a la bóveda de Dotrino
  conectada) y desde las apps nativas (Android/iOS). Hoy la extensión solo importa y exporta su
  propio respaldo (`bkImport` / `bkExport`), y su texto `importHint` manda a la línea de comandos.
- **Hasta que esté**, ni la portada ni la ficha de la tienda lo prometen (se quitó el 2026-11-05).
  Cuando salga, se vuelve a poner en `web/index.html` (`c6t`/`c6d`), `web/app.js` y la descripción
  larga de la Chrome Web Store en es y en (`extension/store/FICHA.md`).
