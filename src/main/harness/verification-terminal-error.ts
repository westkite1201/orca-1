export const HARNESS_VERIFICATION_STOP_UNVERIFIED = 'HARNESS_VERIFICATION_STOP_UNVERIFIED'

export function unverifiedVerificationStopError(cause?: unknown): Error & { code: string } {
  const detail = cause instanceof Error ? ` ${cause.message}` : ''
  return Object.assign(new Error(`Verification terminal stop could not be verified.${detail}`), {
    code: HARNESS_VERIFICATION_STOP_UNVERIFIED
  })
}

export function isUnverifiedVerificationStopError(
  error: unknown
): error is Error & { code: string } {
  return (
    error instanceof Error &&
    (error as Error & { code?: unknown }).code === HARNESS_VERIFICATION_STOP_UNVERIFIED
  )
}
