// Private file-based AES-256-GCM envelope for ops/wal-archive.py.
import fs from 'node:fs';
import { randomBytes, createCipheriv, createDecipheriv, createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { createGzip, createGunzip } from 'node:zlib';

const [mode, inputPath, outputPath, keyPath, aadText] = process.argv.slice(2);
const fail = (code) => { process.stderr.write(code + '\n'); process.exit(2); };
if (!['seal', 'open'].includes(mode) || !inputPath || !outputPath || !keyPath || !aadText) fail('WAL_CRYPTO_ARGS_INVALID');
const key = fs.readFileSync(keyPath);
if (key.length !== 32) fail('WAL_CRYPTO_KEY_LENGTH_INVALID');
const magicV1 = Buffer.from('ALDER-WAL-AESGCM-1\0', 'ascii');
const magicV2 = Buffer.from('ALDER-WAL-AESGCM-2\0', 'ascii');
const hashFile = async (p) => {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(p)) hash.update(chunk);
  return hash.digest('hex');
};
const inputStat = fs.statSync(inputPath);
const temp = outputPath + '.' + randomBytes(6).toString('hex') + '.partial';
let inputBytes = inputStat.size;
let envelopeVersion = 2;
let compression = 'gzip';
try {
  if (mode === 'seal') {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(JSON.stringify({aad:aadText,envelopeVersion:2,compression:'gzip'}), 'utf8'));
    const out = createWriteStream(temp, {flags:'wx', mode:0o600});
    await new Promise((resolve, reject) => out.write(Buffer.concat([magicV2, iv]), error => error ? reject(error) : resolve()));
    await pipeline(createReadStream(inputPath), createGzip(), cipher, out);
    fs.appendFileSync(temp, cipher.getAuthTag());
  } else {
    const magic = Buffer.alloc(magicV2.length);
    const hfd = fs.openSync(inputPath, 'r');
    try { fs.readSync(hfd, magic, 0, magic.length, 0); } finally { fs.closeSync(hfd); }
    const isV2 = magic.equals(magicV2);
    const isV1 = magic.subarray(0,magicV1.length).equals(magicV1) && magic.subarray(magicV1.length).every(byte=>byte===0);
    const envelopeMagic = isV2 ? magicV2 : isV1 ? magicV1 : null;
    if (!envelopeMagic || inputStat.size < envelopeMagic.length + 28) fail('WAL_CRYPTO_ENVELOPE_INVALID');
    envelopeVersion = isV2 ? 2 : 1;
    compression = isV2 ? 'gzip' : 'none';
    const header = Buffer.alloc(envelopeMagic.length + 12);
    const headerFd = fs.openSync(inputPath, 'r');
    try { fs.readSync(headerFd, header, 0, header.length, 0); } finally { fs.closeSync(headerFd); }
    const tag = Buffer.alloc(16); const tfd = fs.openSync(inputPath, 'r');
    try { fs.readSync(tfd, tag, 0, 16, inputStat.size - 16); } finally { fs.closeSync(tfd); }
    const decipher = createDecipheriv('aes-256-gcm', key, header.subarray(magic.length));
    const aad = isV2 ? JSON.stringify({aad:aadText,envelopeVersion:2,compression:'gzip'}) : aadText;
    decipher.setAAD(Buffer.from(aad, 'utf8')); decipher.setAuthTag(tag);
    const out = createWriteStream(temp, {flags:'wx', mode:0o600});
    const transforms = isV2 ? [decipher,createGunzip(),out] : [decipher,out];
    try { await pipeline(createReadStream(inputPath, {start:header.length, end:inputStat.size-17}), ...transforms); }
    catch { throw new Error('WAL_CRYPTO_AUTHENTICATION_FAILED'); }
  }
  const syncFd = fs.openSync(temp, 'r+');
  try { fs.fsyncSync(syncFd); } finally { fs.closeSync(syncFd); }
  // Hard-link publication is atomic and fails if an archive already exists.
  fs.linkSync(temp, outputPath);
  fs.unlinkSync(temp);
  const outputStat = fs.statSync(outputPath);
  process.stdout.write(JSON.stringify({mode, inputBytes, outputBytes:outputStat.size,
    envelopeVersion, compression,
    inputSha256:await hashFile(inputPath), outputSha256:await hashFile(outputPath), verified:mode === 'open'}));
} catch (error) {
  try { fs.unlinkSync(temp); } catch { /* already absent; preserve any published output */ }
  fail(error?.message === 'WAL_CRYPTO_AUTHENTICATION_FAILED' ? 'WAL_CRYPTO_AUTHENTICATION_FAILED' : 'WAL_CRYPTO_OPERATION_FAILED');
}
