// La pregunta de la bóveda cuando NO hay ninguna pantalla de la extensión delante: un
// sitio pide una contraseña (una passkey, por ejemplo) sin popup ni modal abierto, y la
// pregunta tiene que salir en alguna parte.
//
// Es una ventana de la extensión, con su origen: la página que pidió no la ve, no la
// puede pulsar y no puede fingirla. Dibuja exactamente lo mismo que las demás pantallas
// —el mismo módulo— y se cierra al contestar.
//
// Cerrarla sin contestar es decir que no: el service worker ve caerse el puerto y lo
// trata como una negativa, que es lo que nunca se recuerda.

import { hostApprovals } from './approval.js'

hostApprovals({ standalone: true, onAnswer: () => window.close() })
