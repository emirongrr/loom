# Philosophy Compliance Review — Backlog

> Yerel çalışma dosyası. Repoya commit edilmeyecek (untracked kalacak).
> Kaynak: 2026-06-30 tarihli Vitalik/Ethereum wallet felsefesi uygunluk
> denetimi (account core, recovery/keystore, SDK/privacy doğrulaması ile).
> İlerledikçe maddeleri `[x]` yapıp/silerek güncelleyeceğiz.

---

## Immediate (bu hafta yapılabilir, küçük kapsam)

- [x] **PolicyHook.preCheck — fail-open davranışını netleştiren yorum ekle**
  - Severity: Low / Observation
  - Kapsam: küçük (tek dosya, birkaç satır yorum)
  - Dosya: `src/hooks/PolicyHook.sol:104-109`
  - Yapıldı: mode kontrolünün üstüne, asıl doğrulamanın `LoomAccount.execute()`
    seviyesinde yapıldığını ve bu hook'un tek başına bağımsız bir yetkilendirme
    kapısı olmadığını açıklayan yorum eklendi. Davranış değişmedi.
  - Not: `forge` bu makinede PATH'te değil, build/test koşulamadı — kullanıcı
    kendi ortamında `forge build && forge test --match-contract PolicyHook`
    ile teyit etmeli.

- [x] **EthereumL1KeystoreVerifier — kapsamı netleştiren NatSpec ekle**
  - Severity: ~~High~~ → düzeltildi, bkz. not aşağıda
  - Kapsam: küçük (NatSpec)
  - Dosya: `src/keystore/EthereumL1KeystoreVerifier.sol:7-13`
  - **Düzeltme (orijinal rapor hatalıydı):** `docs/decisions/0003-l1-keystore-verifier.md`
    ve `docs/design/keystore.md` okunduğunda, bu kontratın "bozuk proof
    verifier" olmadığı, bilinçli olarak **same-chain (L1-to-L1) doğrudan
    okuma doğrulayıcısı** olarak tasarlandığı ve bunun zaten dokümante
    edildiği görüldü. Gerçek eksik olan L2 (Base/OP/Arbitrum) doğrulayıcıları
    — onlar zaten ayrı, kabul edilmiş bir P0 gap olarak listeleniyor.
    `LoomKeystore` controller'ı için "tek nokta arızası" yorumu da yanlış
    yönlendiriciydi: tasarım, controller'ın kullanıcının kendi L1 Loom
    hesabı (kendi threshold/recovery modeliyle) olmasını öneriyor.
  - Yapıldı: kontrat üstüne, bunun L2 adaptörü OLMADIĞINI ve L2 desteğinin
    henüz var olmadığını netleştiren NatSpec eklendi (zaten var olan
    dokümantasyonu kod seviyesinde de görünür kılmak için).

---

## Medium-term (haftalar sürebilir, ARCHITECTURE.md'ye göre decision record gerektirir)

- [ ] **L2 (Base/OP/Arbitrum) storage-proof verifier — tasarım/decision record**
  - Severity: High (ama "stub düzeltme" değil, "henüz var olmayan özelliği inşa etme" — bkz. yukarıdaki düzeltme notu)
  - Kapsam: büyük, çok adımlı
  - İlgili: `src/keystore/EthereumL1KeystoreVerifier.sol` (referans, dokunulmayacak), yeni `src/keystore/<Chain>KeystoreVerifier.sol`, `docs/decisions/`, `docs/operations/keystore-proof-profile.md`
  - Not: `EthereumL1KeystoreVerifier` zaten doğru ve dokümante edilmiş şekilde
    same-chain L1 doğrulayıcı olarak çalışıyor — bu maddenin kapsamı *onu
    düzeltmek* değil, eksik olan L2 doğrulayıcılarını sıfırdan inşa etmek.
  - Alt adımlar:
    - [x] Hedef zincir: **OP Stack** (Base/Optimism — aynı mekanizma, ayrı deployment)
    - [x] Decision record taslağı: `docs/decisions/0008-op-stack-l2-keystore-verifier.md`
          — L1Block precompile + EIP-1186 storage proof yaklaşımı, finality/reorg
          varsayımları, storage slot derivation, acceptance conditions, residual risks
          (PR #108 merge edildi; #106 ve #107 ile birlikte main'de)
    - [x] Threat-model güncellemesi (`docs/security/threat-model.md`)
          — cross-chain limitation genişletildi: EthereumL1KeystoreVerifier'ın
          same-chain-only olduğu, üretim L2 verifier'ı olmadığı; planlanan OP Stack
          verifier'ının güven sınırı (L1Block + EIP-1186, sequencer = liveness-not-safety,
          version monotonicity + recovery cancellation ile stale-root replay engeli).
          PR #109 merge edildi.
    - [x] Trie kütüphanesi seçimi: Optimism Bedrock MerkleTrie/SecureMerkleTrie/
          RLPReader/Bytes vendored (`lib/optimism-trie/`, pin `b3e09977...`, MIT).
          PR #110 merge edildi. Karar 0008'e "Trie library" bölümü eklendi.
          Gerekçe: state root'unu güvendiğimiz zincirin (OP Stack) production'da
          kullandığı audit'li kod; sıfırdan trie yazmaktan kaçınıldı.
    - [x] `OPStackL2KeystoreVerifier.sol` implementasyonu
          (L1Block okuma + account/storage trie doğrulama + KeystoreConfig decode)
          + `IL1Block` interface. PR #111 merge edildi (main'de).
          NOT: `forge` aslında node_modules'ta kurulu
          (`node_modules/@foundry-rs/forge-win32-amd64/bin/forge.exe`) — lokalde
          tüm CI gate'leri yeşillendirildi: build, fmt, lint(--deny warnings),
          test (16 yeni test geçti), snapshot (.gas-snapshot yeniden üretildi),
          coverage (verifier %94.74 line / %85.71 branch; aggregate %91.81/%67.53),
          sizes, slither (--fail-high, HIGH yok).
    - [x] Storage layout pin testi (LoomKeystore slot 0/1 değişirse kırılmalı)
          — `testStorageLayoutPinMatchesVerifierAssumptions`: gerçek storage'ı
          `vm.load` ile okuyup verifier'ın slot/packing varsayımlarını doğruluyor.
    - [x] Negative test vektörleri (stale root, yanlış slot/identity, yanlış
          versiyon, yanlış field, tampered/malformed proof, zero root) — eklendi.
    - [x] Trie fixture üretimi: `tools/keystore/generate-op-stack-fixture.mjs`
          (@ethereumjs/mpt ile, deps `--no-save`, package.json'a eklenmedi);
          `test/fixtures/op-stack-keystore-proof.json` commit edildi. Pozitif
          EIP-1186 proof testi (`testAcceptsValidProof`) bununla geçiyor.
          PR #111 merge edildi.
    - [ ] `docs/operations/keystore-proof-profile.md` gate'lerini geçir
          ⛔ BLOKE (kod değil): profil, gerçek deployment'ın immutable adres/
          bytecode hash'lerini + audit kanıtını gerektiriyor; doküman sahte
          profil eklemeyi açıkça yasaklıyor. Deployment + audit sonrası yapılır.
    - [ ] Testnet rehearsal (en az iki bağımsız bundler ile)
          ⛔ BLOKE (kod değil): canlı L2 testnet altyapısı gerektirir.
    - [ ] Bağımsız audit (production'a girmeden önce zorunlu)
          ⛔ BLOKE (kod değil): üçüncü taraf. Trie path + verifier audit kapsamında.

  > Özet: OP Stack L2 verifier'ın **kod tarafı tamamlandı** (#108–#111).
  > Kalan 3 alt-adım operasyonel/harici (deployment, canlı testnet, audit) —
  > bu repoda kod ile ilerletilemez.

- [x] **LoomKeystore controller önerisini netleştir/güçlendir (düşük öncelik)**
  - Yapıldı (PR #112, auto-merge): `LoomKeystore`'a NatSpec eklendi (contract notice
    + `register` controller param) — controller'ın tek yetki olduğu, güvenlik-kritik
    olduğu, önerilen controller'ın kendi recovery/delay'i olan kullanıcı-kontrollü
    bir hesap (çıplak hot EOA değil) olduğu, ve bunun kontrat-zorunlu değil
    konvansiyon olduğu (permissionless kullanımı korumak için) belgelendi.
    Kontrat davranışı değişmedi. docs/design/keystore.md zaten öneriyordu; bu onu
    kaynak seviyesinde görünür kıldı.
  - Severity: ~~High~~ → Medium/Low (düzeltildi)
  - Kapsam: küçük-orta
  - Dosya: `src/keystore/LoomKeystore.sol:16,40-108`
  - Düzeltme: `docs/design/keystore.md` zaten "recommended controller is the
    user's L1 Loom account or another user-controlled account with its own
    recovery and delay model" diyor — yani tasarım baştan beri tek-EOA
    controller'ı önermiyor, kullanıcı kontrolündeki bir hesabı öneriyor. Bu
    sadece bir konvansiyon, kontrat seviyesinde zorlanmıyor.
  - Yapılabilir iyileştirme: `register()`'a opsiyonel bir kontrol eklenip
    eklenmeyeceğini değerlendir (örn. controller'ın bir kontrat olmasını
    zorunlu kılmak gibi) — ama bu, EOA controller kullanmak isteyen
    kullanıcıların permissionless operation'ını kısıtlayabileceğinden
    ARCHITECTURE.md "Change Rules" gereği dikkatli değerlendirilmeli.
    Muhtemelen kod değişikliği değil, sadece SDK/client seviyesinde
    "controller olarak EOA kullanmıyorsanız önerilir" uyarısı yeterli.

- [ ] **Privacy adapter — production rehearsal (Railgun önce)**
  - Severity: Medium
  - Kapsam: kod tarafı ZATEN HAZIR; kalan yalnızca canlı koşu (infra-gated)
  - Dosya: `packages/privacy/src/index.js`, `scripts/privacy/run-railgun-rehearsal.mjs`
  - **Düzeltme (inceleme sonrası):** Bu maddenin kod alt-adımları backlog'un
    sandığından çok daha ileride — mevcut ve testli (privacy:test 41/0):
    - [x] Relayer/prover/indexer failure-mode testleri — `packages/privacy/test/
          adapter-failure-modes.test.mjs` (railgun sync / relayer / aztec prover
          hata sınıflandırması, stale checkpoint mutasyonu engeli) + metadata
          leakage harness + private scan lifecycle testleri mevcut.
    - [x] `docs/operations/privacy-adapter-profile.md` gate'leri — doküman +
          `tools/validate-privacy-adapter-profile.mjs` validator + testi mevcut.
    - [x] Rehearsal harness'ı — `runRailgunLiveRehearsal` + secret-reddi guard'ları
          + `scripts/privacy/run-railgun-rehearsal.mjs` mevcut.
    - [ ] ⛔ BLOKE (kod değil): CANLI rehearsal koşusu. Kullanıcı-seçili
          RPC/indexer/relayer/prover endpoint'lerine karşı `LOOM_PRIVACY_REHEARSAL=1
          node scripts/privacy/run-railgun-rehearsal.mjs <config> <evidence>`
          çalıştırıp evidence üretmek gerekir. Bu canlı altyapı olmadan yapılamaz.
    - [ ] ⛔ Sonuç: "private transfers work" iddiası ancak canlı koşu + evidence
          sonrası yapılabilir.

---

## Long-term (büyük yapısal işler)

- [ ] **ERC-7579 modül portabilitesi genişletme**
  - Severity: Observation
  - Kapsam: büyük
  - Not: Şu an bilinçli olarak dar (narrow authority > generic extensibility).
    Audit sonrası, third-party module conformance vektörleri eklenmeli.
  - Dosya: `src/adapters/ERC7579ModuleAdapter.sol`

- [~] **WalletBeat Stage 2 client-side gereksinimleri** (analiz + doküman yapıldı)
  - Severity: (çoğu repo kapsamı dışında — client katmanı)
  - **İnceleme sonucu (2026-07-02):** "client work" sanılan maddelerin bir kısmı
    SDK'da ZATEN mevcut. `docs/standards/walletbeat-stage-2.md` bunu yansıtmıyordu.
  - [x] **(A)** `walletbeat-stage-2.md` güncellendi (PR #114, auto-merge): yeni
    "SDK enablers" bölümü (evidence'lı) — custom endpoint/no-default-provider
    (`createRpcStateTransport`/`createBundlerTransport`), ERC-5792
    (`prepareWalletSendCalls`/`walletGetCapabilities`), clear-signing
    (`explainLifecycleIntent` + typed encoder `createLifecycleCallEncoder`),
    bağımsız bundler, passkey signer, viem. "Required client work" listesi
    gerçekten kalanlara kırpıldı; release gate'e "enabler mandatory'ye dönüştü mü"
    adımı eklendi.
  - Kalanlar (opsiyonel, boundary-uyumlu SDK/docs işi — istenirse):
    - [ ] (B) typed encoder/decoder'ları genişlet — NOT: `encoders` zaten var,
          yalnızca decode/dökümantasyon genişletilebilir (düşük öncelik).
    - [~] (C) SDK force-exit/withdrawal calldata builder + walkaway örneği.
      - [x] Walkaway örneği: `packages/sdk/test/walkaway.test.mjs` (PR #115,
            auto-merge) — tam yaşam döngüsü (deploy→operate→session→recovery→
            ERC-5792) yalnızca kullanıcı-sağladığı signer/transport/fetch ile;
            global-fetch trap'i gizli default provider/network fallback'i
            yakalar. sdk:test 48/0.
      - [x] Force-exit builder: BİLİNÇLİ OLARAK EKLENMEDİ. L2→L1 force-withdrawal
            generic rollup-bridge tooling'i (OP Stack OptimismPortal vb.),
            Loom'a özgü değil; ARCHITECTURE.md System Boundary'nin "cross-chain
            router" istisnasına girer; viem/OP-Stack SDK'ları zaten sağlıyor;
            Loom hesabı çıkışa engel koymuyor. #114'te client işi olarak belgeli.
            İstenirse kendi decision record'u ile ele alınabilir.
    - [x] (D) "custom endpoint before default" testleri (PR #116, auto-merge):
          `createBundlerTransport`/`createRpcStateTransport` endpoint olmadan
          reddediyor (+ bundler malformed endpoint'i reddediyor) — default
          provider'a düşmeme kilitlendi. NOT: ERC-5792 capability/wallet_sendCalls
          doğruluğu ZATEN client-api.test.mjs'de kapsamlı (atomic status,
          cross-chain filtre, address mismatch→{}, 5700/4100/-32602 rejections),
          o yüzden yalnızca eksik transport-endpoint boşluğu eklendi. sdk:test 50/0.
  - Kesinlikle OUT (System Boundary): light client, tx simulation motoru, adres
    çözümleme/naming, hosted infra, audit/bounty/finansman.

- [ ] **Reproducible deployment manifest yayınlama**
  - Severity: Medium
  - Kapsam: orta
  - Not: Bytecode hash, salt, constructor args, explorer verification —
    zincir başına. `docs/operations/deployment-manifest.md` zaten format
    tanımlıyor, eksik olan imzalı production manifest'leri.

---

## Tamamlanan (referans için, raporda zaten doğrulanmış pozitif bulgular — aksiyon gerekmiyor)

- [x] Immutable proxy implementation, admin/upgrade yok
- [x] Execution surface dar (EntryPoint/self-call only, delegatecall yok)
- [x] Guardian'lar fon harcayamıyor, sadece authority replace ediyor
- [x] Recovery: threshold + 3 gün delay + 7 gün window + iptal yolları
- [x] Hook'lar permanent veto olamıyor (`evictHookWithGuardians`)
- [x] Freeze, recovery iptalini engellemiyor (ölü kod kaldırıldı, e20e7e2)
- [x] Session key'ler capability-based (target/selector/limit/expiry/paymaster)
- [x] SDK'da hardcoded RPC/bundler default yok, CI ile zorlanıyor (635f438)
- [x] P-256/WebAuthn passkey desteği (M-of-N threshold)
