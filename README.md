# dotrino-passmanager

Gestor de contraseñas del ecosistema **Dotrino**: contraseñas, códigos de dos pasos
(TOTP) y —más adelante— passkeys, custodiadas por la bóveda del usuario
(`dotrino-vault`) en vez de por un servidor ajeno.

Lo que lo distingue: **el navegador nunca tiene la bóveda entera**. La extensión
pregunta por una credencial concreta y recibe esa sola; quién responde es el vault
del PC, el teléfono (con huella) o, como último recurso, una caché local de solo
lectura.

**Estado: paso 1 en marcha.** Ver [`docs/DISENO.md`](./docs/DISENO.md).

| | | |
|---|---|---|
| `lib/` | `@dotrino/passmanager` — modelo, cifrado, interfaz de bóveda | hecho, 19 tests |
| `extension/` | extensión Chrome MV3 | hecha, sin publicar en la tienda |
| `web/` | landing en [pass.dotrino.com](https://pass.dotrino.com/) | en vivo |

La consola web llega en el paso 2, con el vault: antes no hay nada que sincronice la
bóveda de la extensión con la de la web. La app nativa es una pantalla de
`dotrino-app`, no vive aquí.

## Plan

1. **Bóveda, autocompletado, TOTP e importación** ← aquí estamos
2. El **vault del PC** responde de a una
3. El **teléfono** responde de a una, con huella
4. **Passkeys**

## Desarrollo

```bash
cd lib && npm test              # 19 tests, sin dependencias
cd extension && npm run build   # copia lib/src a src/vendor, luego cargar descomprimida
```
