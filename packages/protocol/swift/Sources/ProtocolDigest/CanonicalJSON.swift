import Foundation
import CoreFoundation
import CryptoKit

public enum CanonicalError: Error {
    case unsupportedValue, unsafeNumber, nonASCIIKey, tooDeep
}

/// Restricted protocol-2 fixture digest format, not a JSON parser or authority gate.
public enum CanonicalJSON {
    public static func encode(_ value: Any, depth: Int = 0) throws -> String {
        guard depth <= 64 else { throw CanonicalError.tooDeep }
        if value is NSNull { return "null" }
        if let number = value as? NSNumber {
            if CFGetTypeID(number) == CFBooleanGetTypeID() {
                return number.boolValue ? "true" : "false"
            }
            let code = String(cString: number.objCType)
            guard code != "f", code != "d",
                  abs(number.doubleValue) <= 9_007_199_254_740_991 else {
                throw CanonicalError.unsafeNumber
            }
            return number.stringValue
        }
        if let string = value as? String {
            let bytes = try JSONSerialization.data(withJSONObject: string,
                options: [.fragmentsAllowed, .withoutEscapingSlashes])
            return String(decoding: bytes, as: UTF8.self)
        }
        if let array = value as? [Any] {
            return "[" + (try array.map { try encode($0, depth: depth + 1) }).joined(separator: ",") + "]"
        }
        if let object = value as? [String: Any] {
            guard object.keys.allSatisfy({ $0.utf8.allSatisfy { $0 < 128 } }) else {
                throw CanonicalError.nonASCIIKey
            }
            return "{" + (try object.keys.sorted().map { key in
                try encode(key, depth: depth + 1) + ":" + encode(object[key]!, depth: depth + 1)
            }).joined(separator: ",") + "}"
        }
        throw CanonicalError.unsupportedValue
    }

    public static func digest(_ value: Any) throws -> String {
        let bytes = Data(try encode(value).utf8)
        return SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
    }
}
