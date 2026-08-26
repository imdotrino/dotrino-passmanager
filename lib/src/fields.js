// Campos sueltos para rellenar formularios: correo, teléfono, dirección, cédula, lo
// que sea. Son del usuario y no de un sitio concreto.
//
// Dos ideas, y las dos son deliberadamente simples:
//
// 1. **Los campos son libres.** Una lista de `{ label, value, kind }`, no un formulario
//    fijo. Cada quien guarda lo que necesita rellenar, y puede tener varios juegos —
//    la dirección de casa y la del trabajo son dos entradas, no dos campos.
//
// 2. **Cross-domain es no tener sitios**, no un tipo aparte. Una entrada sin `sites`
//    sirve en cualquier parte; con `sites`, solo ahí. Eso vale para cualquier tipo de
//    entrada, y así no hay dos reglas de emparejamiento que mantener.
//
// `kind` es opcional y solo sirve para el relleno automático: dice QUÉ ES el dato
// (un correo, un teléfono), para poder ponerlo en el hueco que le corresponde. Sin
// `kind`, el campo se guarda y se copia igual — solo no se rellena solo.

/** Clases de dato que el relleno automático sabe colocar. */
export const KINDS = [
  'email', 'tel', 'given-name', 'family-name', 'full-name',
  'street-address', 'city', 'region', 'postal-code', 'country',
  'organization', 'birthday', 'id-number', 'other',
]

/** Tokens de `autocomplete` del estándar HTML. Cuando el sitio los declara, mandan. */
export const AUTOCOMPLETE_BY_KIND = {
  email: ['email'],
  tel: ['tel', 'tel-national', 'tel-local'],
  'given-name': ['given-name'],
  'family-name': ['family-name'],
  'full-name': ['name'],
  'street-address': ['street-address', 'address-line1'],
  city: ['address-level2'],
  region: ['address-level1'],
  'postal-code': ['postal-code'],
  country: ['country', 'country-name'],
  organization: ['organization'],
  birthday: ['bday'],
}

/** Pistas por nombre/id/etiqueta, para los sitios que no declaran `autocomplete`. */
export const HINTS_BY_KIND = {
  email: ['email', 'correo', 'e-mail', 'mail'],
  tel: ['phone', 'telefono', 'teléfono', 'celular', 'movil', 'móvil', 'mobile', 'tel'],
  'given-name': ['firstname', 'first-name', 'first_name', 'givenname', 'nombre', 'nombres', 'fname'],
  'family-name': ['lastname', 'last-name', 'last_name', 'surname', 'apellido', 'apellidos', 'lname'],
  'full-name': ['fullname', 'full-name', 'nombrecompleto'],
  'street-address': ['address', 'direccion', 'dirección', 'street', 'calle', 'domicilio'],
  city: ['city', 'ciudad', 'localidad'],
  region: ['state', 'province', 'provincia', 'region', 'estado'],
  'postal-code': ['zip', 'zipcode', 'postal', 'postcode'],
  country: ['country', 'pais', 'país'],
  organization: ['company', 'empresa', 'organization', 'organizacion'],
  'id-number': ['cedula', 'cédula', 'dni', 'nif', 'rut', 'curp', 'documento'],
}

/** Normaliza la lista de campos de una entrada. */
export function normalizeFields (fields) {
  if (!Array.isArray(fields)) return []
  return fields
    .filter(f => f && (f.label || f.value))
    .map(f => ({
      label: String(f.label || '').trim(),
      value: String(f.value ?? ''),
      kind: KINDS.includes(f.kind) ? f.kind : undefined,
    }))
}

/** ¿Esta entrada sirve en cualquier sitio? Sin sitios, sí. */
export function isCrossDomain (entry) {
  return !entry?.sites?.length
}

/** El primer campo de esa clase. */
export function fieldOfKind (entry, kind) {
  return (entry?.fields || []).find(f => f.kind === kind) || null
}

/** Un valor por etiqueta, para cuando se sabe qué se busca. */
export function fieldValue (entry, label) {
  const f = (entry?.fields || []).find(x => x.label === label)
  return f ? f.value : ''
}
