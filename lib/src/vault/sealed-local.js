// LA BÓVEDA SELLADA CUANDO QUIEN GUARDA Y QUIEN LEE SON EL MISMO PROCESO.
//
// `SealedVault` es el aparato hablando con una bóveda que está al otro lado de un
// transporte. Esto es el otro caso, y existe de verdad en dos sitios del ecosistema:
//
//   · **`dotrino-passmanager serve`** — el mismo proceso atiende por el proxio y es
//     también la línea de comandos con la que el dueño mira lo suyo;
//   · **la bóveda de dentro de la extensión** — no hay nadie más a quien preguntar.
//
// En los dos, quien lee lo hace con UNA envoltura: la de `#recovery` (el dueño con su
// contraseña) o la del propio aparato. Se le dice cuál al construirla y no se adivina:
// adivinarlo sería leer con la que hubiera, y entonces «no puedo abrir esto» y «esto no es
// para mí» se verían igual.
//
// Cumple el contrato de siempre (`./interface.js`) para que nada de lo que hay encima
// tenga que aprender otra forma de pedir las cosas.

import { VaultError, CODES } from './errors.js'
import { findForUrl } from '../match.js'
import { siteIndex } from '../sealed/keys.js'
import { buildSealedEntry, openSealedEntry, openSealedView } from '../sealed/device.js'

export class SealedLocalVault {
  /**
   * @param {SealedStore} sealed  el almacén de sobres
   * @param {object} opts
   *   `readerPub`   con qué envoltura se lee: `RECOVERY` o la pública de este aparato
   *   `openSealed({ wrap, envelope })` abre un sobre. La privada no sale de donde viva.
   *   `author`      `{ publickey, sign(body) }` quien firma lo que se escribe
   *   `recipients()` → `{ recoveryPub, main, passkeys }` a quién se le envuelve
   *   `keys()`      → las llaves del perfil (`profileKeys`), para huellas y resúmenes
   */
  constructor (sealed, { readerPub, openSealed, author, recipients, keys } = {}) {
    if (!sealed) throw new Error('SealedLocalVault: missing the sealed store')
    if (!readerPub) throw new Error('SealedLocalVault: say which wrap this one reads with')
    for (const n of ['openSealed', 'author', 'recipients', 'keys']) {
      if (!arguments[1]?.[n]) throw new Error(`SealedLocalVault: missing ${n}`)
    }
    this.sealed = sealed
    this.readerPub = readerPub
    this.openSealed = openSealed
    this.author = author
    this.recipients = recipients
    this.keys = keys
  }

  get capabilities () {
    // `canList` es `true` y aquí sí es verdad: quien pregunta es el dueño en su propia
    // máquina, no un aparato pidiendo por el proxio. Lo que no existe en remoto sigue sin
    // existir — esto no se asoma por ningún transporte.
    return { canWrite: true, canList: true, needsApproval: false, sealed: true }
  }

  /** Las vistas, abiertas. Es lo que se enseña en una lista: sin valores privados. */
  async list () {
    const vistas = await this.sealed.views({ pub: this.readerPub })
    const out = []
    for (const v of vistas) {
      out.push(await openSealedView({ ...v, openSealed: this.openSealed }))
    }
    return out
  }

  /**
   * Lo que hay para una URL, ya ORDENADO por lo bien que casa: las entradas, no los pares
   * `{entry, match}` de `findForUrl`. Es la misma forma que devuelve `SealedVault.find`,
   * y tiene que serlo — quien llama no debería notar de qué bóveda le están contestando.
   */
  async find (url) {
    return findForUrl(await this.list(), url).map((x) => x.entry)
  }

  /** Los dominios que hay guardados, para llegar a uno sin adivinar qué escribir. */
  async sites () {
    const todas = await this.list()
    return [...new Set(todas.flatMap((e) => e.sites || []))].sort()
  }

  async search (texto) {
    const q = String(texto || '').trim().toLowerCase()
    if (!q) return []
    return (await this.list()).filter((e) =>
      (e.title || '').toLowerCase().includes(q) || (e.sites || []).some((s) => s.toLowerCase().includes(q)))
  }

  /** Una entrada ENTERA, o solo los campos que se pidan. */
  async get (id, { keys = null } = {}) {
    let got
    try { got = await this.sealed.get(id, { pub: this.readerPub, keys }) }
    catch (e) {
      if (e?.code === 'not-found') throw new VaultError(CODES.NOT_FOUND, 'no hay ninguna entrada con ese id')
      // «no me la envolvieron a mí» no es «no existe», y confundirlas manda a buscar el
      // problema al sitio equivocado.
      if (e?.code === 'not-yours') throw new VaultError(CODES.NOT_ALLOWED, 'esta punta no tiene llave para esa entrada')
      throw e
    }
    return openSealedEntry({ got, openSealed: this.openSealed })
  }

  /**
   * GUARDAR. Se cierra aquí y sale cerrado: la entrada se cifra, su llave se envuelve a
   * los destinatarios que diga el acta AHORA y el conjunto va firmado.
   *
   * Los destinatarios se piden en cada escritura y no se cachean: un aparato que acaba de
   * entrar tiene que poder leer lo siguiente que se guarde.
   */
  async put (entry) {
    const sobre = await buildSealedEntry({
      plain: entry,
      keys: await this.keys(),
      recipients: await this.recipients(),
      author: this.author
    })
    await this.sealed.putSealed(sobre)
    // La VISTA, como devuelve `LocalVault.put`: quien llama enseña el nombre de lo que
    // acaba de guardar. Devolver solo el id dejaba un «Guardada: undefined» en la CLI.
    return { id: sobre.entry.id, title: entry.title || '', sites: entry.sites || [] }
  }

  /**
   * Cambiar unos campos. Se hace leyendo y volviendo a escribir porque aquí quien lee y
   * quien escribe son el mismo: no hay nada que ahorrar ocultándose un valor a sí mismo.
   * (En remoto SÍ lo hay, y por eso allí existe `patchSealed`.)
   */
  async patch (id, changes = {}) {
    const actual = await this.get(id)
    return this.put({ ...actual, ...changes, id })
  }

  async remove (id) { return this.sealed.remove(id) }

  /** La huella de un sitio, por si quien llama quiere preguntar por ella directamente. */
  async siteIndexOf (site) {
    const { kidx } = await this.keys()
    return siteIndex(kidx, site)
  }
}

export default { SealedLocalVault }
