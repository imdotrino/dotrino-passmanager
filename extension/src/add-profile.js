// AÑADIR O CONECTAR UN PERFIL, fuera del popup.
//
// Estas dos pantallas vivían dentro de `popup.js` y se llegaba a ellas por una píldora que
// también hacía de conmutador. Esa píldora se quitó —el selector del topbar hace eso y
// más—, y el menú del ecosistema tiene sus propias entradas «Crear perfil» y «Adoptar un
// perfil», que abren la PÁGINA del perfil. Para que esas dos entradas no sean un enlace a
// una pantalla que no sabe hacer lo que promete, el flujo se saca aquí y lo usan las dos.
//
// No se le pasa nada del popup: recibe `view`, `ask`, `toast` y demás, así que la misma
// pantalla sirve en una ventana de 400px y en una pestaña entera.

import { t } from './i18n.js'

function el (tag, props = {}, children = []) {
  const n = Object.assign(document.createElement(tag), props)
  for (const [k, v] of Object.entries(props)) if (k.includes('-')) { delete n[k]; n.setAttribute(k, v) }
  for (const c of [].concat(children)) if (c) n.append(c)
  return n
}

/**
 * CONECTAR OTRA BÓVEDA. No es la puerta de entrada de nada: la extensión ya tiene la
 * suya y se llega aquí desde «usar otra bóveda».
 *
 * Sirve para lo que la propia no puede: que tus contraseñas estén en un solo sitio para
 * todos tus navegadores, y que sobrevivan a desinstalar esto.
 *
 * Es el emparejamiento del ecosistema, el mismo de cualquier aparato: se pega la
 * invitación que muestra la bóveda y este navegador enseña SEIS caracteres que se
 * teclean allí. Ese código NO viaja — la bóveda solo lo aprende porque lo escribes tú,
 * y por eso aprobar exige tener esta pantalla delante.
 */
export function renderLink (ctx) {
  const { view, lang, ask, toast, humanError, onDone } = ctx
  const openVaultBtn = el('button', { className: 'primary', textContent: t(lang, 'openVault') })
  openVaultBtn.onclick = () => {
    chrome.tabs.create({ url: 'https://vault.dotrino.com/vault' })
    window.close()
  }

  const name = el('input', { type: 'text', placeholder: t(lang, 'vaultName') })
  const invite = el('input', { type: 'text', placeholder: t(lang, 'inviteHint'), 'data-testid': 'invite' })
  const err = el('p', { className: 'error', hidden: true })
  const go = el('button', { className: 'primary', textContent: t(lang, 'linkGo'), 'data-testid': 'pair' })
  const waiting = el('div', { className: 'pairing', hidden: true })

  /**
   * El código aparece cuando la bóveda contesta, no antes: mientras tanto lo que hay es
   * una espera, y decirlo es más honesto que dejar un hueco.
   */
  const mostrarCodigo = (p) => {
    waiting.hidden = false
    waiting.replaceChildren(
      el('p', { className: 'hint', textContent: t(lang, 'pairCode') }),
      el('code', { className: 'mycode', textContent: p.code, 'data-testid': 'pair-code' }),
      el('p', { className: 'hint', textContent: t(lang, 'pairCodeHint') }),
    )
  }

  let poll = null
  const submit = async () => {
    if (!invite.value.trim()) return
    err.hidden = true
    go.disabled = true
    invite.disabled = true
    waiting.hidden = false
    waiting.replaceChildren(el('p', { className: 'hint', textContent: t(lang, 'pairWait') }))
    // El código lo genera el service worker durante el emparejamiento y vive solo
    // mientras dura: se le pregunta, no se le manda un canal aparte para esto.
    poll = setInterval(async () => {
      try {
        const s = await ask('status')
        if (s?.pairing?.code) mostrarCodigo(s.pairing)
      } catch (_) { /* el worker se durmió: la siguiente vuelta */ }
    }, 700)
    try {
      await ask('link', { invite: invite.value.trim(), label: name.value.trim() || null })
      onDone()
    } catch (e) {
      err.textContent = humanError(e)
      err.hidden = false
      waiting.hidden = true
      go.disabled = false
      invite.disabled = false
    } finally { clearInterval(poll) }
  }
  go.onclick = submit
  invite.onkeydown = e => { if (e.key === 'Enter') submit() }

  const backBtn = el('button', { className: 'ghost', textContent: t(lang, 'back') })
  backBtn.onclick = () => { clearInterval(poll); onDone() }

  view.replaceChildren(
    el('h2', { textContent: t(lang, 'linkTitle') }),
    el('p', { className: 'hint', textContent: t(lang, 'linkHint') }),
    openVaultBtn,
    el('p', { className: 'hint', textContent: t(lang, 'openVaultHint') }),
    el('p', { className: 'hint', style: 'margin-top:14px', textContent: t(lang, 'pasteInvite') }),
    name, invite, err, go, waiting,
    backBtn,
  )
}

/** Un perfil más: con su bóveda aquí, o conectando una que ya tienes. */
export function renderAdd (ctx) {
  const { view, lang, ask, toast, humanError, onDone } = ctx
  const name = el('input', { type: 'text', placeholder: t(lang, 'profileName') })

  const here = el('button', { className: 'primary', textContent: t(lang, 'addHere'), 'data-testid': 'add-here' })
  here.onclick = async () => {
    try { await ask('profile-add', { label: name.value.trim() || null }); onDone() } catch (e) { toast(humanError(e), 'error') }
  }

  const connect = el('button', { className: 'ghost', textContent: t(lang, 'addLinked'), 'data-testid': 'add-linked' })
  connect.onclick = () => renderLink(ctx)

  // LA TERCERA VÍA: no crear una cuenta ni conectar una bóveda, sino ENTRAR en una tuya
  // con `nombre@AB12-CD34-EF56`. Abre el GESTOR y no lo hace aquí, porque entrar sostiene
  // un socket y usa el OPAQUE del sandbox; el popup se cierra al pulsar fuera y dejaría el
  // inicio de sesión a medias en la bóveda.
  const entrar = el('button', { className: 'ghost', textContent: t(lang, 'inLink'), 'data-testid': 'add-login' })
  entrar.onclick = () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('src/manager.html') + '#view=login' })
    window.close?.()
  }

  const backBtn = el('button', { className: 'ghost', textContent: t(lang, 'back') })
  backBtn.onclick = onDone

  view.replaceChildren(
    el('h2', { textContent: t(lang, 'addProfile') }),
    name,
    here,
    el('p', { className: 'hint', textContent: t(lang, 'addHereHint') }),
    connect,
    el('p', { className: 'hint', textContent: t(lang, 'addLinkedHint') }),
    entrar,
    el('p', { className: 'hint', textContent: t(lang, 'inWhat') }),
    backBtn,
  )
  name.focus()
}
