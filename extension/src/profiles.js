// EL CONMUTADOR DE PERFILES, el mismo en el popup y en el gestor.
//
// Un perfil es una bóveda (DISENO §3.3): los perfiles no se ven entre ellos y lo que
// enseña cualquier pantalla es lo del ACTIVO. Por eso el gestor lo necesita tanto como el
// popup (dueño, 2026-08-29: *«en el manager no veo el switch de perfiles»*) — sin él, la
// pantalla donde se administra todo no dice de qué bóveda está hablando.
//
// AÑADIR un perfil no está aquí: pide emparejar, que es un flujo con su pantalla y vive
// en el popup. La pieza lo admite (`onAdd`), y quien no lo pase no enseña el `+`.

import { t } from './i18n.js'

function el (tag, props = {}, children = []) {
  const n = Object.assign(document.createElement(tag), props)
  for (const c of [].concat(children)) if (c) n.append(c)
  return n
}

/**
 * @param {object} ctx   `{ lang, ask, toast, humanError, onChanged }`
 * @param {object} s     lo que devuelve `status`: `{ profiles, active }`
 * @param {object} opts  `{ onAdd }` — sin él, no hay botón de añadir
 */
export function profileBar (ctx, s, { onAdd } = {}) {
  const { lang, ask, toast, humanError, onChanged } = ctx
  const bar = el('div', { className: 'profiles' })

  for (const p of s.profiles || []) {
    const activo = p.id === s.active
    const b = el('button', {
      className: 'profile' + (activo ? ' on' : ''),
      type: 'button',
      title: p.kind === 'own' ? t(lang, 'ownVault') : t(lang, 'linkedTo'),
    })
    b.dataset.testid = `profile-${p.id}`
    if (p.avatar) b.append(el('img', { className: 'face', src: p.avatar, alt: '' }))
    b.append(el('span', { textContent: p.label || (p.kind === 'own' ? t(lang, 'thisBrowser') : t(lang, 'aVault')) }))
    b.setAttribute('aria-pressed', String(activo))
    b.onclick = async () => {
      if (activo) return
      try { await ask('profile-use', { id: p.id }); onChanged() } catch (e) { toast(humanError(e), 'error') }
    }
    bar.append(b)
  }

  if (onAdd) {
    const add = el('button', { className: 'profile add', type: 'button', textContent: '+', title: t(lang, 'addProfile') })
    add.dataset.testid = 'profile-add'
    add.onclick = () => onAdd(s)
    bar.append(add)
  }
  return bar
}
