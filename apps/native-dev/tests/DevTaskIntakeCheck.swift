import Foundation

@main
struct DevTaskIntakeCheck {
    @MainActor static func main() {
        let intake = DevTaskIntake()
        var sent: [[String: Any]] = []
        let text = "Fill Fixture Name with fixture-123"
        let target = DevTaskIntake.NativeTarget.captured(
            bundleID: "com.example.target", pid: 123, launchMillis: 4_567)
        let native = DevTaskIntake.Intent.nativeFill(target: target,
            field: "Fixture Name", value: "fixture-123")

        precondition(!intake.submit(native, originalText: text, voice: true,
            send: { _ in false }))
        precondition(intake.activeRequestID == nil && sent.isEmpty,
            "failed delivery must not occupy the writer")

        precondition(intake.submit(native, originalText: text, voice: true,
            send: { request in sent.append(request); return true }))
        guard let first = sent.last,
              let firstID = first["requestId"] as? String,
              let firstCommand = first["command"] as? [String: Any] else {
            fatalError("native request missing committed command")
        }
        precondition(first["type"] as? String == "start_native_fill")
        precondition(first["bundleId"] as? String == "com.example.target")
        precondition(first["targetPid"] as? Int == 123)
        precondition(first["targetLaunchMillis"] as? Int64 == 4_567)
        precondition(firstCommand["taskId"] as? String == firstID)
        precondition(firstCommand["source"] as? String == "voice")
        precondition(firstCommand["text"] as? String == text)
        precondition(firstCommand["isFinal"] as? Bool == true)
        precondition(intake.activeSurface == .native)

        precondition(!intake.submit(.managedFill(url: "https://example.test/",
            field: "Name", value: "test"), send: { _ in
                fatalError("second task dispatched while writer occupied")
            }))
        intake.releaseIfReady(requestID: "stale-request")
        precondition(intake.activeRequestID == firstID,
                     "stale ready must not release the writer")
        intake.releaseIfReady(requestID: firstID)
        precondition(intake.activeRequestID == nil && intake.activeSurface == nil)

        precondition(intake.submit(.managedNavigate(url: "https://example.test/",
            label: "Next", destination: "https://example.test/next"),
            send: { request in sent.append(request); return true }))
        guard let navigate = sent.last,
              let navigateCommand = navigate["command"] as? [String: Any],
              let navigateID = navigate["requestId"] as? String else {
            fatalError("navigation request missing command")
        }
        precondition(navigate["type"] as? String == "start_navigate")
        precondition(navigate["destinationUrl"] as? String ==
                     "https://example.test/next")
        precondition(navigateCommand["text"] as? String ==
                     "Navigate via Next on https://example.test/ to https://example.test/next")
        precondition(navigateCommand["source"] as? String == "text")
        intake.releaseIfReady(requestID: navigateID)

        precondition(intake.submit(.managedFill(url: "https://example.test/",
            field: "Name", value: "test"),
            send: { request in sent.append(request); return true }))
        guard let managed = sent.last,
              let managedCommand = managed["command"] as? [String: Any],
              let managedID = managed["requestId"] as? String else {
            fatalError("managed fill request missing")
        }
        precondition(managed["type"] as? String == "start_fill")
        precondition(managedCommand["text"] as? String ==
            "Fill Name on https://example.test/ with text: test")
        intake.releaseIfReady(requestID: managedID)

        precondition(intake.submit(.nativeFill(target: .explicit(
            bundleID: "com.example.target"), field: "Name", value: "test"),
            send: { request in sent.append(request); return true }))
        guard let explicit = sent.last,
              let explicitCommand = explicit["command"] as? [String: Any],
              let explicitID = explicit["requestId"] as? String else {
            fatalError("explicit native fill request missing")
        }
        precondition(explicit["type"] as? String == "start_native_fill")
        precondition(explicit["targetPid"] == nil)
        precondition(explicitCommand["text"] as? String ==
            "Fill Name in com.example.target with text: test")
        intake.releaseIfReady(requestID: explicitID)

        precondition(intake.submit(.portal(url: "http://127.0.0.1:1234/"),
            send: { request in sent.append(request); return true }))
        guard let portal = sent.last,
              let portalCommand = portal["command"] as? [String: Any],
              let portalID = portal["requestId"] as? String else {
            fatalError("portal request missing")
        }
        precondition(portal["type"] as? String == "start_portal_workflow")
        precondition(portalCommand["text"] as? String ==
            "Download fixture invoice INV-105 from http://127.0.0.1:1234/")
        intake.releaseIfReady(requestID: portalID)

        precondition(intake.submit(.fixtureDocuments,
            send: { request in sent.append(request); return true }))
        guard let documents = sent.last,
              let documentsCommand = documents["command"] as? [String: Any],
              let documentsID = documents["requestId"] as? String else {
            fatalError("fixture Documents request missing")
        }
        precondition(documents["type"] as? String == "start_native_press")
        precondition(documentsCommand["text"] as? String ==
            "Navigate synthetic fixture to Documents")
        intake.releaseIfReady(requestID: documentsID)

        for (open, expectedType, expectedTitle) in [
            (false, "start_native_locate", "SystemOne Fixture — Documents — Budget.xlsx selected"),
            (true, "start_native_open", "SystemOne Fixture — Documents — Budget.xlsx opened"),
        ] {
            precondition(intake.submit(.fixtureFile(open: open),
                send: { request in sent.append(request); return true }))
            guard let request = sent.last, let id = request["requestId"] as? String else {
                fatalError("fixture request missing")
            }
            precondition(request["type"] as? String == expectedType)
            precondition(request["expectedWindowTitle"] as? String == expectedTitle)
            intake.releaseIfReady(requestID: id)
        }

        precondition(intake.submit(.chromeFill(connectionID: "connection-1",
            grantID: "grant-1", url: "http://127.0.0.1:1234/",
            field: "Find invoice", value: "INV-105"),
            send: { request in sent.append(request); return true }))
        guard let chrome = sent.last,
              let chromeCommand = chrome["command"] as? [String: Any] else {
            fatalError("Chrome request missing")
        }
        precondition(chrome["type"] as? String == "start_chrome_fill")
        precondition(chrome["grantId"] as? String == "grant-1")
        precondition(chromeCommand["text"] as? String ==
            "Fill Find invoice in existing Chrome tab http://127.0.0.1:1234/ with text: INV-105")
        intake.releaseIfReady(requestID: intake.activeRequestID!)
        precondition(intake.submit(.fixtureFile(open: true), send: { request in sent.append(request); return true }))
        let sourceID = intake.activeRequestID!
        precondition(!intake.replaceFixture(.fixtureFile(open: true), send: { _ in fatalError("unchanged goal sent") }))
        precondition(!intake.replaceFixture(.fixtureDocuments, send: { _ in false }))
        precondition(intake.replacementRequestID == nil && intake.activeRequestID == sourceID)
        precondition(intake.replaceFixture(.fixtureFile(open: false), send: { request in sent.append(request); return true }))
        let replacementID = intake.replacementRequestID!
        let request = sent.last!
        let payload = request["replacement"] as! [String: Any]
        let correction = payload["command"] as! [String: Any]
        precondition(correction["taskId"] as? String == sourceID && correction["goalRevision"] as? Int == 2)
        precondition(intake.activeRequestID == sourceID)
        precondition(!intake.replaceFixture(.fixtureDocuments, send: { _ in fatalError("concurrent replacement sent") }))
        var handoff: [String: Any] = ["type": "native_replacement_task", "requestId": replacementID,
            "targetRequestId": sourceID, "taskId": replacementID, "taskEpoch": 1, "goalRevision": 2, "mode": "locate"]
        handoff["goalRevision"] = 3
        precondition(!intake.acceptReplacement(handoff))
        handoff["goalRevision"] = 2
        precondition(intake.acceptReplacement(handoff))
        precondition(intake.activeRequestID == replacementID && intake.activeSurface == .nativeLocate)
        precondition(intake.activeGoalRevision == 2 && intake.replacementRequestID == nil)
        precondition(!intake.acceptReplacement(handoff))
        intake.releaseIfReady(requestID: sourceID)
        precondition(intake.activeRequestID == replacementID)
        precondition(intake.replaceFixture(.fixtureDocuments, send: { request in sent.append(request); return true }))
        let rejectedID = intake.replacementRequestID!
        let thirdPayload = sent.last!["replacement"] as! [String: Any]
        precondition((thirdPayload["command"] as! [String: Any])["goalRevision"] as? Int == 3)
        intake.rejectReplacement(requestID: "stale")
        precondition(intake.replacementRequestID == rejectedID)
        intake.rejectReplacement(requestID: rejectedID)
        precondition(intake.replacementRequestID == nil && intake.activeRequestID == replacementID)
        intake.releaseIfReady(requestID: replacementID)
        precondition(intake.activeGoalRevision == 1)
        precondition(!intake.replaceField(field: "Name", value: "new", send: { _ in fatalError("no retained target") }))
        precondition(intake.submit(native, send: { request in sent.append(request); return true }))
        let fieldSourceID = intake.activeRequestID!
        precondition(!intake.replaceField(field: "Fixture Name", value: "fixture-123", send: { _ in fatalError("unchanged field goal") }))
        precondition(!intake.replaceField(field: "", value: "new", send: { _ in fatalError("empty field") }))
        precondition(!intake.replaceField(field: "Name", value: String(repeating: "a", count: 1025), send: { _ in fatalError("overflow") }))
        precondition(!intake.replaceField(field: "Name", value: "new", send: { _ in false }))
        precondition(intake.replacementRequestID == nil && intake.activeRequestID == fieldSourceID)
        precondition(intake.replaceField(field: "Fixture Notes", value: "changed 😀", send: { request in sent.append(request); return true }))
        let fieldChildID = intake.replacementRequestID!
        let fieldRequest = sent.last!
        precondition(fieldRequest["type"] as? String == "replace_native_field")
        let fieldPayload = fieldRequest["replacement"] as! [String: Any]
        precondition(fieldPayload["bundleId"] as? String == "com.example.target")
        precondition(fieldPayload["targetPid"] as? Int == 123 && fieldPayload["targetLaunchMillis"] as? Int64 == 4567)
        let fieldCommand = fieldPayload["command"] as! [String: Any]
        precondition(fieldCommand["taskId"] as? String == fieldSourceID && fieldCommand["goalRevision"] as? Int == 2)
        precondition(fieldCommand["text"] as? String == "Fill Fixture Notes in com.example.target with text: changed 😀")
        precondition(!intake.replaceField(field: "Name", value: "other", send: { _ in fatalError("concurrent correction") }))
        var fieldHandoff: [String: Any] = ["type": "native_replacement_task", "requestId": fieldChildID,
            "targetRequestId": fieldSourceID, "taskId": fieldChildID, "taskEpoch": 1, "goalRevision": 2, "mode": "locate"]
        precondition(!intake.acceptReplacement(fieldHandoff))
        fieldHandoff["mode"] = "fill"
        precondition(intake.acceptReplacement(fieldHandoff))
        intake.releaseIfReady(requestID: fieldSourceID)
        precondition(intake.activeRequestID == fieldChildID && intake.activeGoalRevision == 2)
        precondition(!intake.replaceField(field: "Fixture Notes", value: "changed 😀", send: { _ in fatalError("unchanged child goal") }))
        precondition(intake.replaceField(field: "Fixture Notes", value: "", send: { request in sent.append(request); return true }))
        let nextFieldPayload = sent.last!["replacement"] as! [String: Any]
        precondition(nextFieldPayload["value"] as? String == "" && nextFieldPayload["targetPid"] as? Int == 123)
        precondition((nextFieldPayload["command"] as! [String: Any])["goalRevision"] as? Int == 3)
        intake.rejectReplacement(requestID: intake.replacementRequestID!)
        intake.releaseIfReady(requestID: fieldChildID)
        precondition(!intake.replaceField(field: "Name", value: "new", send: { _ in fatalError("released field target") }))
        print("task intake keeps one writer and binds committed command bytes")
    }
}
