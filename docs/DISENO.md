# Diseño — `dotrino-passmanager` (gestor de contraseñas del ecosistema)

> **Estado:** **pasos 1 y 2 en marcha** (2026-08-25). La extensión **ya no guarda la
> bóveda**: pide de a una por el proxio, y responde `bin/passmanager.js serve`.
> Verificado E2E contra `proxy.dotrino.com`. 28 tests verdes. Landing en vivo en
> `pass.dotrino.com`. Pendiente: que atienda el vault del ecosistema (con sus cajones
> y su bitácora), el teléfono (§2.1), npm y la Chrome Web Store. La consola web sigue
> esperando (§6.2).
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

### 2.0. La aprobación es del APARATO, no de cada credencial

> Decidido por el dueño el 2026-08-25.

Se pide **una vez** y vale para lo que ese aparato pida después. Dura mientras la
bóveda siga encendida: apagarla la retira, y `revokeApproval` la retira sin apagar
nada. Es el mismo modelo que `pair --approval` del vault — una por arranque, sin
ventana de tiempo que nadie va a vigilar.

**No se ata a la conexión**, y es deliberado: un service worker se duerme cada poco y
reconecta constantemente, así que «por conexión» sería pedir el dedo todo el rato
hasta que el usuario aprobara sin mirar. Lo que el usuario apaga cuando quiere cortar
es la bóveda, así que es la bóveda la que manda.

**Y es el ÚNICO permiso.** No se inventa aquí un segundo sistema de aprobación en
paralelo al del vault: el permiso de pedir aprobación ya existe (`pair --approval`,
`caps +aprueba`), y duplicarlo con marcas por entrada solo crea dos reglas que acaban
diciendo cosas distintas. Si hace falta afinar qué se aprueba, se afina **ahí**, donde
ya viven los permisos de los aparatos.

Dos detalles que evitan que se degrade:

- **Una negativa no queda recordada como aprobación**: decir que no deja al aparato
  como estaba, y la siguiente vuelve a preguntar.
- **Dos peticiones a la vez producen UN aviso**, no dos. Dos pestañas abriendo el
  mismo sitio no deben hacer sonar el teléfono dos veces.

### 2.1. Por qué el teléfono es el caso normal, no el PC

El PC se apaga; el teléfono no. Y el teléfono tiene almacenamiento respaldado por
hardware, que el navegador de escritorio no tiene. Además el flujo ya existe: la
**aprobación desde el teléfono** (`pair --approval` / `caps +aprueba`, vault 0.50)
es exactamente esta operación con otro contenido.

El vault del PC no desaparece: cuando está, es quien manda y quien lleva la bitácora
central. Pasa de requisito a comodidad.

## 2.2. La promesa: nada de esto llega a los servidores de Dotrino

> Enunciada por el dueño el 2026-08-25. **Es la promesa fuerte de este producto**, y de
> ella se deducen varias decisiones de arriba.

El gestor **lee la página entera** para saber dónde puede ayudar: todos los campos,
sus etiquetas, la dirección del sitio. En cualquier otro gestor eso sería lo más
invasivo que hace. Aquí es aceptable por una razón concreta y comprobable: **nada de
eso sale del dispositivo del usuario**.

Lo que se afirma, exactamente:

| | |
|---|---|
| lo que lees en la página | no sale del navegador |
| a qué sitio se le pide credencial | **sellado**: el proxio no lo ve |
| qué credencial se devuelve | **sellada**: el proxio no la ve |
| dónde viven las contraseñas | en la bóveda del usuario, nunca en un servidor nuestro |

**Cómo se cumple, y por qué hubo que arreglarlo.** El proxio enruta por pubkey pero
**no cifra el contenido**: `sendByPubkey` serializa el payload y lo manda tal cual. La
primera versión de este transporte mandaba `{op:'find', url:'https://banco.com.ec/'}`
en claro, así que el proxio de Dotrino habría visto a qué sitios se le pide credencial
y cuál se devuelve. Se selló extremo a extremo con `wrapForMember`/`openWrap` de
`@dotrino/identity/content` — la misma cripto de los secretos sellados del vault, no
una nueva—: ECDH P-256 efímero contra la pública de cifrado del otro lado + AES-GCM.

Por eso el código de enlace lleva **dos** públicas: por la de firma enruta el proxio, y
a la de cifrado se le sella el contenido.

**Y lo que NO se afirma**, porque sería falso: el proxio ve **metadatos** — que este
aparato habla con esta bóveda, cuándo y cuánto. No ve qué se pide ni qué se devuelve,
pero el patrón existe. Decirlo es parte de la promesa; una promesa que se calla sus
límites no es fuerte, es publicidad.

**El cifrado no es opcional, y eso hay que hacerlo cumplir en las DOS direcciones.**
Sellar de salida no basta: si la otra punta acepta texto plano, mandarlo así se salta el
sellado entero. Y no solo para leer — alguien que nunca leyera nada podría contestar por
la bóveda y colar una credencial falsa en un formulario. Por eso:

- lo que llega sin sellar se **descarta**, y en la bóveda queda anotado como `unsealed`
- sin llave de cifrado del otro lado **no sale nada**, con código propio
- el código del error se **conserva**: «no tengo la llave» y «se cayó la red» no pueden
  verse igual desde arriba, porque una se arregla enlazando y la otra esperando

**Y esto vive en el PILAR, no aquí.** Se escribió primero en este repo y se movió a
`@dotrino/proxy-client` 0.13.0 (`sendSealed`, `requireSealed`, `meta.sealed`) en cuanto
quedó claro que la garantía no puede ser de una sola app. El gestor lo consume; no
mantiene una segunda implementación.

Comprobado, no supuesto: hay tests que espían el cable y fallan si aparece el sitio, la
operación o la credencial; otros que mandan una petición y una respuesta en claro para
ver que se rechazan; y el E2E contra `proxy.dotrino.com` repite la comprobación sobre
el tráfico real, con `requireSealed` en las dos puntas.

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
| extensión de Chrome | **no. Nunca** | solo recibe credenciales sueltas, de a una |

### 3.1. La extensión no guarda la llave, y la caché queda descartada

> Decidido por el dueño el 2026-08-25.

El diseño llevaba una **caché opt-in de solo lectura** en el navegador, para el caso
de no tener ni el PC ni el teléfono. **Se descarta.** Para abrir esa caché haría falta
la llave, que es exactamente lo que no queremos ahí: sostenerla obligaba a guardarla
entre siestas del service worker, y con ella vuelve todo lo que este diseño evita.

Lo que se pierde: sin bóveda al otro lado, la extensión no rellena nada. Se acepta,
porque los sitios donde puede vivir la bóveda son tres —el vault del PC, el teléfono,
la app— y se asume que uno está.

Lo que se gana no es solo seguridad, es que **el problema desaparece en vez de
gestionarse**: no hay llave en el navegador que proteger, que caducar, ni que borrar
al cerrar.

### 3.2. Lo que SÍ recuerda el navegador: lo ya entregado

**La caché y la aprobación no se condicionan.** La aprobación decide si el *usuario*
tiene que decir que sí; la caché decide si hace falta *ir* a la bóveda. Son cosas
distintas y conviene no volver a mezclarlas:

| En la misma sesión | ¿Aprueba el usuario? | ¿Se va a la bóveda? |
|---|---|---|
| primera contraseña | **sí**, una vez | sí |
| la **misma** otra vez | no | **no** — está recordada |
| una **distinta** | no, el aparato ya está aprobado | sí |
| se olvida el recuerdo | no | sí |


Descartar la copia de la bóveda no obliga a pedirlo todo cada vez. La extensión guarda
en **memoria de sesión** (`chrome.storage.session`, que nunca toca el disco y se vacía
al cerrar el navegador) las credenciales que **la bóveda ya entregó**.

El motivo es de uso, no de arquitectura: entrar tres veces al mismo sitio en una tarde
no debería ser tres aprobaciones en el teléfono.

La diferencia con lo descartado en el §3.1 no es de grado:

| | Caché descartada | Recuerdo de sesión |
|---|---|---|
| Qué guarda | la bóveda entera, cifrada | solo lo que ya se pidió |
| Necesita la llave | sí — por eso se descarta | no: llega ya abierto |
| Lo que nunca pediste | estaba ahí | nunca estuvo |
| Vida | mientras el usuario la deje | minutos, y muere al cerrar |

Tres reglas que lo mantienen honesto:

- **Caduca en minutos**, y una caducada se tira al pasar por ella, no se queda ocupando
  sitio.
- **Desenlazar lo borra en el acto.** Si sobreviviera, «desenlazado» sería mentira
  hasta que caducara.

## 4. Dónde vive cada cosa

Frontera del §4 de `CONVENCIONES-APPS.md`, aplicada:

| Dato | Dónde | Por qué |
|---|---|---|
| las entradas cifradas de la bóveda | **`@dotrino/store`** | sin ellas la app no arranca; tienen que responder offline |
| la CEK envuelta por aparato | **acta / vault** | es material de llaves, no de aplicación |
| adjuntos (documentos, recuperación) | **`dotrino-content`** | son bytes, opcionales, no bloquean el arranque |
| último dominio usado, tab activo | `sessionStorage` | preferencia efímera de UI |
| bitácora de entregas | **vault** (central) o el aparato que responda | se reconcilia al reconectar |

## 4.0. Crear y editar

La bóveda se llena desde donde vive: `dotrino-passmanager` (`ls`, `add`, `edit`,
`show`, `rm`, `gen`, `import`). Ahí está el generador de contraseñas, que **no es un
extra**: un gestor que no genera obliga a inventárselas, y ahí es donde se repite la de
siempre.

Y desde el navegador hay un solo caso, el que ocurre de verdad: **guardar la contraseña
que acabas de escribir**. Está en el popup y no en la página, y esa diferencia es de
seguridad, no de estética — si la página pudiera guardar por su cuenta, llenaría la
bóveda de entradas inventadas. El popup es UI de la extensión, con el usuario delante;
el content script solo atiende peticiones que vienen de él (`sender.tab` las delata).

Editar desde el navegador **no está**, y es deliberado por ahora: son formularios
enteros, y hasta que exista la consola web (§6.2) el sitio de editar es la bóveda.

## 4.1. El gestor NO autocompleta

> Decidido por el dueño el 2026-08-25.

**Nada se rellena solo.** El gestor marca los campos donde puede ayudar con un botón
—un cuarto de circunferencia azul en la esquina superior derecha del campo— y espera.
Al pulsarlo aparece un modal con lo que se puede poner **ahí**, y solo al elegir una
opción se escribe.

Por qué importa, más allá del gusto: rellenar solo obliga a decidir por el usuario en
qué campo va cada dato, y equivocarse significa escribir una credencial en el sitio
equivocado. Marcando y esperando, la decisión es suya y es explícita — que es la misma
regla que rige todo lo demás aquí.

Consecuencias en el código:

- La petición de la credencial (`get`) sale **al elegir en el modal**, no al detectar
  el campo. Abrir una página no pide nada a la bóveda.
- El botón y el modal viven en un **Shadow DOM cerrado**: ni heredan los estilos del
  sitio ni el sitio los alcanza.
- Los botones siguen a sus campos en scroll y resize, y se remontan cuando la SPA
  cambia el formulario.

## 4.2. Campos libres, atados o no a un dominio

Una entrada puede llevar **campos sueltos** además de usuario y contraseña: correo,
teléfono, dirección, cédula, el código del portal — cualquier cosa. Son
`{ label, value, kind }`, y ni las etiquetas ni el número están fijados.

Dos reglas:

- **«Sirve en cualquier sitio» es no tener `sites`**, no un tipo aparte. Con sitios,
  la entrada solo vale ahí; sin ellos, vale en todas partes y siempre por debajo de lo
  que sí es de ese sitio. Una sola regla de emparejamiento, no dos.
- **`kind` es opcional y solo sirve para colocar el dato**: dice qué es (un correo, un
  teléfono) para saber en qué hueco va. Sin `kind` el campo se guarda y se copia
  igual — solo no aparece ofrecido en un campo del formulario.

Para reconocer el hueco se mira primero el **`autocomplete` que declara el sitio**
(cuando está, no hay nada que adivinar, y se respeta `off`), y solo si no lo declara
se recurre a las pistas del nombre. Un buscador nunca se toma por un dato personal.

**Esto no tiene que ver con el perfil de Dotrino.** El perfil es tu identidad en el
ecosistema, con sus flags de visibilidad y su reputación; esto son datos que rellenas
en formularios ajenos, y puedes querer varios juegos (los de casa y los del trabajo)
sin que ninguno sea «quién eres».

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

**La consola NO se construye en el paso 1, y no es por falta de tiempo.** Hasta que
exista el vault del paso 2 no hay nada que sincronice las dos bóvedas: la de la
extensión vive en el almacenamiento del navegador y la de la web viviría en el store,
y serían dos bóvedas distintas que no se ven. Enseñarle al usuario dos listas que no
coinciden es peor que no darle consola. Así que en el paso 1 `pass.dotrino.com` es
**solo la landing**, y la consola llega con el vault, cuando ambas miran lo mismo.

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
- ~~**MV3 duerme el service worker**~~ — **resuelto por el §3.1**: si no se guarda
  ninguna llave, no hay nada que tenga que sobrevivir a la siesta del worker. El
  problema desapareció con la caché.
- **La identidad del aparato sí tiene que persistir**, y ese fue el hallazgo caro:
  `@dotrino/proxy-client` la guardaba en `localStorage`, que no existe en un service
  worker, y sin él **la regeneraba en cada llamada sin guardarla**. La extensión habría
  cambiado de llave cada pocos minutos y la bóveda la habría visto siempre como una
  desconocida. Arreglado en el pilar (0.12.0, IndexedDB), no en la app.
- **Recuperación: frase de 24 palabras, y la emite el vault.** (Decidido por el dueño
  el 2026-08-25.) Perder el master del acta es perder la cuenta
  (`dotrino-acta-perfil`), y en un gestor de contraseñas eso pesa más que en cualquier
  otra app. La salida es la barata y conocida: una frase que el usuario guarda en
  papel, **que el vault puede imprimir**. No añade servidor ni obliga a confiar en
  nadie. Cae del lado del §10 sin forzar nada: emitirla es sacar material de llaves,
  así que es del vault y no del gestor. La recuperación social (repartir trozos entre
  contactos) queda descartada por ahora — sería lo más afín al web-of-trust, y también
  lo más difícil de explicar en lenguaje llano (§9.1).

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
