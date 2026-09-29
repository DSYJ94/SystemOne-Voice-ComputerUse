# Sourced by both the build and launcher. Keep one authoritative list so the
# launcher never reopens a binary older than a compiled source file.
native_dev_sources=(
  "$repository_root/apps/native-dev/main.swift"
  "$repository_root/apps/native-dev/ScopedTaskCommand.swift"
  "$repository_root/apps/native-dev/DevTaskIntake.swift"
  "$repository_root/apps/native-dev/OnDeviceSpeech.swift"
  "$repository_root/apps/native-dev/DevChromeListener.swift"
  "$repository_root/apps/native-dev/NativeFieldWorker.swift"
  "$repository_root/apps/native-dev/NativeInspectionSession.swift"
  "$repository_root/apps/native-dev/NativeWorkerPermitLedger.swift"
  "$repository_root/apps/native-dev/NativeHostPermit.swift"
  "$repository_root/apps/native-dev/NativeWorkerPermitDigest.swift"
  "$repository_root/packages/protocol/swift/Sources/PeerIdentity/PeerIdentity.swift"
  "$repository_root/packages/protocol/swift/Sources/ProtocolDigest/CanonicalJSON.swift"
  "$repository_root/packages/native-ax/Sources/NativeAX/Observation.swift"
  "$repository_root/packages/native-ax/Sources/NativeAX/SystemAXBackend.swift"
  "$repository_root/packages/native-ax/Sources/NativeAX/ValueAction.swift"
  "$repository_root/packages/native-ax/Sources/NativeAX/PressAction.swift"
)
