# Contraseñas selladas por aparato

> **Estado: PROPUESTA** (2026-09-17). Sin código. La pidió el dueño al ver que el acceso
> temporal (`temporary-access.md`) daba por hecho algo imposible: *«los sobres están
> encriptados por dispositivo, y la bóveda está cerrada, ¿de dónde saca la información
> desencriptada?»* — *«la prueba de firma no desencripta las cosas»*.
>
> Es el modelo de los cajones de secretos (`dotrino-vault/docs/secretos-sellados.md` y la
> política de sobres del 2026-09-02) llevado a las contraseñas. **No se escribe criptografía
> nueva.**

## 1. El agujero de hoy

| Bóveda que responde | Dónde está la llave (`cek`) | Qué pasa cerrada |
|---|---|---|
| El demonio del vault (`dotrino-vault/src/vault.js`, `passwordsKey()`) | **dentro de `passwords.json`**, junto a las entradas, cifrado con la llave de la **máquina** (`atRestFor(dir)`), sin la contraseña del perfil | **descifra y entrega igual**: `lock()` existe en la mesa y nadie lo llama |
| La pestaña del vault (`web/src/Vault.vue`) | IndexedDB de ese navegador, no extraíble | mientras la pestaña esté abierta, descifra |
| La bóveda dentro de la extensión (`extension/src/background.js`, `ownKey`) | IndexedDB de la extensión, no extraíble | descifra |
| `dotrino-passmanager serve` | su propio archivo | descifra |

Y el formato (`lib/src/model.js`) lo hace inevitable: una sola `cek` cifra todos los campos
de todas las entradas, y la vista pública —el nombre que se enseña, `fieldKeys`,
`privateKeys`, los resúmenes para comparar— **se calcula abriendo la entrada**. Buscar ya
necesita la llave.

Consecuencia, dicha como en `secretos-sellados.md` §3: con el perfil cerrado, quien tenga
la máquina de la bóveda y su disco **lee todas las contraseñas**. Es el esquema que tuvo la
maestra hasta el 2026-08-31.

## 2. El diseño

### 2.1. La bóveda es un cartero, también para las contraseñas

Cada valor se cifra con una llave de contenido (`cek`) **nueva por escritura**, y esa llave
se envuelve a cada destinatario con su **pública de cifrado** (`wrapForMember` de
`@dotrino/identity/content`). La bóveda guarda sobres y envolturas **que no puede abrir**,
abierta o cerrada.

| Destinatario | Para qué | Abre con |
|---|---|---|
| los **aparatos con `passwords`** y `encPub` en el acta | pedir sus sobres **a demanda** y abrirlos; no los guardan por defecto | su propia privada |
| de un **aparato que se abre con contraseña** (`temporary-access.md`), solo las **entradas marcadas** para él | lo mismo, acotado a esas entradas | su privada, que vive cifrada en la bóveda y solo se abre en memoria tras el inicio OPAQUE |
| la **copia de recuperación**, bajo la frase del perfil | el día que no quede ningún aparato, y para convertir y reparar al abrir la bóveda | la frase |
| **nunca** la bóveda: ni su llave de comunicación, ni su `enc-keypair`, ni la de sellado | — | — |

Lo mismo que en los cajones (`secretos-sellados.md` §8.2 y §9.2), y con el mismo test que lo
afirme: **ninguna envoltura va dirigida a una llave que viva en la máquina de la bóveda**.

### 2.2. Qué queda en claro y qué no

**La vista pública también va sellada** (decidido, 2026-09-17): una copia del disco de la
bóveda no dice en qué sitios tienes cuenta ni con qué usuario.

| En claro | Sellado |
|---|---|
| `id` y fechas | `username`, `secret`, `totp`, `notes`, la privada de la passkey |
| el **índice de sitios**: `HMAC(kidx, sitio)` por cada sitio de la entrada | **cada campo libre por separado** |
| el índice de passkeys: `HMAC(kidx, rpId)` y `HMAC(kidx, credentialId)` | **la vista pública**: `title`, `sites`, `type`, el nombre que se enseña (`hint`), `fieldKeys`, `privateKeys`, `rpId`, `credentialId` |
| los resúmenes para comparar (§2.6) | |

Tres cambios respecto de hoy:

- **La vista pública se guarda sellada, no se calcula.** La escribe quien escribe la
  entrada, y la abre el aparato que pregunta.
- **Los campos libres se sellan uno a uno**, no como un único bloque `fields`. Es lo que
  deja entregar **solo** los campos pedidos (`get(id, { keys })`) sin abrir la entrada.
- **La bóveda busca por huellas, no por sitios.** `kidx` es una llave de tus aparatos
  (§2.6). El aparato calcula la huella de cada variante del sitio que tiene delante
  (`accounts.google.com`, `google.com`, y la de «sirve en cualquier sitio»), la bóveda
  devuelve las entradas que la llevan, y el aparato abre su vista y decide. La lógica de
  emparejar sitios (`match.js`) pasa entera al aparato.

Lo que cuesta:

- **Buscar por texto en toda la bóveda** (`search`, para traerte la cuenta de otro dominio)
  ya no lo puede hacer la bóveda: el aparato pide las vistas selladas, las abre y busca él.
  Son **vistas, no valores**: ninguna contraseña sale por ahí.
- **`sites()`** (en qué dominios hay algo, para la consola) devuelve huellas; los nombres los
  pone el aparato al abrir las vistas.

### 2.3. Leer

```
aparato ── get(id, keys) ──► bóveda   ¿miembro con `passwords`?  ¿aprobación, si toca?
aparato ◄── { sobres de esas keys, SU envoltura de cada generación } ──
aparato     abre con su privada
```

La aprobación sigue donde está (`ApprovalGate`, solo lo privado) y decide **si la bóveda
suelta el sobre**. Nada de lo que la bóveda tiene sirve sin la privada del aparato.

### 2.4. Escribir: el sobre lo hace quien escribe

La política de sobres ya lo fijó para los cajones: **la bóveda cerrada nunca descifra para
escribir; quien escribe manda el sobre hecho** (`putSealed`). Aquí igual:

- El aparato cifra cada valor con una `cek` nueva, la envuelve a **exactamente** los
  destinatarios que dice el acta (ni de menos ni de más: la bóveda lo comprueba contra
  `recipientsOf`, el único sitio que sabe quién debe tener envoltura), **incluida la de
  recuperación** —`putSealed` ya la exige en los cajones— y firma el conjunto (`authorBody`,
  autor miembro con `passwords`).
- **`patch` deja de necesitar leer**: cambiar un campo es poner su sobre nuevo, con su
  generación; los demás campos se quedan con la suya. La regla de siempre —*si hay que leer
  para escribir, la operación va dentro de la bóveda*— desaparece porque ya no hay que leer.
- La bóveda **no ve el valor nuevo**, ni siquiera al escribir. Es más fuerte que los cajones
  en su §8.7 original.

Cada escritura estrena generación, así que hay que **recoger** las que ya no referencia
ningún campo (el mismo barrido de `secretos-sellados.md` §8.7).

### 2.5. Entra o sale un aparato

| | Qué pasa |
|---|---|
| **Sale** (pierde `passwords` o se revoca) | la bóveda le deja de mandar sobres **al refrescar el acta** (5 s). Sus envolturas viejas se borran al abrir la bóveda (`resealAll`). Lo que ya abrió, ya lo tiene: la pantalla lo dice y recomienda cambiar esas contraseñas |
| **Entra** | no tiene envolturas de lo anterior: es una **deuda a la vista** (`incompleteMembers`). La paga **quien ya tiene la llave abierta** —otro aparato con `passwords`, con los cuatro cerrojos de `secretos-sellados.md` §8.11— o la maestra al abrir la bóveda. Mientras tanto **no lee lo anterior**: no hay relevo (§3) |

Nada de esto necesita la maestra desatendida: repartir lo hace un aparato, y reparar es el
segundo trabajo de la maestra al abrir.

### 2.6. Comparar sin abrir, y buscar sin nombrar

**Decidido (2026-09-17): con llave.** Sirve para que el gestor sepa si lo que acabas de
escribir **ya está guardado igual** —y no ofrezca guardarlo, o diga «reemplazar»— **sin abrir
el valor**. Sin ella, comparar una contraseña pediría aprobación solo para decidir qué botón
enseñar.

- Una **llave del perfil**, aleatoria, sellada a los aparatos con `passwords` como una
  generación más. De ella salen dos, para que un uso no sirva para el otro: `kcmp` (comparar)
  y `kidx` (el índice de sitios de §2.2).
- Quien escribe guarda `HMAC(kcmp, id | campo | valor)`. El `id` va dentro: el mismo valor en
  dos entradas da dos resúmenes distintos, así que no delata una contraseña repetida.
- Quien pregunta calcula lo mismo con lo que tiene delante y compara en su service worker.

La bóveda guarda resúmenes **que no puede poner a prueba**: sin la llave no hay diccionario
que valga. Lo que no cambia respecto de hoy: **un aparato con la llave puede adivinar un valor
muy corto** (un PIN de 4 cifras) a partir de su resumen; por eso los resúmenes no salen del
service worker.

**La bóveda solo contesta con lo marcado para quien pregunta**: entradas del índice,
vistas y resúmenes se filtran por destinatario antes de salir. Un aparato con una selección
de entradas (el que se abre con contraseña) no puede ni saber si tienes cuenta en otro sitio,
ni probar resúmenes de lo que no lleva.

### 2.7. Convertir lo que hay

Es un acto único y es **segundo trabajo de la maestra**: se actualiza el vault y **se abren
las cuentas con su frase** (decidido). Al abrir:

1. se abre `passwords.json` con la `cek` vieja;
2. se estrena la **llave del perfil** de §2.6 y se envuelve a los destinatarios;
3. cada entrada se reescribe: un sobre por campo, la vista pública sellada, sus huellas de
   sitio y sus resúmenes;
4. **se borra la `cek` del archivo** y se recorre el disco comprobando que no queda (como
   `dotrino-test/smoke/reposo.mjs`).

Durante ese paso la bóveda ve los valores —los tiene que reescribir—, igual que en la
conversión de los cajones a v5; después, ya no. Un aparato con `passwords` **sin `encPub`** en
el acta no puede recibir envolturas: la conversión lo dice por su nombre en vez de saltárselo.
**Las otras tres bóvedas se quedan, las tres con el mismo formato** (decidido, 2026-09-17): la
pestaña del vault, la bóveda de la extensión y `dotrino-passmanager serve`. Mismos
destinatarios que el vault —los aparatos con `passwords` (y `passkeys` para las passkeys) y la
copia de recuperación, nunca la propia bóveda— y se convierten al abrirlas.

Hasta convertir, la mesa **no entrega** y lo dice con un código que se pueda buscar
(`passwords-not-sealed: open the vault to convert`). Nada de servir con la llave vieja «mientras
tanto»: eso es el agujero con otro nombre.

### 2.8. Las passkeys, detrás de su propio permiso

Una passkey es una **llave privada** que firma el reto de un sitio para entrar sin contraseña.
Se guarda en una entrada como cualquier otro campo, pero no se parece a una contraseña: si
se copia, sirve **hasta que la borres en cada sitio** donde la registraste, y no hay nada que
«cambiar».

Por eso va detrás de **un permiso aparte en el acta, `passkeys`**, que cualquier aparato tiene
o no tiene:

- **Solo los aparatos con `passwords` Y `passkeys`** reciben envoltura de la privada de una
  passkey. La bóveda lo comprueba al guardar (el juego de envolturas de ese campo tiene que
  ser exactamente ese) y filtra al entregar.
- **Sin `passwords` no significa nada**: la passkey vive en una entrada de contraseñas.
- **Quitarlo** (`caps <ID> -passkeys`) corta la entrega en cuanto se refresca el acta; sus
  envolturas se borran al abrir la bóveda, como las de un aparato que sale.
- **Una sesión nunca lo lleva**: entra en `SESSION_FORBIDDEN` junto a `passwords`.
- **Quién lo tiene al empezar** (decidido, 2026-09-17): al **convertir**, todos los aparatos
  que ya tienen `passwords` reciben también `passkeys` —hoy ya abren passkeys, así que nada
  deja de funcionar; se sella en el acta durante la conversión, que es con la bóveda
  abierta—. Al **enlazar** uno nuevo con `passwords` va incluido salvo que se quite.
- **El aparato que se abre con contraseña** es la excepción: se crea **sin** él; quien lo crea
  puede dárselo, y la pantalla dice lo que implica.

Al añadirlo hay que tocar, a la vez: `CAPS` y `DEVICE_CAPS` en `@dotrino/identity`, la palabra
del CLI en `CAP_BY_WORD` (`src/ctl.js`), y la lista de permisos de la TUI (`CAPS_ORDER`), que
está escrita a mano y ya dejó invisibles tres permisos nuevos durante semanas;
`test/tui-render.test.mjs` ata el nombre de la pantalla con el del CLI.

## 3. ~~El relevo: quien aprueba es quien descifra~~ — DESCARTADO

> **Descartado por el dueño (2026-09-17):** *«abren sus propios paquetes, no hace falta que el
> aprobador los abra»*. El aprobador solo aprueba. Se conserva lo que sigue para que se vea
> qué se pensó y por qué no quedó.

Para quien **no tiene envoltura** —un aparato recién entrado con la deuda sin pagar— la
lectura pasa por un **aprobador**: **cualquier** aparato con `passwords` y `approve`, no
necesariamente un teléfono. El orden lo corrigió el dueño (2026-09-17): el aprobador **pide su
sobre DESPUÉS de aprobar**, a demanda, como cualquier lectura suya.

```
solicitante ── get(id, keys) ──► bóveda        (cerrada: da igual)
aprobador   ◄── { quién pide, qué sitio, qué campos }      ← sin ningún sobre
aprobador       [Permitir]
aprobador   ── get(id, keys) ──► bóveda ── los sobres y SU envoltura ──► aprobador
aprobador       abre con su privada
solicitante ◄── solo lo pedido, sellado a SU encPub ─── aprobador   (sendSealed)
```

- **Sin un sí no sale ningún sobre.** El aviso no lleva material cifrado.
- **Aprobar ES descifrar.** No hay un momento en el que la bóveda tenga algo en claro.
- **Lo que no fuerza la bóveda:** un aprobador con `passwords` puede pedir sus sobres cuando
  quiera —son suyos—, así que preguntar antes es regla del aprobador, no un cerrojo. Por eso
  `passwords` es un permiso de confianza total.
- **La `encPub` del solicitante no sale del mensaje**: se saca del acta. Es el cerrojo 3 de
  `secretos-sellados.md` §8.11.
- **Se entrega el resultado, no el secreto de fondo, cuando se puede**: de un TOTP, el
  aprobador calcula el código de 6 dígitos y manda eso, no la semilla; de una passkey,
  firmaría el reto en vez de soltar la privada. (La passkey por relevo no entra en la
  primera versión.)
- **Escribir por relevo**: el solicitante manda el valor sellado al aprobador; el aprobador lo
  abre, lo enseña (lo público en claro, lo privado tapado), y si se aprueba hace él el sobre
  y lo firma como autor (§2.4).

Para el **equipo prestado** el relevo se descartó: el dueño eligió un aparato que se abre con
usuario y contraseña y tiene sus propias envolturas (`temporary-access.md`).

## 4. El precio, dicho claro

1. **Un aparato con `passwords` más una copia del disco de la bóveda lo abren todo.** Es el
   mismo trato que los aparatos que administran en los cajones (`secretos-sellados.md`
   §8.6.1). Perder uno obliga a revocar, abrir la bóveda y cambiar lo importante.
2. **Aprobar no requiere `passwords`**: el aprobador solo dice sí o no, no abre nada.
3. **Buscar por texto en toda la bóveda lo hace el aparato**, abriendo las vistas (§2.2).
4. **Un aparato nuevo no lee lo anterior** hasta que otro le reparta o se abra la bóveda.
5. **El almacén crece** una generación por escritura, con su barrido.

## 5. Qué toca

| Pieza | Cambio |
|---|---|
| `@dotrino/passmanager` `lib/src/model.js` | formato v2: vista pública guardada, un sobre por campo con su generación, llavero de generaciones |
| `@dotrino/passmanager` `lib/src/vault/` | una `SealedVault` para las **cuatro** bóvedas (el dueño: *«el vault embebido, el de la página y el demonio deben funcionar igual»*); `get` devuelve sobres + la envoltura de quien pide; `putSealed` en vez de `put`/`patch` con valores; `find` por huellas del sitio y filtro por destinatario; `match.js` en el aparato |
| `@dotrino/identity/content` | nada: `makeGeneration`, `wrapForMember`, `openWrap`, `encryptWithCek`, `decryptWithCek` ya están |
| `@dotrino/identity` (acta y sesión) | el permiso `passkeys` en `CAPS`/`DEVICE_CAPS`, y en `SESSION_FORBIDDEN` |
| `dotrino-vault` | fuera `passwordsKey()` y la `cek` del archivo; conversión al abrir; `resealAll` también de contraseñas; destinatarios elegibles por entrada; filtrar índice, vistas y resúmenes por destinatario |
| la extensión | abrir sobres con su llave, construir sobres al guardar, `kcmp` para comparar |
| `dotrino-test` | el smoke de reposo busca también contraseñas y la `cek` |

## 6. Lo que decide el dueño

1. ~~**¿Quién abre?**~~ — **decidido (2026-09-17): cada aparato abre sus propios sobres**,
   pedidos a demanda y sin guardarlos. El aprobador **solo aprueba**: no abre nada por nadie.
   Con eso **el relevo de §3 se cae**: un aparato recién entrado espera a que le repartan su
   envoltura (§2.5) en vez de pedir por otro.
2. ~~**Comparar**~~ — **decidido: con llave** (§2.6), de la que sale también la del índice.
3. ~~**Hasta convertir, la mesa no entrega**~~ — **decidido: sí.** Se actualiza el vault y se
   abren las cuentas con su frase para convertir (§2.7).
4. ~~**Passkeys**~~ — **decidido: un permiso del aparato, `passkeys`** (dueño, 2026-09-17:
   *«podría definirse por permiso del dispositivo»*, en vez de una regla para un tipo de
   aparato — *permisos, no tipos*). Detalle en §2.8.
5. ~~**¿La vista pública también sellada?**~~ — **decidido: sí** (§2.2). Buscar por sitio va
   por huellas; buscar por texto lo hace el aparato.
