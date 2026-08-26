// Consola de APARATOS de pass.dotrino.com.
//
// Es un aparato más del ecosistema: habla con la bóveda del usuario por el proxio, con
// todo sellado, y **no puede listar credenciales** — eso es de quien tiene la llave.
// Lo que sí hace, y hoy solo se podía por consola de órdenes: ver qué aparatos hay y
// retirar el que sobre. Cada operación se aprueba en la bóveda, una por una.

import { WebSocketProxyClient, getPublicKeyJwk, signData } from 'https://cdn.jsdelivr.net/npm/@dotrino/proxy-client@0.13/+esm'
import { Identity } from 'https://cdn.jsdelivr.net/npm/@dotrino/identity@latest/+esm'
import { ProxyTransport } from 'https://cdn.jsdelivr.net/npm/@dotrino/passmanager@0.1/+esm'

const LINK = 'dotrino.passmanager.link'
const app = document.getElementById('app')

const T = {
  es: {
    loading: 'Buscando tu bóveda…',
    linkTitle: 'Enlaza esta consola con tu bóveda',
    linkHint: 'Pega el código que muestra tu bóveda al ponerse a escuchar. Esta página no guarda tus contraseñas: solo administra qué aparatos pueden pedírtelas.',
    linkGo: 'Enlazar',
    linkCode: 'Código de la bóveda',
    myCode: 'Y autoriza esta consola en tu bóveda con:',
    noCode: 'No se pudo hablar con tu bóveda de identidad para componer el código. Recarga la página.',
    devices: 'Aparatos que pueden pedir credenciales',
    none: 'No hay ningún aparato autorizado.',
    remove: 'Retirar',
    removed: 'Aparato retirado.',
    since: (d) => `desde ${d}`,
    waiting: 'Esperando a que lo apruebes en tu bóveda…',
    noAnswer: 'Tu bóveda no respondió. ¿Está encendida?',
    denied: 'Tu bóveda no lo autorizó.',
    badCode: 'Ese código no es válido.',
    warn: 'Retirar un aparato es inmediato: deja de poder pedir credenciales en su siguiente petición.',
    unlinkThis: 'Desenlazar esta consola',
  },
  en: {
    loading: 'Looking for your vault…',
    linkTitle: 'Link this console to your vault',
    linkHint: 'Paste the code your vault shows when it starts listening. This page does not keep your passwords: it only manages which devices may ask for them.',
    linkGo: 'Link',
    linkCode: 'Vault code',
    myCode: 'And authorise this console in your vault with:',
    noCode: 'Could not reach your identity vault to build the code. Reload the page.',
    devices: 'Devices that may ask for credentials',
    none: 'No authorised devices.',
    remove: 'Remove',
    removed: 'Device removed.',
    since: (d) => `since ${d}`,
    waiting: 'Waiting for you to approve it in your vault…',
    noAnswer: 'Your vault did not answer. Is it running?',
    denied: 'Your vault did not authorise it.',
    badCode: 'That code is not valid.',
    warn: 'Removing a device takes effect at once: it stops being able to ask on its next request.',
    unlinkThis: 'Unlink this console',
  },
}

let lang = (() => {
  try { const s = localStorage.getItem('dotrino-lang'); if (s === 'es' || s === 'en') return s } catch {}
  return (navigator.language || 'es').toLowerCase().startsWith('en') ? 'en' : 'es'
})()
const t = (k, ...a) => {
  const v = (T[lang] || T.es)[k] ?? T.es[k] ?? k
  return typeof v === 'function' ? v(...a) : v
}

document.addEventListener('dotrino-lang', (e) => {
  lang = e.detail?.lang === 'en' ? 'en' : 'es'
  /**
 * El botón de perfil del topbar necesita la identidad para abrir su modal (§6.1). Sin
 * esto el botón sale pero no hace nada al pulsarlo, que es peor que no tenerlo.
 */
async function cablearTopbar () {
  try {
    const bar = document.querySelector('dotrino-topbar')
    if (bar) bar.identity = await getIdentity()
  } catch { /* sin vault, el topbar se queda sin perfil y la consola lo dirá igual */ }
}

cablearTopbar()
render()
})

const el = (tag, props = {}, kids = []) => {
  const n = Object.assign(document.createElement(tag), props)
  for (const k of [].concat(kids)) if (k) n.append(k)
  return n
}

// --- identidad y transporte ---------------------------------------------------

let identity = null
let transport = null

async function getIdentity () {
  if (!identity) identity = await Identity.connect()
  return identity
}

/**
 * El sellado lo hace el VAULT: la privada de cifrado no está en esta página y no tiene
 * por qué estarlo (CONVENCIONES §4.1).
 */
const sealing = {
  async seal (msg, peerEncPub) {
    if (!peerEncPub) throw Object.assign(new Error('sin llave de cifrado'), { code: 'unsealed' })
    const id = await getIdentity()
    return { app: 'passmanager', sealed: await id.encrypt([peerEncPub], JSON.stringify(msg)), from: await id.getEncryptionPubkey() }
  },
  async open (sobre) {
    const id = await getIdentity()
    return JSON.parse(await id.decrypt(sobre.from, null, sobre.sealed))
  },
  isSealed: (m) => !!m && m.app === 'passmanager' && !!m.sealed,
}

async function connect (link) {
  if (transport) return transport
  const id = await getIdentity()
  const client = new WebSocketProxyClient({
    url: 'wss://proxy.dotrino.com',
    requireSealed: true,
    sealing,
  })
  await client.connect()
  const publickey = await getPublicKeyJwk()
  const data = { op: 'identify', publickey, token: client.token, ts: Date.now() }
  await client.identify({ data, signature: await signData(data) })

  transport = new ProxyTransport({ client, peerPubkey: link.sign, peerEncPub: link.enc })
  return transport
}

// --- el enlace ----------------------------------------------------------------

const readLink = () => { try { return JSON.parse(localStorage.getItem(LINK) || 'null') } catch { return null } }
const saveLink = (l) => localStorage.setItem(LINK, JSON.stringify(l))

async function myCode () {
  const id = await getIdentity()
  const c = { v: 1, sign: await getPublicKeyJwk(), enc: await id.getEncryptionPubkey() }
  return btoa(JSON.stringify(c)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function decodeCode (code) {
  const b64 = String(code || '').trim().replace(/-/g, '+').replace(/_/g, '/')
  const c = JSON.parse(atob(b64))
  if (c?.v !== 1 || !c.sign || !c.enc) throw new Error('bad-code')
  return c
}

function humano (e) {
  if (e?.code === 'denied') return t('denied')
  if (e?.code === 'approval-timeout') return t('noAnswer')
  if (e?.message === 'bad-code' || e?.code === 'bad-code') return t('badCode')
  return e?.message || String(e)
}

// --- vistas -------------------------------------------------------------------

async function renderLink () {
  const input = el('input', { type: 'text', placeholder: t('linkCode'), autofocus: true })
  const boton = el('button', { textContent: t('linkGo') })
  const error = el('p', { className: 'err', hidden: true })

  boton.onclick = async () => {
    try {
      saveLink(decodeCode(input.value))
      transport = null
      /**
 * El botón de perfil del topbar necesita la identidad para abrir su modal (§6.1). Sin
 * esto el botón sale pero no hace nada al pulsarlo, que es peor que no tenerlo.
 */
async function cablearTopbar () {
  try {
    const bar = document.querySelector('dotrino-topbar')
    if (bar) bar.identity = await getIdentity()
  } catch { /* sin vault, el topbar se queda sin perfil y la consola lo dirá igual */ }
}

cablearTopbar()
render()
    } catch (e) { error.textContent = humano(e); error.hidden = false }
  }
  input.onkeydown = (e) => { if (e.key === 'Enter') boton.click() }

  const code = await myCode().catch(() => null)

  // Sin código no se puede autorizar la consola en la bóveda, así que se dice POR QUÉ.
  // Un guion deja al usuario mirando la pantalla sin saber qué hacer.
  const codeNode = code
    ? el('code', { className: 'meta', textContent: code, style: 'word-break:break-all;font-size:11px' })
    : el('p', { className: 'err', textContent: t('noCode') })

  app.replaceChildren(
    el('h2', { textContent: t('linkTitle') }),
    el('p', { className: 'warn', textContent: t('linkHint') }),
    el('div', { className: 'row' }, [input, boton]),
    error,
    el('p', { className: 'loading', textContent: t('myCode') }),
    codeNode,
  )
}

async function renderDevices (link) {
  app.replaceChildren(el('p', { className: 'loading', textContent: t('waiting') }))
  let lista
  try {
    lista = await (await connect(link)).request('devices', {})
  } catch (e) {
    app.replaceChildren(
      el('h2', { textContent: t('devices') }),
      el('p', { className: 'err', textContent: humano(e) }),
      botonDesenlazar(),
    )
    return
  }

  const ul = el('ul', { className: 'devices' })
  for (const d of lista) {
    const quitar = el('button', { className: 'danger', textContent: t('remove') })
    quitar.onclick = async () => {
      quitar.disabled = true
      quitar.textContent = t('waiting')
      try {
        await transport.request('unlink', { pubkey: d.pubkey })
        /**
 * El botón de perfil del topbar necesita la identidad para abrir su modal (§6.1). Sin
 * esto el botón sale pero no hace nada al pulsarlo, que es peor que no tenerlo.
 */
async function cablearTopbar () {
  try {
    const bar = document.querySelector('dotrino-topbar')
    if (bar) bar.identity = await getIdentity()
  } catch { /* sin vault, el topbar se queda sin perfil y la consola lo dirá igual */ }
}

cablearTopbar()
render()
      } catch (e) {
        quitar.disabled = false
        quitar.textContent = t('remove')
        app.prepend(el('p', { className: 'err', textContent: humano(e) }))
      }
    }
    ul.append(el('li', { className: 'device' }, [
      el('div', {}, [
        el('div', { className: 'name', textContent: d.label || '—' }),
        el('div', { className: 'when', textContent: t('since', new Date(d.ts).toLocaleDateString(lang)) }),
        el('div', { className: 'meta', textContent: (d.pubkey || '').slice(0, 44) + '…' }),
      ]),
      quitar,
    ]))
  }

  app.replaceChildren(
    el('h2', { textContent: t('devices') }),
    // Advertencia, no explicación: sin esto alguien retira un aparato creyendo que es
    // reversible (CONVENCIONES §5.1).
    el('p', { className: 'warn', textContent: t('warn') }),
    lista.length ? ul : el('p', { className: 'empty', textContent: t('none') }),
    botonDesenlazar(),
  )
}

function botonDesenlazar () {
  const b = el('button', { className: 'danger', textContent: t('unlinkThis'), style: 'margin-top:20px' })
  b.onclick = () => { localStorage.removeItem(LINK); transport = null; /**
 * El botón de perfil del topbar necesita la identidad para abrir su modal (§6.1). Sin
 * esto el botón sale pero no hace nada al pulsarlo, que es peor que no tenerlo.
 */
async function cablearTopbar () {
  try {
    const bar = document.querySelector('dotrino-topbar')
    if (bar) bar.identity = await getIdentity()
  } catch { /* sin vault, el topbar se queda sin perfil y la consola lo dirá igual */ }
}

cablearTopbar()
render() }
  return b
}

async function render () {
  const link = readLink()
  try {
    if (!link) return renderLink()
    return renderDevices(link)
  } catch (e) {
    app.replaceChildren(el('p', { className: 'err', textContent: humano(e) }))
  }
}

/**
 * El botón de perfil del topbar necesita la identidad para abrir su modal (§6.1). Sin
 * esto el botón sale pero no hace nada al pulsarlo, que es peor que no tenerlo.
 */
async function cablearTopbar () {
  try {
    const bar = document.querySelector('dotrino-topbar')
    if (bar) bar.identity = await getIdentity()
  } catch { /* sin vault, el topbar se queda sin perfil y la consola lo dirá igual */ }
}

cablearTopbar()
render()
