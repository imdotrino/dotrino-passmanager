# Usar el gestor un rato en una máquina que no es tuya

> **Estado: PROPUESTA, sin decidir** (2026-09-17). Sin código. La pidió el dueño: *«¿cómo
> haría para loguearme en passmanager de forma temporal en otra máquina?»*. No se construye
> hasta que el dueño conteste §6 — y la primera pregunta cambia una regla escrita.

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

## 3. La propuesta: la sesión PIDE, y cada entrega la aprueba el teléfono

La sesión **no recibe la capacidad de leer contraseñas**. Recibe la de **pedirlas**, y lo
que decide cada entrega es la aprobación de un aparato tuyo, en ese momento. Es la regla que
el plan de sesiones ya aplica a firmar (§6: *lo sensible lo hace el aparato que respalda, a
demanda*), llevada a las contraseñas.

```
  equipo prestado (extensión)              teléfono (miembro con `approve`)
  ───────────────────────────              ────────────────────────────────
  «Usar un rato» → genera S
  muestra QR + código de 6  ──escanea──►   «Gestor de contraseñas · 1 hora»
                                            [Permitir]  [No]
        ◄──── papel { scopes: [passwords:ask], exp } ────

  pide la contraseña de x.com
  (con el papel) ──────► bóveda ──avisa──►  «Sesión 3F2A pide x.com»
                                            [Permitir]  [No]
        ◄──── esa credencial, sellada a S ──
```

Al pasar `exp`, la bóveda deja de contestar. **Al vencer no hay que firmar ni sellar
nada**, así que se retira sola aunque la bóveda esté cerrada y nadie se acuerde.

Reutiliza lo que ya existe: el flujo de la sesión y el QR al revés (`session-flow`,
`@dotrino/qr`), el aviso al teléfono de la mesa de contraseñas, y el sellado del transporte
(la llave de cifrado de S se averigua y se verifica contra S, `proxy-client` ≥ 0.20).

## 4. Los límites que se proponen

| | |
|---|---|
| **Alcance** | uno nuevo, `passwords:ask`. `passwords` **sigue prohibido**: nada en una sesión lee sin aprobación. |
| **Quién lo puede dar** | el aparato que respalda tiene que tener **hoy**, en el acta, `passwords` **y** `approve`. Nunca amplía. |
| **Duración** | 1 hora por defecto, tope de 4 (las sesiones generales van 8 y 24). |
| **Qué puede hacer** | `find` del sitio y `get`. **No** `search` (buscar en toda la bóveda), **no** `sites`, **no** escribe. |
| **Aprobación** | en cada `get`, de uno en uno, sin la hora deslizante de los aparatos. |
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
  teléfono a mano**. Sin teléfono no hay acceso: es la pregunta abierta «sesión sin
  teléfono» de `inicio-de-sesion.md` §9, y aquí la respuesta tiene que ser que no.

## 6. Lo que decide el dueño

1. **La regla.** `inicio-de-sesion.md` §8 dice que una sesión no lee secretos «ni con
   permiso». ¿Se acepta que **pida** contraseñas si cada entrega la aprueba el teléfono?
   **Sin este sí no se construye nada de lo demás.**
2. **Duración**: ¿1 hora y tope de 4?
3. **Qué pregunta**: ¿todo `get`, también un dato público (tu correo, tu teléfono)? ¿Y
   `find`, que enseña qué cuentas tienes en ese sitio?
4. **Escribir**: ¿puede guardar la contraseña que cambiaste en ese equipo, o solo leer?
5. **Aprobar de uno en uno**, o una ventana corta (p. ej. 5 minutos) por sitio.

## 7. Qué tocaría, cuando se decida

| Pieza | Cambio |
|---|---|
| `@dotrino/identity` (`vault/session.js`) | `passwords:ask` en `SESSION_SCOPES`, con su capacidad exigida (`passwords` + `approve`) y su tope de duración |
| `@dotrino/passmanager` (`VaultResponder`) | aceptar el papel en la petición y aplicar la política de sesión (operaciones cerradas, aprobación siempre). Va aquí y no en cada bóveda: son **cuatro** las que responden |
| `dotrino-vault` (mesa de contraseñas) | verificar el papel contra el acta de hoy, lista de `sid` cerrados hasta su `exp`, y el aviso al teléfono con el sitio que se pide |
| `dotrino-passmanager/extension` | «Usar un rato»: llave S no extraíble, QR, papel en memoria de sesión, borrarlo al vencer |
| `dotrino-profile-app` (`/sessions`) | cerrar una sesión del gestor avisando a la bóveda, firmado |
| app del teléfono | nada nuevo: escanear y aprobar ya existen |
