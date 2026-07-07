package org.loom.mobileprivacywallet.passkey

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class LoomPasskeyModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("LoomPasskey")

    AsyncFunction("isPlatformPasskeyAvailable") {
      true
    }

    AsyncFunction("createPasskey") { _: Map<String, String> ->
      throw IllegalStateException("Android Credential Manager implementation must be completed before release.")
    }

    AsyncFunction("signWithPasskey") { _: Map<String, String> ->
      throw IllegalStateException("Android Credential Manager assertion implementation must be completed before release.")
    }
  }
}

