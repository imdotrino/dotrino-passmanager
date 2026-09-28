// EN QUÉ CUENTA se guarda: el selector de los modales (el de un campo y el aviso de
// después de entrar). Dueño, 2026-09-28: «en los modales debe existir un switcher de
// cuentas para seleccionar en qué cuenta quiero almacenar el registro».
//
// Elegir una cuenta aquí es CAMBIAR DE PERFIL, lo mismo que hace el menú del popup
// (`profile-use`): el gestor guarda en la bóveda del perfil activo y no hay un segundo
// camino para escribir en otra. Lo apuntado para guardar vive en la sesión y no en el
// perfil, así que sobrevive al cambio; lo que el modal tiene que volver a pedir es la
// lista de entradas, que ahora sale de otra bóveda — de eso se encarga `onChange`.
//
// Van solo los perfiles ABIERTOS. Una cuenta de usuario y contraseña que está cerrada no
// es a dónde guardar: para usarla hay que volver a entrar, y eso es del popup.
//
// Con un solo perfil el selector se ve, deshabilitado: dice en qué cuenta cae esto aunque
// no haya otra que elegir.

import { t } from './i18n.js'

const CSS = `
  .account { display: flex; align-items: center; gap: 6px; margin-top: 6px; min-width: 0; }
  .account .lbl2 { font-size: .72rem; text-transform: uppercase; letter-spacing: .04em; opacity: .5; flex: none; }
  .account select {
    flex: 1; min-width: 0; font: inherit; font-size: .82rem; color: inherit;
    background: rgba(255,255,255,.06); border: 1px solid rgba(255,255,255,.2);
    border-radius: 6px; padding: 2px 4px;
  }
  .account select:disabled { opacity: .7; }
  .account select:focus-visible { outline: 2px solid var(--accent); outline-offset: -1px; }
  .account option { color: #000; }
`

/** Cómo se llama un perfil en la lista. Sin nombre, el final de su id: dos sin nombre no se confunden. */
const nameOf = (lang, p) => p.label || t(lang, 'accountUnnamed', String(p.id || '').slice(-6))

/**
 * Monta el selector dentro de `box` y devuelve `refresh()` para repintarlo.
 *
 * `onChange()` corre después de cambiar de perfil: el modal vuelve a cargar lo suyo.
 * `onError(e)` recibe el fallo de cambiar, para enseñarlo donde el modal enseña los suyos.
 */
export function mountAccountSwitch (box, { ask, lang, testid, onChange, onError, resize }) {
  if (!document.getElementById('account-switch-css')) {
    const st = document.createElement('style')
    st.id = 'account-switch-css'
    st.textContent = CSS
    document.head.append(st)
  }
  box.className = 'account'
  box.textContent = ''
  const lbl = document.createElement('span')
  lbl.className = 'lbl2'
  lbl.textContent = t(lang, 'account')
  const sel = document.createElement('select')
  sel.dataset.testid = testid
  sel.setAttribute('aria-label', t(lang, 'account'))
  box.append(lbl, sel)

  let actual = ''
  const refresh = async () => {
    const lista = ((await ask('profiles')) || []).filter((p) => !p.closed)
    sel.textContent = ''
    for (const p of lista) {
      const o = document.createElement('option')
      o.value = p.id
      o.textContent = nameOf(lang, p)
      if (p.current) { o.selected = true; actual = p.id }
      sel.append(o)
    }
    sel.disabled = lista.length < 2
    sel.title = sel.disabled ? t(lang, 'accountOnlyOne') : ''
    resize?.()
  }

  sel.addEventListener('change', async () => {
    const id = sel.value
    if (!id || id === actual) return
    sel.disabled = true
    try {
      await ask('profile-use', { id })
      actual = id
      await onChange?.()
    } catch (e) {
      sel.value = actual
      onError?.(e)
    } finally {
      sel.disabled = sel.options.length < 2
    }
  })

  return { refresh }
}
