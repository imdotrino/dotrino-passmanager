# dotrino-passmanager

Gestor de contraseñas del ecosistema **Dotrino**: contraseñas, códigos de dos pasos
(TOTP) y —más adelante— passkeys, custodiadas por la bóveda del usuario
(`dotrino-vault`) en vez de por un servidor ajeno.

Lo que lo distingue: **el navegador nunca tiene la bóveda entera**. La extensión
pregunta por una credencial concreta y recibe esa sola; quién responde es el vault
del PC, el teléfono (con huella) o, como último recurso, una caché local de solo
lectura.

**Estado: usable de punta a punta.** La bóveda guarda, genera e importa; la extensión
pide de a una por el proxio y nada viaja en claro. Ver
[`docs/DISENO.md`](./docs/DISENO.md).

| | | |
|---|---|---|
| `lib/` | `@dotrino/passmanager` — modelo, cifrado, protocolo, las dos puntas | hecho, 56 tests |
| `bin/` | la bóveda: crear, editar, generar, importar, y responder a los aparatos | hecha |
| `extension/` | extensión Chrome MV3 — pide, no guarda | hecha, sin publicar en la tienda |
| `web/` | landing en [pass.dotrino.com](https://pass.dotrino.com/) | en vivo |

La consola web llega en el paso 2, con el vault: antes no hay nada que sincronice la
bóveda de la extensión con la de la web. La app nativa es una pantalla de
`dotrino-app`, no vive aquí.

## Plan

1. **Bóveda, autocompletado, TOTP e importación** — hecho
2. El **vault del PC** responde de a una — hecho, y **el vault del ecosistema también**
   (`dotrino-vault caps <ID> +contrasenas`), con su acta y su bitácora
3. El **teléfono** aprueba, con huella — hecho: va por la aprobación del vault
   (`dotrino-vault approval <ID> on`)
4. **Passkeys** — hechas

## La bóveda, desde la línea de órdenes

```bash
node bin/passmanager.js ls                    # lo guardado
node bin/passmanager.js add                   # una entrada nueva
node bin/passmanager.js edit salesforce       # editar (por id, título o sitio)
node bin/passmanager.js show salesforce       # verla, con su código de dos pasos
node bin/passmanager.js rm salesforce         # quitarla
node bin/passmanager.js gen 24                # una contraseña
node bin/passmanager.js import claves.csv     # de 1Password, Bitwarden o Chrome
```

Los **sitios vacíos** significan que la entrada sirve en cualquier parte — así se
guardan el correo, el teléfono o la cédula. En la contraseña, **`g` genera una**.

En la página, el gestor pone un botón en la esquina de un campo **solo cuando puede
hacer algo ahí**: si el campo está vacío y tienes algo guardado suyo, **rellenar**; si
tiene algo escrito, **guardar**. Con una sola letra ya aparece. **Nada se rellena solo**: al
pulsar sale un modal pegado al campo donde eliges **de qué entrada**, rellenas ese dato o
**todos** de una vez, y guardas lo que escribiste — marcándolo **privado** si quieres.

**Y la bóveda pregunta antes de soltar nada.** También la que la extensión lleva dentro:
sacar una contraseña de ahí abre una confirmación en la pantalla de la extensión, igual que
con la bóveda del equipo o la del teléfono. Es a propósito que se vea mientras el proceso
se asienta ([`docs/DISENO.md`](./docs/DISENO.md) §3.3.2).

Vale para **cualquier** campo, lo reconozca o no: el número de socio o el código del
portal se guardan por el nombre que les pone la página, y eliges si van a una entrada que
ya tienes o a una nueva.

Desde el navegador, guardar se pregunta **después de entrar**, en la página siguiente,
como en cualquier gestor — y también en formularios que no son un acceso (tu nombre, el
correo, la dirección). El aviso lista **una fila por dato**, marcando lo que es nuevo y lo
que cambia algo que ya tenías, con una casilla para elegir cuáles entran; y **dónde
guardarlo**: una entrada nueva, o cuál de las que ya hay para ese sitio se reemplaza. De
las que hay solo se enseña lo público —la pista del usuario y cuándo se tocó—; los valores
guardados solo salen de la bóveda si los pides. Es un iframe de la extensión: la página no
lo pulsa, ni lo lee, ni escribe en tu bóveda. Detalle en
[`docs/DISENO.md`](./docs/DISENO.md) §4.0.1 y §4.0.2.

Y para que los aparatos puedan pedir. Se conectan **como cualquier aparato del
ecosistema**: la bóveda enseña una invitación, el aparato enseña seis caracteres y se
teclean aquí. No hay códigos de enlace que pegar en las dos direcciones.

```bash
node bin/passmanager.js serve                 # atiende por el proxio (y empareja el primero)
node bin/passmanager.js serve --pair          # abre una invitación para otro aparato
node bin/passmanager.js devices               # los que pueden pedir credenciales
node bin/passmanager.js unlink AB12-CD34      # retirar uno del perfil
```

## Probar la extensión a mano

**[pass.dotrino.com/test/](https://pass.dotrino.com/test/)** — banco de pruebas con
los casos que de verdad rompen a los gestores: acceso que navega, acceso sin `submit`,
dos pantallas, registro con confirmación, campos de datos y los raros de detección. Cada
caso dice qué debería pasar. Se abre y ya; carga la extensión y a probar.

No manda nada a ninguna parte: los formularios solo pasan a otra página de ahí mismo.
`noindex` y fuera del `robots.txt` — es una página interna, no parte del producto.

En local, y para recorrerlo solo:

```bash
npm run test:web                # sirve web/test en http://localhost:8099
npm run test:bench              # lo recorre entero, en un Chrome de verdad
npm run test:save-prompt        # el aviso de guardar, de punta a punta
```

## Desarrollo

```bash
cd lib && npm test              # 67 tests, sin dependencias ni red
node bin/passmanager.js serve   # la bóveda: abre y atiende peticiones
node test/e2e.mjs aparato       # prueba contra el proxio de verdad (ver el propio archivo)
cd extension && npm run build   # arma el vendor, luego cargar descomprimida
```
