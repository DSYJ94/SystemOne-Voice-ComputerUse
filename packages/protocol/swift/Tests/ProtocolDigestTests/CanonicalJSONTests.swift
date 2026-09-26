import Foundation
import XCTest
@testable import ProtocolDigest

final class CanonicalJSONTests: XCTestCase {
    func testSharedGoldenVectors() throws {
        var root = URL(fileURLWithPath: #filePath)
        for _ in 0..<6 { root.deleteLastPathComponent() }
        let data = try Data(contentsOf: root.appendingPathComponent("tests/fixtures/digests.json"))
        let vectors = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [[String: Any]])
        XCTAssertEqual(vectors.count, 4)
        for vector in vectors {
            let value = try XCTUnwrap(vector["value"])
            XCTAssertEqual(try CanonicalJSON.encode(value), vector["canonical"] as? String)
            XCTAssertEqual(try CanonicalJSON.digest(value), vector["sha256"] as? String)
        }
    }

    func testRejectsNonportableValues() {
        XCTAssertThrowsError(try CanonicalJSON.digest(["probability": 0.5]))
        XCTAssertThrowsError(try CanonicalJSON.digest(["é": 1]))
        XCTAssertThrowsError(try CanonicalJSON.digest(["epoch": Int64(9_007_199_254_740_992)]))
    }
}
