package org.loom.mobileprivacywallet.screenprivacy

import android.view.WindowManager
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

// Screen privacy for the wallet UI.
//
// FLAG_SECURE tells the platform that the window content is sensitive: the
// system excludes it from screenshots, screen recording, and the recent-apps
// (task switcher) thumbnail. This is a platform-enforced guarantee on Android,
// unlike iOS where screenshots cannot be blocked and only the app-switcher
// snapshot can be covered.
class LoomScreenPrivacyModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("LoomScreenPrivacy")

    AsyncFunction("isScreenPrivacyAvailable") { promise: Promise ->
      promise.resolve(appContext.currentActivity != null)
    }

    // Applies or clears FLAG_SECURE on the current activity window. The wallet
    // enables it at startup and treats failure as a blocked capability rather
    // than continuing with an unprotected window.
    AsyncFunction("setSecureScreen") { enabled: Boolean, promise: Promise ->
      val activity = appContext.currentActivity
      if (activity == null) {
        promise.reject(
          "ERR_SCREEN_PRIVACY_UNAVAILABLE",
          "No current activity; the secure screen flag cannot be applied.",
          null
        )
        return@AsyncFunction
      }
      activity.runOnUiThread {
        try {
          if (enabled) {
            activity.window.setFlags(
              WindowManager.LayoutParams.FLAG_SECURE,
              WindowManager.LayoutParams.FLAG_SECURE
            )
          } else {
            activity.window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
          }
          promise.resolve(true)
        } catch (error: Throwable) {
          promise.reject(
            "ERR_SCREEN_PRIVACY",
            "Failed to update the secure screen flag: ${error.message}",
            error
          )
        }
      }
    }
  }
}
