import AppKit
import Carbon.HIToolbox

/// The push-to-talk shortcut the user chose (default Control-Option-Space): hold to speak,
/// release to run. Stored as a key code plus Carbon modifier flags, with the key's name as
/// typed when it was recorded so it reads correctly on any keyboard layout.
struct TalkShortcut: Equatable {
    let keyCode: UInt32
    let modifiers: UInt32
    let keyName: String

    static let standard = TalkShortcut(keyCode: UInt32(kVK_Space), modifiers: UInt32(controlKey | optionKey), keyName: "Space")
    /// Stop stays fixed at Control-Option-Escape.
    static let stop = TalkShortcut(keyCode: UInt32(kVK_Escape), modifiers: UInt32(controlKey | optionKey), keyName: "Esc")

    static func load() -> TalkShortcut {
        let defaults = UserDefaults.standard
        guard let code = defaults.object(forKey: "talkKeyCode") as? Int, let flags = defaults.object(forKey: "talkModifiers") as? Int,
              let name = defaults.string(forKey: "talkKeyName") else { return .standard }
        return TalkShortcut(keyCode: UInt32(code), modifiers: UInt32(flags), keyName: name)
    }

    func save() {
        UserDefaults.standard.set(Int(keyCode), forKey: "talkKeyCode")
        UserDefaults.standard.set(Int(modifiers), forKey: "talkModifiers")
        UserDefaults.standard.set(keyName, forKey: "talkKeyName")
    }

    /// "⌃⌥Space", in the order macOS menus use.
    var display: String {
        var text = ""
        if modifiers & UInt32(controlKey) != 0 { text += "⌃" }
        if modifiers & UInt32(optionKey) != 0 { text += "⌥" }
        if modifiers & UInt32(shiftKey) != 0 { text += "⇧" }
        if modifiers & UInt32(cmdKey) != 0 { text += "⌘" }
        return text + keyName
    }

    /// Spoken-style name for status messages ("Control-Option-Space").
    var spoken: String {
        var parts: [String] = []
        if modifiers & UInt32(controlKey) != 0 { parts.append("Control") }
        if modifiers & UInt32(optionKey) != 0 { parts.append("Option") }
        if modifiers & UInt32(shiftKey) != 0 { parts.append("Shift") }
        if modifiers & UInt32(cmdKey) != 0 { parts.append("Command") }
        return (parts + [keyName]).joined(separator: "-")
    }

    static func carbonFlags(_ flags: NSEvent.ModifierFlags) -> UInt32 {
        var value: UInt32 = 0
        if flags.contains(.control) { value |= UInt32(controlKey) }
        if flags.contains(.option) { value |= UInt32(optionKey) }
        if flags.contains(.shift) { value |= UInt32(shiftKey) }
        if flags.contains(.command) { value |= UInt32(cmdKey) }
        return value
    }

    func matches(_ event: NSEvent) -> Bool {
        UInt32(event.keyCode) == keyCode && Self.carbonFlags(event.modifierFlags) == modifiers
    }

    private static let functionKeys: [Int: String] = [kVK_F1: "F1", kVK_F2: "F2", kVK_F3: "F3", kVK_F4: "F4", kVK_F5: "F5",
        kVK_F6: "F6", kVK_F7: "F7", kVK_F8: "F8", kVK_F9: "F9", kVK_F10: "F10", kVK_F11: "F11", kVK_F12: "F12",
        kVK_F13: "F13", kVK_F14: "F14", kVK_F15: "F15", kVK_F16: "F16", kVK_F17: "F17", kVK_F18: "F18", kVK_F19: "F19"]
    private static let named: [Int: String] = [kVK_Space: "Space", kVK_Return: "Return", kVK_Tab: "Tab",
        kVK_Delete: "Delete", kVK_LeftArrow: "←", kVK_RightArrow: "→", kVK_UpArrow: "↑", kVK_DownArrow: "↓"]

    /// A shortcut from a key press, or a reason it cannot be used.
    static func from(_ event: NSEvent) -> Result<TalkShortcut, ShortcutProblem> {
        let code = Int(event.keyCode)
        let flags = carbonFlags(event.modifierFlags)
        let function = functionKeys[code]
        if code == kVK_Escape { return .failure(.escape) }
        // Without Control, Option or Command it would fire while typing (F-keys are fine alone).
        if function == nil && flags & UInt32(controlKey | optionKey | cmdKey) == 0 { return .failure(.needsModifier) }
        let name = function ?? named[code]
            ?? (event.charactersIgnoringModifiers?.trimmingCharacters(in: .whitespaces).uppercased()).flatMap { $0.isEmpty ? nil : $0 }
            ?? "Key \(code)"
        let shortcut = TalkShortcut(keyCode: UInt32(code), modifiers: flags, keyName: name)
        return shortcut.keyCode == stop.keyCode && shortcut.modifiers == stop.modifiers ? .failure(.reserved) : .success(shortcut)
    }
}

enum ShortcutProblem: Error {
    case escape, needsModifier, reserved, taken
    var message: String {
        switch self {
        case .escape: "Esc cancels recording; choose another key."
        case .needsModifier: "Add Control, Option or Command (or use an F-key)."
        case .reserved: "That's the Stop shortcut. Choose another."
        case .taken: "Another app already uses that shortcut. Choose another."
        }
    }
}
