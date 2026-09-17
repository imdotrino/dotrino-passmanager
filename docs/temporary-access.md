# Usar el gestor un rato en una máquina que no es tuya

> **Estado: PROPUESTA** (2026-09-17). Sin código. La pidió el dueño: *«¿cómo haría para
> loguearme en passmanager de forma temporal en otra máquina?»*. El mismo día decidió la
> duración, qué pide aprobación y si se puede guardar (§6). **Falta la primera pregunta,
> que cambia una regla escrita**, y sin ella no se construye.
>
> ⚠️ **Depende de [`sealed-passwords.md`](./sealed-passwords.md).** La primera versión de §3
> daba por hecho que la bóveda descifra la credencial **aunque esté cerrada** (dueño: *«la
> prueba de firma no desencripta las cosas»*). Hoy solo es posible por un agujero —la `cek`
> bajo la llave de la máquina— y se cierra con las contraseñas selladas por aparato. §3 ya
> está rehecha sobre eso: **quien descifra es el teléfono que aprueba**, por relevo.

## 1. Lo que se quiere

Usar tus contraseñas en un equipo prestado durante un rato, y que al acabarse ese rato el
equipo **deje de recibir nada sin que nadie tenga que acordarse de quitarlo**.

## 2. Por qué hoy no se puede

| Camino | Por qué no sirve |
|---|---|
| Enlazar el equipo (`dotrino-vault pair --scope passwords`) | Mete su llave en el acta **sin vencimiento**. Quitarla es `revoke`, que sella el acta y exige la bóveda abierta. Si se olvida, el equipo sigue dentro. |
| Enlazarlo «con fecha» | Al vencer no hay quien lo saque: sacar a un miembro es sellar, y sellar es de la maestra, que con la bóveda cerrada no firma nada (*la maestra tiene dos trabajos*, `CLAUDE.md`). Seguiría en el acta con `sign`, `read` y `store`. **Descartado.** |
| Una sesión (`profile.dotrino.com/sessions`) | `passwords` está en la lista prohibida del papel (`SESSION_FORBIDDEN`, `@dotrino/identity/session`), y el plan lo dice sin matices: *«Sesiones que sellen, administren, aprueben o lean secretos. Ni con permiso.»* (`dotrino-vault/docs/inicio-de-sesion.md` §8). |
| «Entrar con Dotrino» (SSO) | Dice quién eres a una aplicación. No da acceso a ninguna contraseña. |

## 3. La propuesta: la sesión PIDE, y el teléfono que aprueba es el que DESCIFRA

La sesión **no recibe ninguna llave**: ni la capacidad de leer, ni una envoltura. Recibe la
de **pedir**. Cada entrega pasa por el **relevo** de `sealed-passwords.md` §3: la bóveda
—abierta o cerrada, da igual, porque no puede abrir nada— le manda al teléfono los sobres y
**su** envoltura; el teléfono pregunta, abre, y le sella a la sesión **solo lo pedido**.
Aprobar es descifrar.

```
  equipo prestado (extensión)              teléfono (`passwords` + `approve`)
  ───────────────────────────              ──────────────────────────────────
  «Usar un rato» → genera S
  muestra QR + código de 6  ──escanea──►   «Gestor de contraseñas · 1 hora»
                                            [Permitir]  [No]
        ◄──── papel { scopes: [passwords:ask], exp } ────

  pide la contraseña de x.com ──► bóveda ── sobres + SU envoltura ──►
                                            «Sesión 3F2A pide x.com»
                                            [Permitir] → abre
        ◄──────────── solo lo pedido, sellado a S ────────────────
```

Al pasar `exp`, **ni la bóveda suelta sobres ni el teléfono abre**. Al vencer no hay que
firmar ni sellar nada, así que se retira sola y nadie tiene que acordarse.

De un código de dos pasos el teléfono manda **el código**, no la semilla. Guardar va al
revés: la sesión le sella el valor al teléfono, el teléfono lo enseña, y si se aprueba hace
él el sobre y lo firma como autor.

Reutiliza lo que ya existe: el flujo de la sesión y el QR al revés (`session-flow`,
`@dotrino/qr`), el aviso al teléfono de la mesa de contraseñas, y el sellado del transporte
(la llave de cifrado de S se averigua y se verifica contra S, `proxy-client` ≥ 0.20).

## 4. Los límites que se proponen

| | |
|---|---|
| **Alcance** | uno nuevo, `passwords:ask`. `passwords` **sigue prohibido**: nada en una sesión lee sin aprobación. |
| **Quién lo puede dar** | el aparato que respalda tiene que tener **hoy**, en el acta, `passwords` **y** `approve`: es el que va a abrir los sobres. Nunca amplía. |
| **Duración** | 1 hora por defecto, tope de 4 (las sesiones generales van 8 y 24). **Decidido.** |
| **Qué puede hacer** | `find` del sitio, `get` y **guardar** (`put`/`patch`). **No** `search` (buscar en toda la bóveda) ni `sites`. **Decidido.** |
| **Aprobación** | en **cada** `get` —también un dato público, tu correo o tu teléfono— y en **cada** guardado, de uno en uno y sin la hora deslizante de los aparatos. `find` no pregunta: enseña qué cuentas hay en ese sitio para poder elegir, sin ningún valor. **Decidido.** |
| **Dónde vale** | el `origin` firmado es el de la extensión del gestor; en otra aplicación el papel no vale. |
| **Cerrar antes** | desde `profile.dotrino.com/sessions`, y **de verdad**: la bóveda guarda los `sid` cerrados hasta su `exp`, también si se reinicia. En las sesiones generales cerrar es cortesía (el papel muere al vencer); con contraseñas no basta. |
| **Muere con quien respalda** | quitar el teléfono del acta invalida sus papeles. Sale del modelo de F1 y hay que probarlo aquí. |

## 5. Lo que esto NO arregla

- **El equipo prestado ve lo que rellenas.** La aprobación limita cuántas contraseñas salen,
  no protege las que apruebas: una captura de teclado, de pantalla o una extensión
  maliciosa se las lleva igual.
- **Hay que instalar la extensión** en ese equipo, y quitarla al terminar. Lo que quede en
  él (la llave S) no se puede garantizar borrado; lo que se garantiza es que **la bóveda
  deja de contestarle**.
- **Tu bóveda tiene que estar atendiendo** (el demonio, o la pestaña abierta) **y tu
  teléfono a mano y con `passwords`**, porque es quien descifra. Sin teléfono no hay
  acceso: es la pregunta abierta «sesión sin teléfono» de `inicio-de-sesion.md` §9, y aquí
  la respuesta tiene que ser que no.

## 6. Lo que decide el dueño

1. **La regla.** `inicio-de-sesion.md` §8 dice que una sesión no lee secretos «ni con
   permiso». ¿Se acepta que **pida** contraseñas si cada entrega la aprueba el teléfono?
   **Sin este sí no se construye nada de lo demás.**
2. ~~**Duración**~~ — **decidido (2026-09-17): 1 hora, tope de 4.**
3. ~~**Qué pregunta**~~ — **decidido: todo `get`, también lo público; `find` no.**
4. ~~**Escribir**~~ — **decidido: puede guardar, y cada guardado pasa por el teléfono.**
5. **Aprobar de uno en uno**, o una ventana corta (p. ej. 5 minutos) por sitio.

## 7. Qué tocaría, cuando se decida

| Pieza | Cambio |
|---|---|
| `@dotrino/identity` (`vault/session.js`) | `passwords:ask` en `SESSION_SCOPES`, con su capacidad exigida (`passwords` + `approve`) y su tope de duración |
| `@dotrino/passmanager` (`VaultResponder`) | aceptar el papel en la petición y aplicar la política de sesión (operaciones cerradas; aprobación en toda lectura y todo guardado). Va aquí y no en cada bóveda: son **cuatro** las que responden |
| `dotrino-vault` (mesa de contraseñas) | verificar el papel contra el acta de hoy, lista de `sid` cerrados hasta su `exp`, y mandarle al teléfono los sobres con el sitio y si es leer o guardar |
| **antes que todo lo anterior** | las contraseñas selladas por aparato (`sealed-passwords.md`): sin eso no hay quién descifre sin que la bóveda vea el claro |
| `dotrino-passmanager/extension` | «Usar un rato»: llave S no extraíble, QR, papel en memoria de sesión, borrarlo al vencer |
| `dotrino-profile-app` (`/sessions`) | cerrar una sesión del gestor avisando a la bóveda, firmado |
| app del teléfono | nada nuevo: escanear y aprobar ya existen |
