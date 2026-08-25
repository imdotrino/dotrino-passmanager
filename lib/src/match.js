// Emparejamiento de una entrada con el sitio que el usuario tiene delante.
//
// Es la pieza de la que depende la seguridad del autocompletado: emparejar de más
// entrega una credencial al sitio equivocado. Por eso todo se compara por ETIQUETAS
// de dominio, nunca por sufijo de cadena — `evil-salesforce.com` termina en
// `salesforce.com` como texto y no tiene nada que ver con él.

// Sufijos públicos de dos etiquetas más comunes. NO es la Public Suffix List entera
// (son miles de reglas y varios cientos de KB); es la aproximación que cubre el caso
// real. Deuda anotada: cargar la PSL de verdad cuando el autocompletado esté maduro.
// Mientras tanto un sufijo desconocido solo hace el emparejamiento MÁS estricto, que
// es el lado seguro por el que fallar.
const TWO_LABEL_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'me.uk', 'net.uk', 'sch.uk',
  'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au', 'id.au',
  'com.br', 'net.br', 'org.br', 'gov.br',
  'com.ec', 'net.ec', 'org.ec', 'gob.ec', 'edu.ec', 'fin.ec', 'med.ec',
  'com.ar', 'net.ar', 'org.ar', 'gob.ar', 'edu.ar',
  'com.mx', 'net.mx', 'org.mx', 'gob.mx', 'edu.mx',
  'com.co', 'net.co', 'org.co', 'gov.co', 'edu.co',
  'co.jp', 'ne.jp', 'or.jp', 'ac.jp', 'go.jp',
  'com.cn', 'net.cn', 'org.cn', 'gov.cn', 'edu.cn',
  'co.nz', 'net.nz', 'org.nz', 'govt.nz',
  'co.za', 'org.za', 'net.za',
  'com.tr', 'com.tw', 'com.hk', 'com.sg', 'com.my', 'com.pe', 'com.uy',
  'com.ve', 'com.py', 'com.bo', 'com.do', 'com.gt', 'com.pa', 'com.pl',
  'com.es', 'com.pt', 'com.ua', 'com.ru', 'com.vn', 'com.ph',
])

/** Extrae el host de una URL o de algo que ya es un host. Devuelve '' si no vale. */
export function hostOf (input) {
  if (typeof input !== 'string') return ''
  let s = input.trim().toLowerCase()
  if (!s) return ''
  if (!s.includes('://')) s = 'https://' + s
  let u
  try { u = new URL(s) } catch { return '' }
  // Solo esquemas web: un `javascript:` o un `file:` no tienen sitio con el que emparejar.
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return ''
  return u.hostname.replace(/\.$/, '')
}

/** Dominio registrable (eTLD+1 aproximado). Para una IP o un host raro, el host tal cual. */
export function registrableDomain (host) {
  if (!host) return ''
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(':')) return host
  const parts = host.split('.')
  if (parts.length <= 2) return host
  const lastTwo = parts.slice(-2).join('.')
  if (TWO_LABEL_SUFFIXES.has(lastTwo)) return parts.slice(-3).join('.')
  return lastTwo
}

/** ¿`host` es igual a `base` o un subdominio suyo? Compara por etiquetas. */
export function isSameOrSubdomainOf (host, base) {
  if (!host || !base) return false
  if (host === base) return true
  return host.endsWith('.' + base)
}

export const MATCH = { EXACT: 3, SUBDOMAIN: 2, DOMAIN: 1, NONE: 0 }

/**
 * Compara UN patrón de `sites` con el host actual.
 * Patrones admitidos: `ejemplo.com`, `*.ejemplo.com`, o una URL entera.
 */
export function matchSite (pattern, currentHost) {
  if (!currentHost) return MATCH.NONE
  let p = String(pattern || '').trim().toLowerCase()
  if (!p) return MATCH.NONE

  let wildcard = false
  if (p.startsWith('*.')) { wildcard = true; p = p.slice(2) }

  const base = hostOf(p)
  if (!base) return MATCH.NONE

  if (wildcard) return isSameOrSubdomainOf(currentHost, base) ? MATCH.SUBDOMAIN : MATCH.NONE
  if (currentHost === base) return MATCH.EXACT
  if (isSameOrSubdomainOf(currentHost, base)) return MATCH.SUBDOMAIN
  // Último recurso: mismo dominio registrable (login.empresa.com ↔ empresa.com).
  const rd = registrableDomain(currentHost)
  if (rd && rd === registrableDomain(base)) return MATCH.DOMAIN
  return MATCH.NONE
}

/** Mejor nivel de emparejamiento de una entrada con la URL actual. */
export function matchEntry (entry, url) {
  const host = hostOf(url)
  if (!host) return MATCH.NONE
  let best = MATCH.NONE
  for (const s of entry?.sites || []) {
    const m = matchSite(s, host)
    if (m > best) best = m
    if (best === MATCH.EXACT) break
  }
  return best
}

/** Entradas que sirven para esta URL, de mejor a peor emparejamiento. */
export function findForUrl (entries, url) {
  return (entries || [])
    .map(e => ({ entry: e, match: matchEntry(e, url) }))
    .filter(x => x.match > MATCH.NONE)
    .sort((a, b) => b.match - a.match || (b.entry.updatedAt || 0) - (a.entry.updatedAt || 0))
}
