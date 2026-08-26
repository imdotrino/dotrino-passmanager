// El sellado extremo a extremo vive en el PILAR del transporte
// (`@dotrino/proxy-client/sealing`, desde 0.13.0), no aquí.
//
// Se escribió primero en este repo y se movió en cuanto quedó claro que la garantía
// —que lo del usuario no llegue a los servidores de Dotrino, ni de paso— no puede ser
// de una sola app. Este módulo queda como el punto por el que pasa el gestor, para no
// repetir el import por todos lados.

export {
  seal, open, isSealed,
  makeEncKeypair, importEncPrivate, exportEncPrivate,
  setSealingPrimitives,
} from '@dotrino/proxy-client/sealing'
