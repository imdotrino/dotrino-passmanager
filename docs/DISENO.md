# Diseño — `dotrino-passmanager` (gestor de contraseñas del ecosistema)

> **Estado (2026-08-25): usable de punta a punta.** La bóveda (`bin/`) crea, edita,
> genera e importa, y atiende peticiones por el proxio; la extensión pide de a una y
> **no guarda nada**; el contenido va **sellado** y lo que llega en claro se rechaza.
> 56 tests verdes y E2E verificado contra `proxy.dotrino.com`. Landing en vivo en
> `pass.dotrino.com`.
>
> **Publicado en npm:** `@dotrino/passmanager@0.1.0` y `@dotrino/proxy-client@0.13.0`.
> **Passkeys hechas** (§7). La bóveda y sus aparatos se administran en
> `vault.dotrino.com/vault` — una sola dirección desde el 2026-08-26 (§6.2).
>
> **El vault del ecosistema atiende** (`dotrino-vault caps <ID> +contrasenas`): almacén
> cifrado en reposo, llave propia, lista de aparatos que se cruza con el acta, y la
> aprobación en dos tiempos enganchada a la del vault — que es **el teléfono** (§2.1).
> 10 tests propios, 259 en la suite del vault. Detalle en
> `dotrino-vault/docs/passwords.md`.
>
> **En la Chrome Web Store:** en **borrador** con la 0.1.1
> (`iheeephdbjdpgfhkhmfnpgbhmdflplpp`). Se envió a revisión y se canceló: la versión
> enviada no se había usado nunca de punta a punta, y probarla destapó tres fallos. La
> tienda es el último paso, no un hito de progreso.
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

Por eso hacen falta **dos** públicas de cada lado: por la de firma enruta el proxio, y a
la de cifrado se le sella el contenido. Las dos viajan solas en el emparejamiento del
ecosistema —la de cifrado va dentro del `enroll` y queda en el acta—, así que no hay
nada que copiar a mano.

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

## 3.3. Perfiles: un perfil es una bóveda

> Pedido por el dueño el 2026-08-26: «la extensión puede tener varios profiles, varias
> bóvedas donde almacena las contraseñas».

Funciona como el multi-perfil del resto del ecosistema: **este navegador puede tener
varios perfiles y no se ven entre ellos**. Lo que aparece en un sitio es lo del perfil
ACTIVO, y cambiar de perfil cambia de bóveda entera.

El primero nace solo al instalar y su bóveda es la propia extensión (§3.3.1). A partir de
ahí se añaden perfiles de dos formas, y las dos SUMAN:

| | Con su bóveda aquí | Conectando una bóveda |
|---|---|---|
| Dónde guarda | en este navegador, cifrado | en el daemon, o en una pestaña |
| Listo | al instante | hay que emparejar |
| Para qué | separar lo personal del trabajo sin depender de nada | tenerlas en un solo sitio para todos tus navegadores |

**Conectar una bóveda AÑADE un perfil, no reemplaza el que había.** Es lo que antes hacía
`link` y era lo peor que puede hacer un gestor de contraseñas: dejar de enseñarte lo que
ya guardaste porque conectaste otra cosa.

Cada perfil lleva lo suyo de punta a punta —su llave de bóveda, su identidad de aparato y
su par de cifrado—, con las claves separadas en el mismo almacén. Que la **identidad de
aparato** también sea por perfil no es simetría porque sí: si dos bóvedas vieran el mismo
aparato podrían cruzar lo que hace uno con lo que hace el otro. Se le inyecta a
proxy-client con `setKeypairStore`, que además tira su caché — es lo que hace que cambiar
de perfil cambie de verdad quién eres ante la bóveda.

Las claves del **primer** perfil no llevan sufijo: lo que ya estaba guardado sigue siendo
suyo sin migrar nada, y solo los nuevos añaden el suyo.

**Los perfiles son los del ecosistema, no unos inventados aquí.** La lista, cuál está
activo y la llave de cada uno salen de `@dotrino/identity` corriendo DENTRO del service
worker (`extension/src/identity-core.js`). Lo que el gestor añade encima es una sola cosa
por perfil: **dónde guarda** —su propia bóveda aquí, o una conectada—. Todo lo demás
(acta, delegaciones, identicon, «no reactivo») es el mismo código que el resto del
ecosistema, y por eso se comporta igual.

Lo que NO entra es la clase `Identity`: es el cliente que habla con `id.dotrino.com`
montando un **iframe**, y un service worker MV3 no tiene DOM. El núcleo de debajo,
`createIdentityCore({ kv, peers, keyStore })`, no toca DOM. Tres cosas hubo que resolver
para meterlo, y ninguna es evidente:

| Lo que pasaba | Por qué | Cómo se resuelve |
|---|---|---|
| el worker moría al cargar | `capabilities.js` re-exporta `avatar.js`, que no viajaba | vendorizarlo también |
| `import() is disallowed on ServiceWorkerGlobalScope` | el núcleo carga el transporte perezosamente, que en una página es lo correcto | el build lo convierte en estático, apuntando a la copia que viaja |
| el perfil recién creado se esfumaba | el `kv` es síncrono y vuelca detrás; el núcleo nuevo leía el estado de ANTES | esperar a `kv.flushed` antes de rearrancar |

Y dos detalles del núcleo que se pagan si no se leen: `createProfile` crea el perfil y lo
abre en memoria, pero **no lo deja activo** (eso es `switchProfile`), y cambiar de perfil
obliga a **rearrancar** el núcleo — en una app del ecosistema eso lo hace recargar la
página; aquí, como no hay página, se tira y se levanta otro.

**La identidad de red es la del perfil.** El aparato se identifica en el proxio firmando
con la llave del perfil (`handlers.signData`), no con una llave suelta del transporte: es
la regla del ecosistema —la identidad de red coincide con la de firma— y es lo que hace
que la bóveda reconozca al aparato que ya conoce. Y cada perfil se empareja por su
cuenta: dos bóvedas no ven el mismo aparato y no pueden cruzar lo que hace uno con lo
del otro.

**Saldada (2026-08-27): el emparejamiento es el del ecosistema y no hay otro.** Hubo un
código propio —las dos públicas en base64, unos 700 caracteres— que se pegaba en la
extensión, y otro de vuelta que se pegaba en la bóveda. Era un segundo modelo de
emparejamiento conviviendo con el de todos, y por eso el aparato no aparecía en el acta,
no tenía certificado, no se le podía quitar el permiso sin quitarlo entero y había dos
listas que acordarse de tocar.

Ahora se empareja con `vaultPair()` del mismo núcleo, como cualquier otro aparato:
invitación de la bóveda → llave nueva aquí → **seis caracteres** que se teclean allí →
certificado firmado por la maestra y entrada en el acta. Y lo que deja pedir credenciales
es la capacidad **`passwords`** del acta (`pair --scope contrasenas` al conectar, o
`caps <ID> +contrasenas` después): un permiso más, en el sitio donde están los permisos.

## 3.3.1. Nace funcionando: la extensión ES su propia bóveda

> Pedido por el dueño el 2026-08-26: «antes que emparejar, haz que la extensión sea su
> propio vault por defecto».

**Recién instalada, la extensión guarda en sí misma.** Su llave es un `CryptoKey` no
extraíble en IndexedDB (ni su propio código puede sacarla) y las entradas van cifradas en
`chrome.storage.local`. Sin emparejar nada, sin abrir otra pestaña, sin daemon.

Esto es la regla del ecosistema aplicada donde de verdad se nota: **ninguna app puede
exigir un daemon encendido**, y el primer minuto de un gestor de contraseñas no puede ser
pedirle al usuario un código que no tiene. Las dos versiones anteriores de esta sección
fueron dos intentos de esquivar eso por fuera —primero el daemon, después una pestaña—
cuando el sitio donde faltaba era la propia extensión.

Enlazar una bóveda (el daemon, o `vault.dotrino.com/vault`) sigue existiendo y es el
**upgrade**, con lo que la propia no puede dar:

| | La propia | Enlazada |
|---|---|---|
| Empezar | ya está | emparejar |
| Dónde viven | en este navegador | en un solo sitio, para todos tus navegadores |
| Si desinstalas | se van | siguen ahí |
| Aprobación | no hay a quién pedírsela | por petición, en la bóveda o el teléfono |
| Interfaz | **la misma** | **la misma** |

`LocalVault` y `RemoteVault` cumplen el mismo contrato, así que de `connect()` para abajo
casi nada del gestor distingue una vía de la otra: sin enlace se devuelve la propia y ya.
Lo único que cambia a propósito es la caché de sesión, que se salta con la bóveda propia
—existe para no repetir aprobaciones, y aquí no hay ninguna que ahorrar—.

**Deuda anotada:** enlazar todavía usa un código propio (las dos públicas en base64), que
son 700 caracteres para copiar entre dos pestañas del mismo navegador. El ecosistema ya
tiene su emparejamiento —invitación corta + código de 6 dígitos, con el aparato quedando
en el acta y saliendo en `vault.dotrino.com/vault`— y es ahí donde esto tiene que
acabar: `identity.selfVaultPairing()` / `enrollDevice()`. El código propio se va con eso.

## 3.4. Sin daemon también funciona: la bóveda en una pestaña

> Pedido por el dueño el 2026-08-26.

Exigir `dotrino-passmanager serve` para poder empezar contradice la regla del ecosistema:
**ninguna app puede exigir que el usuario tenga un daemon encendido.** El aparato cumple
el rol cuando no hay pieza dedicada, y lo dedicado solo añade disponibilidad.

Así que `vault.dotrino.com/vault` **es** una bóveda mientras esté abierta: guarda,
responde de a una y pide aprobación en la propia página. Se instala la extensión, se abre
eso, y funciona — sin instalar nada más. El popup ofrece «Abrir mi bóveda» antes que pedir
un código, porque pedir un código a quien no tiene ninguno es no tener por dónde empezar.

**Esa página ya no hay que elegirla.** Al abrirla, mira si la cuenta tiene bóveda en otra
máquina: si no la tiene, la bóveda es este aparato y el mostrador se enciende solo (el de
aparatos y el de contraseñas); si la tiene, se conecta a ella y aquí no se levanta ningún
mostrador, porque una cuenta no tiene dos bóvedas.

**Y vive en el vault, no aquí.** La primera versión la puso en `pass.dotrino.com`, que
era el error de siempre visto de cerca: la bóveda es del vault y las apps le piden. Una
bóveda por app son bóvedas que no se ven entre ellas y un usuario que no sabe cuál es la
suya. Al estar en `vault.dotrino.com` es la MISMA pieza que el daemon presenta en la
misma web, comparte origen con sus dispositivos y sus pedidos, y pasar de la pestaña al
daemon es enlazar de nuevo y nada más. Vive en `dotrino-vault/web/src/Vault.vue`.

| | En una pestaña | Con el daemon |
|---|---|---|
| Empezar | abrir una página | instalar y levantar un proceso |
| Disponible | mientras la pestaña esté abierta | siempre, también con el navegador cerrado |
| Aprobación | en la propia página | en la consola, o en el teléfono |
| Protocolo | **el mismo** | **el mismo** |

Que el protocolo sea el mismo es lo que hace que esto no sea un modo aparte: los mismos
aparatos, el mismo emparejamiento y el mismo sellado. Pasar de la pestaña al daemon es
conectarse de nuevo, nada más.

**La llave vive como `CryptoKey` no extraíble en IndexedDB**, no cifrada: IndexedDB clona
el CryptoKey en vez de serializarlo, así que la llave nunca existe en forma exportable —
más fuerte que cifrarla, porque no queda texto que descifrar. Se probó antes sellarla con
`identity.encrypt` y no vale: esa API es para mensajes entre dos partes.

Y el límite, dicho donde se ve: **si borras los datos del sitio, esa bóveda se va con
ellos.** Para eso está exportar (§10.1), y para eso el daemon es el sitio de lo que
quieres conservar pase lo que pase.

## 4.0. Crear y editar

La bóveda se llena desde donde vive: `dotrino-passmanager` (`ls`, `add`, `edit`,
`show`, `rm`, `gen`, `import`). Ahí está el generador de contraseñas, que **no es un
extra**: un gestor que no genera obliga a inventárselas, y ahí es donde se repite la de
siempre.

Y desde el navegador hay un solo caso, el que ocurre de verdad: **guardar la contraseña
que acabas de escribir**. La decisión nunca es de la página: si el sitio pudiera guardar
por su cuenta, llenaría la bóveda de entradas inventadas. Hay dos formas de decir que sí,
y las dos se pulsan en UI de la extensión:

- **El aviso de después de entrar** (§4.0.1), que es el camino normal.
- **El popup**, con «Guardar la contraseña de esta página», mientras el formulario sigue
  escrito. Sigue estando para lo que el aviso no cubre.

### 4.0.1. El aviso sale DESPUÉS de entrar, no antes

> Dicho por el dueño el 2026-08-27: *«los gestores actuales muestran la solicitud de
> guardar después de que el formulario ha sido enviado, en la página siguiente»*.

Y es lo correcto: al enviar el formulario ya no queda nada escrito que leer, y pedirlo
antes es pedirle al usuario que se acuerde de un paso que ningún otro gestor le pide.
Antes había que abrir el popup **antes** de pulsar «Entrar»; quien se olvidaba, volvía a
escribirlo todo.

El recorrido, y dónde está cada pieza:

| | Quién | Qué |
|---|---|---|
| al enviar | content script | lee usuario y contraseña del formulario y las manda al service worker (`capture`) |
| entre páginas | service worker | las sostiene en `chrome.storage.session`, **una sola** y con caducidad de 5 min |
| ya en la página siguiente | content script | pregunta si hay algo pendiente **para este mismo sitio** y monta el aviso |
| el aviso | **iframe de la extensión** | enseña el sitio y el usuario. La contraseña **no llega hasta aquí** |
| el «sí» | service worker | lee lo capturado y escribe en la bóveda; después lo borra |

**Por qué un iframe y no HTML nuestro dentro de la página.** Porque el botón que acaba
escribiendo en la bóveda tiene que pulsarse en el origen de la extensión: así el mensaje
llega con origen `chrome-extension://` y pasa por la misma puerta que el popup, sin
abrirle a la página ninguna operación nueva. La página no puede pulsarlo, ni leerlo, ni
fingirlo — vive además en el Shadow DOM cerrado del §4.1.

**Lo que la página SÍ puede disparar**, y por qué no importa: `capture` (apuntar lo que
ella misma acaba de recibir) y `pending-save` (preguntar si hay algo suyo pendiente, que
devuelve el sitio y el usuario, nunca la contraseña). Ninguna escribe en la bóveda ni
saca nada de ella.

**El coste, dicho en voz alta:** entre una página y la siguiente hay una contraseña en
claro en `chrome.storage.session`. Ese almacén nunca toca el disco y muere con el
navegador, se sostiene **una sola** captura, caduca a los 5 minutos y un «ahora no» la
borra. Es el precio de preguntar cuando la persona ya sabe si la contraseña servía, y no
hay forma de tener lo uno sin lo otro.

**Dos cosas que costaron encontrarse al probarlo en Chrome de verdad** (por eso existe
`extension/test/guardar.e2e.mjs`):

- Preguntar **una sola vez** al cargar no vale: el service worker puede estar dormido y
  la página nueva llega antes de que haya anotado nada. Se reintenta unas veces durante
  un par de segundos. No fallaba — simplemente el aviso no aparecía.
- Media web entra **sin disparar `submit`** (un botón que llama a `fetch` y navega a
  mano), así que además se captura al salir de la página.

Editar desde el navegador **no está**, y es deliberado por ahora: son formularios
enteros, y hasta que exista la consola web (§6.2) el sitio de editar es la bóveda.

## 4.1. El gestor NO autocompleta

> Decidido por el dueño el 2026-08-25.

**Nada se rellena solo.** El gestor marca los campos donde puede ayudar con un botón
—un cuarto de circunferencia azul en la esquina superior derecha del campo, con el
**pájaro de la marca** dentro y traslúcido— y espera.

El pájaro y no el icono entero: a ese tamaño el candado no se lee y queda una mancha, y
lo único que hay que poder distinguir ahí es de quién es el botón. **El ave LLENA el
cuarto de círculo**, sin margen — con margen quedaba una mota. Traslúcido porque acompaña
al campo, no compite con él.

**La circunferencia no crece para que quepa el ave; crece el ave dentro de ella**
(dueño, 2026-08-28). El marcador se apoya sobre el extremo derecho del campo, así que
agrandarlo es tapar lo que el usuario escribe: 20 px es lo que cabe sin estorbar.
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
al wiki. No ejecuta nada, y es lo ÚNICO que hay en este dominio. Lo administrativo está
en `vault.dotrino.com/vault` — la bóveda y sus aparatos, que desde 2026-08-26 son UNA
sola página: dice dónde vive tu bóveda y, si es este aparato, es ella misma la que
responde. La documentación de uso va al wiki (§9.2).

**Hubo aquí una consola de aparatos y se borró.** Duplicaba `vault.dotrino.com/vault`,
que se declara a sí misma la única pantalla del ecosistema donde se gestionan los
dispositivos de un perfil. Dos pantallas que administran lo mismo se desincronizan y
después cada una dice una cosa. Lo que sigue explica por qué esa consola no podía listar
credenciales — el razonamiento se conserva porque la regla no cambió al mudarse.

**La objeción original ya no aplica, pero apareció otra.** Se aplazó porque no había
nada que sincronizara la bóveda de la extensión con la de la web; eso se resolvió al
hacer que la bóveda responda por el proxio: la consola sería **un aparato más**, y
miraría exactamente la misma bóveda.

Lo que sí choca es más de fondo: **un aparato no puede listar** (§2), y una consola que
no lista no es una consola. Las salidas eran tres, y solo una no se contradice:

| | Por qué no |
|---|---|
| dar `list` a la consola | rompe el «de a una» para todos: bastaría con llamarse consola |
| un permiso especial de listar | el mismo agujero, con un nombre más largo |
| **la consola administra APARATOS, no credenciales** | ✔ lo que hoy solo se puede por consola de órdenes |

Así que `vault.dotrino.com/vault` administra **aparatos**: cuáles hay, cuándo se
enlazaron, y retirar el que sobre. De credenciales enseña lo mismo que cualquier
aparato: lo que hay para un sitio, de a una y bajo aprobación. **Listar la bóveda entera
sigue siendo cosa de quien tiene la llave** — la consola de órdenes y la app nativa.

No es una limitación que se arrastra: es la misma regla aplicada a una pieza que
tentaba a saltársela.

## 7. Las passkeys en Chrome — HECHO (2026-08-26)

Chrome **no expone API de proveedor de credenciales a extensiones** — Android 14+ e
iOS 17+ sí, y por eso en móvil el camino es limpio. En el escritorio, la única vía
es la que usan 1Password y Bitwarden: un content script en `world: "MAIN"` que
reemplaza `navigator.credentials.create/get`. Como la llave la generas tú y la firma
la produces tú, la assertion es válida y el sitio no distingue.

Verificado empíricamente: **1Password funciona con passkeys en Salesforce**, lo que
confirma que Salesforce acepta `attestation: "none"` y que el parche funciona ahí.

**Cómo quedó montado:**

| Pieza | Dónde | Qué hace |
|---|---|---|
| `webauthn.js` (lib) | — | crea la credencial y firma la assertion |
| `webauthn-page.js` | mundo de la **página** (`world: MAIN`) | reemplaza `navigator.credentials` |
| `webauthn-bridge.js` | mundo aislado | pasa mensajes; no decide nada |
| `webauthn-create/get` | service worker | pide a la bóveda, que es quien custodia |

Tres decisiones que evitan los fallos caros:

- **La firma va en DER.** WebCrypto la da como `r‖s` de 32 bytes y WebAuthn espera una
  SEQUENCE de dos INTEGER, con byte de relleno cuando el primer bit está alto. Sin esa
  conversión el servidor la rechaza **sin decir por qué**. Hay un test que la verifica
  como lo haría el servidor: rehace `authenticatorData ‖ sha256(clientDataJSON)` y
  comprueba la firma contra la pública registrada.
- **El contador sube en cada firma, y se guarda en la bóveda.** Si se queda quieto, el
  servidor sospecha que la credencial está clonada.
- **La credencial se guarda ANTES de devolverla.** Si el sitio la registra y nosotros no
  la tenemos, el usuario se queda fuera de su cuenta sin saber por qué.

Y la regla que lo hace seguro de usar: **si el gestor no puede, manda el navegador.**
Cualquier fallo —sin bóveda, sin passkey, sin respuesta— cae al `navigator.credentials`
original. Que el gestor falle no puede dejar a nadie sin entrar en su sitio. Verificado
en navegador, para `create` y para `get`.

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
