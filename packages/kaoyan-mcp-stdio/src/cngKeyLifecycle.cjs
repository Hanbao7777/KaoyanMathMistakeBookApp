'use strict';

const { execFile } = require('node:child_process');
const { createHash } = require('node:crypto');

function invoke(script, args) {
  const env = { ...process.env };
  args.forEach((value, index) => { env[`KAOYAN_CNG_ARG_${index}`] = value; });
  return new Promise((resolve, reject) => execFile(
    'pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
    { windowsHide: true, maxBuffer: 32 * 1024, timeout: 15_000, env },
    (error, stdout) => error ? reject(new Error('CNG operation failed')) : resolve(stdout.trim())
  ));
}

function safeName(name) {
  if (!/^kaoyan-[A-Za-z0-9._-]{1,160}$/.test(name)) throw new Error('Invalid disposable CNG key name');
}

function canonicalBase64Url(value, field) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1 || Buffer.from(value, 'base64url').toString('base64url') !== value) {
    throw new Error(`Invalid ${field}`);
  }
}

function publicKeyFingerprint(publicKey) {
  const canonical = JSON.stringify({ publicKey, publicKeyFormat: 'spki-der-base64url' });
  return `sha256-v1:${createHash('sha256').update(canonical, 'utf8').digest('hex')}`;
}

class WindowsCngKeyLifecycle {
  async create(name) {
    safeName(name);
    const script = "$n=$env:KAOYAN_CNG_ARG_0; $p=[Security.Cryptography.CngProvider]::MicrosoftSoftwareKeyStorageProvider; $k=$null; $rsa=$null; try { if([Security.Cryptography.CngKey]::Exists($n,$p)){throw 'key exists'}; $k=[Security.Cryptography.CngKey]::Create([Security.Cryptography.CngAlgorithm]::Rsa,$n,[Security.Cryptography.CngKeyCreationParameters]@{Provider=$p;KeyCreationOptions=[Security.Cryptography.CngKeyCreationOptions]::None}); $rsa=[Security.Cryptography.RSACng]::new($k); [Convert]::ToBase64String($rsa.ExportSubjectPublicKeyInfo()).TrimEnd('=').Replace('+','-').Replace('/','_') } catch { if($k){$k.Delete()}; throw } finally { if($rsa){$rsa.Dispose()}; if($k){$k.Dispose()} }";
    const publicKey = await invoke(script, [name]);
    canonicalBase64Url(publicKey, 'CNG public key');
    return Object.freeze({
      publicKey,
      publicKeyFormat: 'spki-der-base64url',
      signatureAlgorithm: 'rsa-pss-sha256',
      publicKeyFingerprint: publicKeyFingerprint(publicKey)
    });
  }

  async get(name) {
    safeName(name);
    const script = "$n=$env:KAOYAN_CNG_ARG_0; $p=[Security.Cryptography.CngProvider]::MicrosoftSoftwareKeyStorageProvider; if(-not [Security.Cryptography.CngKey]::Exists($n,$p)){throw 'key missing'}; $k=[Security.Cryptography.CngKey]::Open($n,$p); $rsa=$null; try { $rsa=[Security.Cryptography.RSACng]::new($k); [Convert]::ToBase64String($rsa.ExportSubjectPublicKeyInfo()).TrimEnd('=').Replace('+','-').Replace('/','_') } finally { if($rsa){$rsa.Dispose()}; $k.Dispose() }";
    const publicKey = await invoke(script, [name]);
    canonicalBase64Url(publicKey, 'CNG public key');
    return Object.freeze({ publicKey, publicKeyFormat: 'spki-der-base64url', signatureAlgorithm: 'rsa-pss-sha256', publicKeyFingerprint: publicKeyFingerprint(publicKey) });
  }

  async sign(name, canonicalChallenge) {
    safeName(name);
    canonicalBase64Url(canonicalChallenge, 'challenge bytes');
    const script = "$n=$env:KAOYAN_CNG_ARG_0; $d=($env:KAOYAN_CNG_ARG_1).Replace('-','+').Replace('_','/'); switch($d.Length%4){2{$d+='=='}3{$d+='='}}; $p=[Security.Cryptography.CngProvider]::MicrosoftSoftwareKeyStorageProvider; if(-not [Security.Cryptography.CngKey]::Exists($n,$p)){throw 'key missing'}; $k=[Security.Cryptography.CngKey]::Open($n,$p); $rsa=$null; try{$rsa=[Security.Cryptography.RSACng]::new($k); [Convert]::ToBase64String($rsa.SignData([Convert]::FromBase64String($d),[Security.Cryptography.HashAlgorithmName]::SHA256,[Security.Cryptography.RSASignaturePadding]::Pss)).TrimEnd('=').Replace('+','-').Replace('/','_')} finally{if($rsa){$rsa.Dispose()};$k.Dispose()}";
    const signature = await invoke(script, [name, canonicalChallenge]);
    canonicalBase64Url(signature, 'CNG signature');
    return signature;
  }

  async delete(name, requireExisting = false) {
    safeName(name);
    const result = await invoke("$n=$env:KAOYAN_CNG_ARG_0; $p=[Security.Cryptography.CngProvider]::MicrosoftSoftwareKeyStorageProvider; if([Security.Cryptography.CngKey]::Exists($n,$p)){ $k=[Security.Cryptography.CngKey]::Open($n,$p); try{$k.Delete(); 'deleted'} finally{$k.Dispose()} } else { 'missing' }", [name]);
    if (requireExisting && result !== 'deleted') throw new Error('Previous CNG key is missing');
  }

  async rotate(previousName, nextName) {
    const binding = await this.create(nextName);
    try {
      await this.delete(previousName, true);
      return binding;
    } catch (error) {
      await this.delete(nextName).catch(() => undefined);
      throw error;
    }
  }
}

module.exports = { WindowsCngKeyLifecycle };
