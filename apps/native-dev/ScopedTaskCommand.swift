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

/// "go to <site>[ and search for <words>]" or "search <site> for <words>".
/// Routing only; the controller re-parses the committed bytes authoritatively.
struct ScopedBrowse: Equatable {
    let site: String

    /// Identical to BARE_SITES in scoped-native-command.ts.
    static let bareSites = ["wikipedia": "wikipedia.org", "wiki": "wikipedia.org", "bbc": "bbc.co.uk",
                            "python": "python.org", "mozilla": "mozilla.org", "archive": "archive.org",
                            "gov": "gov.uk"]

    static func parse(_ text: String) -> Self? {
        guard text.utf8.count <= 1_300 else { return nil }
        let patterns = [#"^(?:go to|open|visit|navigate to) (\S+?)(?: and (?:search|look up|find)(?: for)? .+)?$"#,
                        #"^search (\S+) for .+$"#]
        for pattern in patterns {
            guard let regex = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]),
                  let match = regex.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)),
                  let range = Range(match.range(at: 1), in: text) else { continue }
            let site = String(text[range]).lowercased()
            if site.range(of: #"^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$"#, options: .regularExpression) != nil {
                return Self(site: bareSites[site] ?? "\(site).com")
            }
            if site.range(of: #"^(?:http://)?127\.0\.0\.1:\d{1,5}/?$"#, options: .regularExpression) != nil
                || site.replacingOccurrences(of: "https://", with: "").trimmingCharacters(in: CharacterSet(charactersIn: "/"))
                    .range(of: #"^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$"#, options: .regularExpression) != nil {
                return Self(site: site)
            }
        }
        return nil
    }

    /// Spoken transcripts: "wikipedia dot org" → "wikipedia.org", no trailing punctuation.
    static func normalizedSpeech(_ text: String) -> String {
        var value = text.trimmingCharacters(in: .whitespacesAndNewlines)
        while let last = value.last, ".!?,".contains(last) { value.removeLast() }
        return value.replacingOccurrences(of: #"(?i)\s+dot\s+(?=[a-z]{2,63}\b)"#, with: ".",
                                          options: .regularExpression)
    }
}
