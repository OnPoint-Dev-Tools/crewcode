import { createHash, randomBytes, timingSafeEqual } from 'crypto'
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server'
import { HubStore, type HubUser } from './hub-store'

const CHALLENGE_TTL_MS = 5 * 60_000
export const HUB_BOOTSTRAP_TTL_MS = 10 * 60_000
export const HUB_SESSION_TTL_MS = 12 * 60 * 60_000

interface PendingChallenge {
  challenge: string
  expiresAt: number
  bootstrapDigest?: Buffer
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest()
}

function matches(value: string, expected: Buffer): boolean {
  const actual = digest(value)
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

export class HubAuth {
  private readonly registrationChallenges = new Map<string, PendingChallenge>()
  private readonly authenticationChallenges = new Map<string, PendingChallenge>()
  private bootstrapDigest: Buffer | null = null
  private bootstrapExpiresAt = 0
  private bootstrapUsed = false

  constructor(
    private readonly store: HubStore,
    readonly publicOrigin: string,
    private readonly now: () => number = Date.now,
  ) {}

  get rpId(): string { return new URL(this.publicOrigin).hostname }

  issueBootstrap(): { token: string; expiresAt: number } | null {
    if (this.store.owner()) return null
    const token = randomBytes(32).toString('base64url')
    this.bootstrapDigest = digest(token)
    this.bootstrapExpiresAt = this.now() + HUB_BOOTSTRAP_TTL_MS
    this.bootstrapUsed = false
    return { token, expiresAt: this.bootstrapExpiresAt }
  }

  async registrationOptions(token: string, username: string): Promise<{ flowId: string; options: PublicKeyCredentialCreationOptionsJSON }> {
    this.requireBootstrap(token)
    const normalized = username.trim()
    if (!/^[\p{L}\p{N}_. -]{1,64}$/u.test(normalized)) throw new Error('owner name must be 1-64 letters, numbers, spaces, dots, underscores, or hyphens')
    const options = await generateRegistrationOptions({
      rpName: 'CrewCode Hub',
      rpID: this.rpId,
      userName: normalized,
      userDisplayName: normalized,
      attestationType: 'none',
      authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
    })
    const flowId = randomBytes(16).toString('hex')
    this.registrationChallenges.set(flowId, { challenge: options.challenge, expiresAt: this.now() + CHALLENGE_TTL_MS, bootstrapDigest: digest(token) })
    return { flowId, options }
  }

  async verifyRegistration(input: { token: string; flowId: string; username: string; response: RegistrationResponseJSON }): Promise<{ user: HubUser; token: string; csrf: string }> {
    this.requireBootstrap(input.token)
    const pending = this.registrationChallenges.get(input.flowId)
    this.registrationChallenges.delete(input.flowId)
    if (!pending || pending.expiresAt <= this.now() || !pending.bootstrapDigest || !matches(input.token, pending.bootstrapDigest)) throw new Error('registration challenge is invalid or expired')
    const verification = await verifyRegistrationResponse({
      response: input.response,
      expectedChallenge: pending.challenge,
      expectedOrigin: this.publicOrigin,
      expectedRPID: this.rpId,
      requireUserVerification: true,
    })
    if (!verification.verified || !verification.registrationInfo) throw new Error('passkey registration could not be verified')
    const username = input.username.trim()
    const user = this.store.createOwnerWithCredential({
      username,
      credential: verification.registrationInfo.credential,
      deviceType: verification.registrationInfo.credentialDeviceType,
      backedUp: verification.registrationInfo.credentialBackedUp,
      now: this.now(),
    })
    this.bootstrapUsed = true
    this.bootstrapDigest = null
    const session = this.store.createSession(user.id, this.now(), HUB_SESSION_TTL_MS)
    return { user, token: session.token, csrf: session.csrf }
  }

  async authenticationOptions(): Promise<{ flowId: string; options: PublicKeyCredentialRequestOptionsJSON }> {
    const owner = this.store.owner()
    if (!owner) throw new Error('Hub owner setup is incomplete')
    const credentials = this.store.credentialsForUser(owner.id)
    const options = await generateAuthenticationOptions({
      rpID: this.rpId,
      allowCredentials: credentials.map(credential => ({ id: credential.id, transports: credential.transports })),
      userVerification: 'required',
    })
    const flowId = randomBytes(16).toString('hex')
    this.authenticationChallenges.set(flowId, { challenge: options.challenge, expiresAt: this.now() + CHALLENGE_TTL_MS })
    return { flowId, options }
  }

  async verifyAuthentication(input: { flowId: string; response: AuthenticationResponseJSON }): Promise<{ user: HubUser; token: string; csrf: string }> {
    const pending = this.authenticationChallenges.get(input.flowId)
    this.authenticationChallenges.delete(input.flowId)
    if (!pending || pending.expiresAt <= this.now()) throw new Error('authentication challenge is invalid or expired')
    const credential = this.store.credential(input.response.id)
    if (!credential) throw new Error('passkey is not registered with this Hub')
    const verification = await verifyAuthenticationResponse({
      response: input.response,
      expectedChallenge: pending.challenge,
      expectedOrigin: this.publicOrigin,
      expectedRPID: this.rpId,
      credential: { id: credential.id, publicKey: new Uint8Array(credential.publicKey), counter: credential.counter, transports: credential.transports },
      requireUserVerification: true,
    })
    if (!verification.verified) throw new Error('passkey authentication could not be verified')
    this.store.updateCredentialCounter(credential.id, verification.authenticationInfo.newCounter)
    const owner = this.store.owner()
    if (!owner || owner.id !== credential.userId) throw new Error('passkey owner is unavailable')
    const session = this.store.createSession(owner.id, this.now(), HUB_SESSION_TTL_MS)
    return { user: owner, token: session.token, csrf: session.csrf }
  }

  private requireBootstrap(token: string): void {
    if (this.store.owner()) throw new Error('Hub owner already exists')
    if (this.bootstrapUsed || !this.bootstrapDigest || this.bootstrapExpiresAt <= this.now() || !matches(token, this.bootstrapDigest)) {
      throw new Error('bootstrap token is invalid, expired, or already used')
    }
  }
}
