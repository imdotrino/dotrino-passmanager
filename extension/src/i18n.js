// Bilingüe es/en (CONVENCIONES §9). Español neutro, tuteo, sin voseo.
const STRINGS = {
  es: {
    title: 'Dotrino',
    unlock: 'Abrir la bóveda',
    password: 'Contraseña maestra',
    create: 'Crear la bóveda',
    createHint: 'Elige la contraseña que abrirá esta bóveda. No se puede recuperar.',
    lock: 'Cerrar',
    search: 'Buscar',
    noneHere: 'No hay nada guardado para este sitio.',
    empty: 'La bóveda está vacía. Importa lo que ya tienes o añade una entrada.',
    fill: 'Rellenar',
    copy: 'Copiar',
    copied: 'Copiado',
    add: 'Añadir',
    importing: 'Importar',
    importFrom: 'Importar de 1Password, Bitwarden o Chrome',
    imported: n => `${n} entrada${n === 1 ? '' : 's'} importada${n === 1 ? '' : 's'}`,
    wrongPassword: 'Esa contraseña no abre la bóveda.',
    noForm: 'No encuentro un formulario de acceso en esta página.',
    save: 'Guardar',
    cancel: 'Cancelar',
    name: 'Nombre',
    sites: 'Sitios',
    username: 'Usuario',
    secret: 'Contraseña',
    totpLabel: 'Código de dos pasos',
    remove: 'Quitar',
    onThisSite: 'En este sitio',
    all: 'Todo',
  },
  en: {
    title: 'Dotrino',
    unlock: 'Open the vault',
    password: 'Master password',
    create: 'Create the vault',
    createHint: 'Choose the password that opens this vault. It cannot be recovered.',
    lock: 'Lock',
    search: 'Search',
    noneHere: 'Nothing saved for this site.',
    empty: 'The vault is empty. Import what you already have, or add an entry.',
    fill: 'Fill',
    copy: 'Copy',
    copied: 'Copied',
    add: 'Add',
    importing: 'Import',
    importFrom: 'Import from 1Password, Bitwarden or Chrome',
    imported: n => `${n} entr${n === 1 ? 'y' : 'ies'} imported`,
    wrongPassword: 'That password does not open the vault.',
    noForm: 'No sign-in form found on this page.',
    save: 'Save',
    cancel: 'Cancel',
    name: 'Name',
    sites: 'Sites',
    username: 'Username',
    secret: 'Password',
    totpLabel: 'Two-step code',
    remove: 'Remove',
    onThisSite: 'On this site',
    all: 'All',
  },
}

export function pickLang () {
  const stored = globalThis.localStorage?.getItem('dotrino-lang')
  if (stored === 'es' || stored === 'en') return stored
  return (navigator.language || 'es').toLowerCase().startsWith('en') ? 'en' : 'es'
}

export function t (lang, key, ...args) {
  const v = (STRINGS[lang] || STRINGS.es)[key] ?? (STRINGS.es[key] ?? key)
  return typeof v === 'function' ? v(...args) : v
}

export { STRINGS }
