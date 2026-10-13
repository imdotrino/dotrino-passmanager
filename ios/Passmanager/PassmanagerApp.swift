import DotrinoNative
import DotrinoNativeUI
import SwiftUI

@main
struct PassmanagerApp: App {
    init() {
        // Before any key or store: the phone's Dotrino apps share keychain and files
        // (dotrino-native/docs/DISENO.md §2.1). Without the groups it stops here, instead of
        // silently becoming another device.
        do { try SharedStorage.share(keychainAccessGroup: "P7G853375S.com.dotrino.shared", appGroup: "group.com.dotrino") }
        catch { fatalError("shared storage: \(error)") }
        // The ecosystem's components with the home's look («Cool & Cozy»).
        DotrinoPalette.use(.coolAndCozy)
    }

    var body: some Scene { WindowGroup { RootView() } }
}

/// «Cool & Cozy», the home's. The same as android/…/res/values/colors.xml.
enum Palette {
    static let bg = Color(hex: 0xF4F7F9)
    static let card = Color(hex: 0xFFFFFF)
    static let card2 = Color(hex: 0xF1F4F6)
    static let line2 = Color(hex: 0xCFD8DE)
    static let text = Color(hex: 0x181C1E)
    static let muted = Color(hex: 0x4A5560)
    static let accent = Color(hex: 0x00658C)
    static let onAccent = Color.white
    static let danger = Color(hex: 0xBA1A1A)
}

extension Color {
    init(hex: UInt32) {
        self.init(red: Double((hex >> 16) & 0xFF) / 255, green: Double((hex >> 8) & 0xFF) / 255, blue: Double(hex & 0xFF) / 255)
    }
}
