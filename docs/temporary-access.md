# Usar el gestor en un equipo que no es tuyo

> **Estado: PROPUESTA** (2026-09-17). Sin código. La pidió el dueño: *«¿cómo haría para
> loguearme en passmanager de forma temporal en otra máquina?»*.
>
> **El modelo lo fijó el dueño el mismo día**, después de una primera versión con sesión y
> aprobador: *«en el vault debería poderse crear un dispositivo que se abra con contraseña;
> con eso no necesitamos ni la aprobación: este dispositivo tiene permisos como los demás,
> su llave vive en el vault igual que sus sobres y se desbloquea con usuario y contraseña»*.
>
> **Depende de [`sealed-passwords.md`](./sealed-passwords.md)**: sin contraseñas selladas por
> aparato no hay sobres que darle a nadie, y la bóveda cerrada seguiría descifrando.

## 1. Lo que se quiere

Entrar al gestor en un equipo prestado **con usuario y contraseña**, sin tener otro aparato
a mano, y que lo que ese equipo pueda llegar a ver esté **acotado de antemano**.

## 2. Por qué hoy no se puede

| Camino | Por qué no sirve |
|---|---|
| Enlazar el equipo (`dotrino-vault pair --scope passwords`) | Mete en el acta una llave que vive **en ese equipo**, sin vencimiento. Quitarla es `revoke`, con la bóveda abierta. |
| Una sesión (`profile.dotrino.com/sessions`) | `passwords` está prohibido en el papel (`SESSION_FORBIDDEN`) y el plan lo dice: *«Sesiones que … lean secretos. Ni con permiso.»* (`dotrino-vault/docs/inicio-de-sesion.md` §8). |
| «Entrar con Dotrino» (SSO) | Dice quién eres a una aplicación. No da ninguna contraseña. |
| Cualquiera, hoy | la bóveda descifra con su propia llave aunque esté cerrada (`sealed-passwords.md` §1). |

## 3. La propuesta: un aparato que se abre con usuario y contraseña

Es **un miembro del acta como cualquier otro**: tiene su llave de firma, su llave de
cifrado, sus permisos y sus sobres. Lo único distinto es **dónde vive su llave privada**: en
la bóveda, cifrada con algo que solo sale de tu contraseña.

**No es una sesión** —no hay papel ni aparato que respalde—, así que la regla de
`inicio-de-sesion.md` §8 no le aplica. Tampoco es una contraseña de cuenta: si la olvidas
pierdes ese aparato, no tu cuenta.

### 3.1. Alta: una vez, con la bóveda abierta

```
tu aparato (consola o TUI)                         bóveda
──────────────────────────                         ──────
eliges usuario, contraseña, permisos
y qué entradas llevará
genera el par de firma y el de cifrado
OPAQUE (registro) ─────────────────────────────►   guarda el registro OPAQUE
cifra las privadas con la export_key   ────────►   guarda ese bloque, que no puede abrir
                                                    la maestra lo admite en el acta
```

- **Las llaves nacen en tu aparato**, no en la bóveda. La bóveda solo recibe material que no
  puede abrir.
- **Sin tipo nuevo en el acta** (*permisos, no tipos*): es un miembro con sus `caps`. Que su
  llave viva en la bóveda es estado de la bóveda, no del acta.
- **Aprobación: la elige quien lo crea** (decidido). Sin aprobación, el aparato lleva
  `unattended`; con ella, lo privado espera el sí de un aprobador, como hoy cualquier aparato
  sin ese permiso (`needsApproval`, `dotrino-vault/src/vault.js:152`).

### 3.2. Entrar en el equipo prestado

**El usuario dice dónde está tu cuenta** (decidido): `nombre@AB12-CD34-EF56`. Lo de antes de la
`@` es el aparato; lo de después, los **primeros 48 bits de la huella de tu cuenta**
(`pubkeyId(profileId)`, con el mismo formato de `keyLabel` y un grupo más). Se ata a la
cuenta y no a una máquina porque la cuenta no cambia nunca, y la bóveda puede mudarse o
tener réplicas. La dirección **nunca va en la contraseña**: hay que mandarla antes de
comprobar nada.

Cada bóveda que atiende esa cuenta, réplicas incluidas, **se anuncia en un canal del proxio**
(firmado y con vencimiento). El gestor lista el canal, y antes de hablar con ninguna
comprueba que el acta que le enseña es de una cuenta cuya huella empieza por ese código.
Una bóveda falsa no puede fabricar eso; con 48 bits, fabricar otra cuenta con el mismo
código cuesta siglos en una máquina normal (con los 32 de `keyLabel` serían horas). El precio:
el canal deja ver que detrás de ese código hay una bóveda encendida, no de quién es ni qué
guarda.

```
equipo prestado (extensión)                        bóveda (abierta o cerrada)
───────────────────────────                        ──────────────────────────
nombre@AB12-CD34-EF56 + contraseña
lista el canal del código, comprueba el acta ──►   anuncio firmado
OPAQUE (inicio) ◄──────────────────────────────►   comprueba sin ver la contraseña
                                                    ¿intentos dentro del límite?
obtiene la export_key
                ◄── bloque de las llaves + inicio de sesión ──
abre las llaves EN MEMORIA
desde aquí es un aparato: find / get / put ────►   solo mientras el inicio de sesión esté vigente
```

- **OPAQUE** (decidido): la bóveda nunca ve la contraseña y no entrega nada con qué
  adivinarla. Desde fuera solo se puede probar **en línea**, contra el límite de intentos.
- **El inicio de sesión no vence en la bóveda** (decidido): cuánto dura lo decide el cliente.
  La bóveda solo entrega sobres mientras haya un inicio de sesión abierto, y se cierra
  cuando el cliente sale, cuando cambias la contraseña o cuando revocas el aparato.
- **Consecuencia, dicha claro:** si alguien se queda con la llave y el inicio de sesión
  abierto —olvidaste salir, o el equipo estaba comprometido—, sigue recibiendo las entradas
  marcadas **hasta que lo cierres tú**. Por eso **tu consola lista los inicios de sesión
  abiertos de cada aparato** —cuándo empezó y cuándo se usó por última vez— **con un botón
  para cerrarlos** (decidido). Cerrar uno no cambia la contraseña ni quita el aparato: el
  siguiente inicio vuelve a pedir la contraseña.
- **Salir** suelta las llaves de memoria y cierra el inicio de sesión en la bóveda.

### 3.3. Qué entradas lleva

**Solo las que marques** (decidido). Es lo que el modelo de sobres permite sin nada extra:
los destinatarios de cada entrada se eligen, y este aparato solo recibe envoltura de las
marcadas para él. Lo que no está envuelto a su llave **no se abre aunque la roben**.

Marcar una entrada que ya existe es darle una envoltura nueva, y la hace quien ya la tiene
abierta (`sealed-passwords.md` §2.5); desmarcarla deja de mandársela en el acto y borra su
envoltura al abrir la bóveda.

**Passkeys, por permiso** (decidido): la privada de una passkey solo se envuelve a aparatos
con el permiso `passkeys` (`sealed-passwords.md` §2.8). Este aparato **se crea sin él**: abierta
en un equipo prestado, una passkey se podría copiar y usar hasta que la borres en cada sitio.
Quien lo crea puede dárselo, y la pantalla lo advierte.

**Tampoco ve lo que no lleva**: la bóveda filtra por destinatario el índice de sitios, las
vistas y los resúmenes, así que ese aparato no puede ni saber si tienes cuenta en un sitio que
no marcaste (`sealed-passwords.md` §2.6).

### 3.4. Dónde se entra: «Iniciar sesión» en el botón de perfil

**Decidido por el dueño (2026-09-17):** el menú del botón de perfil, que hoy tiene «Abrir mi
perfil», «Crear perfil» y «Adoptar un perfil», **suma «Iniciar sesión»**. Ese menú está en todas
las apps (`@dotrino/topbar`), así que se entra igual desde cualquiera.

- **El topbar** gana el elemento y su atributo `profile-login-href`, como `profile-new-href` y
  `profile-adopt-href`: por defecto va a `profile.dotrino.com/login?return=…`, y la extensión del
  gestor —que tiene su propia identidad— lo redirige a su pantalla.
- **La página** pide `nombre@AB12-CD34-EF56` y la contraseña, hace el inicio OPAQUE y abre la llave
  del aparato **en la identidad de ese navegador** (`id.dotrino.com`). Desde ahí, ese navegador
  es ese aparato para **todas las apps** mientras dure el inicio de sesión, y aparece en la lista
  de perfiles del menú con su «Salir».

- **Recordar, lo elige quien entra** (decidido): una casilla «Recordar» en la página.
  **Sin marcar**, la llave vive en memoria hasta cerrar el navegador. **Marcada**, se guarda en
  ese navegador —como llave no extraíble, nunca en claro— y sigue ahí hasta «Salir» o hasta
  que cierres el inicio desde tu consola. La página avisa de no marcarla en un equipo prestado.
  Cambia una línea escrita: `inicio-de-sesion.md` §2 decía que no se ofrece «recuérdame en este
  equipo»; aquella regla era para que una **sesión** no se convirtiera en un enrolamiento
  encubierto, y esto no lo es —la llave es de un aparato que ya está en el acta y se cierra
  desde la consola—, pero la decisión es del dueño y queda anotada allí.
- **Las dos formas de entrar** (decidido): la página ofrece usuario y contraseña, y debajo
  **«Con otro aparato tuyo»**, la sesión con QR que ya existe (`profile.dotrino.com/sessions`),
  que no toca contraseñas ni necesita crear nada antes.

**Lo que implica, dicho claro:** no es un inicio de sesión «del gestor», es **de la cuenta**. Lo
que ese navegador puede hacer lo dicen los permisos del aparato: con `sign` firma por ti (un eco,
una calificación); con `passwords`, rellena lo marcado. Por eso los permisos se eligen al crearlo
y la pantalla de alta los enseña uno por uno.

## 4. Qué protege y qué no

| Quien tiene… | …consigue |
|---|---|
| tu usuario, desde fuera | probar contraseñas **en línea**, contra el límite de intentos |
| una copia del disco de la bóveda | **probar contraseñas sin límite** contra el registro OPAQUE: el material del servidor está ahí. Lo que aguanta es la contraseña, así que tiene que ser larga |
| el equipo prestado mientras estás dentro | **las entradas marcadas** para ese aparato, sin preguntar si lo creaste sin aprobación |
| tu contraseña, capturada en ese equipo | entrar desde cualquier sitio **hasta que la cambies o revoques el aparato**, y solo a lo marcado |
| la llave que quedó en el equipo, con el inicio de sesión abierto | las entradas marcadas, **hasta que lo cierres** desde tu consola, cambies la contraseña o revoques el aparato: la bóveda no lo corta sola |
| la llave que quedó en el equipo, con el inicio de sesión cerrado | nada: sin inicio de sesión abierto no hay sobres, y abrir otro pide la contraseña |

Y lo de siempre: **el equipo prestado ve lo que rellenas**. Nada de esto protege lo que
escribes en una máquina comprometida.

## 5. Lo que se descartó para esto

**La sesión aprobada por relevo** (primera versión de este documento): un QR en el equipo
prestado, un papel firmado por un aprobador y cada contraseña descifrada por el aprobador.
Funciona, pero obliga a tener un aprobador encendido y a mano **en cada uso**. El relevo se
queda en `sealed-passwords.md` §3 para lo que sí lo necesita: un aparato que acaba de entrar
y aún no tiene sus envolturas.

## 6. Decisiones

**Tomadas por el dueño (2026-09-17):**

- un aparato que se abre con usuario y contraseña, con su llave en la bóveda;
- lleva **solo las entradas que marques**;
- la **aprobación la elige quien lo crea**;
- las passkeys van por el permiso `passkeys`, y este aparato **se crea sin él**;
- la contraseña se comprueba con **OPAQUE**, con un paquete propio **`@dotrino/opaque`** que
  envuelve `opaque-ke`;
- el inicio de sesión **no vence en la bóveda**: lo decide el cliente;
- **5 intentos** de contraseña; al pasarlos, **una espera que se duplica** con cada fallo;
- **puede guardar**, como cualquier aparato con `passwords`;
- la consola **lista y cierra** los inicios de sesión abiertos;
- se entra desde **«Iniciar sesión» en el botón de perfil** de cualquier app (§3.4).

**Pendientes:**

Ninguna.

**Decididas por el camino:**

- ~~**Cuánto se queda la llave en el navegador**~~ — **decidido: casilla «Recordar»** (§3.4).
- ~~**¿«Iniciar sesión» ofrece también la sesión con QR?**~~ — **decidido: sí, las dos formas.**

1. ~~**Cuánto dura un inicio de sesión**~~ — **decidido: sin vencimiento en la bóveda, lo
   decide el cliente**, y **la consola lista los inicios abiertos con un botón para
   cerrarlos**.
2. ~~**Intentos**~~ — **decidido: 5, y después una espera que se duplica** con cada fallo
   (1 minuto, 2, 4…), por aparato. Se eligió frente al bloqueo porque con un bloqueo
   cualquiera que sepa tu usuario te deja sin entrar a propósito. El precio: quien prueba
   contraseñas no se para del todo, solo va muy despacio. Un acierto reinicia la cuenta, y
   los fallos van a la bitácora.
3. ~~**Cómo se encuentra tu bóveda**~~ — **decidido: `nombre@AB12-CD34-EF56`** (§3.2).
   **Directorio de nombres: PENDIENTE, sin construir** (dueño, 2026-09-17). Lo decidido:
   - **un servicio aparte**, no el proxio;
   - **solo traduce un nombre al id de la bóveda**, y nada más: **no hay búsqueda** ni lista.
     Sin poder enumerar, deja de ser una lista de quién tiene cuenta; lo que sí ve es qué
     nombre se consulta;
   - **se cobra por reservar un nombre**; sin reservar, el nombre sale al azar.

   Encaja como capa ENCIMA: el nombre solo lleva al código, y el acta se sigue comprobando
   contra él, así que un directorio comprometido puede desviar o negar, no robar la
   contraseña. **Cuando se construya** hay que cambiar lo que choca con cobrar: *«no se
   monetiza al usuario de las apps»* (`MODELO-NEGOCIO.md`) y la moneda de soporte como única
   monetización (`CONVENCIONES-APPS.md` §6). Falta diseñar las reasignaciones a la vista (un
   registro de solo añadir).
4. ~~**La librería de OPAQUE**~~ — **decidido: `@dotrino/opaque`, un paquete del ecosistema
   sobre `opaque-ke`** (Rust, de Meta, RFC 9807, auditado por NCC Group en 2021). No se
   escribe criptografía: el paquete da la API que usan el vault y el gestor, se prueba con
   los vectores del RFC 9807 y **compila el WASM en nuestro CI desde el fuente** de
   `opaque-ke`, fijado a una versión exacta, en vez de fiarse de un binario ya compilado. El
   WASM va dentro del JS, que es lo que entra en el ejecutable único del vault.

   Comparadas el 2026-09-17 y descartadas: **`@cloudflare/opaque-ts`** implementa el borrador
   07 de 2021, no el RFC final, y no publica desde febrero de 2022; **`@serenity-kit/opaque`**
   usa `opaque-ke` y está al día (1.1.0, febrero 2026), pero trae el WASM ya compilado —435 KB
   que nadie puede revisar—; sirve de referencia para compilarlo. **Implementarlo desde cero**
   se descartó: rompe la regla de no escribir cifrado propio, y WebCrypto no da las
   operaciones de curva que hacen falta, así que irían en `BigInt`, sin tiempo constante.
5. ~~**Guardar desde ese aparato**~~ — **decidido: sí, puede guardar**, como cualquier aparato
   con `passwords`. Guardar no pide aprobación (tampoco hoy: al guardar no sale nada de la
   bóveda); la aprobación, si se eligió al crearlo, es para abrir lo privado.

## 7. Qué tocaría

| Pieza | Cambio |
|---|---|
| **antes que todo** | las contraseñas selladas por aparato (`sealed-passwords.md`), con destinatarios elegibles por entrada |
| `dotrino-vault` | alta de un aparato con contraseña (registro OPAQUE + bloque cifrado + admitirlo en el acta), inicio OPAQUE, inicio de sesión con vencimiento, límite de intentos, cambio de contraseña |
| `@dotrino/passmanager` (extensión) | «Entrar con usuario y contraseña»: buscar la bóveda por el código, comprobar el acta, OPAQUE, llaves solo en memoria, salir |
| `dotrino-vault` (anuncio) | anunciar cada cuenta que atiende en el canal de su código, firmado y con vencimiento |
| `@dotrino/topbar` | «Iniciar sesión» en el menú del perfil, `profile-login-href`, textos es/en; y `CONVENCIONES-APPS.md` §6.1, que enumera los elementos del menú |
| `dotrino-profile-app` | la página `/login`: usuario, contraseña, OPAQUE, abrir la llave en la identidad del navegador |
| consola y TUI del vault | crear el aparato, marcar sus entradas, cambiar su contraseña, y **listar y cerrar sus inicios de sesión abiertos** (inicio y último uso) |
| **`@dotrino/opaque`** (repo nuevo) | API de registro e inicio para las dos puntas, vectores del RFC 9807, WASM de `opaque-ke` compilado en CI y publicado desde CI con su procedencia |
