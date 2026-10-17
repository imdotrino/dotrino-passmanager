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

import { pickLang, t, errorText } from './i18n.js'
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

/** Qué pasa con las contraseñas: a cuántos aparatos se les atienden, o por qué no. */
function pintaClaves (nodo, pw) {
  nodo.replaceChildren()
  if (pw?.ok) {
    nodo.textContent = pw.devices ? t(lang, 'vtPw', pw.devices) : t(lang, 'vtPwNone')
    return
  }
  nodo.className = 'hint warn'
  nodo.textContent = t(lang, 'vtPwFail') + ' ' + errorText(lang, pw || {})
  // Falta convertir: se arregla en el gestor. En OTRA pestaña, porque salir de esta la apaga.
  if (pw?.code === 'not-sealed') {
    const ir = el('button', { className: 'btn', textContent: t(lang, 'openConvert') })
    ir.dataset.testid = 'open-convert'
    ir.onclick = () => chrome.tabs.create({ url: chrome.runtime.getURL('src/manager.html#view=convert') })
    nodo.append(' ', ir)
  }
}

async function render () {
  const estado = el('p', { className: 'hint' })
  // LAS CONTRASEÑAS que atiende esta pestaña: las mismas de la bóveda propia, no otra copia.
  const claves = el('p', { className: 'hint' })
  claves.dataset.testid = 'vt-passwords'
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
    claves.replaceChildren()
    parar.hidden = true
  }

  const alGestor = el('button', { className: 'link', textContent: t(lang, 'vtManage') })
  alGestor.onclick = () => { location.href = 'manager.html#view=logins' }

  const bk = respaldo()
  view.replaceChildren(
    el('h2', { textContent: t(lang, 'vtTitle') }),
    el('p', { className: 'hint warn', textContent: t(lang, 'vtOpen') }),
    estado,
    claves,
    lista,
    el('div', { className: 'row' }, [parar, alGestor]),
    msg,
    bk.caja
  )

  // Se enciende al abrir: para eso se abrió esta pestaña.
  estado.textContent = t(lang, 'vtStarting')
  try {
    const r = await logins.serveLogins({})
    estado.textContent = t(lang, 'vtOn')
    estado.dataset.testid = 'vt-on'
    parar.hidden = false
    pintaClaves(claves, r.passwords)
    await bk.pintaCajones()
  } catch (e) {
    estado.textContent = t(lang, 'vtFail') + ' ' + e.message
    parar.hidden = true
  }
  await pinta()
}

/**
 * EL RESPALDO de esta bóveda (dotrino-vault/docs/respaldo.md): los cajones, en un archivo
 * cifrado con una contraseña. Pantalla administrativa: cajones, contraseña y botones. Las
 * contraseñas del gestor no van aquí (`logins.js` dice por qué).
 */
function respaldo () {
  const caja = el('section', { className: 'backup' })
  caja.dataset.testid = 'vt-backup'
  const msg = el('p', { className: 'hint' })
  const errTxt = (e) => ({
    VAULT_LOCKED: t(lang, 'bkLocked'), WRONG_PASSWORD: t(lang, 'bkWrongPwd'), NOT_A_BACKUP: t(lang, 'bkNotBackup'),
    BACKUP_CORRUPT: t(lang, 'bkCorrupt'), WEAK_PASSWORD: t(lang, 'bkShort'), BACKUP_CONFLICTS: t(lang, 'bkChanged')
  })[e?.code] || e?.message || String(e)
  const nombre = (owner, device) => owner === 'ns:@me' ? t(lang, 'bkProfile')
    : owner.startsWith('ns:') ? owner.slice(3) : t(lang, 'bkDevice', device?.id || owner.slice(4, 12), device?.label || '')

  // --- exportar ---
  const elegidos = new Set()
  const cajones = el('div', { className: 'row' })
  const pw1 = el('input', { type: 'password', autocomplete: 'new-password' })
  const pw2 = el('input', { type: 'password', autocomplete: 'new-password' })
  pw1.dataset.testid = 'bk-pass'; pw2.dataset.testid = 'bk-pass2'
  const exportar = el('button', { className: 'btn', textContent: t(lang, 'bkExport') })
  exportar.dataset.testid = 'bk-export'
  const pintaCajones = async () => {
    cajones.replaceChildren()
    let lista = []
    try { lista = await logins.backupDrawers() } catch (e) { msg.textContent = errTxt(e); return }
    if (!lista.length) cajones.append(el('p', { className: 'hint', textContent: t(lang, 'bkNone') }))
    for (const d of lista) {
      const b = el('button', { className: 'btn ghost', textContent: `${nombre(d.owner, d.device)} · ${d.count}` })
      b.dataset.testid = 'bk-drawer'
      b.setAttribute('aria-pressed', 'false')
      b.onclick = () => {
        if (elegidos.has(d.owner)) elegidos.delete(d.owner); else elegidos.add(d.owner)
        b.setAttribute('aria-pressed', String(elegidos.has(d.owner)))
        b.className = elegidos.has(d.owner) ? 'btn' : 'btn ghost'
      }
      cajones.append(b)
    }
    exportar.disabled = !lista.length
  }
  exportar.onclick = async () => {
    msg.textContent = ''
    if (pw1.value.length < 12) { msg.textContent = t(lang, 'bkShort'); return }
    if (pw1.value !== pw2.value) { msg.textContent = t(lang, 'bkMismatch'); return }
    exportar.disabled = true
    try {
      const r = await logins.backupExport({ drawers: elegidos.size ? [...elegidos] : null, password: pw1.value })
      const name = `dotrino-vault-backup-${new Date().toISOString().slice(0, 10)}.json`
      const url = URL.createObjectURL(new Blob([JSON.stringify(r.file, null, 2) + '\n'], { type: 'application/json' }))
      const a = el('a', { href: url, download: name })
      document.body.append(a); a.click(); a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 10000)
      pw1.value = ''; pw2.value = ''
      msg.textContent = t(lang, 'bkSaved', name)
    } catch (e) { msg.textContent = errTxt(e) } finally { exportar.disabled = false }
  }

  // --- importar ---
  let archivo = null
  let plan = null
  let decisiones = {}
  const map = {}
  const fichero = el('input', { type: 'file', accept: '.json,application/json' })
  fichero.dataset.testid = 'bk-file'
  const pwIn = el('input', { type: 'password', autocomplete: 'off' })
  pwIn.dataset.testid = 'bk-in-pass'
  const ver = el('button', { className: 'btn ghost', textContent: t(lang, 'bkPlan') })
  ver.dataset.testid = 'bk-plan'
  const planBox = el('div', {})
  const msgIn = el('p', { className: 'hint' })
  const choques = () => (plan?.drawers || []).flatMap((d) => d.items.filter((i) => i.status === 'conflict').map((i) => `${d.to} ${i.key}`))

  const pintaPlan = () => {
    planBox.replaceChildren()
    if (!plan) return
    if (plan.passwordsLeftOut) planBox.append(el('p', { className: 'hint warn', textContent: t(lang, 'bkPwLeftOut', plan.passwordsLeftOut) }))
    const refs = choques()
    if (refs.length) {
      const todos = (how) => () => { decisiones = Object.fromEntries(refs.map((r) => [r, how])); pintaPlan() }
      const k = el('button', { className: 'btn ghost', textContent: t(lang, 'bkKeepAll') }); k.onclick = todos('keep')
      const r = el('button', { className: 'btn ghost', textContent: t(lang, 'bkReplaceAll') }); r.onclick = todos('replace')
      planBox.append(el('div', { className: 'row' }, [k, r]))
    }
    for (const d of plan.drawers) {
      const dest = d.from === d.to ? nombre(d.to, d.label) : `${nombre(d.from, d.label)} → ${nombre(d.to)}`
      const mover = el('input', { placeholder: t(lang, 'bkMovePh') })
      const moverB = el('button', { className: 'btn ghost', textContent: t(lang, 'bkMove') })
      moverB.onclick = async () => {
        const w = mover.value.trim()
        if (!w) delete map[d.from]
        else if (/^[a-z0-9-]{1,32}$/.test(w)) map[d.from] = 'ns:' + w
        else { msgIn.textContent = t(lang, 'bkBadTarget'); return }
        await planear()
      }
      planBox.append(el('h4', { textContent: dest + (d.status !== 'ok' ? ' — ' + t(lang, 'bkNoDevice') : '') }), el('div', { className: 'row' }, [mover, moverB]))
      for (const it of d.items) {
        const fila = el('div', { className: 'row' }, [el('span', { className: 'hint', textContent: t(lang, 'bkSt_' + it.status) }), el('code', { textContent: it.key })])
        fila.dataset.testid = 'bk-item'
        if (it.status === 'conflict') {
          const ref = `${d.to} ${it.key}`
          for (const how of ['keep', 'replace']) {
            const b = el('button', { className: decisiones[ref] === how ? 'btn' : 'btn ghost', textContent: t(lang, how === 'keep' ? 'bkKeep' : 'bkReplace') })
            b.onclick = () => { decisiones[ref] = how; pintaPlan() }
            fila.append(b)
          }
        }
        planBox.append(fila)
      }
    }
    const faltan = refs.filter((r) => !decisiones[r]).length
    const ir = el('button', { className: 'btn', textContent: faltan ? t(lang, 'bkUndecided', faltan) : t(lang, 'bkImport') })
    ir.dataset.testid = 'bk-import'
    ir.disabled = faltan > 0 || !plan.drawers.length
    ir.onclick = async () => {
      ir.disabled = true
      try {
        const r = await logins.backupImport({ file: archivo, password: pwIn.value, map, decisions: decisiones })
        msgIn.textContent = t(lang, 'bkImported', r.written, r.kept)
        plan = null; decisiones = {}; pwIn.value = ''
        pintaPlan(); await pintaCajones()
      } catch (e) { msgIn.textContent = errTxt(e); ir.disabled = false }
    }
    planBox.append(el('p', { className: 'hint', textContent: t(lang, 'bkCounts', plan.counts.new, plan.counts.same, plan.counts.conflict) }), ir)
  }
  const planear = async () => {
    msgIn.textContent = ''
    ver.disabled = true
    try {
      plan = await logins.backupPlan({ file: archivo, password: pwIn.value, map })
      const valid = new Set(choques())
      decisiones = Object.fromEntries(Object.entries(decisiones).filter(([k]) => valid.has(k)))
    } catch (e) { plan = null; msgIn.textContent = errTxt(e) } finally { ver.disabled = false }
    pintaPlan()
  }
  fichero.onchange = async () => {
    plan = null; decisiones = {}; pintaPlan()
    const f = fichero.files?.[0]
    try { archivo = f ? JSON.parse(await f.text()) : null } catch (_) { archivo = null; msgIn.textContent = t(lang, 'bkNotBackup') }
  }
  ver.onclick = () => { if (archivo && pwIn.value) planear() }

  caja.append(
    el('h3', { textContent: t(lang, 'bkTitle') }),
    el('p', { className: 'hint', textContent: t(lang, 'bkWhat') }),
    cajones,
    el('label', {}, [t(lang, 'bkPass'), pw1]),
    el('label', {}, [t(lang, 'bkPass2'), pw2]),
    el('div', { className: 'row' }, [exportar]),
    msg,
    el('label', {}, [t(lang, 'bkFile'), fichero]),
    el('label', {}, [t(lang, 'bkPass'), pwIn]),
    el('div', { className: 'row' }, [ver]),
    planBox,
    msgIn
  )
  return { caja, pintaCajones }
}

// Al cerrar la pestaña se cae la conexión con ella; soltarla a propósito evita dejar un
// socket a medio morir mientras el navegador recoge la página.
addEventListener('pagehide', () => { try { logins.stopServing() } catch (_) {} })

render()
wireTopbar(ask)
