import AppKit
import ApplicationServices
import Foundation

public enum SystemAXError: Error {
    case notTrusted
    case unavailable(AXError)
    case invalidData
}

/// Read-only macOS Accessibility adapter. The caller supplies an approved app
/// identity and runs the registry on a serial worker; no UI or process activation
/// is performed here. Attribute values, including text-field contents, are never
/// requested. Descriptions still may contain private data and need host review
/// before any provider disclosure.
public struct SystemAXBackend: AXObservationBackend {
    public typealias Handle = AXUIElement

    public init() {}

    public func isCurrentTarget(_ target: AXTarget) -> Bool {
        guard target.pid > 0,
              let app = NSRunningApplication(processIdentifier: target.pid),
              !app.isTerminated,
              app.bundleIdentifier == target.bundleID,
              app.launchDate == target.launchDate,
              let bundleURL = app.bundleURL else { return false }
        return bundleURL.resolvingSymlinksInPath().standardizedFileURL ==
            target.bundleURL.resolvingSymlinksInPath().standardizedFileURL
    }

    public func root(for target: AXTarget) throws -> AXUIElement {
        guard AXIsProcessTrusted() else { throw SystemAXError.notTrusted }
        guard isCurrentTarget(target) else { throw AXObservationError.targetChanged }
        let root = AXUIElementCreateApplication(target.pid)
        let status = AXUIElementSetMessagingTimeout(root, 0.5)
        guard status == .success else { throw SystemAXError.unavailable(status) }
        return root
    }

    public func describe(_ handle: AXUIElement) throws -> AXDescription {
        let timeout = AXUIElementSetMessagingTimeout(handle, 0.5)
        guard timeout == .success else { throw SystemAXError.unavailable(timeout) }
        guard let role = stringAttribute(handle, kAXRoleAttribute) else {
            throw SystemAXError.invalidData
        }
        let secure = stringAttribute(handle, kAXSubroleAttribute) ==
            (kAXSecureTextFieldSubrole as String)
        let label = secure ? "" : (stringAttribute(handle, kAXDescriptionAttribute)
            ?? stringAttribute(handle, kAXTitleAttribute) ?? "")
        let enabled = boolAttribute(handle, kAXEnabledAttribute) ?? false
        var capabilities: [String] = []
        var actionNames: CFArray?
        if AXUIElementCopyActionNames(handle, &actionNames) == .success,
           let names = actionNames as? [String] {
            if names.contains(kAXPressAction as String) { capabilities.append("press") }
        }
        if !secure {
            var settable = DarwinBoolean(false)
            if AXUIElementIsAttributeSettable(handle, kAXValueAttribute as CFString,
                                               &settable) == .success,
               settable.boolValue { capabilities.append("setValue") }
        }
        return AXDescription(role: role, label: String(label.prefix(256)),
                             enabled: enabled, secure: secure,
                             capabilities: capabilities, bounds: bounds(handle))
    }

    public func children(of handle: AXUIElement, limit: Int) throws -> AXChildPage<AXUIElement> {
        guard limit > 0 else { throw SystemAXError.invalidData }
        let timeout = AXUIElementSetMessagingTimeout(handle, 0.5)
        guard timeout == .success else { throw SystemAXError.unavailable(timeout) }
        var count: CFIndex = 0
        let countStatus = AXUIElementGetAttributeValueCount(handle,
                                                            kAXChildrenAttribute as CFString,
                                                            &count)
        if countStatus == .noValue || countStatus == .attributeUnsupported {
            return AXChildPage(handles: [], hasMore: false)
        }
        guard countStatus == .success, count >= 0 else {
            throw SystemAXError.unavailable(countStatus)
        }
        if count == 0 { return AXChildPage(handles: [], hasMore: false) }
        var values: CFArray?
        let status = AXUIElementCopyAttributeValues(handle,
                                                     kAXChildrenAttribute as CFString,
                                                     0, min(count, limit), &values)
        guard status == .success, let items = values as? [AXUIElement] else {
            throw SystemAXError.unavailable(status)
        }
        return AXChildPage(handles: items, hasMore: count > limit)
    }

    public func belongsToTarget(_ handle: AXUIElement, target: AXTarget) -> Bool {
        guard AXUIElementSetMessagingTimeout(handle, 0.5) == .success else { return false }
        var pid: pid_t = 0
        return AXUIElementGetPid(handle, &pid) == .success && pid == target.pid
    }

    private func stringAttribute(_ handle: AXUIElement, _ key: String) -> String? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(handle, key as CFString, &value) == .success
        else { return nil }
        return value as? String
    }

    private func boolAttribute(_ handle: AXUIElement, _ key: String) -> Bool? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(handle, key as CFString, &value) == .success
        else { return nil }
        return value as? Bool
    }

    private func bounds(_ handle: AXUIElement) -> AXBounds? {
        var positionValue: CFTypeRef?
        var sizeValue: CFTypeRef?
        guard AXUIElementCopyAttributeValue(handle, kAXPositionAttribute as CFString,
                                             &positionValue) == .success,
              AXUIElementCopyAttributeValue(handle, kAXSizeAttribute as CFString,
                                             &sizeValue) == .success,
              let position = positionValue,
              let size = sizeValue,
              CFGetTypeID(position) == AXValueGetTypeID(),
              CFGetTypeID(size) == AXValueGetTypeID() else { return nil }
        var point = CGPoint.zero
        var dimensions = CGSize.zero
        guard AXValueGetValue(position as! AXValue, .cgPoint, &point),
              AXValueGetValue(size as! AXValue, .cgSize, &dimensions) else { return nil }
        return AXBounds(x: point.x, y: point.y,
                        width: dimensions.width, height: dimensions.height)
    }
}
