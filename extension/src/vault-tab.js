// LA PESTAÑA QUE ES LA BÓVEDA.
//
// Levantar una bóveda en la extensión **abre una pestaña**, y es a propósito (dueño,
// 2026-09-19). Dos motivos, y los dos son de fondo:
//
//   · **Se ve.** Lo que está encendido tiene que saberse que está encendido. Un documento
//     oculto atendiendo en segundo plano es exactamente lo contrario de lo que promete un
//     gestor de contraseñas.
//   · **Cerrarla es apagarla.** No hay un estado escondido que haya que ir a buscar: la
//     conexión vive aquí, así que la pestaña ES el interruptor.
//
// Es la misma regla que la bóveda-pestaña del ecosistema (`vault.dotrino.com/vault`). La
// que está encendida siempre —con el navegador cerrado— es la del binario.

import { pickLang, t } from './i18n.js'
import { wireTopbar } from './profile-card.js'
import { hostApprovals } from './approval.js'
import * as logins from './logins.js'

hostApprovals()

const lang = pickLang()
const view = document.getElementById('view')

const el = (tag, props = {}, children = []) => {
  const n = Object.assign(document.createElement(tag), props)
  for (const c of [].concat(children)) if (c) n.append(c)
  return n
}

const ask = (op, payload) => new Promise((resolve, reject) => {
  chrome.runtime.sendMessage({ op, payload }, (r) => {
    if (chrome.runtime.lastError) return reject(new Error('unreachable'))
    if (r?.error) return reject(Object.assign(new Error(r.error.message || r.error.code), { code: r.error.code }))
    resolve(r?.result)
  })
})

async function render () {
  const estado = el('p', { className: 'hint' })
  const lista = el('div', { className: 'logins' })
  const msg = el('p', { className: 'hint' })

  const pinta = async () => {
    lista.replaceChildren()
    let filas = []
    try { filas = await logins.listLogins() } catch (e) { msg.textContent = e.message; return }
    if (!filas.length) {
      lista.append(el('p', { className: 'hint', textContent: t(lang, 'vtNoLogins') }))
      return
    }
    // LA DIRECCIÓN es el dato operativo: es lo que se teclea en el equipo prestado.
    for (const l of filas) {
      lista.append(el('div', { className: 'login-row' }, [
        el('div', {}, [
          el('strong', { textContent: l.user }),
          el('div', { className: 'hint' }, [el('code', { textContent: l.address || '' })]),
          el('div', { className: 'hint', textContent: t(lang, 'lgOpen', l.sessions.length) })
        ])
      ]))
    }
  }

  const parar = el('button', { className: 'btn ghost', textContent: t(lang, 'vtStop') })
  parar.onclick = () => {
    logins.stopServing()
    estado.textContent = t(lang, 'vtOff')
    parar.hidden = true
  }

  const alGestor = el('button', { className: 'link', textContent: t(lang, 'vtManage') })
  alGestor.onclick = () => { location.href = 'manager.html#view=logins' }

  view.replaceChildren(
    el('h2', { textContent: t(lang, 'vtTitle') }),
    el('p', { className: 'hint warn', textContent: t(lang, 'vtOpen') }),
    estado,
    lista,
    el('div', { className: 'row' }, [parar, alGestor]),
    msg
  )

  // Se enciende al abrir: para eso se abrió esta pestaña.
  estado.textContent = t(lang, 'vtStarting')
  try {
    const r = await logins.serveLogins({})
    estado.textContent = r.ok ? t(lang, 'vtOn') : t(lang, 'vtNothing')
    parar.hidden = !r.ok
  } catch (e) {
    estado.textContent = t(lang, 'vtFail') + ' ' + e.message
    parar.hidden = true
  }
  await pinta()
}

// Al cerrar la pestaña se cae la conexión con ella; soltarla a propósito evita dejar un
// socket a medio morir mientras el navegador recoge la página.
addEventListener('pagehide', () => { try { logins.stopServing() } catch (_) {} })

render()
wireTopbar(ask)
