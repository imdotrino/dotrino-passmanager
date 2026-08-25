// Bilingüe es/en (CONVENCIONES §9). Español neutro, tuteo, sin voseo.
const STRINGS = {
  es: {
    title: 'Dotrino',
    linkTitle: 'Enlazar con tu bóveda',
    linkHint: 'Pega aquí el código que muestra tu bóveda al ponerse a escuchar. Esta extensión no guarda tus contraseñas: se las pide a ella de una en una.',
    linkCode: 'Código de la bóveda',
    linkGo: 'Enlazar',
    myCode: 'Y autoriza esta extensión en tu bóveda con:',
    unlink: 'Desenlazar',
    badCode: 'Ese código no es válido.',
    noLink: 'Esta extensión no está enlazada a ninguna bóveda.',
    denied: 'Tu bóveda no autoriza a esta extensión todavía.',
    waiting: 'Esperando a tu bóveda…',
    noAnswer: 'Tu bóveda no respondió. ¿Está encendida?',
    search: 'Buscar',
    noneHere: 'No hay nada guardado para este sitio.',
    empty: 'La bóveda está vacía. Importa lo que ya tienes o añade una entrada.',
    fill: 'Rellenar',
    copy: 'Copiar',
    copied: 'Copiado',
    add: 'Añadir',
    importHint: 'Importar es cosa de tu bóveda: dotrino-passmanager import <archivo>',
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
    all: 'Buscar',
  },
  en: {
    title: 'Dotrino',
    linkTitle: 'Link to your vault',
    linkHint: 'Paste the code your vault shows when it starts listening. This extension does not keep your passwords: it asks the vault for them, one at a time.',
    linkCode: 'Vault code',
    linkGo: 'Link',
    myCode: 'And authorise this extension in your vault with:',
    unlink: 'Unlink',
    badCode: 'That code is not valid.',
    noLink: 'This extension is not linked to any vault.',
    denied: 'Your vault does not authorise this extension yet.',
    waiting: 'Waiting for your vault…',
    noAnswer: 'Your vault did not answer. Is it running?',
    search: 'Search',
    noneHere: 'Nothing saved for this site.',
    empty: 'The vault is empty. Import what you already have, or add an entry.',
    fill: 'Fill',
    copy: 'Copy',
    copied: 'Copied',
    add: 'Add',
    importHint: 'Importing is your vault\'s job: dotrino-passmanager import <file>',
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
    all: 'Search',
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
