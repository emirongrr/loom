package org.loom.mobileprivacywallet.passkey

import android.util.Base64
import android.content.pm.PackageManager
import androidx.credentials.CreatePublicKeyCredentialRequest
import androidx.credentials.CreatePublicKeyCredentialResponse
import androidx.credentials.CredentialManager
import androidx.credentials.GetCredentialRequest
import androidx.credentials.GetPublicKeyCredentialOption
import androidx.credentials.PublicKeyCredential
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.math.BigInteger
import java.security.MessageDigest
import org.json.JSONArray
import org.json.JSONObject

class LoomPasskeyModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("LoomPasskey")

    AsyncFunction("isPlatformPasskeyAvailable") {
      val activity = appContext.currentActivity
      activity != null && PasskeyPolicy.isConfigured(activity)
    }

    AsyncFunction("createPasskey") Coroutine { options: Map<String, String> ->
      val activity = appContext.currentActivity ?: throw Exceptions.MissingActivity()
      val rpId = PasskeyPolicy.resolveRpId(activity, options.required("rpId"))
      val expectedOrigin = PasskeyPolicy.resolveExpectedOrigin(activity, options.required("expectedOrigin"))
      val challenge = WebAuthnChecks.challenge(options.required("challenge"))
      val userName = options.required("userName")
      val displayName = options.required("displayName")
      val credentialManager = CredentialManager.create(activity)
      val requestJson = WebAuthnJson.registrationRequest(
        rpId = rpId,
        challenge = challenge,
        userName = userName,
        displayName = displayName
      )

      val response = credentialManager.createCredential(
        context = activity,
        request = CreatePublicKeyCredentialRequest(requestJson)
      )

      val registration = response as? CreatePublicKeyCredentialResponse
        ?: throw IllegalStateException("Credential Manager did not return a public-key registration response.")
      val registrationJson = JSONObject(registration.registrationResponseJson)
      val attestationObject = registrationJson.requiredBase64Url("response", "attestationObject")
      val clientDataJSON = registrationJson.requiredBase64Url("response", "clientDataJSON")
      val credentialId = registrationJson.requiredBase64Url("rawId")
      WebAuthnChecks.clientData(
        clientDataJSON,
        expectedType = "webauthn.create",
        expectedChallenge = challenge,
        expectedOrigin = expectedOrigin
      )
      val publicKey = WebAuthnCbor.extractP256PublicKeyFromAttestation(attestationObject, rpId)

      mapOf(
        "publicKeyX" to publicKey.x.hex(),
        "publicKeyY" to publicKey.y.hex(),
        "credentialIdHash" to sha256(credentialId).hex(),
        "rpId" to rpId,
        "origin" to JSONObject(String(clientDataJSON, Charsets.UTF_8)).getString("origin")
      )
    }

    AsyncFunction("signWithPasskey") Coroutine { options: Map<String, String> ->
      val activity = appContext.currentActivity ?: throw Exceptions.MissingActivity()
      val rpId = PasskeyPolicy.resolveRpId(activity, options.required("rpId"))
      val expectedOrigin = PasskeyPolicy.resolveExpectedOrigin(activity, options.required("expectedOrigin"))
      val challenge = WebAuthnChecks.challenge(options.required("challenge"))
      val credentialManager = CredentialManager.create(activity)
      val requestJson = WebAuthnJson.assertionRequest(rpId = rpId, challenge = challenge)
      val request = GetCredentialRequest(
        listOf(GetPublicKeyCredentialOption(requestJson))
      )

      val response = credentialManager.getCredential(activity, request)
      val credential = response.credential as? PublicKeyCredential
        ?: throw IllegalStateException("Credential Manager did not return a public-key assertion response.")
      val authenticationJson = JSONObject(credential.authenticationResponseJson)
      val authenticatorData = authenticationJson.requiredBase64Url("response", "authenticatorData")
      val clientDataJSON = authenticationJson.requiredBase64Url("response", "clientDataJSON")
      val derSignature = authenticationJson.requiredBase64Url("response", "signature")
      val userHandle = authenticationJson.optionalBase64Url("response", "userHandle")
      WebAuthnChecks.clientData(
        clientDataJSON,
        expectedType = "webauthn.get",
        expectedChallenge = challenge,
        expectedOrigin = expectedOrigin
      )
      WebAuthnChecks.authenticatorData(
        authenticatorData,
        rpId = rpId,
        requireAttestedCredentialData = false
      )

      buildMap {
        put("authenticatorData", authenticatorData.hex())
        put("clientDataJSON", clientDataJSON.hex())
        put("signature", DerSignature.normalizeP256(derSignature).hex())
        if (userHandle != null) put("userHandle", userHandle.hex())
      }
    }
  }
}

private object PasskeyPolicy {
  private const val RP_ID_META = "org.loom.passkey.RP_ID"
  private const val ALLOWED_ORIGINS_META = "org.loom.passkey.ALLOWED_ORIGINS"

  fun isConfigured(activity: android.app.Activity): Boolean =
    runCatching {
      metadata(activity, RP_ID_META).isNotBlank() && metadata(activity, ALLOWED_ORIGINS_META).isNotBlank()
    }.getOrDefault(false)

  fun resolveRpId(activity: android.app.Activity, requestedRpId: String): String {
    val configuredRpId = metadata(activity, RP_ID_META)
    require(configuredRpId.isNotBlank()) { "Passkey RP ID must be configured in native application metadata." }
    require(configuredRpId == requestedRpId) { "Requested passkey RP ID is not allowed by the native build policy." }
    require(Regex("^[a-zA-Z0-9.-]+$").matches(configuredRpId) && !configuredRpId.contains("://")) {
      "Configured passkey RP ID is invalid."
    }
    return configuredRpId
  }

  fun resolveExpectedOrigin(activity: android.app.Activity, requestedOrigin: String): String {
    val allowedOrigins = metadata(activity, ALLOWED_ORIGINS_META)
      .split(",")
      .map { it.trim() }
      .filter { it.isNotEmpty() }
      .toSet()
    require(allowedOrigins.isNotEmpty()) { "Passkey origins must be configured in native application metadata." }
    require(requestedOrigin in allowedOrigins) { "Requested passkey origin is not allowed by the native build policy." }
    return requestedOrigin
  }

  private fun metadata(activity: android.app.Activity, key: String): String {
    val appInfo = activity.packageManager.getApplicationInfo(activity.packageName, PackageManager.GET_META_DATA)
    return appInfo.metaData?.getString(key) ?: ""
  }
}

private object WebAuthnJson {
  fun registrationRequest(rpId: String, challenge: ByteArray, userName: String, displayName: String): String {
    return JSONObject()
      .put("challenge", challenge.base64Url())
      .put("rp", JSONObject().put("id", rpId).put("name", "Loom"))
      .put(
        "user",
        JSONObject()
          .put("id", sha256(userName.toByteArray(Charsets.UTF_8)).base64Url())
          .put("name", userName)
          .put("displayName", displayName)
      )
      .put(
        "pubKeyCredParams",
        JSONArray().put(JSONObject().put("type", "public-key").put("alg", -7))
      )
      .put("timeout", 120000)
      .put("attestation", "none")
      .put(
        "authenticatorSelection",
        JSONObject()
          .put("authenticatorAttachment", "platform")
          .put("residentKey", "required")
          .put("requireResidentKey", true)
          .put("userVerification", "required")
      )
      .toString()
  }

  fun assertionRequest(rpId: String, challenge: ByteArray): String {
    return JSONObject()
      .put("challenge", challenge.base64Url())
      .put("rpId", rpId)
      .put("timeout", 120000)
      .put("userVerification", "required")
      .toString()
  }
}

private data class P256PublicKey(val x: ByteArray, val y: ByteArray)

private object WebAuthnChecks {
  fun challenge(hex: String): ByteArray {
    val bytes = hex.hexToBytes()
    require(bytes.size == 32) { "Passkey challenge must be exactly 32 bytes." }
    require(bytes.any { it.toInt() != 0 }) { "Passkey challenge must not be all zeroes." }
    return bytes
  }

  fun clientData(
    data: ByteArray,
    expectedType: String,
    expectedChallenge: ByteArray,
    expectedOrigin: String
  ) {
    val clientData = JSONObject(String(data, Charsets.UTF_8))
    require(clientData.getString("type") == expectedType) { "Unexpected WebAuthn client data type." }
    require(clientData.getString("origin") == expectedOrigin) { "Unexpected WebAuthn origin." }
    require(clientData.getString("challenge").base64UrlToBytes().contentEquals(expectedChallenge)) {
      "Unexpected WebAuthn challenge."
    }
  }

  fun authenticatorData(authData: ByteArray, rpId: String, requireAttestedCredentialData: Boolean) {
    require(authData.size >= 37) { "Authenticator data is too short." }
    val expectedRpIdHash = sha256(rpId.toByteArray(Charsets.UTF_8))
    require(authData.copyOfRange(0, 32).contentEquals(expectedRpIdHash)) {
      "Authenticator data RP ID hash does not match the native RP policy."
    }
    val flags = authData[32].toInt()
    require((flags and 0x01) == 0x01) { "Authenticator data is missing user presence." }
    require((flags and 0x04) == 0x04) { "Authenticator data is missing user verification." }
    if (requireAttestedCredentialData) {
      require((flags and 0x40) == 0x40) { "Authenticator data does not include attested credential data." }
    }
  }
}

private object WebAuthnCbor {
  fun extractP256PublicKeyFromAttestation(attestationObject: ByteArray, rpId: String): P256PublicKey {
    val attestation = CborReader(attestationObject).readTextMap()
    val authData = attestation["authData"]?.bytes
      ?: throw IllegalStateException("Attestation object does not contain authenticator data.")
    return extractP256PublicKeyFromAuthenticatorData(authData, rpId)
  }

  private fun extractP256PublicKeyFromAuthenticatorData(authData: ByteArray, rpId: String): P256PublicKey {
    WebAuthnChecks.authenticatorData(authData, rpId = rpId, requireAttestedCredentialData = true)

    var offset = 37 + 16
    val credentialIdLength = ((authData[offset].toInt() and 0xff) shl 8) or (authData[offset + 1].toInt() and 0xff)
    offset += 2 + credentialIdLength
    require(offset < authData.size) { "Authenticator credential id length is invalid." }

    val cose = CborReader(authData.copyOfRange(offset, authData.size)).readIntMap()
    require(cose[1]?.int == 2 && cose[3]?.int == -7 && cose[-1]?.int == 1) {
      "Credential public key is not ES256 P-256."
    }
    val x = cose[-2]?.bytes
    val y = cose[-3]?.bytes
    require(x?.size == 32 && y?.size == 32) { "Credential public key coordinates are invalid." }
    return P256PublicKey(x, y)
  }
}

private data class CborValue(val int: Int? = null, val text: String? = null, val bytes: ByteArray? = null)

private class CborReader(private val data: ByteArray) {
  private var offset = 0

  fun readTextMap(): Map<String, CborValue> {
    val count = readHeader(5)
    val result = mutableMapOf<String, CborValue>()
    repeat(count) {
      result[readText()] = readValue()
    }
    return result
  }

  fun readIntMap(): Map<Int, CborValue> {
    val count = readHeader(5)
    val result = mutableMapOf<Int, CborValue>()
    repeat(count) {
      result[readInt()] = readValue()
    }
    return result
  }

  private fun readValue(): CborValue {
    val initial = readByte()
    val major = initial ushr 5
    offset -= 1
    return when (major) {
      0, 1 -> CborValue(int = readInt())
      2 -> CborValue(bytes = readBytes())
      3 -> CborValue(text = readText())
      else -> throw IllegalStateException("Unsupported CBOR value in passkey response.")
    }
  }

  private fun readBytes(): ByteArray {
    val count = readHeader(2)
    require(offset + count <= data.size) { "CBOR byte string is truncated." }
    return data.copyOfRange(offset, offset + count).also { offset += count }
  }

  private fun readText(): String {
    return String(readBytesWithMajor(3), Charsets.UTF_8)
  }

  private fun readBytesWithMajor(major: Int): ByteArray {
    val count = readHeader(major)
    require(offset + count <= data.size) { "CBOR data is truncated." }
    return data.copyOfRange(offset, offset + count).also { offset += count }
  }

  private fun readInt(): Int {
    val initial = readByte()
    val major = initial ushr 5
    val value = readArgument(initial)
    return when (major) {
      0 -> value
      1 -> -1 - value
      else -> throw IllegalStateException("Expected CBOR integer.")
    }
  }

  private fun readHeader(expectedMajor: Int): Int {
    val initial = readByte()
    require(initial ushr 5 == expectedMajor) { "Unexpected CBOR major type." }
    return readArgument(initial)
  }

  private fun readArgument(initial: Int): Int {
    val info = initial and 0x1f
    return when {
      info < 24 -> info
      info == 24 -> readByte()
      info == 25 -> (readByte() shl 8) or readByte()
      else -> throw IllegalStateException("Unsupported CBOR length encoding.")
    }
  }

  private fun readByte(): Int {
    require(offset < data.size) { "Unexpected end of CBOR data." }
    return data[offset++].toInt() and 0xff
  }
}

private object DerSignature {
  private val P256_ORDER = BigInteger("FFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551", 16)
  private val P256_HALF_ORDER = P256_ORDER.shiftRight(1)

  fun normalizeP256(der: ByteArray): ByteArray {
    val reader = DerReader(der)
    val signature = reader.readP256Signature()
    val r = signature.copyOfRange(0, 32)
    val s = signature.copyOfRange(32, 64)
    val rValue = BigInteger(1, r)
    val sValue = BigInteger(1, s)
    require(rValue.signum() > 0 && rValue < P256_ORDER) { "ECDSA signature r is outside the P-256 scalar field." }
    require(sValue.signum() > 0 && sValue < P256_ORDER) { "ECDSA signature s is outside the P-256 scalar field." }
    val canonicalS = if (sValue > P256_HALF_ORDER) P256_ORDER.subtract(sValue) else sValue
    return r + canonicalS.toPaddedBytes(32)
  }

  private fun BigInteger.toPaddedBytes(size: Int): ByteArray {
    var raw = toByteArray()
    while (raw.size > 1 && raw[0].toInt() == 0) {
      raw = raw.copyOfRange(1, raw.size)
    }
    require(raw.size <= size) { "P-256 scalar exceeds expected size." }
    return ByteArray(size - raw.size) + raw
  }
}

private class DerReader(private val data: ByteArray) {
  private var offset = 0

  fun readP256Signature(): ByteArray {
    require(readByte() == 0x30) { "ECDSA signature is not DER encoded." }
    val sequenceLength = readLength()
    val sequenceEnd = offset + sequenceLength
    require(sequenceEnd == data.size) { "ECDSA signature DER sequence length is invalid." }
    val r = readInteger()
    val s = readInteger()
    require(offset == sequenceEnd) { "ECDSA signature has trailing bytes." }
    return r.leftPad(32) + s.leftPad(32)
  }

  private fun readInteger(): ByteArray {
    require(readByte() == 0x02) { "ECDSA signature integer is malformed." }
    val length = readLength()
    require(offset + length <= data.size) { "ECDSA signature integer is truncated." }
    var value = data.copyOfRange(offset, offset + length)
    offset += length
    while (value.size > 1 && value[0].toInt() == 0) {
      value = value.copyOfRange(1, value.size)
    }
    require(value.size <= 32) { "ECDSA signature integer exceeds P-256 length." }
    return value
  }

  private fun readLength(): Int {
    val first = readByte()
    if (first < 0x80) return first
    val count = first and 0x7f
    require(count == 1 || count == 2) { "Unsupported DER length." }
    var value = 0
    repeat(count) {
      value = (value shl 8) or readByte()
    }
    return value
  }

  private fun readByte(): Int {
    require(offset < data.size) { "Unexpected end of DER data." }
    return data[offset++].toInt() and 0xff
  }
}

private fun Map<String, String>.required(key: String): String =
  this[key] ?: throw IllegalArgumentException("Missing required passkey option: $key")

private fun JSONObject.requiredBase64Url(section: String, key: String): ByteArray =
  getJSONObject(section).getString(key).base64UrlToBytes()

private fun JSONObject.requiredBase64Url(key: String): ByteArray =
  getString(key).base64UrlToBytes()

private fun JSONObject.optionalBase64Url(section: String, key: String): ByteArray? {
  val objectValue = getJSONObject(section)
  if (!objectValue.has(key) || objectValue.isNull(key)) return null
  return objectValue.getString(key).base64UrlToBytes()
}

private fun String.hexToBytes(): ByteArray {
  val clean = removePrefix("0x")
  require(startsWith("0x")) { "Hex value must use 0x prefix." }
  require(clean.length % 2 == 0) { "Hex value must have even length." }
  return ByteArray(clean.length / 2) { i ->
    clean.substring(i * 2, i * 2 + 2).toInt(16).toByte()
  }
}

private fun String.base64UrlToBytes(): ByteArray =
  Base64.decode(this, Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP)

private fun ByteArray.base64Url(): String =
  Base64.encodeToString(this, Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP)

private fun ByteArray.hex(): String = joinToString(prefix = "0x", separator = "") { "%02x".format(it) }

private fun ByteArray.leftPad(size: Int): ByteArray =
  if (this.size >= size) this else ByteArray(size - this.size) + this

private fun sha256(data: ByteArray): ByteArray =
  MessageDigest.getInstance("SHA-256").digest(data)
