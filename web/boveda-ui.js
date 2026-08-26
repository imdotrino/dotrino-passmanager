// La pantalla de la bóveda: estado, código de enlace, aparatos y lo guardado.
//
// Es ADMINISTRATIVA (CONVENCIONES §5.1): empieza por lo que se administra, sin
// presentarse. Lo único que se explica es lo que, sin decirlo, llevaría a un error —
// que al cerrar la pestaña la bóveda deja de responder.

import { arrancarBoveda } from './boveda.js?v=1'

const app = document.getElementById('app')
const dlg = document.getElementById('aprobar')

let lang = (() => {
  try { const s = localStorage.getItem('dotrino-lang'); if (s === 'es' || s === 'en') return s } catch {}
  return (navigator.language || 'es').toLowerCase().startsWith('en') ? 'en' : 'es'
})()

const T = {
  es: {
    abriendo: 'Abriendo tu bóveda…',
    activa: 'Tu bóveda está respondiendo',
    inactiva: 'La bóveda no está respondiendo',
    aviso: 'Mientras esta pestaña esté abierta, tu bóveda responde a tus aparatos. Si la cierras, dejan de poder pedir contraseñas — nada se pierde, pero no responden hasta que vuelvas a abrirla.',
    codigo: 'Pega este código en tu extensión para enlazarla:',
    copiado: 'Copiado',
    aparatos: 'Aparatos que pueden pedir credenciales',
    ninguno: 'Ninguno todavía. Enlaza tu extensión con el código de arriba.',
    autorizar: 'Y pega aquí el código que muestra la extensión:',
    autorizarBtn: 'Autorizar',
    retirar: 'Retirar',
    guardadas: 'Guardado en esta bóveda',
    vacia: 'Nada guardado. Importa lo que ya tienes desde otro gestor.',
    importar: 'Importar de 1Password, Bitwarden o Chrome',
    importadas: (n) => `${n} entrada${n === 1 ? '' : 's'} importada${n === 1 ? '' : 's'}`,
    pedir: (q) => `«${q}» pide una contraseña`,
    pedirTexto: 'Si le dices que sí, podrá pedir credenciales mientras esta bóveda siga abierta.',
    error: 'No se pudo abrir la bóveda',
    sinVault: 'Hace falta tu identidad de Dotrino. Abre profile.dotrino.com, crea tu perfil y vuelve.',
  },
  en: {
    abriendo: 'Opening your vault…',
    activa: 'Your vault is answering',
    inactiva: 'The vault is not answering',
    aviso: 'While this tab is open, your vault answers your devices. If you close it they can no longer ask for passwords — nothing is lost, but they get no answer until you open it again.',
    codigo: 'Paste this code into your extension to link it:',
    copiado: 'Copied',
    aparatos: 'Devices that may ask for credentials',
    ninguno: 'None yet. Link your extension with the code above.',
    autorizar: 'And paste here the code your extension shows:',
    autorizarBtn: 'Authorise',
    retirar: 'Remove',
    guardadas: 'Kept in this vault',
    vacia: 'Nothing kept yet. Import what you already have from another manager.',
    importar: 'Import from 1Password, Bitwarden or Chrome',
    importadas: (n) => `${n} entr${n === 1 ? 'y' : 'ies'} imported`,
    pedir: (q) => `“${q}” is asking for a password`,
    pedirTexto: 'If you say yes, it can ask for credentials while this vault stays open.',
    error: 'Could not open the vault',
    sinVault: 'Your Dotrino identity is needed. Open profile.dotrino.com, create your profile and come back.',
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
function preguntar (quien) {
  document.getElementById('aprobar-quien').textContent = t('pedir', quien)
  document.getElementById('aprobar-texto').textContent = t('pedirTexto')
  dlg.showModal()
  return new Promise(resolve => {
    const cerrar = (v) => { dlg.close(); resolve(v) }
    document.getElementById('aprobar-si').onclick = () => cerrar(true)
    document.getElementById('aprobar-no').onclick = () => cerrar(false)
    dlg.oncancel = () => resolve(false)
  })
}

let boveda = null
let ultima = null

async function pintar () {
  const lista = await boveda.aparatos()
  const guardadas = await boveda.vault.list()

  const codigo = el('code', { className: 'codigo', textContent: boveda.codigo })
  codigo.onclick = () => navigator.clipboard.writeText(boveda.codigo).then(() => {
    const antes = codigo.textContent
    codigo.textContent = t('copiado')
    setTimeout(() => { codigo.textContent = antes }, 1200)
  })

  const entrada = el('input', { type: 'text', placeholder: t('autorizarBtn') })
  const boton = el('button', { textContent: t('autorizarBtn') })
  const err = el('p', { className: 'err', hidden: true })
  boton.onclick = async () => {
    try {
      await boveda.autorizar(entrada.value, 'Extensión')
      entrada.value = ''
      pintar()
    } catch (e) { err.textContent = e.message; err.hidden = false }
  }

  const ul = el('ul', { className: 'devices' })
  for (const d of lista) {
    const quitar = el('button', { className: 'danger', textContent: t('retirar') })
    quitar.onclick = async () => { await boveda.retirar(d.pubkey); pintar() }
    ul.append(el('li', { className: 'device' }, [
      el('div', {}, [
        el('div', { className: 'name', textContent: d.label }),
        el('div', { className: 'when', textContent: new Date(d.ts).toLocaleDateString(lang) }),
      ]),
      quitar,
    ]))
  }

  const archivo = el('input', { type: 'file', accept: '.csv,.json,.txt', hidden: true })
  const importar = el('button', { className: 'ghost file', textContent: t('importar') })
  importar.onclick = () => archivo.click()
  archivo.onchange = async () => {
    const f = archivo.files?.[0]
    if (!f) return
    try {
      const { count } = await boveda.importar(await f.text())
      err.className = 'hint'
      err.textContent = t('importadas', count)
      err.hidden = false
      pintar()
    } catch (e) { err.className = 'err'; err.textContent = e.message; err.hidden = false }
  }

  app.replaceChildren(
    el('div', { className: 'estado' }, [
      el('span', { className: 'punto on' }),
      el('span', { textContent: t('activa') }),
    ]),
    // Advertencia, no explicación: sin esto alguien cierra la pestaña y no entiende por
    // qué su extensión dejó de funcionar (CONVENCIONES §5.1).
    el('p', { className: 'aviso', textContent: t('aviso') }),

    el('h2', { textContent: t('codigo') }),
    codigo,

    el('h2', { textContent: t('aparatos'), style: 'margin-top:26px' }),
    lista.length ? ul : el('p', { className: 'empty', textContent: t('ninguno') }),
    el('p', { className: 'hint', style: 'margin-top:14px', textContent: t('autorizar') }),
    el('div', { className: 'row' }, [entrada, boton]),
    err,

    el('h2', { textContent: t('guardadas'), style: 'margin-top:26px' }),
    guardadas.length
      ? el('ul', { className: 'devices' }, guardadas.map(e => el('li', { className: 'device' }, [
          el('div', {}, [
            el('div', { className: 'name', textContent: e.title || e.sites?.[0] || '—' }),
            el('div', { className: 'when', textContent: (e.sites || []).join(' ') || 'cualquier sitio' }),
          ]),
          el('span', { className: 'when', textContent: [e.hasSecret && '🔑', e.hasTotp && '2FA', e.hasFields && '+'].filter(Boolean).join(' ') }),
        ])))
      : el('p', { className: 'empty', textContent: t('vacia') }),
    importar, archivo,

    ultima ? el('p', { className: 'peticion', style: 'margin-top:20px', textContent: ultima }) : null,
  )
}

try {
  boveda = await arrancarBoveda({
    onAprobar: preguntar,
    onPeticion: (r) => {
      ultima = `${new Date(r.ts).toLocaleTimeString(lang)} · ${r.op} · ${r.outcome}`
      pintar().catch(() => {})
    },
  })
  await pintar()
} catch (e) {
  app.replaceChildren(
    el('div', { className: 'estado' }, [el('span', { className: 'punto' }), el('span', { textContent: t('inactiva') })]),
    el('p', { className: 'err', textContent: t('error') + ': ' + (e?.message || e) }),
    el('p', { className: 'hint', textContent: t('sinVault') }),
  )
}
