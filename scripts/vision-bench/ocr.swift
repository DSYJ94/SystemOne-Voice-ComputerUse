import AppKit
import Vision
@main struct OCR { static func main() throws {
    let root = CommandLine.arguments[1]
    let sample = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: root + "/sample.json"))) as! [[String: Any]]
    var out: [[String: Any]] = []
    for item in sample {
        let name = item["img_filename"] as! String
        guard let image = NSImage(contentsOfFile: root + "/screenspotv2_image/" + name),
              let cg = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else { out.append(["img": name, "texts": [], "ms": 0]); continue }
        let request = VNRecognizeTextRequest(); request.recognitionLevel = .accurate; request.usesLanguageCorrection = true
        let start = Date()
        try VNImageRequestHandler(cgImage: cg).perform([request])
        let ms = Int(Date().timeIntervalSince(start) * 1000)
        let w = Double(cg.width), h = Double(cg.height)
        let texts: [[String: Any]] = (request.results ?? []).compactMap { o in
            guard let c = o.topCandidates(1).first, c.confidence > 0.4 else { return nil }
            let b = o.boundingBox
            return ["text": c.string, "box": [b.minX * w, (1 - b.maxY) * h, b.width * w, b.height * h]]
        }
        out.append(["img": name, "texts": texts, "ms": ms])
    }
    try JSONSerialization.data(withJSONObject: out).write(to: URL(fileURLWithPath: root + "/ocr.json"))
    print("done", out.count)
} }
