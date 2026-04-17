export type GenerationToken = symbol

export type StreamGeneration = {
  bumpSession: (sessionID: string) => void
  bumpPart: (sessionID: string, partID: string) => void
  captureSession: (sessionID: string) => GenerationToken
  capturePart: (sessionID: string, partID: string) => GenerationToken
  isSessionCurrent: (sessionID: string, token: GenerationToken) => boolean
  isPartCurrent: (sessionID: string, partID: string, token: GenerationToken) => boolean
  clearSession: (sessionID: string) => void
  clearPart: (sessionID: string, partID: string) => void
  size: () => { sessions: number; parts: number }
}

export function createStreamGeneration(): StreamGeneration {
  const sessionTokens = new Map<string, GenerationToken>()
  const partTokens = new Map<string, GenerationToken>()

  function partKey(sessionID: string, partID: string): string {
    return `${sessionID}:${partID}`
  }

  function ensureSessionToken(sessionID: string): GenerationToken {
    let token = sessionTokens.get(sessionID)
    if (!token) {
      token = Symbol(sessionID)
      sessionTokens.set(sessionID, token)
    }
    return token
  }

  function ensurePartToken(sessionID: string, partID: string): GenerationToken {
    const key = partKey(sessionID, partID)
    let token = partTokens.get(key)
    if (!token) {
      token = Symbol(key)
      partTokens.set(key, token)
    }
    return token
  }

  return {
    bumpSession: (sessionID) => {
      sessionTokens.set(sessionID, Symbol(sessionID))
    },
    bumpPart: (sessionID, partID) => {
      partTokens.set(partKey(sessionID, partID), Symbol(partKey(sessionID, partID)))
    },
    captureSession: ensureSessionToken,
    capturePart: ensurePartToken,
    isSessionCurrent: (sessionID, token) => sessionTokens.get(sessionID) === token,
    isPartCurrent: (sessionID, partID, token) => partTokens.get(partKey(sessionID, partID)) === token,
    clearSession: (sessionID) => {
      sessionTokens.delete(sessionID)
      for (const key of Array.from(partTokens.keys())) {
        if (key.startsWith(`${sessionID}:`)) partTokens.delete(key)
      }
    },
    clearPart: (sessionID, partID) => {
      partTokens.delete(partKey(sessionID, partID))
    },
    size: () => ({ sessions: sessionTokens.size, parts: partTokens.size }),
  }
}
