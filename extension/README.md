# Extensión de Chrome — Dotrino

Extensión MV3 del gestor de contraseñas. Ver el diseño en
[`../docs/DISENO.md`](../docs/DISENO.md).

## La extensión NO tiene la bóveda

No guarda contraseñas, no tiene la llave y no puede listar nada. Cuando hace falta una
credencial se la pide a la bóveda del usuario por el proxio y recibe **esa sola**. Si
la bóveda está apagada, la extensión no sabe nada — y eso es el diseño, no una
carencia.

Dos consecuencias en el código, por si tientan a «arreglarlas»:

- **`enableWebRTC: false`** al crear el cliente. `RTCPeerConnection` no existe en un
  service worker, así que con WebRTC activo la negociación revienta. Y tampoco
  aportaría: los sobres ya van sellados. El día que se quiera, hace falta
  `chrome.offscreen`.
- **La identidad la persiste `@dotrino/proxy-client` ≥ 0.12.0** en IndexedDB. Antes se
  regeneraba en cada llamada sin guardarse, y el aparato cambiaba de llave cada vez
  que el worker se dormía.

## Probar

```bash
npm run build          # copia lib/src y proxy-client a src/vendor (no se commitea)
```

Luego en `chrome://extensions` → «Modo de desarrollador» → «Cargar descomprimida» →
esta carpeta.

Hace falta una bóveda al otro lado:

```bash
cd .. && node bin/passmanager.js serve      # imprime su código
```

Pega ese código en el popup, y autoriza la extensión en la bóveda con el código que el
propio popup muestra:

```bash
node bin/passmanager.js link <código-de-la-extensión> "Chrome del portátil"
```

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
