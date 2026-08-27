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

Y para que los aparatos puedan pedir. Se conectan **como cualquier aparato del
ecosistema**: la bóveda enseña una invitación, el aparato enseña seis caracteres y se
teclean aquí. No hay códigos de enlace que pegar en las dos direcciones.

```bash
node bin/passmanager.js serve                 # atiende por el proxio (y empareja el primero)
node bin/passmanager.js serve --pair          # abre una invitación para otro aparato
node bin/passmanager.js devices               # los que pueden pedir credenciales
node bin/passmanager.js unlink AB12-CD34      # retirar uno del perfil
```

## Desarrollo

```bash
cd lib && npm test              # 67 tests, sin dependencias ni red
node bin/passmanager.js serve   # la bóveda: abre y atiende peticiones
node test/e2e.mjs aparato       # prueba contra el proxio de verdad (ver el propio archivo)
cd extension && npm run build   # arma el vendor, luego cargar descomprimida
```
