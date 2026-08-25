# Diseño — `dotrino-passmanager` (gestor de contraseñas del ecosistema)

> **Estado:** diseño inicial, **sin implementar**. Define el *qué* y el *cómo*, y
> el orden en que se construye.
>
> **Idioma/estilo:** español neutro (tuteo). Fuente de verdad del ecosistema:
> [`CLAUDE.md`](../../CLAUDE.md) y [`CONVENCIONES-APPS.md`](../../CONVENCIONES-APPS.md).

## 1. Propósito

Un **gestor de contraseñas** cuyas credenciales las custodia la bóveda del usuario
(`dotrino-vault`) y no un servidor ajeno. Guarda contraseñas, códigos de dos pasos
(TOTP), notas y —más adelante— **passkeys** (credenciales WebAuthn). Se usa desde
una **extensión de Chrome**, desde la **app nativa** (`dotrino-app`) y desde una
consola web en `pass.dotrino.com`.

**Misión Dotrino:** tus contraseñas son tuyas, y las decisiones sobre ellas también.
Lo que este pilar añade sobre lo que ya existe es una promesa concreta que los
gestores comerciales no pueden hacer: **el navegador nunca tiene tu bóveda entera.**

### Qué NO es (deslindes)

- **No es el vault.** `dotrino-vault` es la CA y el custodio; este repo es el
  **producto** que se apoya en él (modelo de datos, autocompletado, extensión, UI).
  Nada de criptografía nueva: se reusa `@dotrino/identity` como en `secretos-sellados`.
- **No es `vault:secrets:<ns>`.** Los cajones del vault guardan secretos de
  **servicios** (tokens de producción, TURN, federación). Esto guarda credenciales
  **del usuario**, con otro volumen (cientos de entradas, cambios constantes) y otro
  patrón de acceso. Comparte el mecanismo de sellado; no el cajón.
- **No es un almacén más.** Las entradas viven en el **store** (§4): tienen que
  estar disponibles siempre, incluso sin ningún node ni daemon encendido.

## 2. La idea central: el navegador pide de a una

Todos los gestores de contraseñas hacen lo mismo: descargan la bóveda cifrada al
navegador, la descifran al desbloquear, y a partir de ahí la extensión tiene todo.
Un compromiso de la extensión es un compromiso total.

Aquí la extensión **pregunta por una credencial concreta y recibe esa sola**:

```
extensión: "necesito la de salesforce.com"
bóveda:    [aplica política, apunta en la bitácora] → una credencial sellada
extensión: la usa y la olvida
```

Quién responde depende de qué esté encendido, pero la promesa no cambia:

| Quién responde | Cuándo | Qué aporta |
|---|---|---|
| **el vault del PC** | está corriendo el daemon | bitácora central, política completa |
| **el teléfono** | siempre (es el caso normal) | hardware real (Keystore / Secure Enclave) + huella |
| **caché local del navegador** | último recurso | **solo lectura**, opt-in, sin escribir ni crear |

Esto es el patrón del ecosistema —el aparato cumple el rol cuando no hay pieza
dedicada— aplicado a las contraseñas. **Ninguna configuración exige un daemon ni un
VPS encendido**, que es regla dura de `CLAUDE.md`.

### 2.1. Por qué el teléfono es el caso normal, no el PC

El PC se apaga; el teléfono no. Y el teléfono tiene almacenamiento respaldado por
hardware, que el navegador de escritorio no tiene. Además el flujo ya existe: la
**aprobación desde el teléfono** (`pair --approval` / `caps +aprueba`, vault 0.50)
es exactamente esta operación con otro contenido.

El vault del PC no desaparece: cuando está, es quien manda y quien lleva la bitácora
central. Pasa de requisito a comodidad.

## 3. Cifrado y reparto de llaves

Se reusa lo de `@dotrino/identity/content`, ya escrito y probado (ver
[`secretos-sellados.md`](../../dotrino-vault/docs/secretos-sellados.md)):

- Una **CEK por bóveda** (`makeContentKey`), con la que se cifra cada entrada
  (`encryptWithCek` / `decryptWithCek`).
- La CEK se **envuelve a cada aparato de confianza** (`wrapForMember`, ECDH efímero
  contra el `encPub` que el miembro registró en el acta). `makeGeneration` ya reporta
  los miembros a los que no se pudo envolver — no se pierden en silencio.
- Al **revocar** un aparato, la CEK rota y se re-envuelve a los que quedan. La
  revocación es por la llave del aparato, no por su papel
  (`dotrino-revocation-model`).

**El reparto de la CEK es lo que define el nivel de confianza de cada aparato:**

| Aparato | ¿Recibe la CEK? | Consecuencia |
|---|---|---|
| vault del PC, app nativa | sí | puede abrir la bóveda entera; puede escribir |
| extensión de Chrome | **no**, por defecto | solo recibe credenciales sueltas, selladas a su ECDH efímera |
| extensión con caché opt-in | sí, marcada de solo lectura | recupera el comportamiento de un gestor normal; se avisa de lo que se pierde |

Ese último renglón es una **degradación explícita y visible para el usuario**, no un
modo por defecto. Es la única forma de leer una contraseña con el teléfono sin
batería y sin el PC, y quien la activa tiene que saber que a partir de ahí el
navegador sí tiene la bóveda.

## 4. Dónde vive cada cosa

Frontera del §4 de `CONVENCIONES-APPS.md`, aplicada:

| Dato | Dónde | Por qué |
|---|---|---|
| las entradas cifradas de la bóveda | **`@dotrino/store`** | sin ellas la app no arranca; tienen que responder offline |
| la CEK envuelta por aparato | **acta / vault** | es material de llaves, no de aplicación |
| adjuntos (documentos, recuperación) | **`dotrino-content`** | son bytes, opcionales, no bloquean el arranque |
| último dominio usado, tab activo | `sessionStorage` | preferencia efímera de UI |
| bitácora de entregas | **vault** (central) o el aparato que responda | se reconcilia al reconectar |

## 5. Modelo de datos

Una entrada, con el hueco de WebAuthn **reservado desde v1** aunque las passkeys
lleguen en v4. Reservarlo ahora es gratis; migrar el formato con gente usándolo, no.

```jsonc
{
  "id": "uuid",
  "type": "login" | "note" | "card" | "webauthn",
  "sites": ["salesforce.com", "*.force.com"],  // para el emparejamiento por dominio
  "username": "...",
  "secret": "<cifrado con la CEK>",
  "totp": "<cifrado>",                          // otpauth:// URI
  "webauthn": {                                  // v4, el hueco se reserva ya
    "credentialId": "...",
    "rpId": "salesforce.com",
    "userHandle": "...",
    "privateKey": "<cifrado>",
    "signCount": 0
  },
  "createdAt": 0, "updatedAt": 0
}
```

El emparejamiento por dominio sigue las reglas de WebAuthn (eTLD+1) también para las
contraseñas, para que el criterio sea uno solo y no dos.

## 6. Piezas del repo

```
lib/          @dotrino/passmanager — modelo, cifrado, la interfaz de bóveda
extension/    extensión Chrome MV3
web/          pass.dotrino.com — consola de la bóveda + landing
docs/         este documento
```

La app nativa **no vive aquí**: es una pantalla más de `dotrino-app`, que ya es el
aparato con hardware y con el flujo de aprobación.

### 6.1. La interfaz de bóveda

Toda pieza consume la misma interfaz; quién esté detrás es intercambiable. Es lo que
permite construir por pasos sin reescribir nada:

```js
find(domain)     // qué hay para este sitio (metadatos, sin secretos)
get(id)          // UNA credencial — puede exigir aprobación
put(entry)       // exige una bóveda de verdad; nunca la caché
list()           // exige la CEK
```

### 6.2. Web: informativa ≠ administrativa (§5.1)

`pass.dotrino.com/` es la **landing**: qué es, cómo se instala la extensión, enlace
al wiki. No ejecuta nada. `pass.dotrino.com/vault` es la **consola**: la lista, el
buscador y los botones. Sin párrafos de bienvenida. La documentación de uso va al
wiki (§9.2), no a ninguna de las dos.

## 7. Las passkeys en Chrome (v4)

Chrome **no expone API de proveedor de credenciales a extensiones** — Android 14+ e
iOS 17+ sí, y por eso en móvil el camino es limpio. En el escritorio, la única vía
es la que usan 1Password y Bitwarden: un content script en `world: "MAIN"` que
reemplaza `navigator.credentials.create/get`. Como la llave la generas tú y la firma
la produces tú, la assertion es válida y el sitio no distingue.

Verificado empíricamente: **1Password funciona con passkeys en Salesforce**, lo que
confirma que Salesforce acepta `attestation: "none"` y que el parche funciona ahí.

Lo que hay que asumir:

- **Carreras de orden de scripts** — si la página captura la referencia antes, se
  escapa.
- **Iframes cross-origin** — hay logins que viven en un iframe de otro dominio.
- **Páginas privilegiadas** (`chrome://`, la Web Store) no admiten inyección.
- **Sitios que exijan atestación certificada FIDO** quedan fuera y no hay vuelta.

Cobertura esperada:

| | Contraseñas | Passkeys |
|---|---|---|
| App Android / iOS | nativo | nativo, limpio |
| Chrome / Edge | extensión | parche de `navigator.credentials` |
| Safari | extensión | API de proveedor real (macOS 14+) |
| Firefox | extensión | mismo parche, sin API |

## 8. Plan por pasos

| | Qué | Por qué ahí |
|---|---|---|
| **1** | Bóveda + autocompletado + TOTP + importar (1Password, Bitwarden, CSV de Chrome). La extensión con **caché local**. | Sin esto no hay producto, y aquí está el grueso del trabajo. Sin importación nadie migra. |
| **2** | El **vault del PC** responde de a una | Barato: daemon, cajones, bitácora y enrolamiento (`@dotrino/remote-agent`) ya existen. |
| **3** | El **teléfono** responde de a una, con huella | Necesita trabajo en `dotrino-app`, hoy verde (APK debug sin probar en teléfono). |
| **4** | **Passkeys** | Reusa todo lo anterior: detectar el sitio, hablar con la bóveda, devolver algo a la página. |

El orden lo fija el riesgo, no la vistosidad: **el autocompletado es lo que mata a
los gestores de contraseñas, no la criptografía.** Detectar formularios de login en
la web real es campos ocultos, SPAs que remontan el DOM, logins en dos pasos, shadow
DOM y sitios que renombran los inputs en cada despliegue.

## 9. Riesgos abiertos

- **La revisión de la Chrome Web Store** mira con lupa las extensiones que tocan
  credenciales, y lo hace en cada actualización. Puede marcar el ritmo de entrega.
- **MV3 duerme el service worker**: el estado de "desbloqueado" no puede vivir en su
  memoria. Hay que resolverlo desde el diseño, no parchearlo después.
- **La caché opt-in del §3 es la pieza que más fácil se degrada.** Si por comodidad
  acaba activada por defecto, el producto pierde lo único que lo distingue.
- **Recuperación.** Perder el master del acta es perder la cuenta
  (`dotrino-acta-perfil`). Para contraseñas eso es más grave que para cualquier otra
  app del ecosistema, y hay que decidir qué se le ofrece al usuario. **Sin resolver.**

## 10. Sacar credenciales en bloque es del vault, no del gestor

> Decidido por el dueño el 2026-08-25.

**El respaldo se hace desde el vault. El gestor no tiene botón de respaldo.** El vault
ya es quien respalda el acta y la maestra; duplicar esa función en el gestor sería un
segundo camino hacia lo mismo, con otra superficie y otra bitácora.

La regla general de la que esto es un caso: **el gestor pide de a una (§2); cualquier
operación que saque más de una credencial a la vez es de la bóveda.** Exportar es lo
contrario de pedir de a una, así que no le toca al gestor por definición — no por
prudencia.

De ahí, sin más discusión:

- La **extensión nunca exporta ni respalda**: no tiene la CEK (§3).
- La **consola web** tampoco: enlaza al vault, no lo reimplementa.
- El **importar sí** es del gestor (§8, paso 1). Entra de a muchas, pero entrar no es
  salir: no expone nada que el usuario no tuviera ya en la mano.

### 10.1. La exportación existe, y el formato lo elige el usuario

> Decidido por el dueño el 2026-08-25.

Se exporta, y el usuario elige cómo: **en claro** (CSV, que es lo único que los otros
gestores importan), **cifrado**, o **zip con clave**. No se le impone el formato: es
su información y es su decisión — que es literalmente el principio del ecosistema, no
una excepción a él.

**La fricción la pone abrir el vault, no un diálogo.** Para exportar hay que tener la
bóveda abierta, que ya es la operación deliberada y menos cómoda del sistema. Sobre
esa barrera no hace falta apilar un "¿estás seguro?": quien llegó ahí sabe lo que está
haciendo.

Lo único que sí se dice, y **a la vista** —es una advertencia del §5.1, no se esconde
detrás de una (i)—: si eligió el formato en claro, ese archivo contiene sus
contraseñas legibles y conviene borrarlo en cuanto lo haya importado. Se enuncia lo
que pasa; no se le pide que confirme.
