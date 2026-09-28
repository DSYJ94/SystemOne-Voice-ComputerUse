import Foundation

/// The initial real-app command grammar. An unmatched request never becomes an
/// action; the controller parses the same committed bytes again before I/O.
struct ScopedNativeFill: Equatable {
    let fieldLabel: String
    let value: String

    static func parse(_ text: String) -> Self? {
        guard text.utf8.count <= 1_300,
              text.range(of: "Fill ", options: [.anchored, .caseInsensitive]) != nil,
              let separator = text.range(of: " with ", options: .caseInsensitive) else {
            return nil
        }
        let label = String(text[text.index(text.startIndex, offsetBy: 5)..<separator.lowerBound])
        let value = String(text[separator.upperBound...])
        guard !label.isEmpty, label.count <= 160, !value.isEmpty,
              value.utf8.count <= 1_024,
              label == label.trimmingCharacters(in: .whitespacesAndNewlines),
              value == value.trimmingCharacters(in: .whitespacesAndNewlines) else {
            return nil
        }
        return Self(fieldLabel: label, value: value)
    }
}

struct ScopedManagedFill: Equatable {
    let url: String
    let fieldLabel: String
    let value: String

    static func parse(_ text: String) -> Self? {
        guard text.utf8.count <= 3_350,
              text.range(of: "Fill ", options: [.anchored, .caseInsensitive]) != nil,
              let on = text.range(of: " on ", options: .caseInsensitive),
              let with = text.range(of: " with ", options: .caseInsensitive,
                                    range: on.upperBound..<text.endIndex) else {
            return nil
        }
        let label = String(text[text.index(text.startIndex, offsetBy: 5)..<on.lowerBound])
        let url = String(text[on.upperBound..<with.lowerBound])
        let value = String(text[with.upperBound...])
        guard !label.isEmpty, label.count <= 160, !value.isEmpty,
              value.utf8.count <= 1_024, url.utf8.count <= 2_048,
              label == label.trimmingCharacters(in: .whitespacesAndNewlines),
              value == value.trimmingCharacters(in: .whitespacesAndNewlines),
              let parsed = URLComponents(string: url),
              parsed.user == nil, parsed.password == nil,
              parsed.host != nil,
              parsed.scheme == "https" || (parsed.scheme == "http"
                                           && parsed.host == "127.0.0.1") else {
            return nil
        }
        return Self(url: url, fieldLabel: label, value: value)
    }
}
