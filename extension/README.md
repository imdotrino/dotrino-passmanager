# Extensión de Chrome — Dotrino

Extensión MV3 del gestor de contraseñas. Ver el diseño en
[`../docs/DISENO.md`](../docs/DISENO.md).

## Estado: paso 1

La extensión es **hoy** una bóveda local completa, protegida por una contraseña
maestra. Eso es el paso 1 del plan y **no es el destino**: en el paso 2 la CEK deja de
estar aquí y la extensión pasa a pedir de a una al vault (`RemoteVault`, ya escrita en
`lib`), y en el paso 3 al teléfono. Lo que hoy es la bóveda se convierte entonces en
la caché de solo lectura del §3.

Por eso todo pasa por el service worker: el día que cambie quién responde, solo cambia
lo que hay detrás de él.

## Probar

```bash
npm run build          # copia lib/src a src/vendor (no se commitea)
```

Luego en `chrome://extensions` → «Modo de desarrollador» → «Cargar descomprimida» →
esta carpeta.

## El banco de pruebas de detección

`test/formularios.html` reúne los casos que rompen a los detectores de formularios:
campo de contraseña oculto, registro con confirmación, buscador junto al acceso,
inputs sin `name`, acceso en dos pasos, shadow DOM y un formulario que monta la SPA
después.

```bash
cp src/detect.js test/          # el import de abajo lo carga del mismo origen
python3 -m http.server 8931 --directory test
```

Con `http://localhost:8931/formularios.html` abierto, en la consola del navegador:

```js
const m = await import('/detect.js')
m.findLoginForms(document)      // deben salir 7 formularios
```

Lo que tiene que pasar: **7** formularios. El de contraseña oculta no sale; del de
registro sale solo la primera contraseña; en el del buscador el usuario es `login_id`
y nunca `search`.

Esta comprobación es **manual** por ahora: automatizarla pide un navegador de verdad
(Playwright), y todavía no está en el repo. La lógica que sí se prueba sola está en
`../lib` (`npm test`).
