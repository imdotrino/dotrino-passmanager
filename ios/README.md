# Contraseñas para iOS

La versión nativa del gestor de contraseñas de Dotrino (`com.dotrino.passmanager`), la
misma que `../android/`. Diseño: [`../docs/DISENO.md`](../docs/DISENO.md) §6.3.

## ⚠️ Estado: escrita y SIN COMPILAR

Se escribió el 2026-10-13 con la Mac no disponible. **Nunca pasó por `swiftc`**: puede no
compilar a la primera, y nada de lo que hay aquí se ha ejecutado. Lo que sí está probado es
la lógica, en su gemela de Android (mismos nombres, mismo orden), contra la librería JS y
contra una bóveda real. Tampoco se compiló lo que esta app usa de `dotrino-native` 0.34
(`Crypto.wrapForMember`, `Profile.openSealed`, `Profile.vaultEncPub`, `Profile.can`).

Lo primero, con una Mac delante:

```sh
git submodule update --init
cd ios && xcodegen generate
xcodebuild -project Passmanager.xcodeproj -scheme Passmanager \
  -destination 'platform=iOS Simulator,name=iPhone 16' test
```

1. que compile (y `swift test` en `../native`, por `WrapTests`);
2. `CoreTests`: las huellas y los resúmenes tienen que dar lo mismo que el JS — los valores
   esperados son los que `lib/src/sealed/keys.js` da y Android ya comprueba;
3. `VaultE2eTests`, contra un proxio y una bóveda de verdad (en la máquina que tenga los
   repos hermanos `dotrino-proxy`, `dotrino-vault` y `dotrino-identity`):

   ```sh
   E2E_HOST=<IP de esa máquina en la LAN> node ../test/e2e-native.mjs /tmp/pm.json
   TEST_RUNNER_PM_E2E="$(cat /tmp/pm.json)" xcodebuild … test
   ```
4. la pantalla en el simulador, y solo entonces TestFlight.

## Qué hay

```
Passmanager/
  Core/             el puerto de lib/src/sealed y lib/src/vault/sealed.js (gemelo de android/…/core)
  AppModel.swift    el arranque (perfil del teléfono → bóveda) y lo que usan las pantallas
  Views.swift       la lista con búsqueda, el detalle y el editor
PassmanagerTests/   CoreTests y VaultE2eTests
project.yml         XcodeGen
```

Los textos son un solo archivo para las dos apps: `../android/app/src/main/assets/i18n.json`.

## Lo que iOS no tiene igual que Android

- **Capturas de pantalla**: Android las bloquea (`FLAG_SECURE`); iOS no ofrece nada
  equivalente y aquí no se hace nada.
- **Portapapeles**: se copia solo en este teléfono (sin Handoff) y caduca solo al minuto,
  que es mejor que lo que Android permite.
