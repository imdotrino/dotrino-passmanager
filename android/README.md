# Contraseñas para Android

La versión nativa del gestor de contraseñas de Dotrino (`com.dotrino.passmanager`).
Diseño: [`../docs/DISENO.md`](../docs/DISENO.md) §6.3. Uso: <https://wiki.dotrino.com/>.

```
app/src/main/java/com/dotrino/passmanager/
  core/           el puerto de lib/src/sealed y lib/src/vault/sealed.js (sin Android dentro)
  Passmanager.kt  el arranque: perfil del teléfono → bóveda
  MainActivity.kt la lista, la búsqueda y copiar
  Sheets.kt       el detalle y el editor
app/src/debug/    SOLO depuración: arrancar contra la bóveda de prueba, con llaves en software
```

`../native` es el submódulo `dotrino-native` (`git submodule update --init`).

## Pruebas

```sh
(cd ../lib && npm install)             # la librería JS contra la que se prueba
./gradlew :app:testDebugUnitTest       # BridgeTest, VaultE2eTest, CoreTest
```

`VaultE2eTest` levanta un proxio y una bóveda de verdad: necesita los repos hermanos
`dotrino-proxy`, `dotrino-vault` y `dotrino-identity` al lado de este.

En el emulador, contra esa misma bóveda de prueba:

```sh
E2E_HOST=10.0.2.2 node ../test/e2e-native.mjs /tmp/pm.json &
./gradlew :app:assembleDebug && adb install -r app/build/outputs/apk/debug/app-debug.apk
adb shell am start -n com.dotrino.passmanager/.MainActivity --es e2e "$(base64 -w0 /tmp/pm.json)"
```

La pantalla lleva `FLAG_SECURE`: las capturas salen en negro. Se mira con
`adb shell uiautomator dump`.
