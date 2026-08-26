// La pantalla de la bóveda: estado, código de enlace, aparatos y lo guardado.
//
// Es ADMINISTRATIVA (CONVENCIONES §5.1): empieza por lo que se administra, sin
// presentarse. Lo único que se explica es lo que, sin decirlo, llevaría a un error —
// que al cerrar la pestaña la bóveda deja de responder.

import { startVault } from './vault-in-tab.js?v=1'

const app = document.getElementById('app')
const dlg = document.getElementById('aprobar')

let lang = (() => {
  try { const s = localStorage.getItem('dotrino-lang'); if (s === 'es' || s === 'en') return s } catch {}
  return (navigator.language || 'es').toLowerCase().startsWith('en') ? 'en' : 'es'
})()

const T = {
  es: {
    opening: 'Abriendo tu bóveda…',
    active: 'Tu bóveda está respondiendo',
    inactive: 'La bóveda no está respondiendo',
    warning: 'Mientras esta pestaña esté abierta, tu bóveda responde a tus aparatos. Si la cierras, dejan de poder pedir contraseñas — nada se pierde, pero no responden hasta que vuelvas a abrirla.',
    code: 'Pega este código en tu extensión para enlazarla:',
    copied: 'Copiado',
    devices: 'Aparatos que pueden pedir credenciales',
    none: 'Ninguno todavía. Enlaza tu extensión con el código de arriba.',
    authorise: 'Y pega aquí el código que muestra la extensión:',
    authoriseBtn: 'Autorizar',
    removeDevice: 'Retirar',
    entries: 'Guardado en esta bóveda',
    empty: 'Nada guardado. Importa lo que ya tienes desde otro gestor.',
    importEntries: 'Importar de 1Password, Bitwarden o Chrome',
    imported: (n) => `${n} input${n === 1 ? '' : 's'} importada${n === 1 ? '' : 's'}`,
    asking: (q) => `«${q}» pide una contraseña`,
    askingText: 'Si le dices que sí, podrá pedir credenciales mientras esta bóveda siga abierta.',
    error: 'No se pudo abrir la bóveda',
    noIdentity: 'Hace falta tu identidad de Dotrino. Abre profile.dotrino.com, crea tu perfil y vuelve.',
  },
  en: {
    opening: 'Opening your vault…',
    active: 'Your vault is answering',
    inactive: 'The vault is not answering',
    warning: 'While this tab is open, your vault answers your devices. If you close it they can no longer ask for passwords — nothing is lost, but they get no answer until you open it again.',
    code: 'Paste this code into your extension to link it:',
    copied: 'Copied',
    devices: 'Devices that may ask for credentials',
    none: 'None yet. Link your extension with the code above.',
    authorise: 'And paste here the code your extension shows:',
    authoriseBtn: 'Authorise',
    removeDevice: 'Remove',
    entries: 'Kept in this vault',
    empty: 'Nothing kept yet. Import what you already have from another manager.',
    importEntries: 'Import from 1Password, Bitwarden or Chrome',
    imported: (n) => `${n} entr${n === 1 ? 'y' : 'ies'} imported`,
    asking: (q) => `“${q}” is asking for a password`,
    askingText: 'If you say yes, it can ask for credentials while this vault stays open.',
    error: 'Could not open the vault',
    noIdentity: 'Your Dotrino identity is needed. Open profile.dotrino.com, create your profile and come back.',
  },
}
const t = (k, ...a) => {
  const v = (T[lang] || T.es)[k] ?? T.es[k] ?? k
  return typeof v === 'function' ? v(...a) : v
}

const el = (tag, props = {}, kids = []) => {
  const n = Object.assign(document.createElement(tag), props)
  for (const k of [].concat(kids)) if (k) n.append(k)
  return n
}

/** Pregunta de aprobación: un diálogo de verdad, no un `confirm` (CONVENCIONES §5). */
function askUser (who) {
  document.getElementById('aprobar-who').textContent = t('asking', who)
  document.getElementById('aprobar-texto').textContent = t('askingText')
  dlg.showModal()
  return new Promise(resolve => {
    const close = (v) => { dlg.close(); resolve(v) }
    document.getElementById('aprobar-si').onclick = () => close(true)
    document.getElementById('aprobar-no').onclick = () => close(false)
    dlg.oncancel = () => resolve(false)
  })
}

let vault = null
let lastRequest = null

async function render () {
  const list = await vault.devices()
  const entries = await vault.vault.list()

  const code = el('code', { className: 'code', textContent: vault.code })
  code.onclick = () => navigator.clipboard.writeText(vault.code).then(() => {
    const before = code.textContent
    code.textContent = t('copied')
    setTimeout(() => { code.textContent = before }, 1200)
  })

  const input = el('input', { type: 'text', placeholder: t('authoriseBtn') })
  const button = el('button', { textContent: t('authoriseBtn') })
  const err = el('p', { className: 'err', hidden: true })
  button.onclick = async () => {
    try {
      await vault.authorise(input.value, 'Extensión')
      input.value = ''
      render()
    } catch (e) { err.textContent = e.message; err.hidden = false }
  }

  const ul = el('ul', { className: 'devices' })
  for (const d of list) {
    const removeBtn = el('button', { className: 'danger', textContent: t('removeDevice') })
    removeBtn.onclick = async () => { await vault.removeDevice(d.pubkey); render() }
    ul.append(el('li', { className: 'device' }, [
      el('div', {}, [
        el('div', { className: 'name', textContent: d.label }),
        el('div', { className: 'when', textContent: new Date(d.ts).toLocaleDateString(lang) }),
      ]),
      removeBtn,
    ]))
  }

  const file = el('input', { type: 'file', accept: '.csv,.json,.txt', hidden: true })
  const importEntries = el('button', { className: 'ghost file', textContent: t('importEntries') })
  importEntries.onclick = () => file.click()
  file.onchange = async () => {
    const f = file.files?.[0]
    if (!f) return
    try {
      const { count } = await vault.importEntries(await f.text())
      err.className = 'hint'
      err.textContent = t('imported', count)
      err.hidden = false
      render()
    } catch (e) { err.className = 'err'; err.textContent = e.message; err.hidden = false }
  }

  app.replaceChildren(
    el('div', { className: 'estado' }, [
      el('span', { className: 'punto on' }),
      el('span', { textContent: t('active') }),
    ]),
    // Advertencia, no explicación: sin esto alguien cierra la pestaña y no entiende por
    // qué su extensión dejó de funcionar (CONVENCIONES §5.1).
    el('p', { className: 'aviso', textContent: t('warning') }),

    el('h2', { textContent: t('code') }),
    code,

    el('h2', { textContent: t('devices'), style: 'margin-top:26px' }),
    list.length ? ul : el('p', { className: 'empty', textContent: t('none') }),
    el('p', { className: 'hint', style: 'margin-top:14px', textContent: t('authorise') }),
    el('div', { className: 'row' }, [input, button]),
    err,

    el('h2', { textContent: t('entries'), style: 'margin-top:26px' }),
    entries.length
      ? el('ul', { className: 'devices' }, entries.map(e => el('li', { className: 'device' }, [
          el('div', {}, [
            el('div', { className: 'name', textContent: e.title || e.sites?.[0] || '—' }),
            el('div', { className: 'when', textContent: (e.sites || []).join(' ') || 'cualquier sitio' }),
          ]),
          el('span', { className: 'when', textContent: [e.hasSecret && '🔑', e.hasTotp && '2FA', e.hasFields && '+'].filter(Boolean).join(' ') }),
        ])))
      : el('p', { className: 'empty', textContent: t('empty') }),
    importEntries, file,

    lastRequest ? el('p', { className: 'peticion', style: 'margin-top:20px', textContent: lastRequest }) : null,
  )
}

try {
  vault = await startVault({
    onApprove: askUser,
    onRequest: (r) => {
      lastRequest = `${new Date(r.ts).toLocaleTimeString(lang)} · ${r.op} · ${r.outcome}`
      render().catch(() => {})
    },
  })
  await render()
} catch (e) {
  app.replaceChildren(
    el('div', { className: 'estado' }, [el('span', { className: 'punto' }), el('span', { textContent: t('inactive') })]),
    el('p', { className: 'err', textContent: t('error') + ': ' + (e?.message || e) }),
    el('p', { className: 'hint', textContent: t('noIdentity') }),
  )
}
