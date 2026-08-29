/**
 * El contrato que consumen la extensión, la consola web y la app nativa. Quién esté
 * detrás (el vault del PC, el teléfono, o la caché local) es intercambiable — esa es
 * la razón de que exista esta interfaz y no se lea el almacén directamente
 * (DISENO §6.1).
 *
 *   find(url)  → [publicView]   qué hay para este sitio. SIN secretos: sirve para
 *                               elegir entre varias cuentas, no para usarlas.
 *   get(id)    → entrada abierta   UNA credencial. Puede exigir aprobación.
 *   put(entry) → publicView     crear o actualizar. Exige una bóveda de verdad.
 *   search(q)  → [publicView]   buscar por texto en TODA la bóveda, con tope. Exige un
 *                               término que escribe una persona; no es `list`.
 *   remove(id) → void           quitarla. La borra quien la tiene, no quien la pide.
 *   list()     → [publicView]   la bóveda entera. Exige la CEK.
 *
 * `list` no está para la extensión: si pudiera listarlo todo, el "pide de a una"
 * (DISENO §2) sería decorativo.
 *
 * Toda implementación expone además:
 *   capabilities → { canWrite, canList, needsApproval }
 */
export const VaultSource = {
  async find (_url) { throw new Error('not implemented') },
  async get (_id) { throw new Error('not implemented') },
  async put (_entry) { throw new Error('not implemented') },
  async search (_q, _opts) { throw new Error('not implemented') },
  async remove (_id) { throw new Error('not implemented') },
  async list () { throw new Error('not implemented') },
}
