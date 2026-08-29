# Ficha para la Chrome Web Store

Lo que hay que rellenar en el panel, ya escrito. **La subida la hace el dueño**: hace
falta la cuenta de desarrollador (pago único de 5 USD) y no se puede automatizar sin
sus credenciales.

## Lo que falta, exactamente

**Hecho (2026-08-26):** cuenta de desarrollador `sandrade` y extensión dada de alta.

```
CHROME_EXTENSION_ID=iheeephdbjdpgfhkhmfnpgbhmdflplpp
```

**Queda una cosa, y es del dueño:** sacar tres credenciales de un proyecto de Google
Cloud con la *Chrome Web Store API* activada — `CHROME_CLIENT_ID`,
`CHROME_CLIENT_SECRET`, `CHROME_REFRESH_TOKEN`. Los pasos están en la cabecera de
`extension/publish.mjs`. Con eso, subir es un comando:

```bash
cd extension
npm run package                  # arma el zip
npm run publish:store            # lo sube como BORRADOR
node publish.mjs --publish       # y esto lo publica de verdad
```

El script distingue el fallo real del aparente: la tienda contesta **200 con
`uploadState: FAILURE`**, así que mirar solo el código HTTP diría que fue bien cuando no.

## El paquete

```bash
cd extension && npm run package     # deja build/dotrino-passmanager-<versión>.zip
```

El zip lleva el `vendor/` dentro (obligatorio: MV3 solo importa de su propia carpeta) y
deja fuera los tests. Verificado: 49 archivos, ~85 KB.

## Campos del panel

**Nombre**
`Dotrino — gestor de contraseñas`

**Descripción corta** (132 caracteres máx.)
`Tus contraseñas las guarda tu propia bóveda. El navegador recibe solo la del sitio que abres, y nada más.`

**Descripción larga**

```
Un gestor de contraseñas en el que el navegador NO guarda tus contraseñas.

Lo habitual es que la extensión tenga una copia de todas y la descifre al
desbloquearla. Aquí no: cuando entras a un sitio, le pide a tu bóveda la
contraseña de ese sitio, la usa y la suelta. Si alguien se hiciera con la
extensión, no se llevaría tu bóveda, porque no la tiene.

QUÉ HACE

· Guarda contraseñas, códigos de dos pasos y passkeys.
· Guarda también otros datos que rellenas a menudo — correo, teléfono,
  dirección, cédula — atados a un sitio o válidos en cualquiera.
· No autocompleta por su cuenta: marca los campos donde puede ayudar y espera
  a que tú elijas.
· Trae lo que ya tienes desde 1Password, Bitwarden o Chrome.
· Genera contraseñas.

DÓNDE VIVEN TUS DATOS

En tu equipo, en tu bóveda. No en un servidor nuestro: no tenemos ninguno que
las guarde. Lo que viaja entre tus aparatos va cerrado con una llave que solo
ellos tienen, así que por el camino no se puede leer.

Sin cuenta, sin correo, sin anuncios y sin código de terceros. Código abierto
(MIT): https://github.com/imdotrino/dotrino-passmanager

HACE FALTA TU BÓVEDA

Esta extensión pide, no guarda. Necesita tu bóveda corriendo en tu equipo:

    npx dotrino-passmanager serve

Instrucciones en https://pass.dotrino.com
```

**Categoría:** Productividad · Herramientas
**Idiomas:** español, inglés
**Sitio web:** https://pass.dotrino.com
**Política de privacidad:** https://pass.dotrino.com/privacy.html

⚠️ **La ficha de la tienda tiene puesta la URL vieja** (`/privacidad.html`), de cuando
las rutas estaban en español. Hay que corregirla en el panel: **una política que
responde 404 es motivo de rechazo**. La ruta vieja se deja respondiendo igualmente
(CONVENCIONES §8.1: la nueva es la canónica, la vieja se conserva).

## Justificación de permisos

La tienda revisa esto con lupa en cualquier extensión que toque credenciales. Cada
permiso, y por qué es el mínimo:

| Permiso | Por qué |
|---|---|
| `storage` | Guardar a qué bóveda está enlazada y su llave de aparato. Las credenciales entregadas van en `storage.session` (memoria, se borra al cerrar el navegador). |
| `host_permissions` (`https://*/*`) | El gestor tiene que reconocer formularios en cualquier sitio, y no hay forma de acotarlo sin que deje de servir donde el usuario lo necesita. **Solo sitios cifrados**: `http://*/*` se quitó el 2026-08-29 — un gestor de contraseñas no tiene nada que hacer en una página que viaja en claro. Las dos excepciones, `http://localhost` y `http://127.0.0.1`, son la máquina de quien lo desarrolla: ahí corren las pruebas. |
| `world: "MAIN"` (passkeys) | Chrome no da API de proveedor de credenciales a las extensiones; la única vía en escritorio es reemplazar `navigator.credentials` en la página. Es lo mismo que hacen 1Password y Bitwarden. |

**Quitados el 2026-08-29: `activeTab` y `scripting`.** Estaban declarados y no los
usaba una sola línea del código: quien escribe en el campo es el content script, que ya
entra por `content_scripts`. Un permiso que no se usa es una objeción regalada en la
revisión, y una línea de más en el aviso que ve el usuario al instalar.

**Uso de datos que hay que declarar:** «Información de autenticación» — recogida sí,
pero **no se transmite a terceros ni se vende**; viaja cifrada solo entre los aparatos
del propio usuario.

## Estado en la tienda (2026-08-26)

**Enviada a revisión.** `ID: iheeephdbjdpgfhkhmfnpgbhmdflplpp` · `Status: Pending review`

Hecho desde aquí:

- [x] paquete subido (el zip se aceptó al crear el item)
- [x] descripción larga en español
- [x] categoría: **Privacy & Security**
- [x] nombre y resumen: salen del paquete vía `_locales`, así que la tienda los muestra
      en el idioma de quien mira

También hecho:

- [x] **imágenes** (icono y capturas) — las subió el dueño a mano. **Los campos de
      archivo no se pueden automatizar**: probado con el selector nativo, con clic en la
      zona, con el input directo y con un archivo generado en la propia página; en todos,
      `input.files` vuelve a cero. Los archivos listos están en `store/capturas/`, sin
      canal alfa (la tienda lo rechaza y Chromium captura con él).
- [x] **pestaña Privacy** entera: propósito único, justificación de cada permiso
      (`storage` y host), las tres certificaciones y la URL de
      la política.
- [x] **«No, I am not using remote code»** — venía marcado en «Sí» POR DEFECTO, y es
      falso: la extensión lleva todo dentro del paquete (por eso `build.mjs` vendoriza
      lib y proxy-client). Dejarlo habría sido declarar algo que no es cierto y retrasar
      la revisión.
- [x] **correo de contacto del publisher**: `sandrade@dotrino.com`, verificación enviada.

## Se trabaja en BORRADOR, y se envía cuando esté probado

> Decidido por el dueño el 2026-08-26, después de cancelar la primera revisión.

Se envió a revisión una versión que **nadie había usado**: estaba verificada por piezas
—tests, el popup cargando, capturas— pero no de punta a punta. Probarla en serio destapó
tres fallos, dos de ellos capaces de romper el producto en cuanto alguien reiniciara la
bóveda. La revisión se canceló y ahora el borrador es el sitio de trabajo.

La regla: **la tienda es el último paso, no un hito de progreso.** Se sube el paquete al
borrador, se prueba con una bóveda de verdad, y solo entonces se envía.

Con una revisión en curso el botón «Upload new package» queda **deshabilitado** y no hay
forma de dejar nada en borrador — otra razón para no enviar antes de tiempo.

**Estado: borrador con la 0.1.1**, dos idiomas reconocidos y los cuatro permisos
declarados. También se descarga de `pass.dotrino.com`, que es como se instala hoy.

Google avisó de que **la revisión será más lenta por los permisos de host amplios**, y
sugirió acotarlos. No se acotan y el motivo está en la tabla de permisos de más abajo:
un gestor de contraseñas tiene que reconocer formularios donde el usuario tenga cuenta,
y esa lista no se sabe de antemano. La justificación que se envió lo dice así.
## Instrucciones para quien revisa (Access → Test instructions)

Estaban **vacías** hasta el 2026-08-28, y eso es media revisión perdida: quien la abre no
tiene forma de saber que **no hace falta cuenta**. Lo que hay escrito ahora (en inglés,
que es lo que lee el equipo de revisión; 492 de 500 caracteres):

> No account or login is required. The extension works as soon as it is installed: it
> creates its own encrypted vault inside the browser.
>
> To review it:
> 1. Open any page with a sign-in form.
> 2. Type a username and a password. A small blue marker appears in the corner of each field.
> 3. Submit the form. On the next page a prompt offers to save it.
> 4. Go back to the form: the marker now offers to fill it in.
>
> It can optionally connect to a self-hosted vault, but that is not needed to test it.

**Usuario y contraseña de prueba: vacíos, y es correcto.** No hay inicio de sesión que dar.

- [ ] repasar la pestaña **Privacy** (declaración de uso de datos: «información de
      autenticación», recogida sí, **no** vendida ni cedida)
- [ ] pulsar **Submit for review**

## Capturas (1280×800)

> **Rehechas el 2026-08-28** para la 0.16.0: las anteriores eran de la 0.1.x y enseñaban
> una interfaz que ya no existe. Se generan con `extension/store/tienda.mjs` —Chrome de
> verdad, extensión cargada, en español— sobre una página de demo servida interceptando
> `https://tienda.ejemplo`, para que el sitio que sale en la UI se lea y no sea un
> `localhost:8099`.
>
### Qué archivo va en qué campo

Los nombres dicen **la sección del panel y su tamaño**, para no tener que adivinar al
subirlas. Todas en `extension/store/capturas/`, PNG de 24 bits (sin canal alfa: la tienda
lo rechaza y Chromium captura con él).

| Campo del panel | Archivo |
|---|---|
| **Store icon** (128×128) | `store-icon-128x128.png` |
| **Screenshots** (1280×800, hasta 5) | `screenshot-1-save-prompt-1280x800.png` — el aviso de después de entrar |
| | `screenshot-2-fill-field-1280x800.png` — el botón de un campo, con su modal |
| | `screenshot-3-data-fields-1280x800.png` — un formulario de datos, con lo privado |
| | `screenshot-4-popup-list-1280x800.png` — la lista de la extensión |
| **Small promo tile** (440×280) | `small-promo-tile-440x280.png` |
| **Marquee promo tile** (1400×560) | `marquee-promo-tile-1400x560.png` |

Las capturas valen para los dos idiomas: van en **Global screenshots** (la UI sale en
español, que es el idioma por defecto de la ficha). Antes de subirlas hay que **quitar las
que haya**, y cada «Remove image» pide confirmación.

### Subirlas: el panel NO acepta `setInputFiles`

Los campos de imagen son **zonas de arrastre**: el `input[type=file]` que hay al lado
solo lo usa el diálogo nativo, y al escribirle archivos se queda a cero (por eso la nota
anterior decía que había que subirlas a mano). Lo que sí funciona es **soltar el archivo**
como lo haría una persona:

1. Los bytes no se pueden leer desde la página (otro origen, y sin `fs`): se sirven
   interceptando una URL del propio dominio con `page.route` + `route.fulfill({ path })`,
   y la página los pide con `fetch`.
2. Con el blob se arma un `File`, se mete en un `DataTransfer` y se disparan
   `dragenter`/`dragover`/`drop` sobre el `[jsname=DagSrd]` de esa sección.

Y **cada «Remove image» abre un diálogo de confirmación** que hay que contestar: sin eso,
su capa se traga los clics siguientes y parece que la página no responde.


Hechas con la **extensión cargada de verdad** en Chromium, no simuladas:

- [x] `1-popup.jpg` — el popup real pidiendo enlazar, con su código de aparato
- [x] `2-marcador.jpg` — los marcadores sobre un formulario de acceso
- [x] `1-landing.png` / `3-privacidad.png` — las páginas web, por si hacen falta

El popup se captura cargando la extensión y yendo a su URL interna. El id de una
extensión descomprimida **se deriva de la ruta**: SHA-256 del path absoluto, primeros 16
bytes, cada nibble mapeado a `a`–`p`.

```bash
ID=$(python3 -c "import hashlib,os;h=hashlib.sha256(os.path.abspath('.').encode()).hexdigest()[:32];print(''.join(chr(ord('a')+int(c,16)) for c in h))")
chromium --headless=new --load-extension="$PWD" --window-size=1280,800 \
  --screenshot=popup.png "chrome-extension://$ID/src/popup.html"
```

**Sin canal alfa**: la tienda exige JPEG o PNG de 24 bits, y Chromium captura con alfa.
`convert x.png -alpha remove -alpha off -type TrueColor PNG24:x.png`.

Se regeneran con:

```bash
chromium --headless --window-size=1280,800 \
  --screenshot=extension/store/capturas/1-landing.png https://pass.dotrino.com/
```

Faltan tres, y las tres exigen un **navegador de verdad** — no salen de una página
servida en headless:

- [ ] el popup enlazado, con lo que hay para un sitio
- [ ] el botón sobre un campo y su modal abierto
- [ ] la consola de aparatos **con aparatos dentro**

La tercera se intentó en headless y sale con un error en rojo, con razón: sin sesión no
hay bóveda de identidad a la que preguntar. Correcto para el usuario, inservible como
escaparate.

En `chrome://extensions` → «Cargar descomprimida» → carpeta `extension/`, con una bóveda
corriendo al otro lado (`dotrino-vault caps <ID> +contrasenas`, o `npx dotrino-passmanager
serve`).

## Lo que hay que esperar

- La revisión de una extensión de credenciales es **lenta y en cada actualización**.
- Si piden aclaración sobre `world: "MAIN"`, la respuesta es la de la tabla: sin eso no
  hay passkeys en escritorio, y no es un permiso sino una declaración del manifiesto.

## Cuidado con la caché al cambiar la web

`pass.dotrino.com` no tiene build, así que los archivos no llevan hash en el nombre y
Pages los sirve con `max-age=14400` — **cuatro horas**. Un cambio en `app.js` está en
el origen enseguida pero no se ve hasta que caduca el borde.

Por eso los enlaces llevan `?v=N` a mano: **hay que subirlo al tocar el archivo**. Para
comprobar el origen sin esperar: `curl "https://pass.dotrino.com/app.js?v=$(date +%s)"`.
