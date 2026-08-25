# dotrino-passmanager

Gestor de contraseñas del ecosistema **Dotrino**: contraseñas, códigos de dos pasos
(TOTP) y —más adelante— passkeys, custodiadas por la bóveda del usuario
(`dotrino-vault`) en vez de por un servidor ajeno.

Lo que lo distingue: **el navegador nunca tiene la bóveda entera**. La extensión
pregunta por una credencial concreta y recibe esa sola; quién responde es el vault
del PC, el teléfono (con huella) o, como último recurso, una caché local de solo
lectura.

**Estado: diseño, sin implementar.** Ver [`docs/DISENO.md`](./docs/DISENO.md).

## Piezas previstas

| | |
|---|---|
| `lib/` | `@dotrino/passmanager` — modelo, cifrado, interfaz de bóveda |
| `extension/` | extensión Chrome MV3 |
| `web/` | `pass.dotrino.com` — consola de la bóveda + landing |

La app nativa es una pantalla de `dotrino-app`, no vive aquí.
