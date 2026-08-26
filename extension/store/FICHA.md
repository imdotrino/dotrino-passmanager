# Ficha para la Chrome Web Store

Lo que hay que rellenar en el panel, ya escrito. **La subida la hace el dueño**: hace
falta la cuenta de desarrollador (pago único de 5 USD) y no se puede automatizar sin
sus credenciales.

## Lo que falta, exactamente

**Solo dos cosas, y las dos son del dueño porque exigen su cuenta:**

1. **Crear la cuenta de desarrollador** en el panel de la tienda (pago único de 5 USD) y
   dar de alta la extensión una vez, para que le asigne un **ID**.
2. **Sacar tres credenciales** de un proyecto de Google Cloud con la *Chrome Web Store
   API* activada: `CHROME_CLIENT_ID`, `CHROME_CLIENT_SECRET`, `CHROME_REFRESH_TOKEN`.
   Los pasos están en la cabecera de `extension/publish.mjs`.

Con esas cuatro variables en el entorno, subir es un comando:

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

## Capturas (1280×800)

Hechas, en `store/capturas/`, sobre las páginas EN VIVO (no maquetas):

- [x] `1-landing.png` — la portada, con la promesa
- [x] `2-aparatos.png` — la consola de aparatos
- [x] `3-privacidad.png` — la política

Se regeneran con:

```bash
chromium --headless --window-size=1280,800 \
  --screenshot=extension/store/capturas/1-landing.png https://pass.dotrino.com/
```

Faltan las dos que **exigen la extensión cargada**, y esas hay que hacerlas a mano
porque no se pueden sacar de una página servida:

- [ ] el popup enlazado, con lo que hay para un sitio
- [ ] el botón sobre un campo y su modal abierto

En `chrome://extensions` → «Cargar descomprimida» → carpeta `extension/`, con una bóveda
corriendo al otro lado.

## Lo que hay que esperar

- La revisión de una extensión de credenciales es **lenta y en cada actualización**.
- Si piden aclaración sobre `world: "MAIN"`, la respuesta es la de la tabla: sin eso no
  hay passkeys en escritorio, y no es un permiso sino una declaración del manifiesto.
