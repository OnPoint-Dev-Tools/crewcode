import {
  createCipheriv,
  createDecipheriv,
  createECDH,
  createHash,
  createPrivateKey,
  hkdfSync,
  sign,
} from 'crypto'

function transcript(connectionId: string, clientKey: string, serverKey: string): Buffer {
  return Buffer.from(`crewcode-hub-relay-v1\0${connectionId}\0${clientKey}\0${serverKey}`, 'utf8')
}

function nonce(direction: 'browser' | 'brain', sequence: number): Buffer {
  if (!Number.isSafeInteger(sequence) || sequence < 0) throw new Error('invalid relay sequence')
  const value = Buffer.alloc(12)
  value.writeUInt32BE(direction === 'browser' ? 0x42525752 : 0x4252414e, 0)
  value.writeBigUInt64BE(BigInt(sequence), 4)
  return value
}

function aad(connectionId: string, direction: 'browser' | 'brain', sequence: number): Buffer {
  return Buffer.from(`${connectionId}\0${direction}\0${sequence}`, 'utf8')
}

export interface BrainRelayCipher {
  serverKey: string
  signature: string
  decryptBrowser(sequence: number, ciphertext: string): string
  encryptBrain(sequence: number, plaintext: string): string
}

export function createBrainRelayCipher(input: {
  connectionId: string
  clientKey: string
  machinePrivateKey: string
}): BrainRelayCipher {
  const clientPublicKey = Buffer.from(input.clientKey, 'base64url')
  if (clientPublicKey.length !== 65 || clientPublicKey[0] !== 4) throw new Error('invalid browser ephemeral key')
  const ecdh = createECDH('prime256v1')
  ecdh.generateKeys()
  const serverPublicKey = ecdh.getPublicKey()
  const serverKey = serverPublicKey.toString('base64url')
  const shared = ecdh.computeSecret(clientPublicKey)
  const salt = createHash('sha256').update(transcript(input.connectionId, input.clientKey, serverKey)).digest()
  const browserKey = Buffer.from(hkdfSync('sha256', shared, salt, Buffer.from('browser-to-brain'), 32))
  const brainKey = Buffer.from(hkdfSync('sha256', shared, salt, Buffer.from('brain-to-browser'), 32))
  const machineKey = createPrivateKey({ key: Buffer.from(input.machinePrivateKey, 'base64url'), type: 'pkcs8', format: 'der' })
  const signature = sign(null, transcript(input.connectionId, input.clientKey, serverKey), machineKey).toString('base64url')

  return {
    serverKey,
    signature,
    decryptBrowser(sequence, ciphertext) {
      const encoded = Buffer.from(ciphertext, 'base64url')
      if (encoded.length < 17) throw new Error('invalid encrypted relay frame')
      const body = encoded.subarray(0, -16)
      const tag = encoded.subarray(-16)
      const decipher = createDecipheriv('aes-256-gcm', browserKey, nonce('browser', sequence))
      decipher.setAAD(aad(input.connectionId, 'browser', sequence))
      decipher.setAuthTag(tag)
      return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8')
    },
    encryptBrain(sequence, plaintext) {
      const cipher = createCipheriv('aes-256-gcm', brainKey, nonce('brain', sequence))
      cipher.setAAD(aad(input.connectionId, 'brain', sequence))
      const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
      return Buffer.concat([body, cipher.getAuthTag()]).toString('base64url')
    },
  }
}
