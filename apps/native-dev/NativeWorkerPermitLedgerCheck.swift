import Foundation

@main
struct NativeWorkerPermitLedgerCheck {
    static func main() {
        guard CommandLine.arguments.count == 5 else { exit(2) }
        do {
            let ledger = try NativeWorkerPermitLedger(
                path: URL(fileURLWithPath: CommandLine.arguments[1]))
            let consumed = ledger.consume(
                executionID: CommandLine.arguments[2],
                permitRef: CommandLine.arguments[3], taskID: "task-1",
                actionDigest: CommandLine.arguments[4])
            print(consumed ? "consumed" : "refused")
        } catch {
            print("unavailable")
        }
    }
}
