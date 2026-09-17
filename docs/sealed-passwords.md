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

| En claro (la vista pública, la que ya viaja hoy) | Sellado |
|---|---|
| `id`, `type`, `title`, `sites`, fechas | `username`, `secret`, `totp`, `notes`, la privada de la passkey |
| el nombre que se enseña (`hint`) | **cada campo libre por separado** |
| `fieldKeys` y `privateKeys` | |
| `credentialId` y `rpId` de la passkey | |

Dos cambios respecto de hoy:

- **La vista pública se guarda, no se calcula.** La escribe quien escribe la entrada. Así
  `find` y `search` funcionan con la bóveda cerrada sin abrir nada.
- **Los campos libres se sellan uno a uno**, no como un único bloque `fields`. Es lo que
  deja entregar **solo** los campos pedidos (`get(id, { keys })`) sin abrir la entrada.

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
| **Entra** | no tiene envolturas de lo anterior: es una **deuda a la vista** (`incompleteMembers`). La paga **quien ya tiene la llave abierta** —otro aparato con `passwords`, con los cuatro cerrojos de `secretos-sellados.md` §8.11— o la maestra al abrir la bóveda. Mientras tanto puede pedir **por relevo** (§3) |

Nada de esto necesita la maestra desatendida: repartir lo hace un aparato, y reparar es el
segundo trabajo de la maestra al abrir.

### 2.6. Comparar sin abrir

Hoy la bóveda calcula `fieldHashes` con el valor en claro y un `nonce` por respuesta. Cerrada
no puede. Propuesta:

- una **llave de comparación** del perfil (`kcmp`), aleatoria, sellada a los aparatos con
  `passwords` como una generación más;
- quien escribe guarda, en la vista pública, `HMAC(kcmp, id | campo | valor)`;
- quien pregunta calcula lo mismo con lo que tiene delante y compara en su service worker.

La bóveda guarda resúmenes **que no puede poner a prueba**: sin `kcmp` no hay diccionario
que valga. Lo que se pierde respecto de hoy es que el resumen es **estable**, no uno por
respuesta. Decisión del dueño (§6).

### 2.7. Convertir lo que hay

Es un acto único y es **segundo trabajo de la maestra**: al abrir la bóveda con la frase, se
abre `passwords.json` con la `cek` vieja, se reescribe cada entrada sellada a los
destinatarios del acta, se guarda la vista pública, **se borra la `cek` del archivo** y se
recorre el disco comprobando que no queda (como `dotrino-test/smoke/reposo.mjs`).

Hasta convertir, la mesa **no entrega** y lo dice con un código que se pueda buscar
(`passwords-not-sealed: open the vault to convert`). Nada de servir con la llave vieja «mientras
tanto»: eso es el agujero con otro nombre.

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
2. **El aparato que aprueba por relevo necesita `passwords`**, o sea que puede abrir todas
   tus contraseñas.
3. **La vista pública sigue en claro en el disco**: qué sitios, qué nombres de usuario, qué
   campos. Igual que hoy viaja; ahora además está guardada así.
4. **Un aparato nuevo no lee lo anterior** hasta que otro le reparta o se abra la bóveda (o
   pide por relevo).
5. **El almacén crece** una generación por escritura, con su barrido.

## 5. Qué toca

| Pieza | Cambio |
|---|---|
| `@dotrino/passmanager` `lib/src/model.js` | formato v2: vista pública guardada, un sobre por campo con su generación, llavero de generaciones |
| `@dotrino/passmanager` `lib/src/vault/` | una `SealedVault` para las **cuatro** bóvedas (el dueño: *«el vault embebido, el de la página y el demonio deben funcionar igual»*); `get` devuelve sobres + la envoltura de quien pide; `putSealed` en vez de `put`/`patch` con valores; el relevo (§3) |
| `@dotrino/identity/content` | nada: `makeGeneration`, `wrapForMember`, `openWrap`, `encryptWithCek`, `decryptWithCek` ya están |
| `dotrino-vault` | fuera `passwordsKey()` y la `cek` del archivo; conversión al abrir; `resealAll` también de contraseñas; aviso de relevo al aprobador (sin sobres); destinatarios elegibles por entrada |
| la extensión | abrir sobres con su llave, construir sobres al guardar, `kcmp` para comparar |
| `dotrino-test` | el smoke de reposo busca también contraseñas y la `cek` |

## 6. Lo que decide el dueño

1. ~~**¿Quién abre?**~~ — **decidido (2026-09-17): cada aparato abre sus propios sobres**,
   pedidos a demanda y sin guardarlos. El aprobador **solo aprueba**: no abre nada por nadie.
   Con eso **el relevo de §3 se cae**: un aparato recién entrado espera a que le repartan su
   envoltura (§2.5) en vez de pedir por otro.
2. **Comparar**: ¿llave de comparación con resúmenes estables (§2.6), o se quita comparar sin
   abrir?
3. ~~**Hasta convertir, la mesa no entrega**~~ — **decidido: sí.** Se actualiza el vault y se
   abren las cuentas con su frase para convertir (§2.7).
4. **Passkeys por relevo**: ¿fuera de la primera versión?
5. **¿La vista pública también sellada?** Esconde sitios y usuarios de una copia del disco, a
   cambio de que buscar con la bóveda cerrada no enseñe nombres.
