import Foundation
import CoreServices
import AppKit

// The caller owns the dev-only scheme; production abu:// never reaches this helper.
let scheme = CommandLine.arguments[1]
let bundleId = CommandLine.arguments[2]
let expectedApp = URL(fileURLWithPath: CommandLine.arguments[3]).resolvingSymlinksInPath()
let status = LSSetDefaultHandlerForURLScheme(scheme as CFString, bundleId as CFString)
let handler = NSWorkspace.shared.urlForApplication(toOpen: URL(string: "\(scheme)://login")!)
guard status == noErr, handler?.resolvingSymlinksInPath() == expectedApp else {
    FileHandle.standardError.write(Data("[dev-shell] LaunchServices registration failed (status \(status), handler \(handler?.path ?? "none"))\n".utf8))
    exit(1)
}
