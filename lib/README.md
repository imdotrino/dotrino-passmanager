# @dotrino/passmanager

> **Parte del ecosistema [Dotrino](https://dotrino.com).** Dotrino es un ecosistema de aplicaciones centradas en la privacidad de los datos: tu información es tuya, y las decisiones sobre ella también — qué compartes, con quién, cuándo y por qué. Sin anuncios, sin cookies, sin rastreo de datos, sin vender tu identidad a nadie.

El modelo de datos, el cifrado y las dos puntas del gestor de contraseñas de Dotrino:
la bóveda que **custodia** y el aparato que **pide**.

La idea que lo ordena: **el aparato pide una credencial por dominio y recibe esa sola.**
Nunca la bóveda entera. Un compromiso del navegador no es un compromiso total.

```bash
npm install @dotrino/passmanager
```

## Las dos puntas

```js
import { LocalVault, VaultResponder } from '@dotrino/passmanager'

// Donde vive la bóveda: tiene la llave, guarda, y decide quién puede pedir.
const vault = new LocalVault(store)
vault.unlock(cek)

new VaultResponder({
  client,                                   // @dotrino/proxy-client, ya identificado
  vault,
  isAllowed: pub => misAparatos.has(pub),   // por defecto NADIE
  needsApproval: op => op === 'get',        // una vez por aparato, no por credencial
  approve: async ({ pubkey }) => preguntarAlUsuario(pubkey),
  encPubOf: pub => llaveDeCifradoDe(pub),
  onRequest: apuntarEnLaBitacora,
}).start()
```

```js
import { RemoteVault, ProxyTransport } from '@dotrino/passmanager'

// Quien pide: no tiene la llave y NO puede listar.
const remota = new RemoteVault(new ProxyTransport({ client, peerPubkey, peerEncPub }))

const hay = await remota.find('https://salesforce.com/')  // metadatos, sin secretos
const una = await remota.get(hay[0].id)                    // UNA credencial
await remota.list()                                        // ✗ falla: no-key, a propósito
```

`list()` no está para el aparato, y esa ausencia es el diseño: si pudiera listarlo todo,
el «de a una» sería decorativo.

## Qué más trae

| | |
|---|---|
| `sealEntry` / `openEntry` | cifrado por entrada, con el AAD atando cada criptograma a su campo |
| `findForUrl` / `matchSite` | emparejamiento por **etiquetas de dominio**, nunca por sufijo de cadena |
| `totpNow` | códigos de dos pasos (RFC 6238), y acepta el secreto pelado de Bitwarden |
| `importAuto` | 1Password, Bitwarden (CSV y JSON) y Chrome |
| `generatePassword` | generador **sin sesgo** de reparto |
| `normalizeFields` | campos libres `{ label, value, kind }` |
| `SessionCache` | recuerdo en memoria de lo ya entregado |

## Dos reglas que el código hace cumplir

**Nada viaja en claro.** El proxio enruta pero no cifra: sin sellar, vería a qué sitio
se le pide credencial y cuál se devuelve. Va sellado con `@dotrino/proxy-client`
≥ 0.13.0, y **lo que llega sin sellar se rechaza** — sellar solo de salida no sirve de
nada si la otra punta acepta texto plano.

**Una entrada sin `sites` sirve en cualquier parte.** Así se guarda el correo o la
cédula, sin un tipo aparte y con una sola regla de emparejamiento.

## Documentación

Diseño completo, con lo decidido y lo descartado, en
[`docs/DISENO.md`](https://github.com/imdotrino/dotrino-passmanager/blob/main/docs/DISENO.md).
