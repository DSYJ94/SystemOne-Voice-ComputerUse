import Foundation
import ProtocolDigest

enum CheckError: Error { case invalidFixture, mismatch, acceptedInvalidValue }
guard CommandLine.arguments.count == 2 else { throw CheckError.invalidFixture }
let data = try Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))
guard let vectors = try JSONSerialization.jsonObject(with: data) as? [[String: Any]],
      vectors.count == 4 else { throw CheckError.invalidFixture }
for vector in vectors {
    guard let value = vector["value"],
          try CanonicalJSON.encode(value) == vector["canonical"] as? String,
          try CanonicalJSON.digest(value) == vector["sha256"] as? String else {
        throw CheckError.mismatch
    }
}
for value: Any in [["probability": 0.5], ["é": 1], ["epoch": Int64(9_007_199_254_740_992)]] {
    do {
        _ = try CanonicalJSON.digest(value)
        throw CheckError.acceptedInvalidValue
    } catch is CanonicalError { }
}
print("PASS: 4 shared digest vectors and 3 invalid values")
