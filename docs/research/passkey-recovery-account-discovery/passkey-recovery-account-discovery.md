# Recovery Passkey’den Hesabı Sıfır Yerel Veriyle Bulma

**Karar tarihi:** 27 Ağustos 2026

**Hedef:** Recovery sırasında oluşturulan passkey, daha sonra temiz ve alakasız
bir cihazda seçildiğinde hiçbir Loom yerel kaydı, backend hesabı, eski passkey,
adres girişi veya geçmiş log taraması olmadan bugün kontrol ettiği hesabı bulsun.

## Kısa cevap

Bu hedef gerçekleştirilebilir. Doğru yapı:

> Hesaba ait rastgele ve sabit `accountLocator`, recovery passkey’in
> discoverable WebAuthn `userHandle` alanına yazılır; temiz cihazda credential
> seçildiğinde bu locator geri alınır, zincirden tek hesap bulunur ve aynı fresh
> assertion yalnızca hesabın canlı validator key’iyle doğrulanırsa cüzdan açılır.

Passkey’in yeni cihazda erişilebilir olması gerekir. Bu, password-manager sync,
FIDO credential exchange, cross-device authentication veya fiziksel security
key ile sağlanır. Private key yeni cihazda hiçbir yolla mevcut değilse herhangi
bir locator tasarımı onu yeniden üretemez. Loom tarafında ise hiçbir eski cihaz
verisi veya merkezi hesap indeksi gerekmeyecektir.

## Neden çalışır?

WebAuthn discoverable credential, oluşturulurken verilen `userHandle` değerini
credential kaynağının parçası olarak saklar ve `allowCredentials` boşken yapılan
authentication’da geri vermek zorundadır. Standardın kendisi bu alanın temel
amacını kullanıcı hesabını tanımlamak olarak açıklar ve aynı hesaba kayıtlı
credential’larda aynı olmasını önerir. [W3C WebAuthn Level 3](https://www.w3.org/TR/webauthn-3/#user-handle)

FIDO Credential Exchange Format da taşınan passkey’in `credentialId`, `rpId`,
`userHandle` ve key alanlarını içerir; `userHandle` registration sırasında
verilen değerle aynı olmak zorundadır ve kullanıcı tarafından değiştirilemez.
[FIDO CXF 1.0](https://fidoalliance.org/specs/cx/cxf-v1.0-ps-20250814.html#passkey-dictionary)

Dolayısıyla locator sadece tarayıcı localStorage’ında durmaz:

```text
Recovery sırasında
account A ──► accountLocator H ──► yeni passkey credential kaynağı

Daha sonra temiz cihazda
senkronize passkey ──► userHandle içinden H ──► registry ──► account A
                                                   │
fresh assertion ───────────────────────────────────┘
                         │
                         ▼
              canlı validator doğrulaması
```

## Credential içine yazılacak format

Yeni nesil için 62 byte:

```text
0x4c | version=3 | uint64 chainId | address factory | bytes32 accountLocator
```

- `accountLocator`: CSPRNG ile üretilmiş rastgele, sıfır olmayan 32 byte.
- `chainId`: Yanlış zincirde aramayı engeller.
- `factory`: Aynı zincirde eski/yeni immutable deployment’ları ayırır.
- RP ID zaten authenticator tarafından credential’a bağlanır.
- Origin ve RP hash’i ayrıca canlı P-256 validator kaydında doğrulanır.

Toplam 62 byte, WebAuthn’ın 64-byte `userHandle` sınırı içindedir. Account adresi
ve kişisel veri yazılmaz; locator registry’den bağımsızken anlamsızdır.

## Recovery key bu locator’ı nasıl alır?

Recovery töreni zaten exact `account` adresini hedeflemek zorundadır. Guardian
proposal, nonce, mevcut validator seti ve yeni validator bu hesap olmadan
tanımlanamaz. Yeni passkey oluşturulmadan hemen önce:

```solidity
bytes32 locator = registry.handleForAccount(account);
```

iki bağımsız RPC’den okunup karşılaştırılır. Yeni recovery credential şu aynı
bytes ile oluşturulur:

```typescript
navigator.credentials.create({
  publicKey: {
    user: { id: encodeV3(chainId, factory, locator), ... },
    authenticatorSelection: {
      residentKey: "required",
      userVerification: "required"
    }
  }
});
```

Yeni credential’ın `credentialId` ve P-256 key’i farklıdır; account locator aynı
kalır. Guardian’ların onayladığı recovery initializer yeni public key, RP,
origin ve policy hook bağını içerir. Recovery execute edildiğinde validator seti
değişir fakat registry binding değişmez.

## Temiz cihaz discovery

1. Ağ çağrısından önce boş allow-list ile passkey picker açılır.
2. Kullanıcı recovery passkey’ini seçer ve UV yapar.
3. Challenge, origin, cross-origin, RP ID hash, UP ve UV doğrulanır.
4. `userHandle v3` decode edilir; chain ve factory pinned manifestle eşleşir.
5. İki RPC’den `accountForHandle(locator)` okunur ve sonuçlar eşleştirilir.
6. Bulunan hesabın en fazla 16 canlı validator’ı okunur.
7. Fresh assertion her canlı P-256 key’e karşı denenir.
8. Yalnız bir canlı key doğrularsa signer wallet açılır.

```text
Locator sonucu        Assertion sonucu          Durum
────────────────────────────────────────────────────────
geçersiz/yabancı      —                         INVALID
address(0)            —                         NOT_ACTIVATED
account               canlı key doğruluyor      ACTIVE
account               hiçbir canlı key yok      STALE
credential yok        picker sunamıyor           UNAVAILABLE
```

Locator yetki değildir. `userHandle` manipüle edilerek farklı hesaba yönlendirme
yapılırsa o hesabın canlı public key’i assertion’ı doğrulamayacağı için akış
kapanır. Aynı güvenlik mantığı WebAuthn’ın unsigned credential-ID lookup modelinde
de kullanılır: lookup doğru public key’i bulmalı, ardından signature mutlaka
doğrulanmalıdır. [W3C assertion verification](https://www.w3.org/TR/webauthn-3/#sctn-verifying-assertion)

## Bambaşka cihaz garantisinin gerçek sınırı

WebAuthn cloud sync’i zorunlu kılmaz. BE ve BS bayrakları credential’ın backup
özelliğini bildirir:

- `BE=0`: Tek cihaz credential’ıdır ve hiçbir zaman backup edilemez.
- `BE=1`: Multi-device credential’dır; backup/sync için uygundur.
- `BS=1`: Şu anda backup edilmiş olarak raporlanmaktadır.

BE credential ömrü boyunca değişmez; BS değişebilir. Recovery product’ı
registration authenticator data’dan bu bitleri okumalı ve “cihaz kaybından sonra
başka cihazda açılır” yolu için `BE=0` credential’ı reddetmelidir.
[W3C Credential Backup State](https://www.w3.org/TR/webauthn-3/#sctn-credential-backup)

Google Password Manager passkey’leri desteklenen ortamlar arasında şifreli
olarak senkronize ettiğini; Apple ise iCloud Keychain passkey’lerinin Apple
cihazları arasında kullanılabildiğini belgeliyor. Bunlar provider özellikleridir,
Loom authority’si değildir. [Google passkey ortamları](https://developers.google.com/identity/passkeys/supported-environments), [Apple Passkeys](https://developer.apple.com/passkeys/)

En güçlü release testi BE/BS bayrağı değil gerçek clean-device prova olacaktır:
device A’da recovery key oluştur, Loom local state’i tamamen boş device B’de
aynı provider üzerinden passkey’i seç ve hesabı getir.

## Neden diğer seçenekler seçilmedi?

### `credentialIdHash → account`

Credential ID her recovery key’de yenilenir. Bu nedenle her recovery yeni
registry binding’i gerektirir. Üstelik credential ID assertion tarafından
imzalanmaz. Public recovery sürecinde görülen hash’i başka account’un önce claim
etmesi theft yaratmaz ama kalıcı discovery DoS yaratabilir. Candidate listesi
ise attacker-sized scan problemine döner.

### `keyCommitment → account`

Temiz cihaz assertion’ı public key’i geri vermez. Public key yalnız registration
sırasında elde edilir. Hesabı önceden bilmeden key commitment hesaplanamaz.

### Account adresini doğrudan passkey’e yazmak

Recovery key için teknik olarak mümkün olsa da doğrudan zincir adresini
credential provider’a verir ve WebAuthn’ın random opaque handle yönlendirmesine
göre daha korele edilebilirdir. İlk credential için de tek model oluşturmaz:
mevcut CREATE2 adresi key’i içeren init-code hash’ine bağlıdır ve key credential
oluşturulduktan sonra ortaya çıkar. ERC-4337 de counterfactual adresin başlangıç
signature/credential’ına bağlı olmasını güvenlik açısından önerir.
[ERC-4337](https://eips.ethereum.org/EIPS/eip-4337), [EIP-1014](https://eips.ethereum.org/EIPS/eip-1014)

### `largeBlob`, PRF veya Loom backend

`largeBlob` optional’dır ve registration sırasında yazılamaz. PRF veriyi
şifreleyebilir ama ciphertext’in nerede olduğunu çözmez. Hosted index kolaydır
ama Loom servisinin ayakta kalmasını recovery bağımlılığına dönüştürür.

## Uygulama planı

### Aşama 1 — Protokol ve codec

- `walletId` adını yeni nesilde `accountLocator` olarak değiştir.
- `userHandle v3` 62-byte codec’ini uygula.
- Exact length/version, zero locator, chain/factory mismatch ve fuzz testleri ekle.
- Legacy decoder veya ABI alias bırakma.

### Aşama 2 — Contract yüzeyi

- Registry fonksiyonlarını `accountForHandle` ve `handleForAccount` yap.
- Factory-only, one-to-one ve non-zero invariantlarını koru.
- Factory create ile binding aynı transaction’da kalsın.
- Locator CREATE2 salt olarak kalabilir.
- `accountForKey` veya credential-ID registry ekleme.

### Aşama 3 — Recovery credential oluşturma

- Recovery target account doğrulandıktan sonra handle’ı iki RPC’den oku.
- Yeni credential’a aynı v3 handle’ı yaz.
- Registration authenticator data’dan BE/BS çıkar.
- Cross-device recovery için BE=0 credential’ı reddet.
- Yeni public key/RP/origin binding’ini permissionless recovery validator’a yaz.
- Guardian request’in `initDataHash` doğrulamasını koru.

### Aşama 4 — Clean-device discovery state machine

- Picker her ağ çağrısından önce çalışsın.
- Decode → deployment verify → dual-RPC lookup → bounded validators → fresh
  signature sırasını tek domain servisine taşı.
- Sonuçları `INVALID`, `NOT_ACTIVATED`, `ACTIVE`, `STALE`, `UNAVAILABLE` olarak
  typed union yap.
- `ACTIVE` olmadan account store veya signer oluşturma.

### Aşama 5 — Saved Wallets

- Saved data yalnız cache olsun.
- Her açılışta canlı validator/key kontrolü yap.
- `STALE` credential wallet ekranına ve Send’e girmesin.
- Watch-only kullanım ayrı, açık bir “adres izle” özelliği olsun.

### Aşama 6 — Doğrulama

- Unit: v3 codec ve BE/BS parser.
- Contract: registry tekillik/atomiklik ve factory isolation.
- Adversarial: locator kopyalama, yanlış account, yanlış validator, RPC
  disagreement, malformed response.
- Recovery E2E: eski validator kaldır, yeni validator aktive et; yeni passkey
  `ACTIVE`, eski passkey `STALE`.
- Virtual authenticator export/import: browser storage tamamen boşken discovery.
- Fiziksel matris: Google Password Manager, iCloud Keychain ve desteklenen bir
  üçüncü taraf provider; sync ve provider-change vakaları ayrı kaydedilsin.

### Aşama 7 — Yeni deployment

- Yeni factory/registry/ABI ve manifest üret.
- Runtime/init-code hash’lerini ve constructor parametrelerini kanıtla.
- Sepolia’da gerçek iki cihazlı rehearsal receipt’lerini release evidence’a ekle.
- Eski deployment’ı aynı manifestte karıştırma.

## Tamamlanma kriteri

Loom localStorage’ı, IndexedDB’si ve saved wallet kayıtları boş olan cihaz B’de:

1. “Passkey ile cüzdan bul” seçilir.
2. Recovery sırasında cihaz A’da oluşturulmuş ve provider tarafından erişilebilir
   olan passkey seçilir.
3. Kullanıcı adres, dosya veya recovery code girmez.
4. Loom backend veya historical log scan kullanılmaz.
5. Tek account bulunur.
6. Fresh assertion canlı recovery validator key’iyle doğrulanır.
7. Cüzdan signer olarak açılır ve geçerli UserOperation gönderebilir.
8. Eski passkey aynı account’u bulsa bile `STALE` olur ve cüzdanı açamaz.

## Mevcut kodun durumu

Çalışma ağacındaki kod hedefin büyük bölümünü şimdiden taşıyor: recovery akışı
account’tan mevcut ID’yi okuyor, aynı ID ile yeni passkey oluşturuyor ve discovery
canlı validator assertion’ını kontrol ediyor. İlgili dört test dosyası bu araştırma
sırasında 18/18 geçti. Eksik kalan kritik parçalar factory-domain v3 formatı,
BE/BS portability gate, gerçek temiz-cihaz sync/import E2E ve terminoloji/durum
makinesi temizliğidir.
