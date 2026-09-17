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
                ◄── bloque de las llaves + inicio de sesión con vencimiento ──
abre las llaves EN MEMORIA
desde aquí es un aparato: find / get / put ────►   solo mientras el inicio de sesión esté vigente
```

- **OPAQUE** (decidido): la bóveda nunca ve la contraseña y no entrega nada con qué
  adivinarla. Desde fuera solo se puede probar **en línea**, contra el límite de intentos.
- **La llave sola no basta.** La bóveda solo le entrega sobres mientras haya un inicio de
  sesión vigente. Al vencer, quien se haya quedado con la llave no consigue nada sin volver a
  saber la contraseña.
- **Salir** suelta las llaves de memoria y cierra el inicio de sesión en la bóveda.

### 3.3. Qué entradas lleva

**Solo las que marques** (decidido). Es lo que el modelo de sobres permite sin nada extra:
los destinatarios de cada entrada se eligen, y este aparato solo recibe envoltura de las
marcadas para él. Lo que no está envuelto a su llave **no se abre aunque la roben**.

Marcar una entrada que ya existe es darle una envoltura nueva, y la hace quien ya la tiene
abierta (`sealed-passwords.md` §2.5); desmarcarla deja de mandársela en el acto y borra su
envoltura al abrir la bóveda.

## 4. Qué protege y qué no

| Quien tiene… | …consigue |
|---|---|
| tu usuario, desde fuera | probar contraseñas **en línea**, contra el límite de intentos |
| una copia del disco de la bóveda | **probar contraseñas sin límite** contra el registro OPAQUE: el material del servidor está ahí. Lo que aguanta es la contraseña, así que tiene que ser larga |
| el equipo prestado mientras estás dentro | **las entradas marcadas** para ese aparato, sin preguntar si lo creaste sin aprobación |
| tu contraseña, capturada en ese equipo | entrar desde cualquier sitio **hasta que la cambies o revoques el aparato**, y solo a lo marcado |
| la llave que quedó en el equipo, sin la contraseña | nada: sin inicio de sesión vigente no hay sobres |

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
- la contraseña se comprueba con **OPAQUE**.

**Pendientes:**

1. **Cuánto dura un inicio de sesión.** Para la sesión se había decidido 1 hora con tope de
   4. ¿Vale lo mismo aquí?
2. **Límite de intentos**: cuántos, y qué pasa al pasarlo (esperar, o bloquear hasta que
   entres desde otro aparato). Los intentos fallidos van a la bitácora.
3. ~~**Cómo se encuentra tu bóveda**~~ — **decidido: `nombre@AB12-CD34-EF56`** (§3.2).
   **Idea del dueño, sin diseñar:** un directorio que dé a cada cuenta un **nombre al azar**
   gratis (`ana-tigre-47`) y uno **elegido de pago**. Encaja como capa ENCIMA —el alias solo
   traduce al código, y el acta se sigue comprobando contra él, así que un directorio
   comprometido puede desviar o negar, no robar la contraseña—, pero antes hay que resolver:
   - **cobrar choca con reglas escritas**: *«no se monetiza al usuario de las apps»*
     (`MODELO-NEGOCIO.md`), la moneda de soporte como única monetización (`CONVENCIONES-APPS.md`
     §6), y `dotrino-sso` descartó cobrar por el puente alojado por el mismo motivo;
   - **dónde vive**: dos proxios federados que asignan nombres pueden dar el mismo a dos
     cuentas; mejor un servicio aparte con registros firmados;
   - **reasignaciones a la vista** (un registro de solo añadir);
   - **privacidad**: el directorio es una lista de quién tiene cuenta y ve quién busca a quién.
4. **La librería de OPAQUE.** Tiene que ser JS puro o WASM embebido —el vault va en un
   ejecutable único y ahí no entra nada nativo— y pasar por la revisión de dependencias
   (`CONVENCIONES-APPS.md` §1.1). Candidatas: `@cloudflare/opaque-ts` (TypeScript, dos
   dependencias) y `@serenity-kit/opaque` (WASM de `opaque-ke`).
5. **Guardar desde ese aparato**: ¿puede, y con aprobación si la tiene?

## 7. Qué tocaría

| Pieza | Cambio |
|---|---|
| **antes que todo** | las contraseñas selladas por aparato (`sealed-passwords.md`), con destinatarios elegibles por entrada |
| `dotrino-vault` | alta de un aparato con contraseña (registro OPAQUE + bloque cifrado + admitirlo en el acta), inicio OPAQUE, inicio de sesión con vencimiento, límite de intentos, cambio de contraseña |
| `@dotrino/passmanager` (extensión) | «Entrar con usuario y contraseña»: buscar la bóveda por el código, comprobar el acta, OPAQUE, llaves solo en memoria, salir |
| `dotrino-vault` (anuncio) | anunciar cada cuenta que atiende en el canal de su código, firmado y con vencimiento |
| consola y TUI del vault | crear el aparato, marcar sus entradas, cambiar su contraseña |
| dependencia nueva | la librería de OPAQUE, en las dos puntas |
