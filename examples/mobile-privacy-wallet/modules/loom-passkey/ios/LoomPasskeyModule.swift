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
        return LoomPasskeyPolicy.isConfigured()
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
  private var pendingExpectedOrigin: String?
  private var pendingChallenge: Data?

  enum PendingKind {
    case registration
    case assertion
  }

  func createPasskey(options: [String: String], promise: Promise) {
    do {
      let rpId = try LoomPasskeyPolicy.resolveRpId(requested: options["rpId"])
      let expectedOrigin = try LoomPasskeyPolicy.resolveExpectedOrigin(requested: options["expectedOrigin"])
      let challenge = try LoomWebAuthn.validatedChallenge(hex: options["challenge"])
      guard let userName = options["userName"], let displayName = options["displayName"] else {
        promise.reject("ERR_PASSKEY_INPUT", "Passkey registration requires userName and displayName.")
        return
      }

      pendingPromise = promise
      pendingKind = .registration
      pendingRpId = rpId
      pendingExpectedOrigin = expectedOrigin
      pendingChallenge = challenge

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
    } catch {
      promise.reject("ERR_PASSKEY_INPUT", error.localizedDescription)
    }
  }

  func signWithPasskey(options: [String: String], promise: Promise) {
    do {
      let rpId = try LoomPasskeyPolicy.resolveRpId(requested: options["rpId"])
      let expectedOrigin = try LoomPasskeyPolicy.resolveExpectedOrigin(requested: options["expectedOrigin"])
      let challenge = try LoomWebAuthn.validatedChallenge(hex: options["challenge"])

      pendingPromise = promise
      pendingKind = .assertion
      pendingRpId = rpId
      pendingExpectedOrigin = expectedOrigin
      pendingChallenge = challenge

      let provider = ASAuthorizationPlatformPublicKeyCredentialProvider(relyingPartyIdentifier: rpId)
      let request = provider.createCredentialAssertionRequest(challenge: challenge)
      request.userVerificationPreference = .required

      let controller = ASAuthorizationController(authorizationRequests: [request])
      controller.delegate = self
      controller.presentationContextProvider = self
      controller.performRequests()
    } catch {
      promise.reject("ERR_PASSKEY_INPUT", error.localizedDescription)
    }
  }

  func authorizationController(controller: ASAuthorizationController, didCompleteWithAuthorization authorization: ASAuthorization) {
    guard let promise = pendingPromise, let rpId = pendingRpId, let expectedOrigin = pendingExpectedOrigin,
      let challenge = pendingChallenge, let kind = pendingKind
    else {
      return
    }
    defer {
      pendingPromise = nil
      pendingKind = nil
      pendingRpId = nil
      pendingExpectedOrigin = nil
      pendingChallenge = nil
    }

    do {
      switch (kind, authorization.credential) {
      case (.registration, let credential as ASAuthorizationPlatformPublicKeyCredentialRegistration):
        guard let attestationObject = credential.rawAttestationObject else {
          throw LoomPasskeyError.invalidCredential("Registration omitted attestation object; cannot extract P-256 public key.")
        }
        let clientData = try LoomWebAuthn.validateClientData(
          credential.rawClientDataJSON,
          expectedType: "webauthn.create",
          expectedChallenge: challenge,
          expectedOrigin: expectedOrigin
        )
        let publicKey = try LoomWebAuthn.extractP256PublicKey(attestationObject: attestationObject, rpId: rpId)
        promise.resolve([
          "publicKeyX": publicKey.x.hexString,
          "publicKeyY": publicKey.y.hexString,
          "credentialIdHash": SHA256.hash(data: credential.credentialID).data.hexString,
          "rpId": rpId,
          "origin": clientData.origin
        ])
      case (.assertion, let credential as ASAuthorizationPlatformPublicKeyCredentialAssertion):
        _ = try LoomWebAuthn.validateClientData(
          credential.rawClientDataJSON,
          expectedType: "webauthn.get",
          expectedChallenge: challenge,
          expectedOrigin: expectedOrigin
        )
        try LoomWebAuthn.validateAuthenticatorData(
          credential.rawAuthenticatorData,
          rpId: rpId,
          requireAttestedCredentialData: false
        )
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
    pendingExpectedOrigin = nil
    pendingChallenge = nil
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

enum LoomPasskeyPolicy {
  private static let rpIdKey = "LoomPasskeyRpId"
  private static let allowedOriginsKey = "LoomPasskeyAllowedOrigins"

  static func isConfigured() -> Bool {
    do {
      _ = try configuredRpId()
      return !(try allowedOrigins()).isEmpty
    } catch {
      return false
    }
  }

  static func resolveRpId(requested: String?) throws -> String {
    guard let requested else {
      throw LoomPasskeyError.invalidCredential("Passkey RP ID is required.")
    }
    let configured = try configuredRpId()
    guard configured == requested else {
      throw LoomPasskeyError.invalidCredential("Requested passkey RP ID is not allowed by the native build policy.")
    }
    guard configured.range(of: #"^[A-Za-z0-9.-]+$"#, options: .regularExpression) != nil,
      !configured.contains("://")
    else {
      throw LoomPasskeyError.invalidCredential("Configured passkey RP ID is invalid.")
    }
    return configured
  }

  static func resolveExpectedOrigin(requested: String?) throws -> String {
    guard let requested else {
      throw LoomPasskeyError.invalidCredential("Passkey expected origin is required.")
    }
    let origins = try allowedOrigins()
    guard origins.contains(requested) else {
      throw LoomPasskeyError.invalidCredential("Requested passkey origin is not allowed by the native build policy.")
    }
    return requested
  }

  private static func configuredRpId() throws -> String {
    guard let value = Bundle.main.object(forInfoDictionaryKey: rpIdKey) as? String, !value.isEmpty else {
      throw LoomPasskeyError.invalidCredential("Passkey RP ID must be configured in Info.plist.")
    }
    return value
  }

  private static func allowedOrigins() throws -> Set<String> {
    if let values = Bundle.main.object(forInfoDictionaryKey: allowedOriginsKey) as? [String] {
      let filtered = values.filter { !$0.isEmpty }
      guard !filtered.isEmpty else {
        throw LoomPasskeyError.invalidCredential("Passkey allowed origins must not be empty.")
      }
      return Set(filtered)
    }
    if let value = Bundle.main.object(forInfoDictionaryKey: allowedOriginsKey) as? String {
      let filtered = value.split(separator: ",").map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
        .filter { !$0.isEmpty }
      guard !filtered.isEmpty else {
        throw LoomPasskeyError.invalidCredential("Passkey allowed origins must not be empty.")
      }
      return Set(filtered)
    }
    throw LoomPasskeyError.invalidCredential("Passkey allowed origins must be configured in Info.plist.")
  }
}

struct LoomP256PublicKey {
  let x: Data
  let y: Data
}

enum LoomP256 {
  static let order = Data(hexStrict: "0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551")
  static let orderMinusOne = subtract(order, Data(repeating: 0, count: 31) + Data([1]))
  static let halfOrder = Data(hexStrict: "0x7fffffff800000007fffffffffffffff5d576e7357a4501ddfe92f46681b20a0")

  static func subtract(_ left: Data, _ right: Data) -> Data {
    precondition(left.count == right.count)
    var output = Array(repeating: UInt8(0), count: left.count)
    var borrow = 0
    for index in stride(from: left.count - 1, through: 0, by: -1) {
      var value = Int(left[index]) - Int(right[index]) - borrow
      if value < 0 {
        value += 256
        borrow = 1
      } else {
        borrow = 0
      }
      output[index] = UInt8(value)
    }
    precondition(borrow == 0)
    return Data(output)
  }
}

struct LoomClientData {
  let origin: String
}

enum LoomWebAuthn {
  static func validatedChallenge(hex: String?) throws -> Data {
    guard let challenge = Data(hex: hex) else {
      throw LoomPasskeyError.invalidCredential("Passkey challenge must be 0x-prefixed hex.")
    }
    guard challenge.count == 32 else {
      throw LoomPasskeyError.invalidCredential("Passkey challenge must be exactly 32 bytes.")
    }
    guard challenge.contains(where: { $0 != 0 }) else {
      throw LoomPasskeyError.invalidCredential("Passkey challenge must not be all zeroes.")
    }
    return challenge
  }

  static func validateClientData(
    _ data: Data,
    expectedType: String,
    expectedChallenge: Data,
    expectedOrigin: String
  ) throws -> LoomClientData {
    let value = try JSONSerialization.jsonObject(with: data)
    guard let object = value as? [String: Any],
      let type = object["type"] as? String,
      let challenge = object["challenge"] as? String,
      let origin = object["origin"] as? String
    else {
      throw LoomPasskeyError.invalidCredential("Client data JSON is incomplete.")
    }
    guard type == expectedType else {
      throw LoomPasskeyError.invalidCredential("Unexpected WebAuthn client data type.")
    }
    guard origin == expectedOrigin else {
      throw LoomPasskeyError.invalidCredential("Unexpected WebAuthn origin.")
    }
    guard Data(base64URLEncoded: challenge) == expectedChallenge else {
      throw LoomPasskeyError.invalidCredential("Unexpected WebAuthn challenge.")
    }
    return LoomClientData(origin: origin)
  }

  static func validateAuthenticatorData(
    _ authenticatorData: Data,
    rpId: String,
    requireAttestedCredentialData: Bool
  ) throws {
    guard authenticatorData.count >= 37 else {
      throw LoomPasskeyError.invalidCredential("Authenticator data is too short.")
    }
    let expectedRpIdHash = SHA256.hash(data: Data(rpId.utf8)).data
    guard authenticatorData.prefix(32) == expectedRpIdHash else {
      throw LoomPasskeyError.invalidCredential("Authenticator data RP ID hash does not match the native RP policy.")
    }
    let flags = authenticatorData[32]
    guard (flags & 0x01) == 0x01 else {
      throw LoomPasskeyError.invalidCredential("Authenticator data is missing user presence.")
    }
    guard (flags & 0x04) == 0x04 else {
      throw LoomPasskeyError.invalidCredential("Authenticator data is missing user verification.")
    }
    if requireAttestedCredentialData, (flags & 0x40) != 0x40 {
      throw LoomPasskeyError.invalidCredential("Authenticator data does not include attested credential data.")
    }
  }

  static func extractP256PublicKey(attestationObject: Data, rpId: String) throws -> LoomP256PublicKey {
    var reader = LoomCborReader(attestationObject)
    let attestation = try reader.readMap()
    guard let authData = attestation["authData"]?.bytes else {
      throw LoomPasskeyError.invalidCredential("Attestation object does not contain authenticator data.")
    }
    return try extractP256PublicKey(authenticatorData: authData, rpId: rpId)
  }

  static func extractP256PublicKey(authenticatorData: Data, rpId: String) throws -> LoomP256PublicKey {
    guard authenticatorData.count > 55 else {
      throw LoomPasskeyError.invalidCredential("Authenticator data is too short.")
    }
    try validateAuthenticatorData(authenticatorData, rpId: rpId, requireAttestedCredentialData: true)

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

  static func normalizeEcdsaSignature(_ derSignature: Data) throws -> Data {
    var reader = LoomDerReader(derSignature)
    let signature = try reader.readP256Signature()
    let r = Data(signature.prefix(32))
    let s = Data(signature.suffix(32))
    guard r.isNonZeroScalar, r.lexicographicallyPrecedesOrEquals(LoomP256.orderMinusOne),
      s.isNonZeroScalar, s.lexicographicallyPrecedesOrEquals(LoomP256.orderMinusOne)
    else {
      throw LoomPasskeyError.invalidCredential("ECDSA signature scalar is outside the P-256 field.")
    }
    let canonicalS = s.lexicographicallyPrecedesOrEquals(LoomP256.halfOrder)
      ? s
      : LoomP256.subtract(LoomP256.order, Data(s))
    return r + canonicalS
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
    let sequenceLength = try readLength()
    let sequenceEnd = offset + sequenceLength
    guard sequenceEnd == data.count else {
      throw LoomPasskeyError.invalidCredential("ECDSA signature DER sequence length is invalid.")
    }
    let r = try readInteger()
    let s = try readInteger()
    guard offset == sequenceEnd else {
      throw LoomPasskeyError.invalidCredential("ECDSA signature has trailing bytes.")
    }
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
  init(base64URLEncoded value: String) {
    var base64 = value.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
    let padding = (4 - base64.count % 4) % 4
    base64 += String(repeating: "=", count: padding)
    self = Data(base64Encoded: base64) ?? Data()
  }

  init?(hex: String?) {
    guard var value = hex else {
      return nil
    }
    guard value.hasPrefix("0x") else {
      return nil
    }
    value.removeFirst(2)
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

  init(hexStrict hex: String) {
    guard let data = Data(hex: hex) else {
      preconditionFailure("invalid static hex")
    }
    self = data
  }

  var isNonZeroScalar: Bool {
    count == 32 && contains(where: { $0 != 0 })
  }

  func lexicographicallyPrecedesOrEquals(_ other: Data) -> Bool {
    precondition(count == other.count)
    for index in 0..<count {
      if self[index] < other[index] {
        return true
      }
      if self[index] > other[index] {
        return false
      }
    }
    return true
  }
}
