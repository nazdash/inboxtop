import AppKit
import Foundation

struct MenuProblem: Codable {
    var title: String
    var detail: String
    var destination: String
}
struct MenuState: Codable {
    struct Groups: Codable { var act: Int; var read: Int; var clear: Int; var check: Int }
    struct Progress: Codable { var done: Int; var total: Int }
    struct Commands: Codable { var mode: Bool; var sync: Bool; var stop: Bool }
    var `protocol`: Int
    var revision: Int
    var enabled: Bool
    var mode: String
    var unread: Int?
    var ready: Int
    var unanalyzed: Int?
    var groups: Groups
    var subscriptions: Int
    var lastSync: String?
    var progress: Progress?
    var activity: String?
    var issue: String?
    var blockingIssue: MenuProblem?
    // Older workers report per-email failures as issues. Ignore those entirely.
    var blockingProblem: MenuProblem? {
        blockingIssue ?? (issue?.hasPrefix("Sync failed") == true
            ? MenuProblem(title: "Inbox sync failed", detail: "Check connection and mail settings.", destination: "settings") : nil)
    }
    var commands: Commands
    var accessibleStatus: String {
        "inboxtop, \(mode == "live" ? "Live" : "Ad hoc"), \(groups.act) emails need action"
    }
}
// A single template image lets macOS match the other menu bar icons in any appearance.
// Act and problems use different shapes; exact counts and mode remain in the menu.
enum MenuIcon: String {
    case idle, act, problem
    static func choose(_ state: MenuState?, problem: Bool) -> MenuIcon {
        problem ? .problem : (state?.groups.act ?? 0) > 0 ? .act : .idle
    }
    func image() -> NSImage {
        let icon = NSImage(size: NSSize(width: 20, height: 18), flipped: false) { _ in
            let symbol = NSImage(systemSymbolName: self == .problem ? "exclamationmark.triangle" : "envelope", accessibilityDescription: nil)?
                .withSymbolConfiguration(NSImage.SymbolConfiguration(pointSize: 17, weight: .bold).applying(.init(paletteColors: [.black])))
            symbol?.draw(in: NSRect(x: 0, y: 1, width: 20, height: 16))
            if self == .act {
                NSGraphicsContext.saveGraphicsState()
                // Clear a small gap so the badge stays distinct from the envelope.
                NSGraphicsContext.current?.compositingOperation = .clear
                NSBezierPath(ovalIn: NSRect(x: 10, y: -1, width: 11, height: 11)).fill()
                NSGraphicsContext.current?.compositingOperation = .sourceOver
                NSColor.black.setFill()
                NSBezierPath(ovalIn: NSRect(x: 11, y: 0, width: 9, height: 9)).fill()
                // Cut out the punctuation; white paint would become opaque when templated.
                NSGraphicsContext.current?.compositingOperation = .clear
                NSBezierPath(roundedRect: NSRect(x: 15, y: 4, width: 1.2, height: 3), xRadius: 0.5, yRadius: 0.5).fill()
                NSBezierPath(ovalIn: NSRect(x: 15, y: 1.6, width: 1.2, height: 1.2)).fill()
                NSGraphicsContext.restoreGraphicsState()
            }
            return true
        }
        icon.isTemplate = true
        return icon
    }
}
func menuSymbol(_ name: String, color: NSColor? = nil) -> NSImage? {
    let configuration = NSImage.SymbolConfiguration(pointSize: 14, weight: .medium)
    let image = NSImage(systemSymbolName: name, accessibilityDescription: nil)?
        .withSymbolConfiguration(color.map { configuration.applying(.init(paletteColors: [$0])) } ?? configuration)
    image?.size = NSSize(width: 16, height: 16)
    image?.isTemplate = color == nil
    return image
}

// Informational header only; all actions stay native menu items for keyboard/VoiceOver use.
@MainActor
final class MenuHeader: NSView {
    let dot = NSImageView()
    let mode = NSTextField(labelWithString: "Connecting…")
    let synced = NSTextField(labelWithString: "")
    let coverage = NSTextField(labelWithString: "")
    let activity = NSTextField(labelWithString: "")
    let problemTitle = NSTextField(labelWithString: "")
    let problemDetail = NSTextField(wrappingLabelWithString: "")
    init() {
        super.init(frame: NSRect(x: 0, y: 0, width: 250, height: 60))
        mode.font = .systemFont(ofSize: 13, weight: .semibold)
        mode.textColor = .labelColor
        synced.font = .systemFont(ofSize: 11)
        synced.textColor = .secondaryLabelColor
        synced.alignment = .right
        coverage.font = .systemFont(ofSize: 12)
        coverage.textColor = .secondaryLabelColor
        activity.font = .systemFont(ofSize: 12)
        activity.textColor = .labelColor
        problemTitle.font = .systemFont(ofSize: 12, weight: .semibold)
        problemTitle.textColor = .systemOrange
        problemDetail.font = .systemFont(ofSize: 12)
        problemDetail.textColor = .labelColor
        for view in [dot, mode, synced, coverage, activity, problemTitle, problemDetail] { addSubview(view) }
        for label in [mode, synced, coverage, activity] {
            label.lineBreakMode = .byTruncatingTail
        }
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }
    func refresh(state: MenuState?, attempted: Bool, pending: Bool, problem: MenuProblem? = nil) {
        let live = state?.mode == "live"
        mode.stringValue = state == nil ? (attempted ? "Disconnected" : "Connecting…") : live ? "Live" : "Ad hoc"
        dot.image = menuSymbol("circle.fill", color: live ? .systemGreen : .secondaryLabelColor)
        coverage.stringValue = state.map { "\($0.unread.map { $0.formatted() } ?? "Unknown") unread · \($0.ready.formatted()) analyzed" } ?? "Inbox counts unavailable"
        let parser = ISO8601DateFormatter()
        parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let date = state?.lastSync.flatMap { parser.date(from: $0) }
        synced.stringValue = date.map { "Synced " + DateFormatter.localizedString(from: $0, dateStyle: Calendar.current.isDateInToday($0) ? .none : .short, timeStyle: .short) } ?? (state == nil ? "" : "Not synced yet")
        synced.toolTip = date.map { DateFormatter.localizedString(from: $0, dateStyle: .full, timeStyle: .medium) }
        activity.stringValue = pending ? "Working…" : state?.progress.map { "Analyzing \($0.done) / \($0.total)" } ?? state?.activity ?? ""
        activity.isHidden = activity.stringValue.isEmpty
        problemTitle.stringValue = problem?.title ?? ""
        problemDetail.stringValue = problem?.detail ?? ""
        problemTitle.isHidden = problem == nil
        problemDetail.isHidden = problem == nil
        let problemHeight: CGFloat = problem == nil ? 0 : 64
        setFrameSize(NSSize(width: 250, height: (activity.isHidden ? 60 : 80) + problemHeight))
        let top = frame.height - 27
        dot.frame = NSRect(x: 18, y: top + 4, width: 8, height: 8)
        mode.frame = NSRect(x: 32, y: top, width: 90, height: 18)
        synced.frame = NSRect(x: 126, y: top + 1, width: 106, height: 16)
        coverage.frame = NSRect(x: 18, y: top - 22, width: 214, height: 18)
        activity.frame = NSRect(x: 18, y: 8 + problemHeight, width: 214, height: 18)
        problemTitle.frame = NSRect(x: 18, y: 43, width: 214, height: 18)
        problemDetail.frame = NSRect(x: 18, y: 8, width: 214, height: 32)
    }
}
struct Runtime: Decodable { let executable: String; let bridge: String; let directory: String }
struct BridgeResult: Sendable { let data: Data; let succeeded: Bool }

func argument(_ flag: String) -> String? {
    guard let index = CommandLine.arguments.firstIndex(of: flag), index + 1 < CommandLine.arguments.count else { return nil }
    return CommandLine.arguments[index + 1]
}

// Launch argument arrays, never a shell; keep process I/O off the main thread.
func bridge(_ runtime: Runtime, _ arguments: [String]) async -> BridgeResult {
    await Task.detached(priority: .utility) {
        let process = Process()
        let parent = Bundle.main.bundleURL.deletingLastPathComponent()
        process.executableURL = runtime.executable == "@inboxtop" ? parent.appendingPathComponent("inboxtop") : URL(fileURLWithPath: runtime.executable)
        process.arguments = [runtime.bridge] + arguments
        process.currentDirectoryURL = runtime.directory == "@bundle-parent" ? parent : URL(fileURLWithPath: runtime.directory)
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = FileHandle.nullDevice
        do {
            try process.run()
            let timeout = DispatchWorkItem { if process.isRunning { process.terminate() } }
            DispatchQueue.global().asyncAfter(deadline: .now() + 65, execute: timeout)
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            process.waitUntilExit()
            timeout.cancel()
            return BridgeResult(data: data, succeeded: process.terminationStatus == 0)
        } catch { return BridgeResult(data: Data(), succeeded: false) }
    }.value
}

@MainActor
final class MenuApp: NSObject, NSApplicationDelegate, NSMenuDelegate {
    private var item: NSStatusItem!
    private let menu = NSMenu()
    private let moreMenu = NSMenu(title: "More")
    private let header = MenuHeader()
    private var rows: [String: NSMenuItem] = [:]
    private var state: MenuState?
    private var runtime: Runtime?
    private var timer: Timer?
    private var open = false
    private var inFlight = false
    private var pending: (String, String?)?
    private var failure: String?
    private var issueDestination = "inbox"
    private var disconnected = true
    private var attempted = false
    private var failedPolls = 0
    private var nextPoll = Date.distantPast
    private let fixture = argument("--fixture")

    func applicationDidFinishLaunching(_ notification: Notification) {
        // Launch Services prevents duplicate instances of this bundle.
        NSApp.setActivationPolicy(.accessory)
        if let url = Bundle.main.url(forResource: "runtime", withExtension: "json"),
           let data = try? Data(contentsOf: url) {
            runtime = try? JSONDecoder().decode(Runtime.self, from: data)
        }
        item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        menu.autoenablesItems = false
        menu.delegate = self
        item.menu = menu
        moreMenu.autoenablesItems = false
        let heading = NSMenuItem()
        heading.view = header
        menu.addItem(heading)
        add("issue", "Open settings…", key: ",", action: "open", symbol: "gearshape")
        menu.addItem(.separator())
        add("act", "Act", key: "1", action: "open", symbol: "bolt.fill", color: .systemOrange)
        add("read", "Read", key: "2", action: "open", symbol: "book", color: .systemBlue)
        add("clear", "Low priority", key: "3", action: "open", symbol: "tray")
        add("check", "Check manually", key: "4", action: "open", symbol: "questionmark.circle", color: .systemOrange)
        menu.addItem(.separator())
        add("subscriptions", "Subscriptions", key: "l", action: "open", symbol: "newspaper", color: .systemPurple)
        add("chat", "Chat", key: "c", action: "open", symbol: "bubble.left.and.bubble.right", color: .systemTeal)
        menu.addItem(.separator())
        add("mode", "Switch to Live", key: "m", action: "mode", symbol: "play.circle")
        add("stop", "Stop analysis", key: "p", action: "stop", symbol: "stop.circle")
        add("connect", "Retry connection", key: "r", action: "connect", symbol: "arrow.clockwise")
        add("inbox", "Open inboxtop", key: "o", action: "open", symbol: "terminal")
        add("more", "More", symbol: "ellipsis.circle")
        rows["more"]?.submenu = moreMenu
        rows["more"]?.isEnabled = true
        add("sync", "Sync inbox", key: "u", action: "sync", symbol: "arrow.clockwise", parent: moreMenu)
        add("hide", "Hide menu bar icon", action: "hide", symbol: "eye.slash", parent: moreMenu)
        update()
        timer = Timer(timeInterval: 1, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.poll() }
        }
        RunLoop.main.add(timer!, forMode: .common)
        poll()
        if fixture != nil && CommandLine.arguments.contains("--smoke-test") {
            Task { @MainActor in
                while self.inFlight { try? await Task.sleep(nanoseconds: 10_000_000) }
                precondition(self.rows["act"]?.keyEquivalent == "1")
                precondition(self.rows["chat"]?.keyEquivalent == "c")
                precondition(self.item.button?.title.isEmpty == true)
                precondition(self.item.button?.image?.isTemplate == true)
                precondition(self.rows["act"]?.isEnabled == true)
                let blocking = self.state!.blockingProblem
                precondition(self.rows["issue"]?.isHidden == (blocking == nil))
                precondition(self.header.problemTitle.stringValue == (blocking?.title ?? ""))
                if blocking != nil {
                    precondition(self.rows["issue"]?.keyEquivalent == ",")
                    precondition(self.issueDestination == blocking!.destination)
                }
                let before = self.state!.mode
                self.choose(self.rows["mode"]!)
                while self.inFlight { try? await Task.sleep(nanoseconds: 10_000_000) }
                precondition(self.state!.mode != before)
                precondition(self.item.button?.title.isEmpty == true)
                precondition(self.item.button?.image?.isTemplate == true)
                let syncKey = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [], timestamp: 0, windowNumber: 0, context: nil, characters: "u", charactersIgnoringModifiers: "u", isARepeat: false, keyCode: 32)!
                precondition(self.menu.performKeyEquivalent(with: syncKey))
                while self.inFlight { try? await Task.sleep(nanoseconds: 10_000_000) }
                precondition(self.rows["sync"]?.menu === self.moreMenu)
                precondition(self.rows["hide"]?.menu === self.moreMenu)
                precondition(self.header.mode.stringValue == (self.state!.mode == "live" ? "Live" : "Ad hoc"))
                for key in ["act", "read", "clear", "check", "subscriptions", "chat", "mode", "inbox"] {
                    precondition(self.rows[key]?.image != nil)
                }
                print("PASS: monochrome status icon, compact header, action icons, More submenu and keyboard actions")
                fflush(stdout)
                self.choose(self.rows["hide"]!)
            }
        }
    }
    private func add(_ id: String, _ title: String, key: String = "", action: String? = nil,
                     symbol: String? = nil, color: NSColor? = nil, parent: NSMenu? = nil) {
        let row = NSMenuItem(title: title, action: action == nil ? nil : #selector(choose(_:)), keyEquivalent: key)
        row.keyEquivalentModifierMask = []
        row.target = self
        row.representedObject = action
        row.identifier = NSUserInterfaceItemIdentifier(id)
        row.isEnabled = action != nil
        if let symbol { row.image = menuSymbol(symbol, color: color) }
        rows[id] = row
        (parent ?? menu).addItem(row)
    }
    func menuWillOpen(_ menu: NSMenu) { open = true; nextPoll = .distantPast; poll() }
    func menuDidClose(_ menu: NSMenu) { open = false }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        nextPoll = .distantPast; poll(); return false
    }
    private func poll() {
        guard !inFlight, pending == nil, Date() >= nextPoll else { return }
        request("status")
    }
    @objc private func choose(_ sender: NSMenuItem) {
        guard let action = sender.representedObject as? String, let id = sender.identifier?.rawValue else { return }
        if action == "hide" && disconnected { NSApp.terminate(nil); return }
        guard pending == nil else { return }
        let value = action == "open" ? (id == "issue" ? issueDestination : id) : action == "mode" ? (state?.mode == "live" ? "adhoc" : "live") : nil
        pending = (action, value)
        failure = nil
        update()
        if !inFlight { request(action, value: value) }
    }
    private func request(_ command: String, value: String? = nil) {
        inFlight = true
        Task {
            if let fixture {
                if state == nil, let data = try? Data(contentsOf: URL(fileURLWithPath: fixture)) {
                    state = try? JSONDecoder().decode(MenuState.self, from: data)
                }
                if command == "mode" { state?.mode = value ?? "adhoc" }
                if command == "stop" { state?.mode = "adhoc"; state?.progress = nil; state?.activity = nil }
                if command == "hide" { NSApp.terminate(nil) }
                disconnected = state == nil
                if command == "open" { failure = "Preview only · no terminal was opened" }
            } else if let runtime {
                var args = [command]
                for flag in ["--socket", "--env", "--profile", "--cwd"] {
                    if let value = argument(flag) { args += [flag, value] }
                }
                if let value { args += ["--value", value] }
                let response = await bridge(runtime, args)
                if response.succeeded && command == "open" {
                    failure = nil
                } else if response.succeeded,
                          let loaded = try? JSONDecoder().decode(MenuState.self, from: response.data), loaded.protocol == 1 {
                    state = loaded
                    disconnected = false
                    failedPolls = 0
                    if !loaded.enabled { NSApp.terminate(nil); return }
                    if command != "status" { failure = nil }
                } else {
                    if command == "status" || command == "connect" { disconnected = true; failedPolls += 1 }
                    failure = command == "status" ? nil : command == "open"
                        ? "Could not open Terminal · check Automation permissions"
                        : "Request not confirmed · open inboxtop to check before retrying"
                }
            } else { disconnected = true; failure = "Companion build is incomplete · rebuild with npm run build:menu" }
            attempted = true
            inFlight = false
            if command != "status" { pending = nil }
            nextPoll = Date().addingTimeInterval(disconnected ? min(60, Double(max(1, failedPolls)) * 5) : open ? 3 : 5)
            update()
            if let queued = pending { request(queued.0, value: queued.1) }
        }
    }
    private func update() {
        let current = disconnected ? nil : state
        let live = current?.mode == "live"
        let blocking = attempted && disconnected
            ? MenuProblem(title: runtime == nil && fixture == nil ? "Menu helper needs rebuilding" : "Worker is not connected",
                          detail: runtime == nil && fixture == nil ? "Run npm run build:menu, then reopen." : "Retry connection or open inboxtop.", destination: "inbox")
            : current?.blockingProblem
        let notice = blocking ?? failure.map { _ in
            MenuProblem(title: "Command not completed", detail: failure?.hasPrefix("Could not open Terminal") == true
                ? "Allow Terminal in macOS Automation settings." : "Open inboxtop to check before retrying.", destination: "inbox")
        }
        let problem = blocking != nil
        item.button?.image = MenuIcon.choose(current, problem: problem).image()
        item.button?.title = ""
        item.button?.imagePosition = .imageOnly
        item.button?.contentTintColor = nil
        let accessible = current?.accessibleStatus ?? "inboxtop, disconnected, counts unavailable"
        item.button?.setAccessibilityLabel(accessible + (blocking.map { ", " + $0.title } ?? ""))
        item.button?.toolTip = accessible + (blocking.map { ", " + $0.title + ". " + $0.detail } ?? "")
        header.refresh(state: current, attempted: attempted, pending: pending != nil, problem: notice)
        issueDestination = notice?.destination == "settings" ? "settings" : "inbox"
        rows["issue"]?.title = issueDestination == "settings" ? "Open settings…" : "Open inboxtop…"
        rows["issue"]?.isHidden = notice == nil
        rows["issue"]?.isEnabled = pending == nil
        let groups: [(String, String, Int?)] = [
            ("act", "Act", current?.groups.act), ("read", "Read", current?.groups.read),
            ("clear", "Low priority", current?.groups.clear), ("check", "Check manually", current?.groups.check)
        ]
        for (id, title, count) in groups { rows[id]?.title = "\(title) · \(count.map(String.init) ?? "—")" }
        rows["subscriptions"]?.title = "Subscriptions" + (current.map { " · \($0.subscriptions)" } ?? "")
        for id in ["act", "read", "clear", "check", "subscriptions", "chat", "inbox"] {
            rows[id]?.isEnabled = pending == nil
        }
        rows["mode"]?.title = live ? "Switch to Ad hoc" : "Switch to Live"
        rows["mode"]?.isEnabled = pending == nil && current?.commands.mode == true
        rows["sync"]?.isEnabled = pending == nil && current?.commands.sync == true
        rows["stop"]?.isEnabled = pending == nil && current?.commands.stop == true
        rows["stop"]?.isHidden = current?.commands.stop != true && pending?.0 != "stop"
        rows["connect"]?.isHidden = !disconnected
        rows["connect"]?.isEnabled = pending == nil
        rows["hide"]?.title = disconnected ? "Hide until next launch" : "Hide menu bar icon"
        rows["hide"]?.isEnabled = pending == nil
    }
}

if let path = argument("--render-header"), let fixture = argument("--fixture") {
    let state = try JSONDecoder().decode(MenuState.self, from: Data(contentsOf: URL(fileURLWithPath: fixture)))
    MainActor.assumeIsolated {
        _ = NSApplication.shared
        let header = MenuHeader()
        header.refresh(state: state, attempted: true, pending: false, problem: state.blockingProblem)
        let window = NSWindow(contentRect: header.bounds, styleMask: [.borderless], backing: .buffered, defer: false)
        window.appearance = NSAppearance(named: argument("--appearance") == "dark" ? .darkAqua : .aqua)
        window.contentView = header
        header.layoutSubtreeIfNeeded()
        window.appearance!.performAsCurrentDrawingAppearance {
            let bitmap = header.bitmapImageRepForCachingDisplay(in: header.bounds)!
            header.cacheDisplay(in: header.bounds, to: bitmap)
            let canvas = NSImage(size: header.frame.size)
            canvas.lockFocus()
            NSColor.windowBackgroundColor.setFill()
            header.bounds.fill()
            let content = NSImage(size: header.frame.size)
            content.addRepresentation(bitmap)
            content.draw(in: header.bounds, from: .zero, operation: .sourceOver, fraction: 1)
            canvas.unlockFocus()
            let result = NSBitmapImageRep(data: canvas.tiffRepresentation!)!
            try! result.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: path))
        }
    }
} else if let path = argument("--render-icons") {
    let canvas = NSImage(size: NSSize(width: 300, height: 72))
    canvas.lockFocus()
    NSColor(calibratedWhite: 0.12, alpha: 1).setFill()
    NSRect(x: 0, y: 0, width: 300, height: 72).fill()
    for (index, kind) in [MenuIcon.idle, .act, .problem].enumerated() {
        let rect = NSRect(x: CGFloat(index * 100 + 40), y: 36, width: 20, height: 18)
        NSGraphicsContext.saveGraphicsState()
        let layer = NSImage(size: NSSize(width: 20, height: 18))
        layer.lockFocus()
        kind.image().draw(in: NSRect(x: 0, y: 0, width: 20, height: 18))
        NSColor.white.setFill()
        NSRect(x: 0, y: 0, width: 20, height: 18).fill(using: .sourceIn)
        layer.unlockFocus()
        layer.draw(in: rect)
        NSGraphicsContext.restoreGraphicsState()
        (kind.rawValue as NSString).draw(at: NSPoint(x: index * 100 + 30, y: 10), withAttributes: [.foregroundColor: NSColor.white, .font: NSFont.systemFont(ofSize: 12)])
    }
    canvas.unlockFocus()
    let bitmap = NSBitmapImageRep(data: canvas.tiffRepresentation!)!
    try bitmap.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: path))
} else if let path = argument("--check-fixture") {
    let state = try JSONDecoder().decode(MenuState.self, from: Data(contentsOf: URL(fileURLWithPath: path)))
    guard state.protocol == 1 else { exit(1) }
    print(state.accessibleStatus)
    print("Icon: \(MenuIcon.choose(state, problem: state.blockingProblem != nil).rawValue)")
} else {
    MainActor.assumeIsolated {
        let app = NSApplication.shared
        let delegate = MenuApp()
        app.delegate = delegate
        app.run()
    }
}
