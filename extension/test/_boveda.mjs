// CONVERTIR LA BÓVEDA DE LA EXTENSIÓN, que es lo primero que hace un usuario.
//
// Desde `sealed-passwords.md` §2.7 la bóveda propia guarda sobres que necesitan su copia
// de recuperación, y **sin convertir no atiende** — a propósito: servir con la llave vieja
// «mientras tanto» sería el mismo agujero con otro nombre.
//
// Vive aquí y no copiado en cada prueba porque la contraseña y el momento en que se pide
// son los mismos para todas: cinco copias serían cuatro que se quedan atrás el día que
// esto cambie.

/** La contraseña de las pruebas. Doce o más, como exige la copia de recuperación. */
export const CLAVE_BOVEDA = 'una contraseña larga de verdad'

/**
 * @param {(op:string, payload?:object) => Promise<any>} pedir  el puente al service worker
 * @param {(cond:boolean, msg:string) => void} [ok]  para que el fallo salga en la lista
 */
export async function convertirBoveda (pedir, ok = null) {
  const r = await pedir('sealed-convert', { password: CLAVE_BOVEDA })
  const bien = !r?.error
  if (ok) ok(bien, 'la bóveda se convierte al formato sellado' + (bien ? '' : ` — ${r.error.code}: ${r.error.message}`))
  else if (!bien) throw Object.assign(new Error(r.error.message || 'no se pudo convertir'), { code: r.error.code })
  return r?.result
}
