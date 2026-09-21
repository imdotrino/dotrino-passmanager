// EL PUENTE al OPAQUE que corre en la página sandbox.
//
// Ofrece los mismos `client` y `server` de `@dotrino/opaque`, con una diferencia que se
// nota y está asumida: **son asíncronos**, porque cada llamada cruza un `postMessage`. Por
// eso el mostrador (`createLoginDesk`) acepta que le inyecten el OPAQUE: en el binario y en
// la pestaña es el de casa y va en el mismo hilo; aquí vive al otro lado de una frontera.
//
// La frontera existe para no abrirle la CSP a toda la extensión: solo la página sandbox
// puede instanciar WebAssembly, y es lo único que hay dentro.

const SANDBOX = 'opaque-sandbox.html'

let marco = null
let listo = null
let n = 0
const pendientes = new Map()

function montar () {
  if (listo) return listo
  marco = document.createElement('iframe')
  marco.src = SANDBOX
  marco.hidden = true
  marco.setAttribute('aria-hidden', 'true')
  listo = new Promise((resolve) => {
    addEventListener('message', (e) => {
      if (e.source !== marco?.contentWindow) return   // solo lo que sale de NUESTRO marco
      if (e.data?.opaqueReady) return resolve()
      const p = pendientes.get(e.data?.id)
      if (!p) return
      pendientes.delete(e.data.id)
      if (e.data.error) return p.reject(Object.assign(new Error(e.data.error.message), { code: e.data.error.code }))
      p.resolve(e.data.result)
    })
    document.body.append(marco)
  })
  return listo
}

async function llamar (fn, args) {
  await montar()
  const id = 'o' + (++n)
  return new Promise((resolve, reject) => {
    pendientes.set(id, { resolve, reject })
    marco.contentWindow.postMessage({ id, fn, args }, '*')
  })
}

export const client = {
  registrationStart: (a) => llamar('client.registrationStart', a),
  registrationFinish: (a) => llamar('client.registrationFinish', a),
  loginStart: (a) => llamar('client.loginStart', a),
  loginFinish: (a) => llamar('client.loginFinish', a)
}

export const server = {
  // El mostrador le pregunta la suite a QUIEN CALCULA (`createLoginDesk`); sin esto caía al
  // OPAQUE de casa, que en la extensión no existe, y dar de alta un aparato de usuario y
  // contraseña reventaba con «opaque: inject it».
  suiteId: () => llamar('suiteId', {}),
  createSetup: () => llamar('server.createSetup', {}),
  registrationResponse: (a) => llamar('server.registrationResponse', a),
  registrationFinish: (a) => llamar('server.registrationFinish', a),
  loginStart: (a) => llamar('server.loginStart', a),
  loginFinish: (a) => llamar('server.loginFinish', a)
}

export const suiteId = () => llamar('suiteId', {})
