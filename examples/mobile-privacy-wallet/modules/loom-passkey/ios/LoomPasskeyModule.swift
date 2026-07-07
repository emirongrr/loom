import AuthenticationServices
import CryptoKit
import ExpoModulesCore
import Foundation
import UIKit

public class LoomPasskeyModule: Module {
  private let session = LoomPasskeySession()

  public func definition() -> ModuleDefinition {
    Name("LoomPasskey")

    AsyncFunction("isPlatformPasskeyAvailable") { () -> Bool in
      if #available(iOS 16.0, *) {
        return true
      }
      return false
    }

    AsyncFunction("createPasskey") { (options: [String: String], promise: Promise) in
      if #available(iOS 16.0, *) {
        session.createPasskey(options: options, promise: promise)
      } else {
        promise.reject("ERR_PASSKEY_UNAVAILABLE", "Platform passkeys require iOS 16 or later.")
      }
    }

    AsyncFunction("signWithPasskey") { (options: [String: String], promise: Promise) in
      if #available(iOS 16.0, *) {
        session.signWithPasskey(options: options, promise: promise)
      } else {
        promise.reject("ERR_PASSKEY_UNAVAILABLE", "Platform passkeys require iOS 16 or later.")
      }
    }
  }
}

@available(iOS 16.0, *)
final class LoomPasskeySession: NSObject, ASAuthorizationControllerDelegate, ASAuthorizationControllerPresentationContextProviding {
  private var pendingPromise: Promise?
  private var pendingKind: PendingKind?
  private var pendingRpId: String?

  enum PendingKind {
    case registration
    case assertion
  }

  func createPasskey(options: [String: String], promise: Promise) {
    guard let rpId = options["rpId"], let challenge = Data(hex: options["challenge"]),
      let userName = options["userName"], let displayName = options["displayName"]
    else {
      promise.reject("ERR_PASSKEY_INPUT", "Passkey registration requires rpId, challenge, userName, and displayName.")
      return
    }

    pendingPromise = promise
    pendingKind = .registration
    pendingRpId = rpId

    let provider = ASAuthorizationPlatformPublicKeyCredentialProvider(relyingPartyIdentifier: rpId)
    let userId = SHA256.hash(data: Data(userName.utf8)).data
    let request = provider.createCredentialRegistrationRequest(
      challenge: challenge,
      name: userName,
      userID: userId
    )
    request.displayName = displayName
    request.attestationPreference = .none
    request.userVerificationPreference = .required

    let controller = ASAuthorizationController(authorizationRequests: [request])
    controller.delegate = self
    controller.presentationContextProvider = self
    controller.performRequests()
  }

  func signWithPasskey(options: [String: String], promise: Promise) {
    guard let rpId = options["rpId"], let challenge = Data(hex: options["challenge"]) else {
      promise.reject("ERR_PASSKEY_INPUT", "Passkey assertion requires rpId and challenge.")
      return
    }

    pendingPromise = promise
    pendingKind = .assertion
    pendingRpId = rpId

    let provider = ASAuthorizationPlatformPublicKeyCredentialProvider(relyingPartyIdentifier: rpId)
    let request = provider.createCredentialAssertionRequest(challenge: challenge)
    request.userVerificationPreference = .required

    let controller = ASAuthorizationController(authorizationRequests: [request])
    controller.delegate = self
    controller.presentationContextProvider = self
    controller.performRequests()
  }

  func authorizationController(controller: ASAuthorizationController, didCompleteWithAuthorization authorization: ASAuthorization) {
    guard let promise = pendingPromise, let rpId = pendingRpId, let kind = pendingKind else {
      return
    }
    defer {
      pendingPromise = nil
      pendingKind = nil
      pendingRpId = nil
    }

    do {
      switch (kind, authorization.credential) {
      case (.registration, let credential as ASAuthorizationPlatformPublicKeyCredentialRegistration):
        guard let attestationObject = credential.rawAttestationObject else {
          throw LoomPasskeyError.invalidCredential("Registration omitted attestation object; cannot extract P-256 public key.")
        }
        let publicKey = try LoomWebAuthn.extractP256PublicKey(attestationObject: attestationObject)
        let origin = try LoomWebAuthn.origin(fromClientDataJSON: credential.rawClientDataJSON)
        promise.resolve([
          "publicKeyX": publicKey.x.hexString,
          "publicKeyY": publicKey.y.hexString,
          "credentialIdHash": SHA256.hash(data: credential.credentialID).data.hexString,
          "rpId": rpId,
          "origin": origin
        ])
      case (.assertion, let credential as ASAuthorizationPlatformPublicKeyCredentialAssertion):
        let signature = try LoomWebAuthn.normalizeEcdsaSignature(credential.signature)
        promise.resolve([
          "authenticatorData": credential.rawAuthenticatorData.hexString,
          "clientDataJSON": credential.rawClientDataJSON.hexString,
          "signature": signature.hexString,
          "userHandle": credential.userID.hexString
        ])
      default:
        throw LoomPasskeyError.invalidCredential("Unexpected passkey credential type.")
      }
    } catch {
      promise.reject("ERR_PASSKEY_RESULT", error.localizedDescription)
    }
  }

  func authorizationController(controller: ASAuthorizationController, didCompleteWithError error: Error) {
    pendingPromise?.reject("ERR_PASSKEY_AUTHORIZATION", error.localizedDescription)
    pendingPromise = nil
    pendingKind = nil
    pendingRpId = nil
  }

  func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
    guard let window = UIApplication.shared.connectedScenes
      .compactMap({ $0 as? UIWindowScene })
      .flatMap({ $0.windows })
      .first(where: { $0.isKeyWindow })
    else {
      return ASPresentationAnchor()
    }
    return window
  }
}

enum LoomPasskeyError: LocalizedError {
  case invalidCredential(String)
  case unsupportedCbor(String)

  var errorDescription: String? {
    switch self {
    case .invalidCredential(let message), .unsupportedCbor(let message):
      return message
    }
  }
}

struct LoomP256PublicKey {
  let x: Data
  let y: Data
}

enum LoomWebAuthn {
  static func extractP256PublicKey(attestationObject: Data) throws -> LoomP256PublicKey {
    var reader = LoomCborReader(attestationObject)
    let attestation = try reader.readMap()
    guard let authData = attestation["authData"]?.bytes else {
      throw LoomPasskeyError.invalidCredential("Attestation object does not contain authenticator data.")
    }
    return try extractP256PublicKey(authenticatorData: authData)
  }

  static func extractP256PublicKey(authenticatorData: Data) throws -> LoomP256PublicKey {
    guard authenticatorData.count > 55 else {
      throw LoomPasskeyError.invalidCredential("Authenticator data is too short.")
    }
    let flags = authenticatorData[32]
    guard flags & 0x40 == 0x40 else {
      throw LoomPasskeyError.invalidCredential("Authenticator data does not include attested credential data.")
    }

    var offset = 37 + 16
    let credentialIdLength = Int(authenticatorData[offset]) << 8 | Int(authenticatorData[offset + 1])
    offset += 2 + credentialIdLength
    guard offset < authenticatorData.count else {
      throw LoomPasskeyError.invalidCredential("Authenticator credential id length is invalid.")
    }

    var reader = LoomCborReader(authenticatorData.subdata(in: offset..<authenticatorData.count))
    let coseKey = try reader.readIntMap()
    guard coseKey[1]?.int == 2, coseKey[3]?.int == -7, coseKey[-1]?.int == 1,
      let x = coseKey[-2]?.bytes, let y = coseKey[-3]?.bytes, x.count == 32, y.count == 32
    else {
      throw LoomPasskeyError.invalidCredential("Credential public key is not ES256 P-256.")
    }
    return LoomP256PublicKey(x: x, y: y)
  }

  static func origin(fromClientDataJSON data: Data) throws -> String {
    let value = try JSONSerialization.jsonObject(with: data)
    guard let object = value as? [String: Any], let origin = object["origin"] as? String else {
      throw LoomPasskeyError.invalidCredential("Client data JSON does not contain origin.")
    }
    return origin
  }

  static func normalizeEcdsaSignature(_ derSignature: Data) throws -> Data {
    var reader = LoomDerReader(derSignature)
    return try reader.readP256Signature()
  }
}

struct LoomCborValue {
  let int: Int?
  let text: String?
  let bytes: Data?
}

struct LoomCborReader {
  private let data: Data
  private var offset: Int = 0

  init(_ data: Data) {
    self.data = data
  }

  mutating func readMap() throws -> [String: LoomCborValue] {
    let count = try readHeader(expectedMajor: 5)
    var result: [String: LoomCborValue] = [:]
    for _ in 0..<count {
      let key = try readText()
      result[key] = try readValue()
    }
    return result
  }

  mutating func readIntMap() throws -> [Int: LoomCborValue] {
    let count = try readHeader(expectedMajor: 5)
    var result: [Int: LoomCborValue] = [:]
    for _ in 0..<count {
      let key = try readInt()
      result[key] = try readValue()
    }
    return result
  }

  private mutating func readValue() throws -> LoomCborValue {
    let initial = try readByte()
    let major = initial >> 5
    offset -= 1
    switch major {
    case 0, 1:
      return LoomCborValue(int: try readInt(), text: nil, bytes: nil)
    case 2:
      return LoomCborValue(int: nil, text: nil, bytes: try readBytes())
    case 3:
      return LoomCborValue(int: nil, text: try readText(), bytes: nil)
    default:
      throw LoomPasskeyError.unsupportedCbor("Unsupported CBOR value in passkey response.")
    }
  }

  private mutating func readBytes() throws -> Data {
    let count = try readHeader(expectedMajor: 2)
    guard offset + count <= data.count else {
      throw LoomPasskeyError.unsupportedCbor("CBOR byte string is truncated.")
    }
    defer { offset += count }
    return data.subdata(in: offset..<(offset + count))
  }

  private mutating func readText() throws -> String {
    let bytes = try readHeader(expectedMajor: 3)
    guard offset + bytes <= data.count, let value = String(data: data.subdata(in: offset..<(offset + bytes)), encoding: .utf8) else {
      throw LoomPasskeyError.unsupportedCbor("CBOR text string is invalid.")
    }
    offset += bytes
    return value
  }

  private mutating func readInt() throws -> Int {
    let initial = try readByte()
    let major = initial >> 5
    let value = try readArgument(initial)
    if major == 0 {
      return value
    }
    if major == 1 {
      return -1 - value
    }
    throw LoomPasskeyError.unsupportedCbor("Expected CBOR integer.")
  }

  private mutating func readHeader(expectedMajor: UInt8) throws -> Int {
    let initial = try readByte()
    guard initial >> 5 == expectedMajor else {
      throw LoomPasskeyError.unsupportedCbor("Unexpected CBOR major type.")
    }
    return try readArgument(initial)
  }

  private mutating func readArgument(_ initial: UInt8) throws -> Int {
    let info = initial & 0x1f
    if info < 24 {
      return Int(info)
    }
    if info == 24 {
      return Int(try readByte())
    }
    if info == 25 {
      return Int(try readByte()) << 8 | Int(try readByte())
    }
    throw LoomPasskeyError.unsupportedCbor("Unsupported CBOR length encoding.")
  }

  private mutating func readByte() throws -> UInt8 {
    guard offset < data.count else {
      throw LoomPasskeyError.unsupportedCbor("Unexpected end of CBOR data.")
    }
    defer { offset += 1 }
    return data[offset]
  }
}

struct LoomDerReader {
  private let data: Data
  private var offset: Int = 0

  init(_ data: Data) {
    self.data = data
  }

  mutating func readP256Signature() throws -> Data {
    guard try readByte() == 0x30 else {
      throw LoomPasskeyError.invalidCredential("ECDSA signature is not DER encoded.")
    }
    _ = try readLength()
    let r = try readInteger()
    let s = try readInteger()
    return leftPad(r, size: 32) + leftPad(s, size: 32)
  }

  private mutating func readInteger() throws -> Data {
    guard try readByte() == 0x02 else {
      throw LoomPasskeyError.invalidCredential("ECDSA signature integer is malformed.")
    }
    let length = try readLength()
    guard offset + length <= data.count else {
      throw LoomPasskeyError.invalidCredential("ECDSA signature integer is truncated.")
    }
    var value = data.subdata(in: offset..<(offset + length))
    offset += length
    while value.count > 1 && value.first == 0x00 {
      value.removeFirst()
    }
    guard value.count <= 32 else {
      throw LoomPasskeyError.invalidCredential("ECDSA signature integer exceeds P-256 length.")
    }
    return value
  }

  private mutating func readLength() throws -> Int {
    let first = try readByte()
    if first < 0x80 {
      return Int(first)
    }
    let count = Int(first & 0x7f)
    guard count == 1 || count == 2 else {
      throw LoomPasskeyError.invalidCredential("Unsupported DER length.")
    }
    var value = 0
    for _ in 0..<count {
      value = (value << 8) | Int(try readByte())
    }
    return value
  }

  private mutating func readByte() throws -> UInt8 {
    guard offset < data.count else {
      throw LoomPasskeyError.invalidCredential("Unexpected end of DER data.")
    }
    defer { offset += 1 }
    return data[offset]
  }

  private func leftPad(_ value: Data, size: Int) -> Data {
    if value.count >= size {
      return value
    }
    return Data(repeating: 0, count: size - value.count) + value
  }
}

extension SHA256.Digest {
  var data: Data {
    Data(self)
  }
}

extension Data {
  init?(hex: String?) {
    guard var value = hex else {
      return nil
    }
    if value.hasPrefix("0x") {
      value.removeFirst(2)
    }
    guard value.count % 2 == 0 else {
      return nil
    }
    var bytes = Data()
    var index = value.startIndex
    while index < value.endIndex {
      let next = value.index(index, offsetBy: 2)
      guard let byte = UInt8(value[index..<next], radix: 16) else {
        return nil
      }
      bytes.append(byte)
      index = next
    }
    self = bytes
  }

  var hexString: String {
    "0x" + map { String(format: "%02x", $0) }.joined()
  }
}
