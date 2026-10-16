// Contraseñas para Android: la versión NATIVA del gestor de contraseñas de Dotrino
// (CONVENCIONES §16). Es un aparato del acta con el permiso `passwords` que habla `pm2.*` con la
// bóveda: busca, copia y edita. La extensión va delante; lo que esta todavía no hace (rellenar
// en otras apps) está dicho en docs/DISENO.md §6.3.
import java.io.File
import java.util.Base64

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.serialization")
}

// `dotrino-env` pone en el entorno ANDROID_UPLOAD_KEYSTORE_B64 / _STORE_PASSWORD / _KEY_ALIAS /
// _KEY_PASSWORD (cajón `claude`, con aprobación en el teléfono). El .jks se escribe en
// $XDG_RUNTIME_DIR —memoria, no disco— y se borra al salir la JVM; `--no-daemon` hace que esa
// JVM sea la de ESTA compilación y no un daemon que se queda vivo con la ruta apuntada.
//
// Sin esas variables el release sale SIN firmar (y así lo dice Gradle): no hay otra llave de
// repuesto a la que caer.
val uploadKey: Map<String, String>? = run {
    val b64 = System.getenv("ANDROID_UPLOAD_KEYSTORE_B64") ?: return@run null
    val dir = System.getenv("XDG_RUNTIME_DIR") ?: error("XDG_RUNTIME_DIR is not set: refusing to write the upload key to disk")
    val f = File(dir, "dotrino-upload-${ProcessHandle.current().pid()}.jks")
    f.writeBytes(Base64.getDecoder().decode(b64))
    f.setReadable(false, false); f.setReadable(true, true)
    f.deleteOnExit()
    mapOf(
        "storeFile" to f.absolutePath,
        "storePassword" to (System.getenv("ANDROID_UPLOAD_STORE_PASSWORD") ?: error("ANDROID_UPLOAD_STORE_PASSWORD missing")),
        "keyAlias" to (System.getenv("ANDROID_UPLOAD_KEY_ALIAS") ?: error("ANDROID_UPLOAD_KEY_ALIAS missing")),
        "keyPassword" to (System.getenv("ANDROID_UPLOAD_KEY_PASSWORD") ?: error("ANDROID_UPLOAD_KEY_PASSWORD missing")),
    )
}

android {
    namespace = "com.dotrino.passmanager"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.dotrino.passmanager"
        minSdk = 31
        targetSdk = 36
        versionCode = 8
        versionName = "0.1.0"
    }

    // La MISMA llave que la app de identidad (Play App Signing «misma llave que otra app»): su
    // servicio es de nivel firma y no atiende a una app firmada con otra (DISENO.md §2.3).
    signingConfigs {
        if (uploadKey != null) {
            create("release") {
                storeFile = file(uploadKey.getValue("storeFile"))
                storePassword = uploadKey.getValue("storePassword")
                keyAlias = uploadKey.getValue("keyAlias")
                keyPassword = uploadKey.getValue("keyPassword")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            if (uploadKey != null) signingConfig = signingConfigs.getByName("release")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    buildFeatures { buildConfig = true }
    // Los textos de la app también en las pruebas JVM.
    sourceSets["test"].resources.srcDir("src/main/assets")
}

dependencies {
    implementation("com.dotrino:dotrino-native")   // includeBuild de ../native/android
    // El proveedor de passkeys del sistema (Credential Manager). Sin play-services: el proveedor no lo necesita.
    implementation("androidx.credentials:credentials:1.5.0")
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.9.0")
}
