// CÓMO SE DICE dónde vale un registro, en una línea.
//
// Un registro puede valer en VARIOS dominios (§4.2): la misma cuenta en `banco.com.ec` y
// en `bancoapp.com`, o una ficha de datos que no es de ningún sitio. Hasta el 2026-08-29
// las listas enseñaban `sites[0]` y punto, así que un registro que cruzaba dominios se
// veía igual que uno de un solo sitio — y no había forma de saberlo sin abrirlo.
//
// Vive aparte porque lo usan dos pantallas que no comparten nada más: el popup y el
// gestor. Dos formas de decir lo mismo acabarían diciendo cosas distintas.

import { t } from './i18n.js'

/**
 * Los sitios de un registro, para una lista: **todos, uno al lado de otro**.
 *
 * Hubo una versión que ponía `pass.dotrino.com +1`, y el dueño la tiró el 2026-08-29:
 * *«no me ahorra nada»*. Y es verdad — un `+1` obliga a abrir la ficha para saber qué es
 * ese uno, así que ahorra caracteres y cuesta un clic. Si no caben, los recorta el CSS y
 * quedan enteros en el `title`.
 *
 * Sin ninguno, se dice: «en cualquier sitio» no es un hueco, es lo que hace que una ficha
 * de datos sirva en todas partes.
 */
export function siteLabel (lang, entry) {
  const sitios = Array.isArray(entry?.sites) ? entry.sites : []
  if (!sitios.length) return entry?.title || t(lang, 'noSite')
  return sitios.join(' · ')
}

/** Todos, para el `title` que sale al pasar por encima. */
export function siteTitle (entry) {
  const sitios = Array.isArray(entry?.sites) ? entry.sites : []
  return sitios.join(' · ')
}
