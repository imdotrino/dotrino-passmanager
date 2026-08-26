// Los errores cruzan procesos (extensión ↔ vault ↔ teléfono), así que se comprueban
// por `e.code`, NUNCA por el texto: traducir un mensaje que alguien empareja por
// regex lo rompe en silencio. El mensaje es para el humano; el código, para el código.

export class VaultError extends Error {
  constructor (code, message) {
    super(message || code)
    this.name = 'VaultError'
    this.code = code
  }
}

export const CODES = {
  LOCKED: 'locked',                 // la bóveda está cerrada
  NO_KEY: 'no-key',                 // este aparato no tiene la CEK (extensión, por diseño)
  READ_ONLY: 'read-only',           // caché local: puede leer, no escribir
  NOT_FOUND: 'not-found',
  DENIED: 'denied',                 // la política dijo que no
  APPROVAL_TIMEOUT: 'approval-timeout', // nadie aprobó desde el teléfono
  UNREACHABLE: 'unreachable',       // no hay bóveda al otro lado
  UNSEALED: 'unsealed',             // llegó (o iba a salir) sin cifrar: NO se acepta
  UNDECIPHERABLE: 'undecipherable', // sellado, pero no para mí
}
