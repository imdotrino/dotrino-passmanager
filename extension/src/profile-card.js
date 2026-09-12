// LA TARJETA DE PERFIL del ecosistema, dentro de la extensión (CONVENCIONES §6.1).
//
// No es un formulario nuestro: es `<dotrino-profile>`, el mismo Web Component que usan las
// demás apps, vendorizado como el topbar (MV3 solo importa de su propia carpeta). Aquí solo
// se escribe el PROVEEDOR — las cinco funciones que el componente pide para leer y guardar—
// y cada una es una operación que el service worker ya tenía.
//
// Por qué no había pantalla hasta hoy: `profile-rename` y `profile-remove` existían en el
// service worker desde siempre y **nadie los llamaba**. Se podía crear un perfil y cambiarse
// a él, pero no ponerle nombre ni borrarlo (dueño, 2026-09-11: «a la extensión le falta el
// editor del perfil»). Escribir aquí otro formulario habría sido reimplementar un pilar a
// mano, que es justo lo que la regla principal prohíbe.
//
// Y de paso deshace un choque de nombres que estaba escrito como excusa para no tener esta
// pantalla: el componente trae SU conmutador de perfiles, así que sustituye al casero de
// `profiles.js` en vez de convivir con él. En la extensión «perfil» vuelve a ser una cosa.

import './vendor/profile/index.js'

/**
 * El puente entre el componente y el service worker.
 *
 * `manage` hace que el componente enseñe el editor completo y el borrado; sin él la tarjeta
 * es de solo lectura (así es fuera de `profile.dotrino.com`, y aquí SÍ se administra: esta
 * es la pantalla de administrar, no la informativa).
 *
 * @param {(op: string, payload?: object) => Promise<any>} ask  el `ask` de la pantalla
 */
export function profileProvider (ask) {
  return {
    /**
     * La lista para el conmutador. El service worker dice `label` y el componente lee
     * `name`: se traduce aquí, que es la frontera, y no se toca ninguno de los dos lados.
     */
    async listProfiles () {
      const st = await ask('status')
      return (st?.profiles || []).map((p) => ({
        id: p.id,
        name: p.label || '',
        avatar: p.avatar || null,
        pubkey: p.pubkey || p.id,
        current: !!p.current,
      }))
    },

    /** El registro completo del perfil activo: foto, redes, datos. */
    async getMyProfile () { return (await ask('profile-get')) || {} },

    /**
     * Guardar es un PATCH: lo que no venga no se toca. El componente manda solo lo que
     * cambiaste, y pisar el resto con lo que la pantalla tuviera en memoria es cómo se
     * pierde una foto por editar un teléfono.
     */
    async setMyProfile (patch) { return ask('profile-set', { patch }) },

    /**
     * El nombre visible. Va por `profile-set` y no por `profile-rename`: el núcleo refleja
     * el `nickname` del perfil en la etiqueta del conmutador él solo, así que hacer las dos
     * cosas escribiría el mismo dato por dos caminos — y dos caminos se desincronizan.
     */
    async setMyName (name) { return ask('profile-set', { patch: { nickname: name } }) },

    async switchProfile (id) { return ask('profile-use', { id }) },
    async deleteProfile (id) { return ask('profile-remove', { id }) },
  }
}

/**
 * LA BARRA, CABLEADA: el topbar pinta SU selector de perfiles, no uno nuestro.
 *
 * El componente ya trae todo —la lista con avatares, cuál está activo, cambiar de perfil,
 * crear y adoptar— y lo pinta solo en cuanto le pasas un `identity`. Lo único que le hacía
 * falta es que ese `identity` exista: el del ecosistema monta un iframe contra
 * id.dotrino.com, y aquí la identidad vive en el service worker.
 *
 * Así que esto es un ADAPTADOR de cinco funciones, no una pantalla. Antes el botón abría
 * una página nuestra y el selector no salía por ninguna parte (dueño, 2026-09-11: «debería
 * mostrar el selector de perfiles IGUAL que en todo lado»).
 *
 * Y se le dice dónde vive el perfil AQUÍ: su menú lleva por defecto a profile.dotrino.com,
 * que es otra identidad distinta de la que estás usando en la extensión.
 */
export function wireTopbar (ask) {
  const barra = document.querySelector('dotrino-topbar')
  if (!barra) return

  const pagina = (n) => chrome.runtime.getURL(`src/${n}.html`)
  barra.setAttribute('profile-href', pagina('profile'))
  barra.setAttribute('profile-new-href', pagina('profile') + '#new')
  barra.setAttribute('profile-adopt-href', pagina('profile') + '#adopt')
  // En OTRA pestaña: en el popup, navegar mete el perfil dentro de una ventanita de 400px,
  // y en el gestor te lleva fuera y pierdes donde estabas.
  barra.setAttribute('profile-target', '_blank')

  barra.identity = {
    /** La lista para el selector. El worker dice `label`; el componente lee `name`. */
    async listProfiles () {
      const st = await ask('status')
      return (st?.profiles || []).map((p) => ({
        id: p.id,
        name: p.label || '',
        avatar: p.avatar || null,
        pubkey: p.pubkey || p.id,
        current: !!p.current,
      }))
    },
    async currentProfile () {
      const st = await ask('status')
      const p = (st?.profiles || []).find((x) => x.current)
      // Con la forma que el componente espera, no la del worker: ahí `label` es `name`, y
      // el `pubkey` es lo que le deja derivar el identicon del botón.
      return p ? { id: p.id, name: p.label || '', avatar: p.avatar || null, pubkey: p.pubkey || p.id } : null
    },
    /** De aquí saca el avatar del botón, sin que haya que ponérselo a mano. */
    async getMe () { return (await ask('profile-get')) || {} },
    async switchProfile (id) { return ask('profile-use', { id }) },
  }
}

/**
 * La tarjeta ya cableada, lista para colgar de la pantalla.
 *
 * Se cuelga VACÍA y se rellena después: el componente necesita el `pubkey` para cargar
 * —sin él `reload()` se planta, también en `mode="self"`—, y pedirlo es un viaje al
 * service worker. Devolverla ya montada y que se complete sola evita que la pantalla
 * espere por esto.
 */
export function profileCard (ask, lang) {
  const card = document.createElement('dotrino-profile')
  card.setAttribute('mode', 'self')
  card.setAttribute('manage', '')          // editor + borrado: esto es administrar
  // Sin reputación: aquí no se califica a nadie. Sin esto salían dos paneles vacíos con un
  // botón de recargar que no recarga nada — ruido que además promete algo que esto no hace.
  card.setAttribute('no-reputation', '')
  card.setAttribute('lang', lang || 'es')
  card.dataset.testid = 'profile-card'

  // EL TEMA, explícito (§6.1: «si tematizás la tarjeta, va por las variables --ccp-*»).
  //
  // El componente NO tiene tema oscuro: una sola paleta gobernada por estas variables, y sus
  // valores por defecto son CREMA. Sin pasárselas quedaba una tarjeta clara sobre el fondo
  // oscuro, con los botones al borde de no leerse (dueño, 2026-09-11).
  //
  // Y hay que ponerlas TODAS, no solo las que se ven mal: la cadena de cada una cae a
  // `var(--accent, …)`, `var(--text, …)`… que la app define para lo suyo, así que a medias
  // salía una mezcla —el azul de la app sobre la paleta crema del componente— peor que
  // cualquiera de las dos enteras.
  //
  // Los valores NO se escriben aquí: salen del tema (`theme.css`), que es el único sitio
  // donde vive la paleta. Dos listas de colores se desincronizan.
  for (const [ccp, token] of [
    ['--ccp-bg', '--panel'], ['--ccp-bg-2', '--bg-low'], ['--ccp-bg-3', '--bg'],
    ['--ccp-bg-4', '--panel-high'], ['--ccp-border', '--line'],
    ['--ccp-text', '--fg'], ['--ccp-muted', '--dim'],
    ['--ccp-accent', '--accent'], ['--ccp-accent-2', '--accent-container'],
    ['--ccp-accent-text', '--on-accent'], ['--ccp-input-bg', '--bg'],
    ['--ccp-font', '--font'], ['--ccp-font-headline', '--font-brand'],
    ['--ccp-font-mono', '--font-mono'], ['--ccp-radius', '--radius'],
  ]) card.style.setProperty(ccp, `var(${token})`)
  card.provider = profileProvider(ask)

  // La pública del perfil activo. Es lo que el componente usa para saber de quién habla, y
  // sale del mismo registro que va a editar.
  ask('profile-get')
    .then((me) => { if (me?.publickey) card.setAttribute('pubkey', me.publickey) })
    .catch(() => {})

  return card
}
