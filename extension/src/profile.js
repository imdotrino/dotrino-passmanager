// LA PÁGINA DEL PERFIL de la extensión.
//
// Solo monta la tarjeta del ecosistema a lo ancho. Todo lo que hace —editar, cambiar de
// cuenta, borrar— vive en el componente y en el proveedor (`profile-card.js`); aquí no hay
// lógica que mantener, y es a propósito.

import './vendor/topbar/index.js'
import { profileCard, wireTopbar } from './profile-card.js'
import { pickLang, t, errorText } from './i18n.js'
import { renderAdd, renderLink } from './add-profile.js'
import { hostApprovals } from './approval.js'
import { askWorker as ask } from './page.js'

// La bóveda puede preguntar mientras esta pestaña está delante: la pregunta sale aquí,
// como en el resto de pantallas de la extensión.
hostApprovals()

const lang = pickLang()
document.documentElement.lang = lang


const view = document.getElementById('view')

const toast = (txt) => { try { console.warn('[profile]', txt) } catch (_) {} }
const humanError = (e) => errorText(ctx.lang, e)

/** La tarjeta, que es lo que esta página es el 99 % de las veces. */
function render () {
  location.hash = ''
  // Los ACCESOS con usuario y contraseña de esta cuenta: crearlos para poder entrar desde
  // otro equipo, y encender la pestaña que los atiende. Son aparatos de la cuenta, así que
  // van con la cuenta y no en la lista de contraseñas.
  const accesos = document.createElement('a')
  accesos.className = 'link'
  accesos.href = 'manager.html#view=logins'
  accesos.textContent = t(ctx.lang, 'lgLink')
  accesos.dataset.testid = 'go-logins'
  view.replaceChildren(profileCard(ask, ctx.lang), accesos)
}

/**
 * Y las dos entradas del menú del ecosistema, que llegan por el `#`.
 *
 * «Crear perfil» y «Adoptar un perfil» son enlaces del topbar y apuntan aquí; si esta
 * página los ignorara, serían dos botones que abren una pantalla y no hacen nada. El flujo
 * es el MISMO que el del popup — vive en `add-profile.js` y lo usan los dos.
 */
const ctx = { view, lang, ask, toast, humanError, onDone: render }
// El idioma lo lleva la barra del ecosistema (§9): al cambiarlo se vuelve a pintar, como
// en las otras dos pantallas.
document.addEventListener('dotrino-lang', (ev) => {
  ctx.lang = ev.detail?.lang || ctx.lang
  document.documentElement.lang = ctx.lang
  render()
})

const donde = location.hash.replace('#', '')
if (donde === 'new') renderAdd(ctx)
else if (donde === 'adopt') renderLink(ctx)
else render()

addEventListener('dotrino-profile', (e) => { e.preventDefault() })

// La barra, con su selector de perfiles y tu avatar: lo pinta el componente.
wireTopbar(ask)
