import Cocoa
import ApplicationServices

// zcax: tiny accessibility helper that talks ONLY to the process with bundle id dev.zcode.app.
func attr(_ e: AXUIElement, _ k: String) -> AnyObject? {
    var v: CFTypeRef?
    return AXUIElementCopyAttributeValue(e, k as CFString, &v) == .success ? (v as AnyObject?) : nil
}
func str(_ e: AXUIElement, _ k: String) -> String {
    if let s = attr(e, k) as? String { return s }
    if let n = attr(e, k) as? NSNumber { return n.stringValue }
    return ""
}
func kids(_ e: AXUIElement) -> [AXUIElement] { (attr(e, "AXChildren") as? [AXUIElement]) ?? [] }
func label(_ e: AXUIElement) -> String { [str(e,"AXTitle"), str(e,"AXDescription"), str(e,"AXValue")].joined(separator: " | ") }

func dump(_ e: AXUIElement, _ depth: Int, _ maxDepth: Int, _ maxVal: Int) {
    let role = str(e, "AXRole"), title = str(e, "AXTitle"), desc = str(e, "AXDescription")
    var val = str(e, "AXValue"); if val.count > maxVal { val = String(val.prefix(maxVal)) + "..." }
    let ident = str(e, "AXDOMIdentifier"), foc = str(e, "AXFocused")
    var line = String(repeating: "  ", count: depth) + role
    let sub = str(e, "AXSubrole"); if !sub.isEmpty { line += "/\(sub)" }
    if !title.isEmpty { line += " t=\"\(title)\"" }
    if !desc.isEmpty { line += " d=\"\(desc)\"" }
    if !val.isEmpty { line += " v=\"\(val.replacingOccurrences(of: "\n", with: "\\n"))\"" }
    if !ident.isEmpty { line += " id=\(ident)" }
    if foc == "1" { line += " FOCUSED" }
    print(line)
    if depth >= maxDepth { return }
    for k in kids(e) { dump(k, depth + 1, maxDepth, maxVal) }
}
func matches(_ e: AXUIElement, _ role: String, _ q: String) -> Bool {
    if str(e,"AXRole") != role { return false }
    if q.isEmpty { return true }
    if q.hasPrefix("=") { let x = String(q.dropFirst()); return [str(e,"AXTitle"), str(e,"AXDescription"), str(e,"AXValue")].contains(x) }
    return label(e).localizedCaseInsensitiveContains(q)
}
func pick(_ out: [AXUIElement]) -> AXUIElement? {
    let n = Int(ProcessInfo.processInfo.environment["ZCAX_NTH"] ?? "0") ?? 0
    return n < out.count ? out[n] : nil
}
func find(_ e: AXUIElement, _ pred: (AXUIElement) -> Bool, _ out: inout [AXUIElement], _ depth: Int = 0, limit: Int = Int.max) {
    if depth > 80 || out.count >= limit { return }
    if pred(e) { out.append(e) }
    for k in kids(e) {
        if out.count >= limit { break }
        find(k, pred, &out, depth + 1, limit: limit)
    }
}

guard let app = NSRunningApplication.runningApplications(withBundleIdentifier: "dev.zcode.app").first else { print("ERR zcode-not-running"); exit(2) }
let ax = AXUIElementCreateApplication(app.processIdentifier)
AXUIElementSetAttributeValue(ax, "AXManualAccessibility" as CFString, kCFBooleanTrue)
let wins = (attr(ax, "AXWindows") as? [AXUIElement]) ?? []
guard let win = wins.first(where: { str($0,"AXRole") == "AXWindow" && str($0,"AXSubrole") == "AXStandardWindow" }) ?? wins.first(where: { str($0,"AXRole") == "AXWindow" }) else { print("ERR no-window"); exit(2) }
let a = CommandLine.arguments
let cmd = a.count > 1 ? a[1] : "dump"
let matchLimit = ["find", "count"].contains(cmd) ? Int.max : max(1, (Int(ProcessInfo.processInfo.environment["ZCAX_NTH"] ?? "0") ?? 0) + 1)
switch cmd {
case "snapshot":
    var controls: [AXUIElement] = []
    let roles: Set<String> = ["AXPopUpButton", "AXButton", "AXMenuItem", "AXMenu", "AXSlider", "AXTextArea"]
    find(win, { roles.contains(str($0, "AXRole")) }, &controls)
    var state: [String: Any] = ["model": NSNull(), "effort": NSNull(), "mode": NSNull(), "provider": NSNull(), "effort_index": NSNull(), "ready": NSNull()]
    var items: [[String: Any]] = []
    var menuOpen = false, workspace = false, back = false, modelSettings = false, plan = false
    for e in controls {
        let role = str(e, "AXRole"), desc = str(e, "AXDescription"), title = str(e, "AXTitle")
        let name = !title.isEmpty ? title : desc
        if role == "AXMenu" { menuOpen = true }
        if role == "AXTextArea" { workspace = true }
        if role == "AXSlider" && desc == "Effort" { state["effort_index"] = Int(str(e, "AXValue")); menuOpen = true }
        if role == "AXButton" {
            if desc == "Back to workspace" { back = true }
            if desc == "Model settings" { modelSettings = true }
            if desc == "Remove Plan from the next submission" { plan = true }
            if desc == "Start Plan" {
                var images: [AXUIElement] = []
                find(e, { str($0, "AXRole") == "AXImage" }, &images)
                if let image = images.first(where: { ["Ready", "Not ready"].contains(str($0, "AXDescription")) }) { state["ready"] = str(image, "AXDescription") == "Ready" }
            }
        }
        if role == "AXPopUpButton" {
            for effort in ["Low", "High", "Max"] where name.hasSuffix(" " + effort) {
                state["model"] = String(name.dropLast(effort.count + 1)); state["effort"] = effort.lowercased()
            }
            if desc == "Switch mode" {
                var texts: [AXUIElement] = []
                find(e, { str($0, "AXRole") == "AXStaticText" }, &texts, limit: 1)
                if let text = texts.first { state["mode"] = str(text, "AXValue") }
            }
        }
        if role == "AXMenuItem" {
            let value = name.isEmpty ? str(e, "AXValue") : name
            items.append(["name": value, "checked": str(e, "AXValue") == "1", "enabled": str(e, "AXEnabled") != "0"])
            if value.hasPrefix("Provider: ") { state["provider"] = String(value.dropFirst(10)) }
        }
    }
    state["menu_items"] = items; state["menu_open"] = menuOpen; state["workspace"] = workspace
    state["back"] = back; state["model_settings"] = modelSettings; state["plan"] = plan
    print(String(data: try JSONSerialization.data(withJSONObject: state, options: [.sortedKeys]), encoding: .utf8)!)
case "exists":
    var out: [AXUIElement] = []
    find(win, { matches($0, a[2], a[3]) }, &out, limit: 1)
    print(out.isEmpty ? "0" : "1")
case "dump":
    dump(win, 0, a.count > 2 ? Int(a[2])! : 30, 200)
case "find":  // find <role> <substring>  -> prints matches
    var out: [AXUIElement] = []
    find(win, { matches($0, a[2], a[3]) }, &out, limit: matchLimit)
    for e in out { print(label(e) + (str(e,"AXEnabled") == "0" ? " [disabled]" : "")) }
case "press": // press <role> <substring>  (AXPress on the first match)
    var out: [AXUIElement] = []
    find(win, { matches($0, a[2], a[3]) }, &out, limit: matchLimit)
    guard let e = pick(out) else { print("ERR not-found"); exit(3) }
    let r = AXUIElementPerformAction(e, "AXPress" as CFString)
    print(r == .success ? "OK pressed \(label(e))" : "ERR press \(r.rawValue)")
case "action": // action <role> <substring> <AXAction>
    var out: [AXUIElement] = []
    find(win, { matches($0, a[2], a[3]) }, &out, limit: matchLimit)
    guard let e = pick(out) else { print("ERR not-found"); exit(3) }
    let r = AXUIElementPerformAction(e, a[4] as CFString)
    print(r == .success ? "OK \(a[4]) \(label(e))" : "ERR action \(r.rawValue)")
case "attrs": // attrs <role> <substring> -> key attributes and actions
    var out: [AXUIElement] = []
    find(win, { matches($0, a[2], a[3]) }, &out, limit: matchLimit)
    guard let e = pick(out) else { print("ERR not-found"); exit(3) }
    var names: CFArray?
    AXUIElementCopyActionNames(e, &names)
    print("value=\(str(e,"AXValue")) min=\(str(e,"AXMinValue")) max=\(str(e,"AXMaxValue")) enabled=\(str(e,"AXEnabled")) selected=\(str(e,"AXSelected")) actions=\((names as? [String]) ?? [])")
case "setnum": // setnum <role> <substring> <number>  (sliders)
    var out: [AXUIElement] = []
    find(win, { matches($0, a[2], a[3]) }, &out, limit: matchLimit)
    guard let e = pick(out) else { print("ERR not-found"); exit(3) }
    let r = AXUIElementSetAttributeValue(e, "AXValue" as CFString, NSNumber(value: Double(a[4])!))
    print(r == .success ? "OK set" : "ERR set \(r.rawValue)")
case "count": // count <role> <substring>
    var out: [AXUIElement] = []
    find(win, { matches($0, a[2], a[3]) }, &out, limit: matchLimit)
    print(out.count)
case "pressup": // pressup <role> <substring>: find the element, then AXPress it or its nearest ancestor that supports AXPress
    var out: [AXUIElement] = []
    find(win, { matches($0, a[2], a[3]) }, &out, limit: matchLimit)
    guard var e = pick(out) else { print("ERR not-found"); exit(3) }
    for _ in 0..<8 {
        var names: CFArray?
        AXUIElementCopyActionNames(e, &names)
        if ((names as? [String]) ?? []).contains("AXPress") {
            let r = AXUIElementPerformAction(e, "AXPress" as CFString)
            print(r == .success ? "OK pressed \(str(e,"AXRole")) via \(label(e))" : "ERR press \(r.rawValue)"); exit(r == .success ? 0 : 3)
        }
        guard let p = attr(e, "AXParent") else { break }
        e = p as! AXUIElement
    }
    print("ERR no-pressable-ancestor")
case "windowid":
    let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] ?? []
    for w in list where (w[kCGWindowOwnerPID as String] as? Int32) == app.processIdentifier && (w[kCGWindowLayer as String] as? Int) == 0 {
        print(w[kCGWindowNumber as String] ?? "")
    }
case "setvalue": // setvalue <role> <substring> <text>
    var out: [AXUIElement] = []
    find(win, { matches($0, a[2], a[3]) }, &out, limit: matchLimit)
    guard let e = pick(out) else { print("ERR not-found"); exit(3) }
    let r = AXUIElementSetAttributeValue(e, "AXValue" as CFString, a[4] as CFString)
    print(r == .success ? "OK set" : "ERR set \(r.rawValue)")
case "settext": // settext <role> <substring> <text>: put text into a rich editor through AXSelectedText (works on the Electron contenteditable composer; AXValue does not)
    var out: [AXUIElement] = []
    find(win, { matches($0, a[2], a[3]) }, &out, limit: matchLimit)
    guard let e = pick(out) else { print("ERR not-found"); exit(3) }
    AXUIElementSetAttributeValue(e, "AXFocused" as CFString, kCFBooleanTrue)
    let r = AXUIElementSetAttributeValue(e, "AXSelectedText" as CFString, a[4] as CFString)
    print(r == .success ? "OK set" : "ERR set \(r.rawValue)")
case "selectall": // selectall <role> <substring>: select the whole content through AXSelectedTextRange (so settext replaces it)
    var out: [AXUIElement] = []
    find(win, { matches($0, a[2], a[3]) }, &out, limit: matchLimit)
    guard let e = pick(out) else { print("ERR not-found"); exit(3) }
    let n = Int(str(e, "AXNumberOfCharacters")) ?? 0
    var rng = CFRange(location: 0, length: n)
    let v = AXValueCreate(.cfRange, &rng)!
    let r = AXUIElementSetAttributeValue(e, "AXSelectedTextRange" as CFString, v)
    print(r == .success ? "OK selected \(n)" : "ERR select \(r.rawValue)")
case "window": // window <min|unmin|state>: AXMinimized of ZCode's window
    switch a.count > 2 ? a[2] : "state" {
    case "min": let r = AXUIElementSetAttributeValue(win, "AXMinimized" as CFString, kCFBooleanTrue); print(r == .success ? "OK minimized" : "ERR min \(r.rawValue)")
    case "unmin": let r = AXUIElementSetAttributeValue(win, "AXMinimized" as CFString, kCFBooleanFalse); print(r == .success ? "OK unminimized" : "ERR unmin \(r.rawValue)")
    default: print("minimized=\(str(win,"AXMinimized")) hidden=\(app.isHidden) active=\(app.isActive)")
    }
case "hide": print(app.hide() ? "OK hidden" : "ERR hide")
case "unhide": print(app.unhide() ? "OK unhidden" : "ERR unhide")
case "bgpaste", "bgclear", "bgpress": // bgpaste <role> <substring> <text> | bgclear <role> <substring> | bgpress <role> <substring>
    // Text goes in through the editor's own context menu (AXShowMenu > Paste / Select all > Delete): AXValue and AXSelectedText writes are
    // ignored by the Electron composer, and the page refuses the menu command while its app is inactive. So ZCode is activated only for
    // the ~150-300 ms the menu press takes and the previous app is brought back at once. The queued paste still lands afterwards; the
    // clipboard is restored only after the text is visible (an earlier restore would paste the OLD clipboard).
    var out: [AXUIElement] = []
    find(win, { matches($0, a[2], a[3]) }, &out, limit: matchLimit)
    guard var e = pick(out) else { print("ERR not-found"); exit(3) }
    let t0 = Date()
    func ms() -> Int { Int(Date().timeIntervalSince(t0) * 1000) }
    func spin(_ s: Double) { RunLoop.current.run(until: Date(timeIntervalSinceNow: s)) }
    func isFront(_ pid: pid_t) -> Bool { NSWorkspace.shared.frontmostApplication?.processIdentifier == pid }
    let prev = NSWorkspace.shared.frontmostApplication
    let wasMin = str(win, "AXMinimized") == "1"
    let wasHidden = app.isHidden
    let pb = NSPasteboard.general
    let saved: [[(NSPasteboard.PasteboardType, Data)]] = (pb.pasteboardItems ?? []).map { it in it.types.compactMap { t in it.data(forType: t).map { (t, $0) } } }
    let isPaste = cmd == "bgpaste"
    if isPaste { pb.clearContents(); pb.setString(a[4], forType: .string) }
    func restoreApp() {
        if let p = prev, p.bundleIdentifier != "dev.zcode.app" {
            p.activate()
            var n = 0
            while !isFront(p.processIdentifier) && n < 100 { spin(0.01); n += 1 }
        }
    }
    func remin() { if wasHidden { app.hide() }; if wasMin { AXUIElementSetAttributeValue(win, "AXMinimized" as CFString, kCFBooleanTrue) } }   // only after the text is visible: a hidden page drops the queued command
    func restoreClipboard() {
        if !isPaste { return }
        pb.clearContents()
        for item in saved { let n = NSPasteboardItem(); for (t, d) in item { n.setData(d, forType: t) }; pb.writeObjects([n]) }
    }
    func fail(_ m: String) -> Never { restoreApp(); remin(); restoreClipboard(); print("ERR " + m); exit(4) }
    func menuPress(_ name: String) -> Bool {
        AXUIElementPerformAction(e, "AXShowMenu" as CFString)
        for _ in 0..<80 {
            for m in kids(win) where str(m, "AXRole") == "AXMenu" {
                if let i = kids(m).first(where: { matches($0, "AXMenuItem", "=" + name) }), str(i, "AXEnabled") != "0" { return AXUIElementPerformAction(i, "AXPress" as CFString) == .success }
            }
            spin(0.01)
        }
        return false
    }
    if wasMin {
        AXUIElementSetAttributeValue(win, "AXMinimized" as CFString, kCFBooleanFalse)
        var n = 0
        while str(win, "AXMinimized") == "1" && n < 100 { spin(0.01); n += 1 }
        spin(Double(ProcessInfo.processInfo.environment["ZCAX_UNMIN_MS"] ?? "400")! / 1000)   // the page is hidden while minimized and wakes up only after the window is back
    }
    app.activate()
    var tries = 0
    while !isFront(app.processIdentifier) && tries < 100 { spin(0.01); tries += 1 }
    if !isFront(app.processIdentifier) { fail("not-activated") }
    let tAct = ms()
    if wasMin { var again: [AXUIElement] = []; find(win, { matches($0, a[2], a[3]) }, &again); if let n = pick(again) { e = n } }   // the page rebuilds its tree when the window comes back
    AXUIElementSetAttributeValue(e, "AXFocused" as CFString, kCFBooleanTrue)
    let n0 = str(e, "AXValue").utf16.count   // composer length before the paste (an empty composer reports a single newline)
    if cmd == "bgpress" {
        // for page actions that the page refuses while its app is inactive (e.g. writing the clipboard)
        if AXUIElementPerformAction(e, "AXPress" as CFString) != .success { fail("press-failed") }
        spin(0.2)
    } else if isPaste {
        if !menuPress("Paste") { fail("no-paste-menu") }
    } else {
        if !menuPress("Select all") { fail("no-select-all-menu") }
        var deleted = false
        for _ in 0..<4 where !deleted {   // the page needs a moment to show the selection; "Delete" is missing from the menu until then
            spin(0.35)
            deleted = menuPress("Delete")
        }
        if !deleted { fail("no-delete-menu") }
    }
    let tFocus = ms()
    restoreApp()   // the command is queued in the page by now; it lands although ZCode is no longer active
    let tBack = ms()
    // A paste counts as landed when the composer ends with the pasted text's tail AND has grown by the pasted length (a head probe would
    // match text left by an earlier chunk). The page turns a single paste of 15360+ characters into a "Pasted text" attachment, so
    // callers (zcbridge paste) chunk long text below that.
    let want = isPaste ? a[4].trimmingCharacters(in: .whitespacesAndNewlines) : ""
    let probe = String(want.suffix(24))
    let wantLen = want.utf16.count
    let baseLen = n0 <= 1 ? 0 : n0
    var ok = false
    let deadline = Date(timeIntervalSinceNow: 4 + Double(wantLen) / 1500)
    var nextLookup = Date(timeIntervalSinceNow: 0.3)
    var reacquired = 0
    while !ok && Date() < deadline {
        if Date() >= nextLookup && reacquired < 2 {
            var fresh: [AXUIElement] = []
            find(win, { matches($0, a[2], a[3]) }, &fresh, limit: matchLimit)
            if let current = pick(fresh) { e = current }
            reacquired += 1; nextLookup = Date(timeIntervalSinceNow: 0.5)
        }
        let v = str(e, "AXValue")
        ok = cmd == "bgpress" ? true : isPaste ? (v.trimmingCharacters(in: .whitespacesAndNewlines).hasSuffix(probe) && v.utf16.count >= baseLen + wantLen - 2) : v.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        if !ok { spin(0.02) }
    }
    remin()
    restoreClipboard()
    print(ok ? "OK \(cmd) reacquired=\(reacquired) focus=\(tFocus)ms (activate=\(tAct)ms) back=\(tBack)ms visible=\(ms())ms" : "ERR text-not-visible activate=\(tAct)ms focus=\(tFocus)ms back=\(tBack)ms visible=\(ms())ms reacquired=\(reacquired)")
case "textlen": // textlen <role> <substring>: AXValue length (UTF-16 units), AXNumberOfCharacters and the last 40 characters (dump cuts values at 200)
    var out: [AXUIElement] = []
    find(win, { matches($0, a[2], a[3]) }, &out, limit: matchLimit)
    guard let e = pick(out) else { print("ERR not-found"); exit(3) }
    let v = str(e, "AXValue")
    print("OK len=\(v.utf16.count) chars=\(str(e, "AXNumberOfCharacters")) tail=\(v.suffix(40).replacingOccurrences(of: "\n", with: "\\n"))")
case "texts": // texts <minLen>: full AXValue of every AXStaticText with at least minLen characters, in tree order, newlines as \\n (live preview of a streaming reply)
    var out: [AXUIElement] = []
    let minLen = Int(a.count > 2 ? a[2] : "1") ?? 1
    find(win, { str($0, "AXRole") == "AXStaticText" && str($0, "AXValue").count >= minLen }, &out)
    for e in out { print(str(e, "AXValue").replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\n", with: "\\n")) }
case "focus": // focus <role> <substring>
    var out: [AXUIElement] = []
    find(win, { matches($0, a[2], a[3]) }, &out, limit: matchLimit)
    guard let e = pick(out) else { print("ERR not-found"); exit(3) }
    let r = AXUIElementSetAttributeValue(e, "AXFocused" as CFString, kCFBooleanTrue)
    print(r == .success ? "OK focused" : "ERR focus \(r.rawValue)")
case "activate":
    app.activate()
    for _ in 0..<20 { if NSWorkspace.shared.frontmostApplication?.bundleIdentifier == "dev.zcode.app" { print("OK"); exit(0) }; Thread.sleep(forTimeInterval: 0.1) }
    print("ERR not-frontmost")
case "frontmost":
    print(NSWorkspace.shared.frontmostApplication?.bundleIdentifier ?? "none")
default: print("ERR usage")
}
