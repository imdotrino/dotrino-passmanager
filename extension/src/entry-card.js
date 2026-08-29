// LA TARJETA DE UN REGISTRO, la misma en las dos pantallas.
//
// El popup y el gestor enseñan lo mismo y hacen casi lo mismo con ello (dueño,
// 2026-08-29: *«todas las acciones del modal principal deberían estar presentes en el
// manager, menos fill que no tiene sentido»*), así que la tarjeta es UNA pieza. Dos
// copias parecidas se separan a la primera corrección, y entonces la misma entrada se
// administra distinto según por dónde entres.
//
// Lo único que cambia entre pantallas son las acciones que se le pasan: sin `onFill`, no
// hay botón de rellenar — rellenar es de la página que tienes delante, y el gestor no
// tiene ninguna.
//
// Lo que la tarjeta NO hace: traerse nada privado. Enseña los valores públicos de golpe
// (`get` por claves, que no pregunta) y los privados tapados; copiar uno privado es la
// única cosa de aquí que pide autorización, y solo al pulsarla.

import { t, fieldLabel } from './i18n.js'
import { siteLabel, siteTitle } from './sites.js'
import { entryFieldValues } from './vendor/passmanager/fields.js'

function el (tag, props = {}, children = []) {
  const n = Object.assign(document.createElement(tag), props)
  for (const c of [].concat(children)) if (c) n.append(c)
  return n
}

/**
 * CÓMO SE LLAMA una entrada en una lista: el nombre que le puso el usuario, y si no, lo
 * que la bóveda calculó de su contenido (§5).
 */
export function entryName (e) {
  return e?.hint || e?.title || e?.sites?.[0] || '—'
}

/**
 * EL ORDEN DE LAS LISTAS: alfabético, y punto (dueño, 2026-08-29).
 *
 * Antes salían como las devuelve `find`: por lo bien que emparejan y, a igualdad, por lo
 * último tocado. Eso está bien para ELEGIR una —que es lo que hace el modal de un campo—
 * y mal para LEER una lista: la entrada que acabas de rozar se te mueve a la primera fila
 * y ya no está donde la dejaste. `localeCompare` para que los acentos ordenen bien.
 */
export const byName = (a, b) =>
  entryName(a).localeCompare(entryName(b), undefined, { sensitivity: 'base', numeric: true })

/** Lo que lleva una entrada. Las notas no se rellenan en ninguna parte, pero se copian. */
function keysOf (e) {
  const keys = Array.isArray(e.fieldKeys) ? [...e.fieldKeys] : []
  if (e.hasNotes && !keys.includes('notes')) keys.push('notes')
  return keys
}

/** El sitio de la tarjeta, y nada si repite lo que ya dice el nombre de arriba. */
function siteLine (lang, e) {
  const s = siteLabel(lang, e)
  return s && s !== (e.hint || '') ? s : ''
}

/**
 * EL NOMBRE, y su lápiz. El **visto** confirma: salir del campo y Enter hacen lo mismo,
 * pero no se anuncian y nadie sabe dónde pulsar.
 */
function nameCell (ctx, e, onRenamed) {
  const { lang, ask, toast, humanError, pre } = ctx
  const nombre = entryName(e)
  const linea = el('div', { className: 'name' })
  const texto = el('span', { className: 'nametext', textContent: nombre })

  const lapiz = el('button', { className: 'pencil', type: 'button', textContent: '✎', title: t(lang, 'renameEntry') })
  lapiz.setAttribute('aria-label', t(lang, 'renameEntry'))
  lapiz.dataset.testid = `${pre}-rename-${e.id}`

  lapiz.onclick = () => {
    const caja = el('input', { type: 'text', className: 'newname', value: nombre === '—' ? '' : nombre })
    caja.placeholder = t(lang, 'entryName')
    caja.dataset.testid = `${pre}-name-${e.id}`
    const visto = el('button', { className: 'ok', type: 'button', textContent: '✓', title: t(lang, 'confirmName') })
    visto.setAttribute('aria-label', t(lang, 'confirmName'))
    visto.dataset.testid = `${pre}-name-ok-${e.id}`

    let cerrado = false
    const guardar = async (aplicar) => {
      if (cerrado) return
      cerrado = true
      // Salir del campo SIN tocar nada no escribe (dueño, 2026-08-29: *«aplasto editar y
      // cancelo con el blur y pasa a estar primero en la lista»*). Escribir por escribir
      // le subía la fecha a la entrada, y con ella su sitio en cualquier lista ordenada
      // por lo último tocado. Un blur no es una decisión.
      const puesto = caja.value.trim()
      if (!aplicar || puesto === (nombre === '—' ? '' : nombre).trim()) return onRenamed(false)
      try { await ask('rename', { id: e.id, name: puesto }) } catch (err) { toast(humanError(err), 'error') }
      onRenamed(true)
    }
    caja.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') { ev.preventDefault(); guardar(true) }
      if (ev.key === 'Escape') { ev.preventDefault(); guardar(false) }
    })
    caja.addEventListener('blur', () => guardar(true))
    visto.onclick = (ev) => { ev.preventDefault(); guardar(true) }

    linea.replaceChildren(el('span', { className: 'editing' }, [caja, visto]))
    caja.focus()
    caja.select()
  }

  linea.append(texto, lapiz)
  return linea
}

/** El panel de campos: una fila por dato, con su botón de copiar. */
async function paintFields (ctx, e, panel) {
  const { lang, ask, toast, humanError, pre } = ctx
  const privadas = new Set(Array.isArray(e.privateKeys) ? e.privateKeys : [])
  const keys = keysOf(e)
  if (!keys.length) {
    panel.replaceChildren(el('p', { className: 'hint', textContent: t(lang, 'nothingForField') }))
    return
  }
  panel.replaceChildren(el('p', { className: 'hint', textContent: t(lang, 'waiting') }))

  const valores = new Map()
  const etiquetas = new Map()
  const publicas = keys.filter(k => !privadas.has(k))
  if (publicas.length) {
    try {
      const abierta = await ask('get', { id: e.id, keys: publicas })
      for (const f of entryFieldValues(abierta)) valores.set(f.key, f.value)
      if (abierta.notes) valores.set('notes', abierta.notes)
      const campos = (() => {
        if (Array.isArray(abierta.fields)) return abierta.fields
        try { return JSON.parse(abierta.fields || '[]') } catch { return [] }
      })()
      for (const c of campos) if (c?.label) etiquetas.set(c.kind || `label:${c.label}`, c.label)
    } catch (_) { /* sin valores quedan los nombres y el botón, que es lo que importa */ }
  }

  const MAX = 22
  panel.replaceChildren(...keys.map((k) => {
    const v = valores.get(k) || ''
    const vista = privadas.has(k) ? '••••••' : (v.length > MAX ? v.slice(0, MAX - 1) + '…' : v)

    const copiar = el('button', { className: 'ghost mini', textContent: t(lang, 'copyValue') })
    copiar.dataset.testid = `${pre}-copy-${e.id}-${k}`
    copiar.onclick = async () => {
      copiar.disabled = true
      try {
        // ESE campo y ninguno más. Si es privado, aquí es donde pregunta la bóveda.
        const abierta = await ask('get', { id: e.id, keys: [k] })
        const uno = entryFieldValues(abierta).find(f => f.key === k)
        const texto = k === 'notes' ? abierta.notes : uno?.value
        if (!texto) throw Object.assign(new Error('vacío'), { code: 'not-found' })
        await navigator.clipboard.writeText(String(texto))
        toast(t(lang, 'copied'))
      } catch (err) { toast(humanError(err), 'error') } finally { copiar.disabled = false }
    }

    const fila = el('div', { className: 'f' }, [
      el('span', { className: 'fk', textContent: fieldLabel(lang, k, etiquetas.get(k)) }),
      el('span', { className: 'fv', textContent: vista, title: privadas.has(k) ? '' : v }),
      copiar,
    ])
    fila.dataset.testid = `${pre}-field-${e.id}-${k}`
    return fila
  }))
}

/**
 * @param {object} ctx  `{ lang, ask, toast, humanError, pre }` — `pre` es el prefijo de
 *                      los `data-testid`, para saber en qué pantalla se está mirando.
 * @param {object} e    la vista pública de la entrada
 * @param {object} acts `{ onRenamed, onEdit, onDelete, onDefault, onFill, isDefault }`;
 *                      cada acción que falte, su botón no sale.
 */
export function entryCard (ctx, e, acts) {
  const { lang, pre } = ctx
  const { onRenamed, onEdit, onDelete, onDefault, onFill, isDefault } = acts
  const botones = []

  if (onEdit) {
    const b = el('button', { className: 'ghost', textContent: t(lang, 'edit') })
    b.dataset.testid = `${pre}-edit-${e.id}`
    b.onclick = () => onEdit(e)
    botones.push(b)
  }
  // Rellenar es de la PÁGINA que tienes delante; el gestor no tiene ninguna, así que
  // ahí no se pasa y el botón no existe (dueño, 2026-08-29).
  if (onFill) {
    const b = el('button', { className: 'ghost', textContent: t(lang, 'fill') })
    b.dataset.testid = `${pre}-fill-${e.id}`
    b.onclick = () => onFill(e)
    botones.push(b)
  }

  const del = el('button', { className: 'ghost danger', textContent: t(lang, 'del') })
  del.dataset.testid = `${pre}-del-${e.id}`
  botones.push(del)

  const marca = el('input', { type: 'checkbox', checked: !!isDefault })
  marca.dataset.testid = `${pre}-default-${e.id}`
  marca.onchange = () => onDefault(e, marca.checked)

  // La confirmación sale AQUÍ, debajo de su tarjeta, no en otra pantalla (dueño,
  // 2026-08-28): irse a una ventana nueva para contestar «sí» hace perder de vista cuál
  // de las tres entradas se estaba borrando, que es justo el dato que importa.
  const si = el('button', { className: 'danger', textContent: t(lang, 'del') })
  si.dataset.testid = `${pre}-del-yes-${e.id}`
  const no = el('button', { className: 'ghost', textContent: t(lang, 'cancel') })
  const confirmar = el('div', { className: 'confirm', hidden: true }, [
    el('span', { className: 'hint', textContent: t(lang, 'delConfirm') }), si, no,
  ])
  del.onclick = () => { confirmar.hidden = false; si.focus() }
  no.onclick = () => { confirmar.hidden = true; del.focus() }
  si.onclick = () => onDelete(e)

  // El panel va DEBAJO de los botones (dueño, 2026-08-29).
  const panel = el('div', { className: 'peek', hidden: true })
  const chevron = el('button', { className: 'chev', type: 'button', textContent: '›' })
  chevron.dataset.testid = `${pre}-peek-${e.id}`
  chevron.setAttribute('aria-expanded', 'false')
  chevron.title = t(lang, 'showFields')
  chevron.setAttribute('aria-label', t(lang, 'showFields'))

  let abierto = false
  chevron.onclick = async () => {
    abierto = !abierto
    panel.hidden = !abierto
    chevron.textContent = abierto ? '⌄' : '›'
    chevron.setAttribute('aria-expanded', String(abierto))
    chevron.title = t(lang, abierto ? 'hideFields' : 'showFields')
    if (abierto && !panel.dataset.done) { panel.dataset.done = '1'; await paintFields(ctx, e, panel) }
  }

  const li = el('li', { className: 'entry' }, [
    // ARRIBA el nombre de la entrada, ABAJO el sitio (dueño, 2026-08-29): en una lista de
    // un solo sitio, el sitio es lo que todas tienen en común y el nombre lo único que
    // las distingue.
    el('div', { className: 'head' }, [
      chevron,
      el('div', { className: 'who' }, [
        nameCell(ctx, e, onRenamed),
        el('div', { className: 'hint', textContent: siteLine(lang, e), title: siteTitle(e) }),
      ]),
    ]),
    el('div', { className: 'acts' }, [
      el('label', { className: 'def' }, [marca, el('span', { textContent: t(lang, 'byDefault') })]),
      el('div', { className: 'btns' }, botones),
    ]),
    panel,
    confirmar,
  ])
  li.dataset.testid = `${pre}-record-${e.id}`
  return li
}
