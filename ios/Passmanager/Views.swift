import DotrinoNative
import DotrinoNativeUI
import SwiftUI

/// The app: a search box and what is saved, with «copy» one tap away — finding a password and
/// copying it is what this app is for. From a row, its detail; from there, editing.
struct RootView: View {
    @StateObject private var m = AppModel()
    @ObservedObject private var lang = DotrinoLang.shared
    @State private var query = ""
    @State private var detail: EntryView?
    @State private var editing: EditTarget?
    @State private var web: URL?

    /// What the editor opens with: nil = a new entry.
    struct EditTarget: Identifiable { let id = UUID(); let view: EntryView? }

    var body: some View {
        VStack(spacing: 0) {
            DotrinoTopbar(repo: "imdotrino/dotrino-passmanager", brand: .init(name: t("app.name"), image: Image("Brand")),
                          profile: m.topbarProfile, onProfileChanged: { Task { await m.reboot() } }) {
                if m.booted {
                    Button { editing = EditTarget(view: nil) } label: {
                        Text("+").font(.title2.bold()).foregroundColor(Palette.onAccent)
                            .padding(.horizontal, 14).padding(.vertical, 2).background(Capsule().fill(Palette.accent))
                    }.accessibilityLabel(t("add")).accessibilityIdentifier("add")
                }
            }
            if let s = statusText {
                Text(s).font(.footnote).foregroundColor(Palette.muted).frame(maxWidth: .infinity).padding(6).background(Palette.card2)
                    .accessibilityIdentifier("status")
            }
            content
        }
        .background(Palette.bg.ignoresSafeArea())
        .task { await m.boot() }
        .fullScreenCover(isPresented: Binding(get: { web != nil }, set: { if !$0 { web = nil } })) {
            if let u = web { DotrinoWebSheet(url: u) { web = nil; Task { await m.reboot() } } }
        }
        .sheet(item: $detail) { v in
            DetailSheet(m: m, view: v, onEdit: { detail = nil; editing = EditTarget(view: v) }).environmentObject(lang)
        }
        .sheet(item: $editing) { target in EditSheet(m: m, view: target.view).environmentObject(lang) }
        .overlay(alignment: .bottom) { toast }
        .id(lang.code)
    }

    private var statusText: String? {
        if m.busy > 0 { return t("approval.waiting") }
        guard m.booted else { return nil }
        if m.status == "connecting" { return t("status.connecting") }
        if m.status == "offline" { return t("status.offline") }
        return nil
    }

    @ViewBuilder private var toast: some View {
        if let msg = m.toast {
            Text(msg).font(.footnote).foregroundColor(.white).padding(.horizontal, 16).padding(.vertical, 10)
                .background(Capsule().fill(Color.black.opacity(0.82))).padding(.bottom, 24).padding(.horizontal, 20)
                .accessibilityIdentifier("toast")
                .task(id: msg) {
                    try? await Task.sleep(nanoseconds: 3_000_000_000)
                    if m.toast == msg { m.toast = nil }
                }
        }
    }

    @ViewBuilder private var content: some View {
        if let p = m.problem {
            VStack(spacing: 18) {
                Text(p).foregroundColor(Palette.muted).multilineTextAlignment(.center).accessibilityIdentifier("problem")
                if m.problemCode == "no-profile" {
                    Button(t("boot.createProfile")) { web = DotrinoTopbarURLs.create }.buttonStyle(Pill(filled: true))
                    Button(t("boot.adoptProfile")) { web = DotrinoTopbarURLs.adopt }.buttonStyle(Pill(filled: false))
                } else if m.problemCode == "no-vault" {
                    Button(t("boot.noVaultHow")) { web = DotrinoTopbarURLs.adopt }.buttonStyle(Pill(filled: true))
                }
                Button(t("retry")) { Task { await m.reboot() } }.buttonStyle(Pill(filled: m.problemCode == nil || m.problemCode == "no-permission" || m.problemCode == "no-vault-key"))
                    .accessibilityIdentifier("retry")
            }.padding(32).frame(maxHeight: .infinity)
        } else if !m.loaded {
            VStack(spacing: 14) { ProgressView(); Text(t("list.loading")).foregroundColor(Palette.muted) }.frame(maxHeight: .infinity)
        } else {
            list
        }
    }

    private var shown: [EntryView] {
        let term = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return term.isEmpty ? m.views : m.views.filter { $0.matches(term) }
    }

    private var list: some View {
        VStack(spacing: 0) {
            TextField(t("search.placeholder"), text: $query)
                .textInputAutocapitalization(.never).autocorrectionDisabled()
                .padding(.horizontal, 14).padding(.vertical, 12)
                .background(RoundedRectangle(cornerRadius: 16).fill(Palette.card))
                .overlay(RoundedRectangle(cornerRadius: 16).stroke(Palette.line2))
                .padding(.horizontal, 12).padding(.top, 10).padding(.bottom, 4)
                .accessibilityIdentifier("search")
            ScrollView {
                LazyVStack(spacing: 8) {
                    if shown.isEmpty {
                        Text(m.views.isEmpty ? t("list.empty") : t("list.noMatch", ["q": query.trimmingCharacters(in: .whitespacesAndNewlines)]))
                            .foregroundColor(Palette.muted).multilineTextAlignment(.center).padding(.top, 48).padding(.horizontal, 32)
                    }
                    ForEach(shown) { v in row(v) }
                    presenceRule
                }.padding(.horizontal, 12).padding(.top, 6).padding(.bottom, 24)
            }
        }
    }

    private func subtitle(_ v: EntryView) -> String {
        let s = (!v.hint.isEmpty && !v.title.isEmpty && v.title != v.hint) ? v.title : v.sites.joined(separator: ", ")
        return s.isEmpty ? t("detail.noSites") : s
    }

    private func row(_ v: EntryView) -> some View {
        HStack(spacing: 10) {
            Avatar(name: m.title(of: v), key: v.id)
            VStack(alignment: .leading, spacing: 2) {
                Text(m.title(of: v)).font(.body.weight(.bold)).foregroundColor(Palette.text).lineLimit(1)
                Text(subtitle(v)).font(.footnote).foregroundColor(Palette.muted).lineLimit(1)
            }
            Spacer(minLength: 4)
            // Both buttons are always there: one that does not apply is shown disabled, not hidden.
            quick("person.fill", t("copy.user"), "copy-user", enabled: v.fieldKeys.contains("username")) { await m.copyField(v, "username", what: t("field.username")) }
            quick("key.fill", t("copy.secret"), "copy-secret", enabled: v.hasSecret) { await m.copyField(v, "secret", what: t("field.secret")) }
        }
        .padding(.leading, 12).padding(.trailing, 8).padding(.vertical, 10)
        .background(RoundedRectangle(cornerRadius: 16).fill(Palette.card))
        .contentShape(Rectangle())
        .onTapGesture { detail = v }
        .accessibilityIdentifier("entry")
    }

    private func quick(_ symbol: String, _ what: String, _ id: String, enabled: Bool, _ action: @escaping () async -> Void) -> some View {
        Button { Task { await action() } } label: {
            Image(systemName: symbol).foregroundColor(Palette.text).padding(.horizontal, 12).padding(.vertical, 9)
                .background(RoundedRectangle(cornerRadius: 14).fill(Palette.card2))
        }
        .buttonStyle(.plain).disabled(!enabled).opacity(enabled ? 1 : 0.35)
        .accessibilityLabel(what).accessibilityIdentifier(id)
    }

    /// The rule as a sentence, with its button beside it.
    private var presenceRule: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(t(m.presenceOn ? "presence.rule.on" : "presence.rule.off")).font(.footnote).foregroundColor(Palette.muted)
                .accessibilityIdentifier("presence-rule")
            Button(t("presence.change")) { Task { await m.togglePresence() } }.buttonStyle(Pill(filled: false))
                .accessibilityIdentifier("presence-change")
        }.frame(maxWidth: .infinity, alignment: .leading).padding(.top, 18).padding(.horizontal, 4)
    }
}

struct Pill: ButtonStyle {
    var filled = false
    var color = Palette.accent
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.font(.body.weight(.bold))
            .foregroundColor(filled ? Palette.onAccent : Palette.text)
            .padding(.horizontal, 20).padding(.vertical, 12)
            .background(Capsule().fill(filled ? color : Palette.card))
            .overlay(Capsule().stroke(filled ? Color.clear : Palette.line2))
            .opacity(configuration.isPressed ? 0.8 : 1)
    }
}

/// A round avatar with the initial, coloured from the key: every entry is told apart at a glance.
struct Avatar: View {
    let name: String, key: String
    private static let palette: [UInt32] = [0x00658C, 0x006B5C, 0x665590, 0x8C4A00, 0x3F6B00, 0x7A3E6B]
    var body: some View {
        let sum = key.unicodeScalars.reduce(0) { ($0 &* 31 &+ Int($1.value)) & 0x7FFFFFFF }
        Text(name.trimmingCharacters(in: .whitespaces).first.map { String($0).uppercased() } ?? "?")
            .font(.system(size: 16, weight: .bold)).foregroundColor(.white)
            .frame(width: 40, height: 40).background(Circle().fill(Color(hex: Self.palette[sum % Self.palette.count])))
    }
}

/// ONE ENTRY: its public details as they are, its private ones covered until asked for. A
/// private value is fetched from the vault when «Show» or «Copy» is pressed — which is when
/// the vault may ask one of your devices to approve — and forgotten when the sheet closes.
struct DetailSheet: View {
    @ObservedObject var m: AppModel
    let view: EntryView
    let onEdit: () -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var entry: Entry?
    @State private var opened: [String: String] = [:]     // key -> value, only while the sheet is open
    @State private var asking = false
    @State private var tick = Date()
    private let timer = Timer.publish(every: 1, on: .main, in: .common).autoconnect()

    private var keys: [String] { view.fieldKeys + (view.hasNotes ? ["notes"] : []) }

    private func value(of key: String) -> String? {
        if let v = opened[key] { return v }
        guard let e = entry else { return nil }
        if key == "username" { return e.username.isEmpty ? nil : e.username }
        return e.fields.first { $0.key == key }?.value
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                HStack {
                    Text(m.title(of: view)).font(.title3.bold()).foregroundColor(Palette.text)
                    Spacer()
                    Button { dismiss() } label: { Image(systemName: "xmark").foregroundColor(Palette.muted).padding(8) }
                        .accessibilityLabel(t("close")).accessibilityIdentifier("sheet-close")
                }
                if asking {
                    Text(t("delete.ask", ["name": m.title(of: view)])).foregroundColor(Palette.text)
                    HStack {
                        Spacer()
                        Button(t("cancel")) { asking = false }.buttonStyle(Pill(filled: false)).accessibilityIdentifier("delete-cancel")
                        Button(t("delete.yes")) {
                            Task {
                                if await m.ask({ try await $0.remove(view.id) }) != nil { m.toast = t("deleted"); dismiss(); await m.reload() }
                            }
                        }.buttonStyle(Pill(filled: true, color: Palette.danger)).accessibilityIdentifier("delete-yes")
                    }
                } else {
                    Text(view.sites.isEmpty ? t("detail.noSites") : view.sites.joined(separator: ", ")).font(.subheadline).foregroundColor(Palette.muted)
                        .accessibilityIdentifier("detail-sites")
                    ForEach(keys, id: \.self) { key in fieldRow(key) }
                    if entry?.withheld.isEmpty == false { Text(t("detail.withheld")).font(.footnote).foregroundColor(Palette.muted) }
                    HStack {
                        Spacer()
                        Button(t("delete")) { asking = true }.buttonStyle(Pill(filled: false)).accessibilityIdentifier("detail-delete")
                        Button(t("edit")) { onEdit() }.buttonStyle(Pill(filled: true)).accessibilityIdentifier("detail-edit")
                    }.padding(.top, 8)
                }
            }.padding(20)
        }
        .background(Palette.card.ignoresSafeArea())
        .onReceive(timer) { tick = $0 }
        .task {
            // The public details cost no approval: they are asked for at once.
            let publicKeys = view.fieldKeys.filter { !view.privateKeys.contains($0) }
            if !publicKeys.isEmpty { entry = await m.ask { try await $0.get(view.id, keys: publicKeys) } }
        }
    }

    private func totpText(_ secret: String) -> String {
        _ = tick   // read so the row is drawn again every second
        do { return try Totp.code(secret) + "  ·  " + t("detail.totpLeft", ["s": try Totp.remaining(secret)]) }
        catch { return m.message(of: error) }
    }

    private func fieldRow(_ key: String) -> some View {
        let isPrivate = view.privateKeys.contains(key) || key == "notes"
        let v = value(of: key)
        let shown = v == nil ? (isPrivate ? t("detail.hidden") : "…") : (key == "totp" ? totpText(v!) : v!)
        return VStack(alignment: .leading, spacing: 2) {
            Text(labelOfKey(key)).font(.caption.weight(.bold)).foregroundColor(Palette.muted)
            HStack(spacing: 4) {
                Text(shown).foregroundColor(Palette.text).frame(maxWidth: .infinity, alignment: .leading)
                    .accessibilityIdentifier("value-\(key)")
                if isPrivate {
                    Button(v == nil ? t("show") : t("hide")) {
                        if v != nil { opened[key] = nil } else { Task { if let got = await reveal(key) { opened[key] = got } } }
                    }.font(.footnote.weight(.bold)).foregroundColor(Palette.accent).padding(8).accessibilityIdentifier("show-\(key)")
                }
                Button(t("copy")) {
                    Task {
                        var got = value(of: key)
                        if got == nil { got = await reveal(key) }
                        guard let got else { return }
                        if key == "totp" {
                            do { m.copy(try Totp.code(got), what: t("copy.code")) } catch { m.toast = m.message(of: error) }
                        } else { m.copy(got, what: labelOfKey(key)) }
                    }
                }.font(.footnote.weight(.bold)).foregroundColor(Palette.accent).padding(8).accessibilityIdentifier("copy-\(key)")
            }
        }
    }

    /// Fetches ONE private value: the phone's «is it you?» first, then the vault (and its approval).
    private func reveal(_ key: String) async -> String? {
        guard await m.confirmed() else { return nil }
        guard let e = await m.ask({ try await $0.get(view.id, keys: [key]) }) else { return nil }
        switch key {
        case "secret": return e.secret
        case "totp": return e.totp
        case "notes": return e.notes
        case "username": return e.username
        default: return e.fields.first { $0.key == key }?.value ?? ""
        }
    }
}

/// NEW or EDIT. Editing changes ONLY what was touched: a private detail is not fetched to be
/// edited — left empty it stays as it is in the vault, and typing replaces it. That is what
/// lets a password be changed without anybody having to approve reading the old one.
struct EditSheet: View {
    @ObservedObject var m: AppModel
    let view: EntryView?
    @Environment(\.dismiss) private var dismiss

    /// A free field on the form. `had` = it exists in the vault; `known` = its value is in hand (public).
    struct Row: Identifiable {
        let id = UUID()
        let key: String?
        var label: String
        var value: String
        var isPrivate: Bool
        let known: String?
        var removed = false
        var had: Bool { key != nil }
    }

    @State private var ready = false
    @State private var before: Entry?
    @State private var name = ""
    @State private var sites = ""
    @State private var username = ""
    @State private var secret = ""
    @State private var totp = ""
    @State private var notes = ""
    @State private var dropFixed: Set<String> = []
    @State private var rows: [Row] = []
    @State private var saving = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 6) {
                HStack {
                    Text(t(view == nil ? "edit.new" : "edit.title")).font(.title3.bold()).foregroundColor(Palette.text)
                    Spacer()
                    Button { dismiss() } label: { Image(systemName: "xmark").foregroundColor(Palette.muted).padding(8) }
                        .accessibilityLabel(t("close")).accessibilityIdentifier("sheet-close")
                }
                if !ready { ProgressView().frame(maxWidth: .infinity).padding(40) } else { form }
            }.padding(20)
        }
        .background(Palette.card.ignoresSafeArea())
        .task { await load() }
    }

    private func load() async {
        guard let view else { ready = true; return }
        // What is public is brought to be edited in place; what is private is not.
        let publicKeys = ["name"] + view.fieldKeys.filter { !view.privateKeys.contains($0) }
        guard let e = await m.ask({ try await $0.get(view.id, keys: publicKeys) }) else { dismiss(); return }
        before = e
        name = e.name; username = e.username; sites = view.sites.joined(separator: ", ")
        rows = view.fieldKeys.filter { !Entry.fixed.contains($0) }.map { key in
            let f = e.fields.first { $0.key == key }
            return Row(key: key, label: f?.label ?? labelOfKey(key), value: f?.value ?? "", isPrivate: view.privateKeys.contains(key), known: f?.value)
        }
        ready = true
    }

    private func caption(_ text: String) -> some View {
        Text(text).font(.caption.weight(.bold)).foregroundColor(Palette.muted).padding(.top, 10)
    }

    private func input(_ id: String, _ hint: String, _ text: Binding<String>, plain: Bool = false) -> some View {
        TextField(hint, text: text)
            .textInputAutocapitalization(plain ? .sentences : .never).autocorrectionDisabled(!plain)
            .padding(.horizontal, 14).padding(.vertical, 12)
            .background(RoundedRectangle(cornerRadius: 16).fill(Palette.card))
            .overlay(RoundedRectangle(cornerRadius: 16).stroke(Palette.line2))
            .accessibilityIdentifier(id)
    }

    /// A private detail that already exists: «unchanged» as its hint, and a way to take it out.
    @ViewBuilder private func keepable(_ key: String, _ text: Binding<String>, has: Bool, hint: String = "") -> some View {
        let going = dropFixed.contains(key)
        input("edit-\(key)", going ? t("field.willRemove") : (has ? t("field.keep") : hint), text).disabled(going)
        if has {
            Button(going ? t("field.undo") : t("field.remove")) {
                if going { dropFixed.remove(key) } else { dropFixed.insert(key); text.wrappedValue = "" }
            }.font(.footnote.weight(.bold)).foregroundColor(Palette.accent).padding(.leading, 4).accessibilityIdentifier("remove-\(key)")
        }
    }

    @ViewBuilder private var form: some View {
        caption(t("field.name")); input("edit-name", t("field.nameHint"), $name, plain: true)
        caption(t("field.sites")); input("edit-sites", t("field.sitesHint"), $sites)
        caption(t("field.username")); input("edit-username", "", $username)
        caption(t("field.secret")); keepable("secret", $secret, has: view?.hasSecret == true)
        Button(t("generate")) { dropFixed.remove("secret"); secret = Generate.password() }.buttonStyle(Pill(filled: false)).accessibilityIdentifier("edit-generate")
        caption(t("field.totp")); keepable("totp", $totp, has: view?.hasTotp == true, hint: t("field.totpHint"))
        caption(t("field.notes")); keepable("notes", $notes, has: view?.hasNotes == true)

        ForEach($rows) { $row in
            VStack(alignment: .leading, spacing: 6) {
                // The name IS the key of an existing field: it does not change here.
                input("free-label", t("field.label"), $row.label).disabled(row.had)
                input("free-value", row.had && row.known == nil ? t("field.keep") : t("field.value"), $row.value).disabled(row.removed)
                HStack(spacing: 16) {
                    // The private mark lives inside the envelope, with the value: it changes when the value is written again.
                    let canMark = !row.had || row.known != nil
                    Button(t(row.isPrivate ? "field.private" : "field.public")) { row.isPrivate.toggle() }
                        .disabled(!canMark).opacity(canMark ? 1 : 0.5).accessibilityIdentifier("free-private")
                    Button(row.removed ? t("field.undo") : t("field.remove")) {
                        if row.had { row.removed.toggle() } else { rows.removeAll { $0.id == row.id } }
                    }.accessibilityIdentifier("free-remove")
                }.font(.footnote.weight(.bold)).foregroundColor(Palette.accent).padding(.leading, 4)
            }.padding(.top, 14).opacity(row.removed ? 0.5 : 1)
        }
        Button(t("field.addFree")) { rows.append(Row(key: nil, label: "", value: "", isPrivate: false, known: "")) }
            .buttonStyle(Pill(filled: false)).padding(.top, 14).accessibilityIdentifier("edit-add-field")
        if view != nil { Text(t("edit.privateNote")).font(.footnote).foregroundColor(Palette.muted).padding(.top, 14) }
        Button(t("save")) { Task { await save() } }.buttonStyle(Pill(filled: true)).frame(maxWidth: .infinity).padding(.top, 20)
            .disabled(saving).accessibilityIdentifier("edit-save")
    }

    private func save() async {
        saving = true
        defer { saving = false }
        let siteList = sites.split(whereSeparator: { $0 == "," || $0 == " " || $0 == "\n" }).map { String($0) }
        let nm = name.trimmingCharacters(in: .whitespacesAndNewlines), user = username.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let view else {
            if nm.isEmpty && siteList.isEmpty && user.isEmpty { m.toast = t("edit.needTitle"); return }
            let fields: [Field] = rows.compactMap { r in
                let l = r.label.trimmingCharacters(in: .whitespacesAndNewlines)
                return (l.isEmpty || r.value.isEmpty) ? nil : Field(label: l, value: r.value, kind: nil, isPrivate: r.isPrivate)
            }
            let entry = Entry(id: UUID().uuidString.lowercased(), title: siteList.first ?? nm, name: nm, sites: siteList, username: user,
                              secret: secret, totp: totp.trimmingCharacters(in: .whitespacesAndNewlines), notes: notes, fields: fields)
            if await m.ask({ try await $0.put(entry) }) != nil { m.toast = t("saved"); dismiss(); await m.reload() }
            return
        }
        guard let was = before else { return }
        func fixed(_ key: String, _ text: String) -> String? { dropFixed.contains(key) ? "" : (text.isEmpty ? nil : text) }
        var changed: [Field] = [], removed: [String] = [], publicAfter: [Field] = []
        for r in rows {
            if let key = r.key {
                let old = was.fields.first { $0.key == key }
                if r.removed { removed.append(key); continue }
                let value = r.value.isEmpty ? (r.known ?? "") : r.value
                let f = Field(label: old?.label ?? r.label.trimmingCharacters(in: .whitespacesAndNewlines), value: value, kind: old?.kind, isPrivate: r.isPrivate)
                if !value.isEmpty && (r.value != (r.known ?? "") || r.isPrivate != view.privateKeys.contains(key)) { changed.append(f) }
                if !r.isPrivate && !value.isEmpty { publicAfter.append(f) }
            } else {
                let l = r.label.trimmingCharacters(in: .whitespacesAndNewlines)
                if l.isEmpty || r.value.isEmpty { continue }
                let f = Field(label: l, value: r.value, kind: nil, isPrivate: r.isPrivate)
                changed.append(f); if !r.isPrivate { publicAfter.append(f) }
            }
        }
        let sitesNow = Entry.normalizeSites(siteList)
        // The visible name after the change, from what is public and in hand; with nothing to go by, it stays.
        let hint = Entry(id: view.id, name: nm, username: user, fields: publicAfter).who()
        let changes = Changes(
            name: nm == was.name ? nil : nm, username: user == was.username ? nil : user,
            secret: fixed("secret", secret), totp: fixed("totp", totp.trimmingCharacters(in: .whitespacesAndNewlines)), notes: fixed("notes", notes),
            fields: changed, removeFields: removed, sites: sitesNow == view.sites ? nil : sitesNow, hint: hint.isEmpty ? nil : hint)
        if await m.ask({ try await $0.patch(view.id, changes) }) != nil { m.toast = t("saved"); dismiss(); await m.reload() }
    }
}
