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

```js
import { LocalVault, GuardedVault, ApprovalGate } from '@dotrino/passmanager'

// Una bóveda LOCAL que además pide autorización: es lo que usa la extensión, donde no
// hay transporte de por medio y por tanto nadie le ponía la puerta.
const gate = new ApprovalGate({ ask: ({ payload }) => preguntarleAlUsuario(payload) })
const vault = new GuardedVault(new LocalVault(store), { gate })

await vault.find(url)      // público: no pregunta
await vault.get(id)        // pide autorización, o lanza `not-approved`
```

La puerta es **la misma pieza** que usa `VaultResponder`, y por eso las tres bóvedas del
gestor se comportan igual: el sí se recuerda (o no, según con qué llave), el no nunca se
recuerda, y dos peticiones a la vez producen un solo aviso.

Y como abrir una entrada cuesta una autorización, `find` y `search` traen además **un
resumen de cada campo** —públicos y privados, un solo método— con un nonce nuevo en cada
respuesta, para poder decir «esto ya está guardado igual» sin abrir nada:

```js
const [hit] = await vault.find('https://salesforce.com/')
const hash = await fieldHasher(hit.nonce)
const igual = await hash('secret', loQueEscribio) === hit.fieldHashes.secret
```

El resumen dice si es igual, **no qué era**: para eso hay que abrir la entrada. Y no se
reparte más allá de quien compara — con un valor corto y de forma conocida (un teléfono,
un documento), tenerlo delante es poder adivinarlo.

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
| `GuardedVault` / `ApprovalGate` | la puerta de autorización, delante de cualquier bóveda |
| `entryFieldKeys` / `entryFieldValues` | qué campos lleva una entrada, por su nombre |
| `makeNonce` / `fieldHasher` | los **resúmenes** con los que se compara sin abrir la entrada |

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
