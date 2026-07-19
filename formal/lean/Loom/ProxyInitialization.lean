namespace Loom

structure InitializationStorage where
  configVersion : Nat
  validatorSetIdentity : Nat
  deriving DecidableEq, Repr

structure ProxyStoragePair where
  implementation : InitializationStorage
  proxy : InitializationStorage
  deriving DecidableEq, Repr

def initializeProxyStorage
    (storage : ProxyStoragePair)
    (configVersion validatorSetIdentity : Nat) : ProxyStoragePair :=
  {
    storage with
      proxy := {
        configVersion := configVersion,
        validatorSetIdentity := validatorSetIdentity
      }
  }

theorem proxy_initialization_updates_only_proxy_storage
    (storage : ProxyStoragePair)
    (configVersion validatorSetIdentity : Nat) :
    let updated := initializeProxyStorage storage configVersion validatorSetIdentity
    updated.proxy.configVersion = configVersion
      /\ updated.proxy.validatorSetIdentity = validatorSetIdentity
      /\ updated.implementation = storage.implementation := by
  simp [initializeProxyStorage]

end Loom
