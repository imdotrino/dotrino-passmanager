// EL WASM DE OPAQUE, en una página sandbox y detrás de un `postMessage`.
//
// Entran cadenas y salen cadenas: aquí no hay llaves guardadas, ni almacén, ni `chrome.*`
// —una página sandbox no los tiene—. Lo único que pasa por aquí que sea sensible es la
// contraseña, y pasa porque es donde se comprueba sin que nadie la vea: eso es OPAQUE.
//
// El motivo de que esté aparte está en `opaque-sandbox.html`: MV3 bloquea el WASM con su
// CSP por defecto, y una página sandbox tiene la suya, así que el permiso no se le abre a
// toda la extensión.

import { client, server, suiteId } from './vendor/opaque/index.js'

/** Lo que se puede pedir desde fuera. Lista CERRADA: nada de llamar a lo que se ocurra. */
const API = {
  'client.registrationStart': (a) => client.registrationStart(a),
  'client.registrationFinish': (a) => client.registrationFinish(a),
  'client.loginStart': (a) => client.loginStart(a),
  'client.loginFinish': (a) => client.loginFinish(a),
  'server.createSetup': () => server.createSetup(),
  'server.registrationResponse': (a) => server.registrationResponse(a),
  'server.registrationFinish': (a) => server.registrationFinish(a),
  'server.loginStart': (a) => server.loginStart(a),
  'server.loginFinish': (a) => server.loginFinish(a),
  suiteId: () => suiteId()
}

addEventListener('message', (e) => {
  const { id, fn, args } = e.data || {}
  if (!id || !API[fn]) return
  try {
    // El `code` del error CRUZA: `login-failed` y «se rompió algo» se arreglan de formas
    // distintas, y sin él al otro lado solo llega una frase.
    e.source.postMessage({ id, result: API[fn](args || {}) }, '*')
  } catch (err) {
    e.source.postMessage({ id, error: { message: err?.message || String(err), code: err?.code } }, '*')
  }
})

// El WASM se instancia con la primera llamada, no al cargar: abrir el gestor no lo paga.
parent.postMessage({ opaqueReady: true }, '*')
