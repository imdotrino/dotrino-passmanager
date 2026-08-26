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
**Política de privacidad:** https://pass.dotrino.com/privacidad.html

## Justificación de permisos

La tienda revisa esto con lupa en cualquier extensión que toque credenciales. Cada
permiso, y por qué es el mínimo:

| Permiso | Por qué |
|---|---|
| `storage` | Guardar a qué bóveda está enlazada y su llave de aparato. Las credenciales entregadas van en `storage.session` (memoria, se borra al cerrar el navegador). |
| `activeTab` / `scripting` | Rellenar el campo que el usuario elige, solo en la pestaña que tiene delante. |
| `host_permissions` (`http/https`) | El gestor tiene que reconocer formularios en cualquier sitio. No hay forma de acotarlo sin que deje de servir donde el usuario lo necesita. |
| `world: "MAIN"` (passkeys) | Chrome no da API de proveedor de credenciales a las extensiones; la única vía en escritorio es reemplazar `navigator.credentials` en la página. Es lo mismo que hacen 1Password y Bitwarden. |

**Uso de datos que hay que declarar:** «Información de autenticación» — recogida sí,
pero **no se transmite a terceros ni se vende**; viaja cifrada solo entre los aparatos
del propio usuario.

## Estado en la tienda (2026-08-26)

**Extensión creada y en borrador.** `ID: iheeephdbjdpgfhkhmfnpgbhmdflplpp`

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
      (`storage`, `activeTab`, `scripting`, host), las tres certificaciones y la URL de
      la política.
- [x] **«No, I am not using remote code»** — venía marcado en «Sí» POR DEFECTO, y es
      falso: la extensión lleva todo dentro del paquete (por eso `build.mjs` vendoriza
      lib y proxy-client). Dejarlo habría sido declarar algo que no es cierto y retrasar
      la revisión.
- [x] **correo de contacto del publisher**: `sandrade@dotrino.com`, verificación enviada.

Queda **una sola cosa**, y es del dueño porque llega a su correo:

- [ ] pulsar el enlace de verificación (caduca en una hora) y después **Submit for
      review**.
- [ ] repasar la pestaña **Privacy** (declaración de uso de datos: «información de
      autenticación», recogida sí, **no** vendida ni cedida)
- [ ] pulsar **Submit for review**

## Capturas (1280×800)

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
hay bóveda de identidad a la que preguntar, así que la consola dice que no pudo componer
el código. Correcto para el usuario, inservible como escaparate.

En `chrome://extensions` → «Cargar descomprimida» → carpeta `extension/`, con una bóveda
corriendo al otro lado (`dotrino-vault passwords <ID> on`, o `npx dotrino-passmanager
serve`).

## Lo que hay que esperar

- La revisión de una extensión de credenciales es **lenta y en cada actualización**.
- Si piden aclaración sobre `world: "MAIN"`, la respuesta es la de la tabla: sin eso no
  hay passkeys en escritorio, y no es un permiso sino una declaración del manifiesto.

## Cuidado con la caché al cambiar la web

`pass.dotrino.com` no tiene build, así que los archivos no llevan hash en el nombre y
Pages los sirve con `max-age=14400` — **cuatro horas**. Un cambio en `vault.js` está en
el origen enseguida pero no se ve hasta que caduca el borde.

Por eso los enlaces llevan `?v=N` a mano: **hay que subirlo al tocar el archivo**. Para
comprobar el origen sin esperar: `curl "https://pass.dotrino.com/vault.js?v=$(date +%s)"`.
