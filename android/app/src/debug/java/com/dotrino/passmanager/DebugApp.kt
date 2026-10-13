package com.dotrino.passmanager

import android.app.Activity
import android.app.Application
import android.os.Bundle
import android.util.Base64
import com.dotrino.sdk.ActaSync
import com.dotrino.sdk.Profile
import com.dotrino.sdk.ProxyConnection
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/**
 * DEBUG BUILD ONLY. Started with the extra `e2e` (the base64 of what `test/e2e-native.mjs`
 * wrote), the app runs as that test device — its keys in software — against that test vault,
 * instead of the phone's profile:
 *
 *   adb shell am start -n com.dotrino.passmanager/.MainActivity --es e2e "$(base64 -w0 out.json)"
 */
class DebugApp : Application() {
    override fun onCreate() {
        super.onCreate()
        registerActivityLifecycleCallbacks(object : ActivityLifecycleCallbacks {
            override fun onActivityPreCreated(a: Activity, b: Bundle?) {
                val raw = a.intent?.getStringExtra("e2e") ?: return
                val f = Json.parseToJsonElement(String(Base64.decode(raw, Base64.DEFAULT), Charsets.UTF_8)).jsonObject
                fun s(k: String) = f.getValue(k).jsonPrimitive.content
                val keys = SoftKeys(f.getValue("privateJwk").jsonObject, f.getValue("encPrivateJwk").jsonObject, s("publickey"), s("encPub"))
                val profile = Profile.of(keys, null, Profile.VaultLink(s("master"), s("proxyUrl"), f.getValue("cert").jsonObject, s("deviceId")))
                Passmanager.reset()
                Passmanager.source = object : Passmanager.Source {
                    override suspend fun profile() = profile
                    override suspend fun catchUp(profile: Profile, conn: ProxyConnection) = ActaSync.update(profile, conn, { _, _ -> })
                }
            }
            override fun onActivityCreated(a: Activity, b: Bundle?) {}
            override fun onActivityStarted(a: Activity) {}
            override fun onActivityResumed(a: Activity) {}
            override fun onActivityPaused(a: Activity) {}
            override fun onActivityStopped(a: Activity) {}
            override fun onActivitySaveInstanceState(a: Activity, b: Bundle) {}
            override fun onActivityDestroyed(a: Activity) {}
        })
    }
}
