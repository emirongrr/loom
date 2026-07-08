import ExpoModulesCore
import UIKit

// Screen privacy for the wallet UI.
//
// iOS cannot block screenshots or screen recording the way Android's
// FLAG_SECURE does. What the platform does allow is covering the window before
// the system captures the app-switcher snapshot: when the app resigns active,
// an opaque blur overlay is placed over the key window so balances, addresses,
// and recovery state are not persisted into the task-switcher thumbnail.
// Screenshot prevention on iOS must not be claimed; see docs/PRIVACY_MODEL.md.
public class LoomScreenPrivacyModule: Module {
  private let privacyGuard = LoomScreenPrivacyGuard()

  public func definition() -> ModuleDefinition {
    Name("LoomScreenPrivacy")

    AsyncFunction("isScreenPrivacyAvailable") { () -> Bool in
      return true
    }

    AsyncFunction("setSecureScreen") { (enabled: Bool, promise: Promise) in
      DispatchQueue.main.async {
        if enabled {
          self.privacyGuard.enable()
        } else {
          self.privacyGuard.disable()
        }
        promise.resolve(true)
      }
    }
  }
}

final class LoomScreenPrivacyGuard {
  private var overlay: UIVisualEffectView?
  private var observers: [NSObjectProtocol] = []

  func enable() {
    guard observers.isEmpty else {
      return
    }
    let center = NotificationCenter.default
    observers.append(
      center.addObserver(
        forName: UIApplication.willResignActiveNotification,
        object: nil,
        queue: .main
      ) { [weak self] _ in
        self?.showOverlay()
      }
    )
    observers.append(
      center.addObserver(
        forName: UIApplication.didBecomeActiveNotification,
        object: nil,
        queue: .main
      ) { [weak self] _ in
        self?.hideOverlay()
      }
    )
  }

  func disable() {
    let center = NotificationCenter.default
    for observer in observers {
      center.removeObserver(observer)
    }
    observers.removeAll()
    hideOverlay()
  }

  private func keyWindow() -> UIWindow? {
    return UIApplication.shared.connectedScenes
      .compactMap { $0 as? UIWindowScene }
      .flatMap { $0.windows }
      .first { $0.isKeyWindow }
  }

  private func showOverlay() {
    guard overlay == nil, let window = keyWindow() else {
      return
    }
    let effectView = UIVisualEffectView(effect: UIBlurEffect(style: .systemThickMaterial))
    effectView.frame = window.bounds
    effectView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    window.addSubview(effectView)
    overlay = effectView
  }

  private func hideOverlay() {
    overlay?.removeFromSuperview()
    overlay = nil
  }
}
