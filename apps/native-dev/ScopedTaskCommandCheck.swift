import Foundation

@main
enum ScopedTaskCommandCheck {
    static func main() {
        precondition(ScopedNativeFill.parse("Fill Display Name with café ✓")
            == ScopedNativeFill(fieldLabel: "Display Name", value: "café ✓"))
        precondition(ScopedManagedFill.parse(
            "Fill Search on https://example.com/ with café")
            == ScopedManagedFill(url: "https://example.com/",
                                 fieldLabel: "Search", value: "café"))
        precondition(ScopedNativeFill.parse("delete this") == nil)
        precondition(ScopedManagedFill.parse("Fill Search on http://example.com/ with text") == nil)
        precondition(ScopedNativeFill.parse("Fill Name with  secret") == nil)
        print("PASS: scoped native and managed command parsing")
    }
}
