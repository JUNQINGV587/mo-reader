export class ReaderError extends Error {
  constructor(code, message, details = undefined, options = undefined) {
    super(message, options)
    this.name = 'ReaderError'
    this.code = code
    if (details !== undefined) this.details = details
  }
}

export function fail(code, message, details) {
  throw new ReaderError(code, message, details)
}

export function assert(condition, code, message, details) {
  if (!condition) fail(code, message, details)
}

export function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}
