# Contraseñas para iOS

La versión nativa del gestor de contraseñas de Dotrino (`com.dotrino.passmanager`), la
misma que `../android/`. Diseño: [`../docs/DISENO.md`](../docs/DISENO.md) §6.3.

## Estado: compila y pasa las pruebas, SIN publicar

Escrita el 2026-10-13 sin Mac; compilada y probada el 2026-10-15 en la Mac (Xcode 26.5,
simulador iPhone 15 Pro, `dotrino-native` v0.35.2):

- compiló a la primera;
- `CoreTests` (4): las huellas y los resúmenes dan lo mismo que el JS;
- `VaultE2eTests`, contra un proxio y una bóveda de verdad levantados en otra máquina de la LAN;
- la app arranca en el simulador y enseña «este teléfono todavía no tiene perfil».

Falta: probarla con un perfil de verdad en un iPhone, y TestFlight (no existe todavía la
ficha `com.dotrino.passmanager` en App Store Connect).

Para repetirlo, con una Mac delante:

```sh
git submodule update --init
cd ios && xcodegen generate
xcodebuild -project Passmanager.xcodeproj -scheme Passmanager \
  -destination 'platform=iOS Simulator,name=iPhone 15 Pro' test
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
