import ExpoModulesCore

public class LoomPasskeyModule: Module {
  public func definition() -> ModuleDefinition {
    Name("LoomPasskey")

    AsyncFunction("isPlatformPasskeyAvailable") { () -> Bool in
      return true
    }

    AsyncFunction("createPasskey") { (_ options: [String: String]) throws -> [String: String] in
      throw LoomPasskeyError.notImplemented("iOS AuthenticationServices implementation must be completed before release.")
    }

    AsyncFunction("signWithPasskey") { (_ options: [String: String]) throws -> [String: String] in
      throw LoomPasskeyError.notImplemented("iOS AuthenticationServices assertion implementation must be completed before release.")
    }
  }
}

enum LoomPasskeyError: Error {
  case notImplemented(String)
}

